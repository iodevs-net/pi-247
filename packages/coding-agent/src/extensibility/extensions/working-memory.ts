import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "./types";

/**
 * Working Memory Extension
 *
 * Provides an intra-session scratchpad that persists across turns
 * but is NOT subject to context compaction. The agent writes
 * structured notes (architecture, decisions, explored files, errors)
 * and they are automatically injected before each agent loop.
 *
 * This solves the root cause of context loss: everything currently
 * lives in the conversational context, which gets compacted and
 * loses critical details. Working memory lives outside that boundary.
 *
 * Sections are free-form keys — the agent chooses what to track.
 * Convention suggests: architecture, decisions, explored, constraints, errors
 */

const WORKING_MEMORY_ENTRY = "working_memory";
const LOGBOOK_FILE = ".p247/logbook.md";
const MAX_LOGBOOK_ENTRIES = 5;

interface WorkingMemoryData {
	sections: Record<string, string>;
}

interface LogbookEntry {
	date: string;
	type: string;
	title: string;
}

function emptyData(): WorkingMemoryData {
	return { sections: {} };
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatForInjection(data: WorkingMemoryData, logbookEntries: LogbookEntry[]): string {
	const keys = Object.keys(data.sections);
	const hasSections = keys.length > 0;
	const hasLogbook = logbookEntries.length > 0;
	if (!hasSections && !hasLogbook) return "";

	const parts: string[] = ["<working-memory>"];
	if (hasSections) {
		for (const key of keys.sort()) {
			parts.push(`  <${key}>`, `    ${data.sections[key]}`, `  </${key}>`);
		}
	}
	if (hasLogbook) {
		parts.push("  <logbook-readonly>");
		for (const entry of logbookEntries) {
			const title = entry.title.length > 80 ? entry.title.slice(0, 77) + "..." : entry.title;
			parts.push(`    <entry date="${entry.date}" type="${entry.type.toLowerCase()}">${escapeXml(title)}</entry>`);
		}
		parts.push("  </logbook-readonly>");
	}
	parts.push("</working-memory>");
	return parts.join("\n");
}

function findLatestMemory(ctx: ExtensionContext): WorkingMemoryData {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			"customType" in entry &&
			entry.customType === WORKING_MEMORY_ENTRY &&
			entry.data &&
			typeof entry.data === "object"
		) {
			const data = entry.data as WorkingMemoryData;
			if (data.sections && typeof data.sections === "object") {
				return data;
			}
		}
	}
	return emptyData();
}

function parseLogbookEntries(content: string): LogbookEntry[] {
	const entries: LogbookEntry[] = [];
	const dayRegex = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
	const dayPositions: { date: string; start: number; end: number }[] = [];

	let dayMatch: RegExpExecArray | null;
	while ((dayMatch = dayRegex.exec(content)) !== null) {
		const start = dayMatch.index;
		const date = dayMatch[1];
		if (dayPositions.length > 0) {
			dayPositions[dayPositions.length - 1].end = start;
		}
		dayPositions.push({ date, start, end: content.length });
	}

	for (const day of dayPositions) {
		if (entries.length >= MAX_LOGBOOK_ENTRIES) break;
		const section = content.slice(day.start, day.end);
		const entryRegex = /^###\s+(Fixed|Changed|Ongoing|Decided|Added|Removed):\s+(.+)$/gm;
		let entryMatch: RegExpExecArray | null;
		while ((entryMatch = entryRegex.exec(section)) !== null) {
			if (entries.length >= MAX_LOGBOOK_ENTRIES) break;
			entries.push({
				date: day.date,
				type: entryMatch[1],
				title: entryMatch[2].trim(),
			});
		}
	}

	return entries;
}

async function readRecentLogbookEntries(cwd: string): Promise<LogbookEntry[]> {
	const filePath = path.join(cwd, LOGBOOK_FILE);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return parseLogbookEntries(content);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

export default function (pi: ExtensionAPI) {
	// Current in-memory state — hydrated from session on first use
	let current: WorkingMemoryData | undefined;

	const getMemory = (ctx: ExtensionContext): WorkingMemoryData => {
		if (!current) {
			current = findLatestMemory(ctx);
		}
		return current;
	};

	const persist = () => {
		if (!current) return;
		pi.appendEntry(WORKING_MEMORY_ENTRY, { sections: current.sections });
	};

	// --- Tool: scratch ---
	pi.registerTool({
		name: "scratch",
		label: "Working Memory",
		description:
			"Read/write intra-session working memory. " +
			"Persists across turns, NOT subject to compaction. " +
			"Use to track: architecture decisions, explored files, constraints, errors resolved, current state. " +
			"Suggested sections: architecture, decisions, explored, constraints, errors, state. " +
			"You MAY invent custom sections. " +
			"Set action='set' with section+content to write. Set action='clear' to wipe all.",
		parameters: pi.typebox.Object({
			action: pi.typebox.Union(
				[
					pi.typebox.Literal("set", { description: "Set or update a section" }),
					pi.typebox.Literal("clear", { description: "Clear all sections" }),
				],
				{ description: "Operation to perform" },
			),
			section: pi.typebox.Optional(
				pi.typebox.String({
					description:
						"Section key (required for 'set'). Suggested: architecture, decisions, explored, constraints, errors, state",
				}),
			),
			content: pi.typebox.Optional(
				pi.typebox.String({
					description: "Section content (required for 'set'). Use empty string to delete section.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mem = getMemory(ctx);

			if (params.action === "clear") {
				current = emptyData();
				persist();
				return {
					content: [{ type: "text" as const, text: "Working memory cleared." }],
					details: {},
				};
			}

			if (params.action === "set") {
				if (!params.section) {
					return {
						content: [{ type: "text" as const, text: "Error: 'section' required for 'set' action." }],
						details: {},
						isError: true,
					};
				}

				if (params.content && params.content.trim().length > 0) {
					mem.sections[params.section] = params.content;
				} else {
					delete mem.sections[params.section];
				}
				current = mem;
				persist();

				const sectionCount = Object.keys(mem.sections).length;
				return {
					content: [
						{
							type: "text" as const,
							text: `Section '${params.section}' updated. ${sectionCount} section(s) active.`,
						},
					],
					details: { sections: Object.keys(mem.sections) },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	});

	// --- Inject working memory before each agent loop ---
	pi.on("before_agent_start", async (_event, ctx) => {
		// Hydrate from session on first call
		if (!current) {
			current = findLatestMemory(ctx);
		}

		// Read recent logbook entries from disk
		let logbookEntries: LogbookEntry[] = [];
		try {
			logbookEntries = await readRecentLogbookEntries(ctx.cwd);
		} catch (err) {
			pi.logger.warn("Working memory: failed to read logbook for injection", {
				error: String(err),
			});
		}

		// Format with current sections + logbook entries
		const injection = formatForInjection(
			current ?? emptyData(),
			logbookEntries,
		);
		if (!injection) return;

		return {
			message: {
				customType: "working_memory_context",
				content: [{ type: "text" as const, text: injection }],
				display: false,
			},
		};
	});

	// --- Reset on new agent start ---
	pi.on("agent_start", () => {
		// Keep memory across agent loops within the same session
		// (agent_start fires per prompt, not per session)
		// Only reset if explicitly needed — the tool manages its own state
	});
}
