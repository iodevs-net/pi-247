import path from "path";
import {
	createAgentSession,
	Settings,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { debug, log } from "./debug";
import { detectToolLoop, stableStringify } from "@oh-my-pi/pi-coding-agent/utils/loop-detection";
import { hasVerificationEvidence } from "@oh-my-pi/pi-coding-agent/utils/evidence";
import { checkContextPressure } from "./context-guard";
import { buildSystemPrompt } from "./system-prompt";

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

/** Severity of detected loop */
type LoopSeverity = "ok" | "loop" | "escalate";

type TurnResult = {
	text: string;
	partial: boolean;
	loopSeverity: LoopSeverity;
	toolCallHistory: string;
	toolCallEntries: Array<{ tool: string; key: string }>;
};

/**
 * Wraps pi-247 AgentSession with Promise-based prompt/response API.
 * Maintains conversation context. Queues messages when agent busy.
 */
export class AgentClient {
	private session: AgentSession | null = null;
	private processing = false;
	private queue: QueueItem[] = [];
	private idleWaiters: Array<() => void> = [];
	#currentAbort: AbortController | null = null;

	get isBusy(): boolean {
		return this.processing;
	}

	/** Cancel current prompt, clear queue, reset session */
	async stop(): Promise<void> {
		log("agent", "stop requested (cancel=%s queue=%d)", this.#currentAbort !== null, this.queue.length);
		this.#currentAbort?.abort();
		this.#currentAbort = null;

		const q = this.queue.splice(0);
		for (const item of q) {
			item.reject(new Error("Cancelled by /stop"));
		}

		if (this.session) {
			try { await this.session.prompt("/reset").catch(() => {}); } catch {}
		}
	}

	async init(cwd: string, sessionDir: string | null, agentDir?: string): Promise<void> {
		log("agent", "starting pi-247 session (cwd=%s)", cwd);
		debug("agent", "init with sessionDir=%s agentDir=%s", sessionDir ?? "null", agentDir ?? "default");

		const opts: Record<string, unknown> = { cwd };
		if (agentDir) {
			opts.agentDir = agentDir;
		}
		// Always persist sessions — derive default from agentDir if not configured
		const resolvedDir = sessionDir ?? (agentDir ? path.join(agentDir, "sessions") : undefined);
		opts.sessionManager = await SessionManager.continueRecent(cwd, resolvedDir);
		opts.systemPrompt = buildSystemPrompt(cwd);

		const settings = await Settings.init({ cwd, agentDir: agentDir ?? undefined });
		settings.override("compaction.thresholdPercent", 50);
		opts.settings = settings;

		// If ANTHROPIC_MODEL + ANTHROPIC_BASE_URL point to a non-Anthropic endpoint,
		// inject a custom model so the agent actually uses the configured provider.
		const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
		const anthropicModel = process.env.ANTHROPIC_MODEL?.trim();
		if (
			anthropicBaseUrl &&
			anthropicModel &&
			!anthropicBaseUrl.includes("api.anthropic.com") &&
			!anthropicBaseUrl.includes("api.anthropic.com")
		) {
			opts.model = {
				id: anthropicModel,
				name: anthropicModel,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: anthropicBaseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
				contextWindow: 65536,
				maxTokens: 8192,
				headers: {},
				thinking: {
					minLevel: "minimal" as const,
					maxLevel: "xhigh" as const,
					mode: "budget" as const,
				},
			} satisfies Model;
			log("agent", "custom model injected: %s via %s", anthropicModel, anthropicBaseUrl);
		}

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
		this.#currentAbort = new AbortController();
		try {
			return await this.runPrompt(text, this.#currentAbort.signal);
		} finally {
			this.#currentAbort = null;
			this.processing = false;
			this.notifyIdleWaiters();
			this.dequeue();
		}
	}

	/**
	 * Monitor a single turn cycle via subscription. Returns the assistant text
	 * and detected loop severity from tool call patterns.
	 *
	 * Resolves when BOTH turn_end event fires (agent done) AND session.prompt()
	 * promise settles. Both signals needed before proceeding to next turn.
	 */
	private waitForTurn(session: AgentSession, turnPrompt: string, signal?: AbortSignal): Promise<TurnResult> {
		const toolCalls: Array<{ tool: string; key: string }> = [];
		const parts: string[] = [];
		let partial = false;
		let loopSeverity: LoopSeverity = "ok";

		const { promise, resolve, reject } = Promise.withResolvers<TurnResult>();
		let resolved = false;
		let promptDone = false;
		let turnReady = false;
		let toolUseBoundary = false;

		const timer = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			reject(new Error(`Prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`));
		}, PROMPT_TIMEOUT_MS);

		if (signal?.aborted) {
			resolved = true;
			clearTimeout(timer);
			reject(new Error("Stopped by user"));
			return promise;
		}
		signal?.addEventListener("abort", () => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			unsubscribe();
			reject(new Error("Stopped by user"));
		}, { once: true });

		function finish() {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			unsubscribe();
			resolve({
				text: parts.join("").trim(),
				partial,
				loopSeverity,
				toolCallHistory: toolCalls.map(t => `${t.tool}(${t.key})`).join(" | "),
				toolCallEntries: [...toolCalls],
			});
		}

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (resolved) return;

			// Accumulate streaming text deltas
			if (event.type === "message_update" && "assistantMessageEvent" in event) {
				const ev = event as { assistantMessageEvent?: { type?: string; delta?: string } };
				if (ev.assistantMessageEvent?.type === "text_delta" && ev.assistantMessageEvent.delta) {
					parts.push(ev.assistantMessageEvent.delta);
				}
			}

			if (event.type === "message_end") {
				const msg = (event as {
					message?: { role?: string; content?: Array<{ type: string; text: string }>; stopReason?: string };
				}).message;
				if (msg?.role !== "assistant") return;

				// Replace incremental deltas with final message text
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
					toolUseBoundary = true;
				}

				// Track tool calls for loop detection
				if (msg.stopReason === "toolUse" && msg.content) {
					for (const block of msg.content as Array<Record<string, unknown>>) {
						const tu = block.toolUse as { name?: string; arguments?: Record<string, unknown> } | undefined;
						if (!tu?.name) continue;
						const argsKey = stableStringify(tu.arguments ?? {});
						toolCalls.push({ tool: tu.name, key: argsKey });
						if (detectToolLoop(toolCalls).isLoop) {
							loopSeverity = "loop";
							debug("loop", "tool loop: %s(%s)", tu.name, argsKey);
						}
					}
				}
			}

			if (event.type === "turn_end") {
				if (toolUseBoundary) {
					toolUseBoundary = false;
					return;
				}
				turnReady = true;
				if (promptDone) finish();
			}
		});

		session.prompt(turnPrompt).then(() => {
			promptDone = true;
			if (turnReady) finish();
		}).catch((err: unknown) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			unsubscribe();
			reject(err);
		});

		return promise;
	}

	private async runPrompt(text: string, signal?: AbortSignal): Promise<PromptResult> {
		const session = this.session!;
		let combinedText = "";
		let loopCount = 0;
		let currentText = text;

		for (let attempt = 0; attempt <= 4; attempt++) {
			// Pre-turn context check
			await this.maybeCompactContext(session);

			const result = await this.waitForTurn(session, currentText, signal);
			combinedText += (combinedText ? "\n\n" : "") + result.text;

			// Log post-turn context usage
			const postUsage = session.getContextUsage();
			if (postUsage?.percent != null) {
				debug("context", "post-turn: %d%% (%d/%d)", postUsage.percent, postUsage.tokens ?? 0, postUsage.contextWindow);
			}

			// 1. Loop detection — escalate if repeating tools
			if (attempt < 4 && result.loopSeverity === "loop") {
				if (/ESCALANDO/i.test(result.text)) {
					log("loop", "agent escalated, not re-intervening");
					return { text: combinedText, partial: false };
				}
				loopCount++;
				log("loop", "intervening #%d after detecting tool repetition", loopCount);
				currentText = this.getLoopIntervention(loopCount);
				continue;
			}

			// 2. Verification Gate — only for file-modifying tools
			if (attempt < 4 && hasWriteToolCalls(result.toolCallEntries)) {
				const intervention = getVerificationIntervention(result.text);
				if (intervention) {
					currentText = intervention;
					continue;
				}
			}

			return { text: combinedText, partial: result.partial };
		}

		return { text: combinedText, partial: false };
	}

	private async maybeCompactContext(session: AgentSession): Promise<void> {
		const usage = session.getContextUsage();
		if (!usage?.percent) return;
		const action = checkContextPressure(usage.percent);
		if (action === "compact") {
			log("context", "CRITICAL %d%% — forcing pre-prompt compaction", usage.percent);
			await session.compact("Gateway: pre-prompt compaction at critical threshold").catch(() => {});
		} else if (action === "warn") {
			log("context", "WARNING %d%% — monitoring", usage.percent);
		}
	}

	private getLoopIntervention(loopCount: number): string {
		const strategies = [
			"[SISTEMA: Estas repitiendo la misma herramienta. Cambia de estrategia IMMEDIATAMENTE. Prueba otro enfoque completamente diferente.]",
			"[SISTEMA: Sigue en loop. Es tu ULTIMA oportunidad de auto-correccion. Si no puedes resolverlo, di ESCALANDO y explica el problema.]",
		];
		return strategies[Math.min(loopCount - 1, strategies.length - 1)];
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

// -- Module-level pure functions ------------------------------------------------

function hasWriteToolCalls(entries: Array<{ tool: string; key: string }>): boolean {
	return entries.some(tc => ["edit", "write", "ast_edit"].includes(tc.tool.toLowerCase()));
}

/** Returns intervention text if verification gate fails, null if it passes. */
function getVerificationIntervention(text: string): string | null {
	if (/\bNO_VERIFICADO\b/.test(text)) return null;

	if (/\bVERIFICADO\b/.test(text)) {
		if (hasVerificationEvidence(text)) return null;
		log("gate", "VERIFICADO without evidence, intervening");
		return "[SISTEMA: Declaraste VERIFICADO pero no hay evidencia de verificacion (output de test/diff/build). Ejecuta el comando correspondiente y muestra el output REAL.]";
	}

	log("gate", "missing verification declaration, intervening");
	return "[SISTEMA: No se detecto declaracion VERIFICADO/NO_VERIFICADO. Ejecuta el protocolo Verification Gate obligatorio.]";
}
