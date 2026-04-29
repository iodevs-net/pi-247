export interface GatewayConfig {
	telegramToken: string;
	email: EmailConfig | null;
	allowedUsers: string[];
	agentCwd: string;
	/** Session persistence dir for pi-247 */
	sessionDir: string | null;
}

export interface EmailConfig {
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	imapUser: string;
	imapPass: string;
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
	smtpUser: string;
	smtpPass: string;
	allowedDomains: string[];
	checkIntervalMs: number;
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
	const emailSection = loadEmailConfig();

	return {
		telegramToken: tgToken,
		email: emailSection,
		allowedUsers,
		agentCwd: process.env.GATEWAY_AGENT_CWD ?? process.cwd(),
		sessionDir: process.env.GATEWAY_SESSION_DIR ?? null,
	};
}

function loadEmailConfig(): EmailConfig | null {
	const imapHost = process.env.EMAIL_IMAP_HOST ?? "";
	if (!imapHost) return null;

	return {
		imapHost,
		imapPort: parseInt(process.env.EMAIL_IMAP_PORT ?? "993", 10),
		imapSecure: process.env.EMAIL_IMAP_SECURE !== "false",
		imapUser: process.env.EMAIL_IMAP_USER ?? "",
		imapPass: process.env.EMAIL_IMAP_PASS ?? "",
		smtpHost: process.env.EMAIL_SMTP_HOST ?? "",
		smtpPort: parseInt(process.env.EMAIL_SMTP_PORT ?? "587", 10),
		smtpSecure: process.env.EMAIL_SMTP_SECURE === "true",
		smtpUser: process.env.EMAIL_SMTP_USER ?? "",
		smtpPass: process.env.EMAIL_SMTP_PASS ?? "",
		allowedDomains: (process.env.EMAIL_ALLOWED_DOMAINS ?? "*").split(",").map(s => s.trim()),
		checkIntervalMs: parseInt(process.env.EMAIL_CHECK_INTERVAL_MS ?? "30000", 10),
	};
}
