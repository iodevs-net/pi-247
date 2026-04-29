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

export function loadConfig(): GatewayConfig {
	const tgToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
	if (!tgToken) {
		console.error("FATAL: TELEGRAM_BOT_TOKEN env var required");
		process.exit(1);
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
