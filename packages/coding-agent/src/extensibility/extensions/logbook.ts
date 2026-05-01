import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "./types";

/**
 * Logbook Extension — cross-session persistent memory.
 *
 * Stores structured markdown entries in .p247/logbook.md that survive
 * session restarts, compaction, and process termination.
 *
 * Complementary to working-memory (intra-session scratchpad):
 *   working-memory = what I'm doing right now (resets each session)
 *   logbook       = what the project has learned (permanent)
 */

const LOGBOOK_FILE = ".p247/logbook.md";
const LOCK_DIR = ".p247/.logbook.lock";
const LOGBOOK_TOOL = "logbook";
const MAX_FILE_BYTES = 100_000;
const MAX_ENTRY_BYTES = 5_000;
const MAX_INJECTION_CHARS = 3_000;
const NUDGE_INTERVAL = 10;
const ALLOWED_TYPES = ["Fixed", "Changed", "Ongoing", "Decided", "Added", "Removed"];
const MAX_AUTO_ENTRIES = 5;
const AUTO_PATTERNS: Array<{ re: RegExp; type: string }> = [
	{ re: /(?:arreglé|corregí|solucioné|fixe(?:é|e)|resolví)/i, type: "Fixed" },
	{ re: /(?:root cause|causa raíz|encontré el bug|diagnóstico|la raíz)/i, type: "Fixed" },
	{ re: /(?:decidí|opté por|voy a adoptar|approach será)/i, type: "Decided" },
	{ re: /(?:cambié|cambiamos|refactor(?:icé|ic))(?:\s|$)/i, type: "Changed" },
];

interface LogbookEntry {
	date: string;
	type: string;
	title: string;
	body: string;
}

