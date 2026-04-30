import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, TextContent, Usage } from "@oh-my-pi/pi-ai";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import type { ResolvedSessionMatch, SessionInfo } from "./types";

// =============================================================================
// Session listing & discovery
// =============================================================================

class RecentSessionInfo {
	#fullName: string | undefined;
	#name: string | undefined;
	#timeAgo: string | undefined;

	constructor(
		readonly path: string,
		readonly mtime: number,
		header: Record<string, unknown>,
		firstPrompt?: string,
	) {
		// Extract title from session header, falling back to first user prompt, then id
		const trystr = (v: unknown) => (typeof v === "string" ? v : undefined);
		this.#fullName =
			sanitizeSessionName(trystr(header.title)) ??
			sanitizeSessionName(firstPrompt) ??
			sanitizeSessionName(trystr(header.id));
	}

	/** Full session name from header, or filename without extension as fallback */
	get fullName(): string {
		if (this.#fullName) return this.#fullName;
		this.#fullName = this.path.split("/").pop()?.replace(".jsonl", "") ?? "Unknown";
		return this.#fullName;
	}

	/** Truncated name for display (max 40 chars) */
	get name(): string {
		if (this.#name) return this.#name;
		const fullName = this.fullName;
		this.#name = fullName.length <= 40 ? fullName : `${fullName.slice(0, 39)}…`;
		return this.#name;
	}

	/** Human-readable relative time (e.g., "2 hours ago") */
	get timeAgo(): string {
		if (this.#timeAgo) return this.#timeAgo;
		this.#timeAgo = formatTimeAgo(new Date(this.mtime));
		return this.#timeAgo;
	}
}

function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts the text content from a user message entry.
 * Returns undefined if the entry is not a user message or has no text.
 */
function extractFirstUserPrompt(entries: Array<Record<string, unknown>>): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && "text" in block) {
					const text = (block as { text: unknown }).text;
					if (typeof text === "string") return text;
				}
			}
		}
	}
	return undefined;
}

/** Format a time difference as a human-readable string */
function formatTimeAgo(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

/**
 * Reads all session files from the directory and returns them sorted by mtime (newest first).
 * Uses low-level file I/O to efficiently read only the first 4KB of each file
 * to extract the JSON header and first user message without loading entire session logs into memory.
 */
async function getSortedSessions(sessionDir: string, storage: SessionStorage): Promise<RecentSessionInfo[]> {
	try {
		const files: string[] = storage.listFilesSync(sessionDir, "*.jsonl");
		const sessions: RecentSessionInfo[] = [];
		await Promise.all(
			files.map(async (path: string) => {
				try {
					const content = await storage.readTextPrefix(path, 4096);
					const entries = parseJsonlLenient<Record<string, unknown>>(content);
					if (entries.length === 0) return;
					const header = entries[0] as Record<string, unknown>;
					if (header.type !== "session" || typeof header.id !== "string") return;
					const mtime = storage.statSync(path).mtimeMs;
					const firstPrompt = header.title ? undefined : extractFirstUserPrompt(entries);
					sessions.push(new RecentSessionInfo(path, mtime, header, firstPrompt));
				} catch {}
			}),
		);
		return sessions.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

/** Exported for testing */
export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await getSortedSessions(sessionDir, storage);
	return sessions[0]?.path || null;
}

/** Get recent sessions for display in welcome screen */
export async function getRecentSessions(
	sessionDir: string,
	limit = 3,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	const sessions = await getSortedSessions(sessionDir, storage);
	return sessions.slice(0, limit);
}

function getTaskToolUsage(details: unknown): Usage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const usage = record.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as Usage;
}

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

const SESSION_LIST_PREFIX_BYTES = 4096;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;
const sessionListPrefixDecoder = new TextDecoder("utf-8", { fatal: false });

async function readSessionListPrefix(file: string, storage: SessionStorage, buffer: Buffer): Promise<string> {
	if (!(storage instanceof FileSessionStorage)) {
		return storage.readTextPrefix(file, buffer.byteLength);
	}

	const handle = await fs.promises.open(file, "r");
	try {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		return sessionListPrefixDecoder.decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) {
			return decodeJsonStringFragment(source.slice(valueStart, i));
		}
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const typeIndex = content.indexOf('"type"', index);
		if (typeIndex === -1) break;
		const colonIndex = content.indexOf(":", typeIndex + 6);
		if (colonIndex === -1) break;
		const type = extractStringProperty(content, "type", typeIndex);
		if (type === "message") count++;
		index = colonIndex + 1;
	}
	return count;
}

