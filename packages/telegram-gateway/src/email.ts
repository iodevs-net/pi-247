import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AgentClient } from "./agent-client";
import type { EmailConfig } from "./config";
import { withRetry } from "./retry";
import { debug, log, error as logError } from "./debug";

/**
 * Email adapter. Listens for new emails via IMAP polling,
 * relays to pi-247 agent, sends responses via SMTP.
 */
export class EmailListener {
	private config: EmailConfig;
	private agent: AgentClient;
	private imap: ImapFlow;
	private transporter: nodemailer.Transporter;
	private interval: ReturnType<typeof setInterval> | null = null;
	private seenUids: Set<number> = new Set();
	private stopped = false;
	private imapConnected = false;

	constructor(config: EmailConfig, agent: AgentClient) {
		this.config = config;
		this.agent = agent;

		this.imap = new ImapFlow({
			host: config.imapHost,
			port: config.imapPort,
			secure: config.imapSecure,
			auth: { user: config.imapUser, pass: config.imapPass },
			logger: false,
		});

		this.transporter = nodemailer.createTransport({
			host: config.smtpHost,
			port: config.smtpPort,
			secure: config.smtpSecure,
			auth: { user: config.smtpUser, pass: config.smtpPass },
		});
	}

	async start(): Promise<void> {
		log("email", "connecting IMAP %s:%d", this.config.imapHost, this.config.imapPort);
		await this.connectImap();
		log("email", "IMAP connected");

		debug("email", "syncing seen UIDs");
		await this.syncSeenUids();

		const interval = this.config.checkIntervalMs;
		log("email", "polling every %dms", interval);
		this.interval = setInterval(() => this.checkMail(), interval);
	}

	private async connectImap(): Promise<void> {
		await withRetry(() => this.imap.connect(), {
			maxAttempts: 5,
			baseMs: 2000,
		});
		this.imapConnected = true;
		this.imap.on("close", () => { this.imapConnected = false; });
	}

	private async ensureImapConnected(): Promise<void> {
		if (this.imapConnected && this.imap.usable) return;
		debug("email", "IMAP not connected, reconnecting");
		this.imap = new ImapFlow({
			host: this.config.imapHost,
			port: this.config.imapPort,
			secure: this.config.imapSecure,
			auth: { user: this.config.imapUser, pass: this.config.imapPass },
			logger: false,
		});
		await this.connectImap();
	}

	private async syncSeenUids(): Promise<void> {
		try {
			const lock = await this.imap.getMailboxLock("INBOX");
			try {
				const msgs: Set<number> = new Set();
				for await (const msg of this.imap.fetch("1:*", { uid: true })) {
					msgs.add(msg.uid);
				}
				this.seenUids = msgs;
				debug("email", "synced %d seen UIDs", msgs.size);
			} finally {
				lock.release();
			}
		} catch (err) {
			logError("email", "sync error", err);
		}
	}

	private async checkMail(): Promise<void> {
		if (this.stopped) return;
		try {
			await this.ensureImapConnected();

			const lock = await this.imap.getMailboxLock("INBOX");
			try {
				const status = await this.imap.status("INBOX", { unseen: true });
				if (!status.unseen) return;

				for await (const msg of this.imap.fetch("1:*", { uid: true, envelope: true, source: true })) {
					if (this.seenUids.has(msg.uid)) continue;
					this.seenUids.add(msg.uid);

					const from = msg.envelope?.from?.[0];
					if (!from) continue;

					const senderAddr = `${from.address ?? ""}`.toLowerCase();
					if (!this.isAllowedSender(senderAddr)) {
						debug("email", "blocked sender: %s", senderAddr);
						continue;
					}

					const subject = msg.envelope?.subject ?? "(no subject)";
					const body = await this.extractText(msg);
					if (!body?.trim()) continue;
					if (body.length > 50000) {
						debug("email", "body truncated from %d to 50000 chars", body.length);
					}

					const promptText = `[Email from ${senderAddr}]\nSubject: ${subject}\n\n${body}`;
					log("email", "processing from %s: %s", senderAddr, subject);

					const result = await this.agent.prompt(promptText);
					const reply = result.text.trim() || "(no response)";
					debug("email", "response len=%d partial=%s", reply.length, result.partial);

					await withRetry(() =>
						this.transporter.sendMail({
							from: this.config.smtpUser,
							to: from.address,
							subject: `Re: ${subject}`,
							text: reply,
						}),
						{ maxAttempts: 3, baseMs: 1000 },
					);
					log("email", "replied to %s", senderAddr);
				}
			} finally {
				lock.release();
			}
		} catch (err) {
			logError("email", "check error", err);
		}
	}

	private extractText(msg: any): Promise<string> {
		return Promise.resolve(typeof msg.text === "string" ? msg.text : JSON.stringify(msg.text));
	}

	private isAllowedSender(address: string): boolean {
		if (this.config.allowedDomains.includes("*")) return true;
		const domain = address.split("@").pop() ?? "";
		return this.config.allowedDomains.some(d => domain.endsWith(d));
	}

	async stop(): Promise<void> {
		this.stopped = true;
		log("email", "stopping");
		if (this.interval) clearInterval(this.interval);
		try { await this.imap.logout(); } catch { /* ignore */ }
		this.transporter.close();
	}
}
