import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { debug, log } from "./debug";

export interface PromptResult {
	text: string;
	partial: boolean;
}

interface QueueItem {
	text: string;
	resolve: (r: PromptResult) => void;
	reject: (err: unknown) => void;
}

const PROMPT_TIMEOUT_MS = parseInt(process.env.GATEWAY_PROMPT_TIMEOUT ?? "120000", 10);
const MAX_QUEUE_SIZE = parseInt(process.env.GATEWAY_MAX_QUEUE ?? "20", 10);

const TELEGRAM_SYSTEM_PROMPT_SUFFIX = `

## Telegram Communication Rules
You are responding via Telegram messenger. Follow these rules:
- **Ultra concise**: 2-4 sentences max. No introductions, no farewells.
- **State intent first**: "Revisando logs..." "Buscando en web..." then result.
- **No narration**: Don't describe what you're doing step by step. Just do it.
- **Markdown**: Use *bold* for commands/paths, \`code\` for snippets.
- **No disclaimers**: No "let me know if you need anything else", "hope this helps", etc.
- **One message**: Send complete result in single message unless >4000 chars.`;

/**
 * Wraps pi-247 AgentSession with Promise-based prompt/response API.
 * Maintains conversation context. Queues messages when agent busy.
 */
export class AgentClient {
	private session: AgentSession | null = null;
	private processing = false;
	private queue: QueueItem[] = [];
	private idleWaiters: Array<() => void> = [];

	get isBusy(): boolean {
		return this.processing;
	}

	async init(cwd: string, sessionDir: string | null): Promise<void> {
		log("agent", "starting pi-247 session (cwd=%s)", cwd);
		debug("agent", "init with sessionDir=%s", sessionDir ?? "null");

		const opts: Record<string, unknown> = { cwd };
		if (sessionDir) {
			opts.sessionManager = await SessionManager.continueRecent(cwd, sessionDir);
		}
		opts.systemPrompt = (defaultPrompt: string) => defaultPrompt + TELEGRAM_SYSTEM_PROMPT_SUFFIX;

		const result = await createAgentSession(opts as Parameters<typeof createAgentSession>[0]);
		this.session = result.session;

		if (result.modelFallbackMessage) {
			console.warn("[agent] %s", result.modelFallbackMessage);
		}

		console.log("[agent] session ready");
	}

	/**
	 * Send a prompt to the agent. Queues if busy, processes sequentially.
	 * Resolves when the agent finishes responding.
	 */
	async prompt(text: string): Promise<PromptResult> {
		if (!this.session) throw new Error("AgentClient not initialized. Call init() first.");

		const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;

		// If already processing a message, queue and return a promise
		if (this.processing) {
			if (this.queue.length >= MAX_QUEUE_SIZE) {
				const err = new Error(`Queue full (max ${MAX_QUEUE_SIZE}). Try again later.`);
				debug("queue", "QUEUE FULL: %s", preview);
				throw err;
			}
			debug("queue", "QUEUE +%d: %s", this.queue.length + 1, preview);
			return new Promise((resolve, reject) => {
				this.queue.push({ text, resolve, reject });
			});
		}

		debug("agent", "EXEC (idle): %s", preview);
		return this.executePrompt(text);
	}

	private async executePrompt(text: string): Promise<PromptResult> {
		this.processing = true;
		try {
			return await this.runPrompt(text);
		} finally {
			this.processing = false;
			this.notifyIdleWaiters();
			this.dequeue();
		}
	}

	private async runPrompt(text: string): Promise<PromptResult> {
		const session = this.session!;

		return new Promise<PromptResult>((resolve, reject) => {
			const parts: string[] = [];
			let partial = false;
			let toolUsePending = false;
			let settled = false;

			const timer = setTimeout(() => {
				settled = true;
				reject(new Error(`Prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`));
			}, PROMPT_TIMEOUT_MS);

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (settled) return;
				debug("agent", "EVENT: type=%s", event.type);

				if (event.type === "message_update" && "assistantMessageEvent" in event) {
					const ev = event as { assistantMessageEvent?: { type?: string; delta?: string } };
					if (ev.assistantMessageEvent?.type === "text_delta" && ev.assistantMessageEvent.delta) {
						parts.push(ev.assistantMessageEvent.delta);
						debug("agent", "  text_delta: +%d chars", ev.assistantMessageEvent.delta.length);
					}
				}

				if (event.type === "message_end") {
					const msg = (event as { message?: { role?: string; content?: Array<{ type: string; text: string }>; stopReason?: string } }).message;
					debug("agent", "  message_end role=%s stopReason=%s", msg?.role, (msg as any)?.stopReason);
					if (msg?.role === "assistant") {
						if (msg.content && Array.isArray(msg.content)) {
							const fullText = msg.content
								.filter(c => c?.type === "text")
								.map(c => c.text)
								.join("");
							if (fullText) {
								parts.length = 0;
								parts.push(fullText);
							}
						}
						if (msg.stopReason === "error" || msg.stopReason === "aborted") {
							partial = true;
						}
						if (msg.stopReason === "toolUse") {
							toolUsePending = true;
							debug("agent", "  toolUse detected, deferring resolve");
						}
					}
				}

				if (event.type === "turn_end") {
					if (toolUsePending) {
						debug("agent", "  turn_end after toolUse, waiting for next turn");
						toolUsePending = false;
						return;
					}
					const totalLen = parts.join("").length;
					debug("agent", "TURN_END: response=%d chars partial=%s", totalLen, partial);
					clearTimeout(timer);
					unsubscribe();
					resolve({ text: parts.join("").trim(), partial });
				}
			});

			session.prompt(text).catch((err: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				reject(err);
			});
		});
	}

	private dequeue(): void {
		if (this.queue.length === 0) return;
		const next = this.queue.shift()!;
		this.executePrompt(next.text).then(next.resolve).catch(next.reject);
	}

	private notifyIdleWaiters(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const w of waiters) w();
	}

	async waitForIdle(): Promise<void> {
		if (!this.processing) return;
		return new Promise(resolve => {
			this.idleWaiters.push(resolve);
		});
	}

	async shutdown(): Promise<void> {
		log("agent", "shutting down (queue=%d, processing=%s)", this.queue.length, this.processing);
		if (this.session) {
			try {
				await this.session.prompt("/reset");
			} catch {
				// ignore
			}
			this.session = null;
		}
	}
}