function extractFirstUserMessageFromPrefix(content: string): string | undefined {
	const roleIndex = content.indexOf('"role"');
	if (roleIndex === -1) return undefined;

	let index = roleIndex;
	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		if (role === "user") {
			return extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		}
		index = content.indexOf('"role"', index + 6);
	}

	return undefined;
}

interface SessionListHeader {
	type: "session";
	id: string;
	cwd?: string;
	title?: string;
	parentSession?: string;
	timestamp?: string;
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const parsedHeader = entries[0];
	if (parsedHeader?.type === "session" && typeof parsedHeader.id === "string") {
		return {
			type: "session",
			id: parsedHeader.id,
			cwd: typeof parsedHeader.cwd === "string" ? parsedHeader.cwd : undefined,
			title: typeof parsedHeader.title === "string" ? parsedHeader.title : undefined,
			parentSession: typeof parsedHeader.parentSession === "string" ? parsedHeader.parentSession : undefined,
			timestamp: typeof parsedHeader.timestamp === "string" ? parsedHeader.timestamp : undefined,
		};
	}

	const firstLineEnd = content.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
	if (extractStringProperty(firstLine, "type") !== "session") return undefined;

	const id = extractStringProperty(firstLine, "id");
	if (!id) return undefined;

	return {
		type: "session",
		id,
		cwd: extractStringProperty(firstLine, "cwd"),
		title: extractStringProperty(firstLine, "title"),
		parentSession: extractStringProperty(firstLine, "parentSession"),
		timestamp: extractStringProperty(firstLine, "timestamp"),
	};
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

async function collectSessionFromFile(
	file: string,
	storage: SessionStorage,
	buffer: Buffer,
): Promise<SessionInfo | undefined> {
	try {
		const content = await readSessionListPrefix(file, storage, buffer);
		const entries = parseJsonlLenient<Record<string, unknown>>(content);
		const header = parseSessionListHeader(content, entries);
		if (!header) return undefined;

		let parsedMessageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let shortSummary: string | undefined;

		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as { type?: string; message?: Message; shortSummary?: string };

			if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
				shortSummary = entry.shortSummary;
			}

			if (entry.type === "message" && entry.message) {
				parsedMessageCount++;

				if (entry.message.role === "user" || entry.message.role === "assistant") {
					const textContent = extractTextFromContent(entry.message.content);

					if (textContent) {
						allMessages.push(textContent);

						if (!firstMessage && entry.message.role === "user") {
							firstMessage = textContent;
						}
					}
				}
			}
		}

		firstMessage ||= extractFirstUserMessageFromPrefix(content) ?? "";
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
		const stats = storage.statSync(file);
		return {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: stats.mtime,
			messageCount,
			size: stats.size,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.length > 0 ? allMessages.join(" ") : firstMessage,
		};
	} catch {
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: string[],
	storage: SessionStorage,
	startIndex: number,
	stride: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const buffer = Buffer.allocUnsafe(SESSION_LIST_PREFIX_BYTES);

	for (let i = startIndex; i < files.length; i += stride) {
		const session = await collectSessionFromFile(files[i], storage, buffer);
		if (session) sessions.push(session);
	}

	return sessions;
}

export async function collectSessionsFromFiles(files: string[], storage: SessionStorage): Promise<SessionInfo[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount),
						),
					)
				).flat();

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

function sessionMatchesResumeArg(session: SessionInfo, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	const normalizedId = session.id.toLowerCase();
	if (normalizedId.startsWith(normalizedArg)) {
		return true;
	}

	const fileName = path.basename(session.path, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) {
		return true;
	}

	const separator = fileName.lastIndexOf("_");
	if (separator < 0) {
		return false;
	}

	const fileSessionId = fileName.slice(separator + 1);
	return fileSessionId.startsWith(normalizedArg);
}

export async function resolveResumableSession(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<ResolvedSessionMatch | undefined> {
	const { SessionManager } = await import("./session-manager");
	const localSessionDir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
	const localSessions = await SessionManager.list(cwd, localSessionDir, storage);
	const localMatch = localSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (localMatch) {
		return { session: localMatch, scope: "local" };
	}

	if (sessionDir) {
		return undefined;
	}

	const globalSessions = await SessionManager.listAll(storage);
	const globalMatch = globalSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (!globalMatch) {
		return undefined;
	}

	return { session: globalMatch, scope: "global" };
}
