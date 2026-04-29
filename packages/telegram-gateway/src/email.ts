import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AgentClient } from "./agent-client";
import type { EmailConfig } from "./config";
import { debug, log, error as logError } from "./debug";

/**
 * Email adapter. Listens for new emails via IMAP IDLE,
 * relays to pi-247 agent, sends responses via SMTP.
 */
export class EmailListener {
	private config: EmailConfig;
	private agent: AgentClient;
	private imap: ImapFlow;
	private transporter: nodemailer.Transporter;
	private interval: ReturnType<typeof setInterval> | null = null;
	private seenUids: Set<number> = new Set();

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
		await this.imap.connect();
		log("email", "IMAP connected");

		// Initial sync of seen UIDs
		debug("email", "syncing seen UIDs");
		await this.syncSeenUids();

		// Poll for new emails
		const interval = this.config.checkIntervalMs;
		log("email", "polling every %dms", interval);
		this.interval = setInterval(() => this.checkMail(), interval);
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
		try {
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

					const promptText = `[Email from ${senderAddr}]\nSubject: ${subject}\n\n${body}`;
					log("email", "processing from %s: %s", senderAddr, subject);

					const result = await this.agent.prompt(promptText);
					const reply = result.text.trim() || "(no response)";
					debug("email", "response len=%d partial=%s", reply.length, result.partial);

					await this.transporter.sendMail({
						from: this.config.smtpUser,
						to: from.address,
						subject: `Re: ${subject}`,
						text: reply,
					});
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
		log("email", "stopping");
		if (this.interval) clearInterval(this.interval);
		await this.imap.logout();
		this.transporter.close();
	}
}
