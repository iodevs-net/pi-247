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

interface WorkingMemoryData {
	sections: Record<string, string>;
}

function emptyData(): WorkingMemoryData {
	return { sections: {} };
}

function formatForInjection(data: WorkingMemoryData): string {
	const keys = Object.keys(data.sections);
	if (keys.length === 0) return "";
	const parts: string[] = ["<working-memory>"];
	for (const key of keys.sort()) {
		parts.push(`  <${key}>`, `    ${data.sections[key]}`, `  </${key}>`);
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
	pi.on("before_agent_start", (_event, ctx) => {
		// Hydrate from session on first call
		if (!current) {
			current = findLatestMemory(ctx);
		}

		if (!current || Object.keys(current.sections).length === 0) return;

		const injection = formatForInjection(current);
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