interface LogbookData {
	entries: LogbookEntry[];
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function logbookPath(cwd: string): string {
	return path.join(cwd, LOGBOOK_FILE);
}

function lockDirPath(cwd: string): string {
	return path.join(cwd, LOCK_DIR);
}

// ─── Advisory lock via mkdir atomicity (POSIX) ──────────────────────────────

async function acquireLock(cwd: string): Promise<() => void> {
	const lockDir = lockDirPath(cwd);
	const deadline = Date.now() + 2_500;
	let attempt = 0;
	while (Date.now() < deadline) {
		try {
			await fs.mkdir(lockDir, { recursive: false });
			return async () => {
				try {
					await fs.rmdir(lockDir);
				} catch {
					/* best-effort cleanup */
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const delay = Math.min(50 * 1.5 ** attempt, 500);
			await new Promise(r => setTimeout(r, delay));
			attempt++;
		}
	}
	throw new Error("Could not acquire logbook lock within timeout");
}

// ─── Parse / render ─────────────────────────────────────────────────────────

function parseLogbook(content: string): LogbookData {
	const entries: LogbookEntry[] = [];
	const dayRegex = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;

	let dayMatch: RegExpExecArray | null;
	const dayPositions: { date: string; start: number; end: number }[] = [];

	while ((dayMatch = dayRegex.exec(content)) !== null) {
		const start = dayMatch.index;
		const date = dayMatch[1];
		// If we already have a day, close its range
		if (dayPositions.length > 0) {
			dayPositions[dayPositions.length - 1].end = start;
		}
		dayPositions.push({ date, start, end: content.length });
	}

	for (const day of dayPositions) {
		const section = content.slice(day.start, day.end);
		let entryMatch: RegExpExecArray | null;
		const entryRegexLocal = /^###\s+(Fixed|Changed|Ongoing|Decided|Added|Removed):\s+(.+)$/gm;
		while ((entryMatch = entryRegexLocal.exec(section)) !== null) {
			const type = entryMatch[1];
			const title = entryMatch[2].trim();
			const bodyStart = entryMatch.index + entryMatch[0].length;
			// Find next entry or end of section
			const nextEntry = section.slice(bodyStart).match(/^###\s+(Fixed|Changed|Ongoing|Decided|Added|Removed):/m);
			const body = nextEntry
				? section.slice(bodyStart, bodyStart + nextEntry.index!).trim()
				: section.slice(bodyStart).trim();
			entries.push({ date: day.date, type, title, body });
		}
	}

	// Sort reverse chronological (newest first)
	entries.sort((a, b) => b.date.localeCompare(a.date) || b.title.localeCompare(a.title));
	return { entries };
}

function renderFile(entries: LogbookEntry[]): string {
	const sorted = [...entries].sort(
		(a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
	);

	const lines: string[] = ["# Logbook", "", "<!-- LOGBOOK_INDEX v1 -->"];
	for (const entry of sorted) {
		const summary = entry.title.length > 80 ? entry.title.slice(0, 77) + "..." : entry.title;
		lines.push(`- ${entry.date}: ${summary}`);
	}
	lines.push("<!-- /LOGBOOK_INDEX -->", "");

	let currentDate = "";
	for (const entry of sorted) {
		if (entry.date !== currentDate) {
			currentDate = entry.date;
			lines.push(`## ${currentDate}`, "");
		}
		lines.push(`### ${entry.type}: ${entry.title}`, "", entry.body, "");
	}

	return lines.join("\n").trimEnd() + "\n";
}

function formatForInjection(data: LogbookData): string {
	const sorted = [...data.entries].sort(
		(a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
	);

	let total = 0;
	const parts: string[] = ["<logbook>"];
	for (const entry of sorted) {
		const line = `  <entry date="${entry.date}" type="${entry.type.toLowerCase()}">${escapeXml(entry.title)}</entry>`;
		if (total + line.length + 7 > MAX_INJECTION_CHARS) break; // +7 for </logbook>\n
		parts.push(line);
		total += line.length;
	}
	if (parts.length === 1) return "";
	parts.push("</logbook>");
	parts.push("<!-- record cross-session notes: logbook append -->");
	return parts.join("\n");
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Read / write helpers ───────────────────────────────────────────────────

async function readLogbook(filePath: string): Promise<LogbookData> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return parseLogbook(content);
	} catch (err) {
		if (isEnoent(err)) return { entries: [] };
		throw err;
	}
}

async function writeLogbookAtomic(filePath: string, entries: LogbookEntry[]): Promise<void> {
	const tmpPath = filePath + ".tmp";
	await fs.writeFile(tmpPath, renderFile(entries), "utf-8");
	await fs.rename(tmpPath, filePath);
}

function truncateEntries(entries: LogbookEntry[]): LogbookEntry[] {
	const sorted = [...entries].sort(
		(a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
	);
	let result = sorted;
	while (result.length > 0) {
		const rendered = renderFile(result);
		if (rendered.length <= MAX_FILE_BYTES) break;
		result = result.slice(0, -1); // drop oldest
	}
	return result;
}

async function ensureP247Dir(cwd: string): Promise<void> {
	const dir = path.join(cwd, ".p247");
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch {
		// race is fine
	}
}

function isValidDate(s: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ─── Auto-recording helpers ────────────────────────────────────────────

async function appendEntry(cwd: string, entry: LogbookEntry): Promise<number> {
	await ensureP247Dir(cwd);
	const filePath = logbookPath(cwd);
	const unlock = await acquireLock(cwd);
	try {
		const data = await readLogbook(filePath);
		data.entries.unshift(entry);
		data.entries = truncateEntries(data.entries);
		await writeLogbookAtomic(filePath, data.entries);
		return data.entries.length;
	} finally {
		unlock();
	}
}

function extractTextContent(
	content: Array<{ type: string; text?: string }> | string | undefined,
): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter(c => c.type === "text" && c.text)
		.map(c => c.text!)
		.join("\n");
}

function extractSurroundingSentence(text: string, index: number): string {
	const start = Math.max(0, text.lastIndexOf(".", index - 1) + 1);
	const end = text.indexOf(".", index);
	return text.slice(start, end >= 0 ? end + 1 : undefined).trim();
}

// ─── Extension factory ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: LOGBOOK_TOOL,
		label: "Logbook",
		description:
			"Read/write persistent per-project logbook (.p247/logbook.md). " +
			"Survives across sessions and compaction. Use to track decisions, " +
			"findings, bug contexts, and refactoring notes that should persist. " +
			"Actions: 'read' returns current logbook, 'append' adds an entry, " +
			"'prune' removes oldest entries.",
		parameters: pi.typebox.Object({
			action: pi.typebox.Union(
				[
					pi.typebox.Literal("read", { description: "Return full logbook content" }),
					pi.typebox.Literal("append", { description: "Add a new entry" }),
					pi.typebox.Literal("prune", { description: "Remove oldest entries to free space" }),
				],
				{ description: "Operation to perform" },
			),
			date: pi.typebox.Optional(
				pi.typebox.String({
					description: "Date in YYYY-MM-DD format (defaults to today for 'append')",
				}),
			),
			type: pi.typebox.Optional(
				pi.typebox.String({
					description: "Entry type (required for 'append'): Fixed, Changed, Ongoing, Decided, Added, Removed",
				}),
			),
			title: pi.typebox.Optional(
				pi.typebox.String({ description: "Brief title (required for 'append')" }),
			),
			body: pi.typebox.Optional(
				pi.typebox.String({ description: "Full entry body (required for 'append')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = logbookPath(ctx.cwd);

			if (params.action === "read") {
				const data = await readLogbook(filePath);
				if (data.entries.length === 0) {
					return {
						content: [{ type: "text" as const, text: "Logbook is empty. Use 'append' to add entries." }],
						details: {},
					};
				}
				return {
					content: [{ type: "text" as const, text: renderFile(data.entries) }],
					details: { entryCount: data.entries.length },
				};
			}

			if (params.action === "append") {
				if (!params.type || !params.title || !params.body) {
					return {
						content: [
							{
								type: "text" as const,
								text: "'type', 'title', and 'body' are required for 'append'.",
							},
						],
						details: {},
						isError: true,
					};
				}
				if (!ALLOWED_TYPES.includes(params.type)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Invalid type '${params.type}'. Must be one of: ${ALLOWED_TYPES.join(", ")}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				if (params.body.length > MAX_ENTRY_BYTES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Body exceeds ${MAX_ENTRY_BYTES} character limit.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const date = params.date && isValidDate(params.date) ? params.date : new Date().toISOString().slice(0, 10);
				const newEntry: LogbookEntry = {
					date,
					type: params.type,
					title: params.title.trim(),
					body: params.body.trim(),
				};

				const entryCount = await appendEntry(ctx.cwd, newEntry);

				return {
					content: [{ type: "text" as const, text: `Entry added. ${entryCount} total entries.` }],
					details: { entryCount },
				};
			}

			if (params.action === "prune") {
				const unlock = await acquireLock(ctx.cwd);
				let before = 0;
				let after = 0;
				try {
					const data = await readLogbook(filePath);
					before = data.entries.length;
					const keepCount = Math.max(5, Math.ceil(data.entries.length / 2));
					const pruned = data.entries.slice(0, keepCount);

					if (pruned.length === 0) {
						try {
							await fs.unlink(filePath);
						} catch {
							/* ok */
						}
					} else {
						await writeLogbookAtomic(filePath, pruned);
					}
					after = pruned.length;
				} finally {
					unlock();
				}

				return {
					content: [{ type: "text" as const, text: `Pruned from ${before} to ${after} entries.` }],
					details: { before, after },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	});

	// ─── Inject logbook summary before each agent loop ────────────────────

	let turnCount = 0;
	let lastNudgeTurn = 0;

	pi.on("before_agent_start", async (_event, ctx) => {
		const filePath = logbookPath(ctx.cwd);
		try {
			const data = await readLogbook(filePath);
			if (data.entries.length === 0) return;

			let injection = formatForInjection(data);
			if (!injection) return;

			turnCount++;
			if (turnCount > 0 && turnCount % NUDGE_INTERVAL === 0) {
				injection +=
					"\n<logbook-nudge>\n" +
					"Consider saving noteworthy findings, decisions, or fixes using\n" +
					"logbook append (type: Fixed|Changed|Ongoing|Decided|Added|Removed).\n" +
					"This preserves context across sessions and compactions.\n" +
					"</logbook-nudge>";
			}

			return {
				message: {
					customType: "logbook_context",
					content: [{ type: "text" as const, text: injection }],
					display: false,
				},
			};
		} catch (err) {
			if (isEnoent(err)) return;
			pi.logger.warn("Logbook: failed to read for injection", { error: String(err) });
			return;
		}
	});

	// ─── Active nudge: next-turn message without triggerTurn ────────

	pi.on("agent_end", () => {
		turnCount++;
		if (turnCount - lastNudgeTurn >= NUDGE_INTERVAL) {
			lastNudgeTurn = turnCount;
			pi.sendMessage(
				{
					customType: "logbook_nudge",
					content: [
						{
							type: "text" as const,
							text:
								"<logbook-nudge>\n" +
								"Save noteworthy findings using logbook append.\n" +
								"Types: Fixed, Changed, Ongoing, Decided, Added, Removed.\n" +
								"One concise entry per session is enough.\n" +
								"</logbook-nudge>",
						},
					],
					display: false,
				},
				// No triggerTurn — nested agent.prompt() leaks events into
				// external subscribers (Telegram gateway). Auto-recording
				// + passive nudge cover persistence without forced turns.
				{ deliverAs: "nextTurn" },
			);
		}
	});

		// ─── Auto-recording: tool errors + decision detection ────────────

		let autoEntryCount = 0;
		let recordedErrorKeys = new Set<string>();

		pi.on("turn_end", async (event, ctx) => {
			if (autoEntryCount >= MAX_AUTO_ENTRIES) return;

			// 1. Auto-record tool errors
			for (const tr of event.toolResults) {
				if (!tr.isError) continue;
				const errorText = extractTextContent(tr.content);
				if (!errorText) continue;
				const errorKey = tr.toolName + ":" + errorText.slice(0, 120);
				if (recordedErrorKeys.has(errorKey)) continue;
				recordedErrorKeys.add(errorKey);

				const firstLine = errorText.split("\n")[0].slice(0, 80);
				await appendEntry(ctx.cwd, {
					date: new Date().toISOString().slice(0, 10),
					type: "Ongoing",
					title: "Error in " + tr.toolName + ": " + firstLine,
					body: errorText.slice(0, 500),
				});
				autoEntryCount++;
				if (autoEntryCount >= MAX_AUTO_ENTRIES) return;
			}

			// 2. Detect decisions/arreglos in assistant text
			// turn_end always carries the assistant's response
			const msg = event.message as { content: AssistantMessage["content"] };
			const text = extractTextContent(msg.content);
			if (!text) return;

			for (const { re, type } of AUTO_PATTERNS) {
				const match = text.match(re);
				if (!match) continue;

				const sentence = extractSurroundingSentence(text, match.index!);
				if (sentence.length < 20) continue;

				const key = "dec:" + sentence.slice(0, 100);
				if (recordedErrorKeys.has(key)) continue;
				recordedErrorKeys.add(key);

				await appendEntry(ctx.cwd, {
					date: new Date().toISOString().slice(0, 10),
					type,
					title: sentence.slice(0, 80),
					body: sentence.slice(0, 500),
				});
				autoEntryCount++;
				if (autoEntryCount >= MAX_AUTO_ENTRIES) return;
			}
		});

}
