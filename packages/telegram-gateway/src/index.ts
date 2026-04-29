/**
 * pi-247 Gateway — Telegram bridge
 *
 * Starts pi-247 agent session and Telegram bot.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN          Bot token from @BotFather
 *   GATEWAY_ALLOWED_USERS       Comma-separated user IDs (default: "*")
 *   GATEWAY_AGENT_CWD           Working directory (default: cwd)
 *   GATEWAY_SESSION_DIR         Session persistence dir (default: auto)
 *   GATEWAY_AGENT_DIR           Config dir (default: ~/.omp/pi-gateway)
 */

import { loadConfig } from "./config";
import { log } from "./debug";
import { AgentClient } from "./agent-client";
import { TelegramBot } from "./telegram";

async function main(): Promise<void> {
	const config = loadConfig();
	log("gateway", "config: telegram=%s, cwd=%s, sessionDir=%s", config.telegramToken ? "yes" : "no", config.agentCwd, config.sessionDir ?? "auto");

	// ── Start pi-247 agent session ──────────────────────────────────────────
	const agent = new AgentClient();
	await agent.init(config.agentCwd, config.sessionDir, config.agentDir);
	log("gateway", "pi-247 agent ready");

	// ── Start Telegram bot ──────────────────────────────────────────────────
	const tgBot = new TelegramBot(
		{ token: config.telegramToken, allowedUsers: config.allowedUsers },
		agent,
	);
	await tgBot.start();
	log("gateway", "Telegram bot started");

	// ── Shutdown handling ───────────────────────────────────────────────────
	const shutdown = async () => {
		log("gateway", "shutting down...");
		await tgBot.stop();
		await agent.shutdown();
		log("gateway", "bye");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch(err => {
	console.error("[gateway] fatal:", err);
	process.exit(1);
});
