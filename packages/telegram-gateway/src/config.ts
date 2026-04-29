import path from "path";
import os from "os";
import fs from "fs";

export interface GatewayConfig {
	telegramToken: string;
	allowedUsers: string[];
	agentCwd: string;
	/** Session persistence dir for pi-247 */
	sessionDir: string | null;
	/** Agent config dir (~/.omp/agent by default). Isolated from omp/Claude Code. */
	agentDir: string;
}

/**
 * Walk up from cwd to find project root (dir with package.json containing "workspaces").
 */
function findProjectRoot(start: string): string {
	let dir = path.resolve(start);
	for (let i = 0; i < 10; i++) {
		const pkgPath = path.join(dir, "package.json");
		try {
			const content = fs.readFileSync(pkgPath, "utf-8");
			if (content.includes('"workspaces"') || content.includes('"workspaces":')) {
				return dir;
			}
		} catch {
			// not found, continue up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}

function isPlaceholderToken(token: string): boolean {
	const placeholders = [
		"your_bot_token",
		"your-token-here",
		"<token>",
		"xxxxx",
		"123456",
		"YOUR_BOT_TOKEN",
	];
	const lower = token.toLowerCase();
	return placeholders.some(p => lower.includes(p));
}

function looksLikeBotToken(token: string): boolean {
	return /^\d+:[a-zA-Z0-9_-]+$/.test(token);
}

export function loadConfig(): GatewayConfig {
	const tgToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
	if (!tgToken) {
		console.error("FATAL: TELEGRAM_BOT_TOKEN env var required");
		console.error("");
		console.error("  Create a .env file in the project root or packages/telegram-gateway/:");
		console.error('    TELEGRAM_BOT_TOKEN="your_token_from_@BotFather"');
		console.error("");
		console.error("  Or export it (less secure — visible in process list):");
		console.error("    export TELEGRAM_BOT_TOKEN=your_token");
		console.error("");
		process.exit(1);
	}

	if (isPlaceholderToken(tgToken)) {
		console.error("FATAL: TELEGRAM_BOT_TOKEN appears to be a placeholder value");
		console.error("  Get a real token from @BotFather and add it to your .env file.");
		process.exit(1);
	}

	if (!looksLikeBotToken(tgToken)) {
		console.warn("[config] TELEGRAM_BOT_TOKEN doesn't look like a valid bot token (expected format: 123456:ABCdef)");
	}

	const allowedRaw = process.env.GATEWAY_ALLOWED_USERS ?? "*";
	const allowedUsers = allowedRaw === "*" ? ["*"] : allowedRaw.split(",").map(s => s.trim()).filter(Boolean);

	const defaultAgentDir = path.join(os.homedir(), ".omp", "pi-gateway");
	const defaultCwd = findProjectRoot(process.cwd());

	return {
		telegramToken: tgToken,
		allowedUsers,
		agentCwd: process.env.GATEWAY_AGENT_CWD ?? defaultCwd,
		sessionDir: process.env.GATEWAY_SESSION_DIR ?? null,
		agentDir: process.env.GATEWAY_AGENT_DIR ?? defaultAgentDir,
	};
}
