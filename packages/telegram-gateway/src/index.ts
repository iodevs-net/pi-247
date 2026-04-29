#!/usr/bin/env bun
/**
 * pi-247 Gateway — Telegram + Email bridge
 *
 * Starts pi-247 agent session, Telegram bot, and optional email listener.
 * Relays messages from chat platforms to the agent and sends responses back.
 *
 * Usage:
 *   export TELEGRAM_BOT_TOKEN="..."
 *   bun packages/telegram-gateway/src/index.ts
 *
 * Optional env vars:
 *   GATEWAY_ALLOWED_USERS    Comma-separated Telegram user IDs, or "*" (default)
 *   GATEWAY_AGENT_CWD        Working directory for pi-247 agent (default: cwd)
 *   GATEWAY_SESSION_DIR      Session persistence dir (default: auto)
 *   EMAIL_IMAP_HOST          Enable email listener (IMAP host)
 *   EMAIL_IMAP_USER / _PASS  IMAP credentials
 *   EMAIL_SMTP_HOST           SMTP host for sending replies
 *   EMAIL_SMTP_USER / _PASS  SMTP credentials
 *   EMAIL_ALLOWED_DOMAINS    Sender domains to accept (default: "*")
 */

import { loadConfig } from "./config";
import { AgentClient } from "./agent-client";
import { TelegramBot } from "./telegram";
import { EmailListener } from "./email";
import { log } from "./debug";

async function main(): Promise<void> {
	const config = loadConfig();
	log("gateway", "config: telegram=%s, email=%s, cwd=%s, sessionDir=%s",
		config.telegramToken ? "yes" : "no",
		config.email ? "yes" : "no",
		config.agentCwd,
		config.sessionDir ?? "auto");

	// ── Start pi-247 agent session ──────────────────────────────────────────
	const agent = new AgentClient();
	await agent.init(config.agentCwd, config.sessionDir, config.agentDir);
	log("gateway", "pi-247 agent ready");

	// ── Start Telegram bot ──────────────────────────────────────────────────
	const tgBot = new TelegramBot(
		{ token: config.telegramToken, allowedUsers: config.allowedUsers },
		agent,
	);
	log("gateway", "connecting Telegram bot...");
	await tgBot.start();

	// ── Start email listener if configured ──────────────────────────────────
	let emailListener: EmailListener | null = null;
	if (config.email) {
		emailListener = new EmailListener(config.email, agent);
		await emailListener.start();
		log("gateway", "Email listener started");
	}

	// ── Graceful shutdown ───────────────────────────────────────────────────
	const shutdown = async () => {
		log("gateway", "shutting down...");
		if (emailListener) await emailListener.stop();
		await tgBot.stop();
		await agent.shutdown();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	log("gateway", "pi-247 gateway running. Press Ctrl+C to stop.");
}

main().catch((err: unknown) => {
	console.error("[gateway] fatal:", err);
	process.exit(1);
});
