import { Bot, type Context, GrammyError } from "grammy";
import type { AgentClient } from "./agent-client";
import { RateLimiter } from "./rate-limiter";
import { withRetry } from "./retry";
import { splitMarkdown } from "./splitter";
import { debug, log, error as logError } from "./debug";

export interface TelegramConfig {
	token: string;
	allowedUsers: string[];
}

const RATE_LIMIT = parseInt(process.env.GATEWAY_RATE_LIMIT ?? "10", 10);
const MAX_MSG_LEN = 4000;

export class TelegramBot {
	private bot: Bot;
	private agent: AgentClient;
	private config: TelegramConfig;
	private rateLimiter = new RateLimiter({ maxRequests: RATE_LIMIT });
	private stopped = false;

	constructor(config: TelegramConfig, agent: AgentClient) {
		this.config = config;
		this.agent = agent;
		this.bot = new Bot(config.token);
		this.registerHandlers();
	}

	private registerHandlers(): void {
		this.bot.command("start", async ctx => {
			log("telegram", "/start from user=%s", ctx.from?.username ?? ctx.from?.id ?? "?");
			await ctx.reply("pi-247 gateway active. Send message to start.");
		});

		this.bot.command("new", async ctx => {
			log("telegram", "/new from user=%s", ctx.from?.username ?? ctx.from?.id ?? "?");
			if (this.agent.isBusy) await ctx.reply("⏳ waiting...");
			await this.agent.waitForIdle();
			await this.agent.prompt("/reset");
			await ctx.reply("Reset done.");
		});

		this.bot.command("status", async ctx => {
			const s = this.agent.isBusy ? "busy" : "idle";
			debug("telegram", "/status → %s", s);
			await ctx.reply(`pi-247 gateway. Agent: ${s}.`);
		});

		this.bot.command("stop", async ctx => {
			log("telegram", "/stop from user=%s", ctx.from?.username ?? ctx.from?.id ?? "?");
			if (!this.agent.isBusy) {
				await ctx.reply("Agent is not busy.");
				return;
			}
			await ctx.reply("⏹ Stopping...");
			await this.agent.stop();
			await ctx.reply("✅ Stopped. Ready for next message.");
		});

		this.bot.on("message:text", async ctx => {
			if (!isAllowed(ctx, this.config.allowedUsers)) return;
			const text = ctx.message.text.trim();
			if (!text) return;
			const userId = String(ctx.from?.id ?? "?");
			if (!this.rateLimiter.allow(userId)) {
				debug("telegram", "rate limited user=%s", userId);
				await ctx.reply("⏳ Too many requests. Slow down.");
				return;
			}
			await handleMessage(ctx, this.agent);
		});
	}

	async start(): Promise<void> {
		const me = await this.bot.api.getMe();
		log("telegram", "bot connected: @%s (id=%s)", me.username ?? "?", me.id);
		await this.startPolling();
	}

	private async startPolling(): Promise<void> {
		while (!this.stopped) {
			debug("telegram", "starting long-polling");
			try {
				await withRetry(() => this.bot.start({ drop_pending_updates: true }), {
					maxAttempts: 3,
					baseMs: 2000,
					isRetryable: (err) => {
						if (err instanceof GrammyError) {
							return err.error_code >= 500 || err.error_code === 429;
						}
						return true;
					},
				});
				break; // exited cleanly via bot.stop()
			} catch (err) {
				if (this.stopped) break;
				logError("telegram", "polling failed, reconnecting in 10s", err);
				await sleep(10_000);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		debug("telegram", "stopping bot");
		await this.bot.stop();
		log("telegram", "bot stopped");
	}
}

// -- Message handler ---------------------------------------------------------------

async function handleMessage(ctx: Context, agent: AgentClient): Promise<void> {
	const chatId = ctx.chat!.id;
	let text = ctx.message!.text!.trim();
	if (!text) return;
	if (text.length > MAX_MSG_LEN) {
		debug("telegram", "msg truncated from %d to %d chars", text.length, MAX_MSG_LEN);
		text = text.slice(0, MAX_MSG_LEN);
	}
	text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

	const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
	log("telegram", "msg from=%s: %s", ctx.from?.username ?? ctx.from?.id ?? "?", preview);

	// Queue notification
	if (agent.isBusy) {
		debug("telegram", "busy, queueing msg");
		await ctx.reply("⏳ Queued — will process after current task.");
	}

	// Typing indicator loop (parallel to prompt)
	const abort = new AbortController();
	const typingP = (async () => {
		debug("telegram", "typing start (chatId=%s)", chatId);
		while (!abort.signal.aborted) {
			try { await ctx.api.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
			await sleep(4000);
		}
	})();

	try {
		const result = await agent.prompt(text);
		const reply = result.text || "(no response)";
		debug("telegram", "response len=%d partial=%s", reply.length, result.partial);
		for (const chunk of splitMarkdown(reply, 4000)) {
			try {
				await ctx.reply(chunk, { parse_mode: "Markdown" });
			} catch {
				debug("telegram", "Markdown parse failed, sending as plain text");
				await ctx.reply(stripMarkdown(chunk));
			}
		}
		debug("telegram", "response sent (%d chunks)", Math.ceil(reply.length / 4000));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logError("telegram", "prompt failed", err);
		await ctx.reply(`Error: ${msg}`);
	} finally {
		abort.abort();
		await typingP.catch(() => {});
		debug("telegram", "typing stopped");
	}
}

// -- Helpers ------------------------------------------------------------------------

function isAllowed(ctx: Context, users: string[]): boolean {
	if (users.includes("*")) return true;
	const id = String(ctx.from?.id ?? "");
	const un = ctx.from?.username ?? "";
	return users.includes(id) || users.includes(`@${un}`);
}

function stripMarkdown(text: string): string {
	return text
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}
