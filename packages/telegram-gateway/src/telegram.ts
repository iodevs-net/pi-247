import { Bot, type Context } from "grammy";
import type { AgentClient } from "./agent-client";
import { debug, log, error as logError } from "./debug";

export interface TelegramConfig {
	token: string;
	allowedUsers: string[];
}

export class TelegramBot {
	private bot: Bot;
	private agent: AgentClient;
	private config: TelegramConfig;

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

		this.bot.on("message:text", async ctx => {
			if (!isAllowed(ctx, this.config.allowedUsers)) return;
			const text = ctx.message.text.trim();
			if (!text) return;
			await handleMessage(ctx, this.agent);
		});
	}

	async start(): Promise<void> {
		const me = await this.bot.api.getMe();
		log("telegram", "bot connected: @%s (id=%s)", me.username ?? "?", me.id);
		debug("telegram", "starting bot long-polling");
		await this.bot.start({ drop_pending_updates: true });
	}

	async stop(): Promise<void> {
		debug("telegram", "stopping bot");
		await this.bot.stop();
		log("telegram", "bot stopped");
	}
}

// ── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(ctx: Context, agent: AgentClient): Promise<void> {
	const chatId = ctx.chat!.id;
	const text = ctx.message!.text!.trim();
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
		for (const chunk of splitMessage(reply, 4000)) {
			await ctx.reply(chunk, { parse_mode: "Markdown" });
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAllowed(ctx: Context, users: string[]): boolean {
	if (users.includes("*")) return true;
	const id = String(ctx.from?.id ?? "");
	const un = ctx.from?.username ?? "";
	return users.includes(id) || users.includes(`@${un}`);
}

function splitMessage(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}
