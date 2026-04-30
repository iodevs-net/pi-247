import { hasVerificationEvidence } from "../../utils/evidence";
import { detectToolLoop, stableStringify, type ToolCallEntry } from "../../utils/loop-detection";
import type { ExtensionAPI, ExtensionContext } from "./types";

// -- Low-level helpers -----------------------------------------------------------

function extractText(message: {
	role?: string;
	content?: Array<{ type: string; text?: string }>;
}): string {
	return message.content
		?.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("") ?? "";
}

function extractFilePath(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const typedArgs = args as Record<string, unknown>;
	switch (toolName) {
		case "edit":
		case "write":
		case "ast_edit":
			return typedArgs.path as string;
		default:
			return undefined;
	}
}

function getVerificationSuggestion(): string {
	return "bun test || bun check || npm test || yarn test";
}

const COMPLETION_CLAIM = /\b(done|completed|finished|fixed|solved|resolved)\b/i;
const COMPLETION_PHRASE = /\b(all\s+done|task\s+complete|is\s+(?:now\s+)?(?:fixed|working|complete))\b/i;
const COMPLETION_ES = /\b(verificad[ao]s?|listo|terminado|resuelto)\b/i;

function hasCompletionClaim(text: string): boolean {
	return COMPLETION_CLAIM.test(text) || COMPLETION_PHRASE.test(text) || COMPLETION_ES.test(text);
}

// -- Exported subsystems ---------------------------------------------------------

export interface MutationTracker {
	loopHistory: ToolCallEntry[];
	mutatedFiles: Set<string>;
}

/**
 * Track tool calls and file mutations from tool_execution_start events.
 */
export function createMutationTracker(pi: ExtensionAPI): MutationTracker {
	const loopHistory: ToolCallEntry[] = [];
	const mutatedFiles = new Set<string>();
	const MUTATING_TOOLS = new Set(["edit", "write", "ast_edit"]);

	pi.on("tool_execution_start", async event => {
		const args = event.args ?? {};
		const key = typeof args === "string" ? args : typeof args === "object" && args ? stableStringify(args) : String(args);
		loopHistory.push({ tool: event.toolName, key });

		if (MUTATING_TOOLS.has(event.toolName)) {
			const filePath = extractFilePath(event.toolName, args);
			if (filePath) mutatedFiles.add(filePath);
			pi.logger.debug("Verification: Tracking mutation of %s", filePath ?? event.toolName);
		}
	});

	return { loopHistory, mutatedFiles };
}

/**
 * Detect tool-call repetition and send escalating system interventions.
 * Returns true if intervention was sent (caller should skip further processing).
 */
export function createAntiLoopGuard(pi: ExtensionAPI, loopHistory: ToolCallEntry[]) {
	let loopCount = 0;
	const MAX_INTERVENTIONS = 4;

	return function checkLoop(assistantText: string): boolean {
		const detection = detectToolLoop(loopHistory);
		if (!detection.isLoop || loopCount >= MAX_INTERVENTIONS) return false;

		if (/ESCALANDO/i.test(assistantText)) {
			pi.logger.debug("Anti-Loop: Agent escalated, not intervening.");
			return false;
		}

		loopCount++;
		const strategies = [
			"[SISTEMA: Estas repitiendo la misma herramienta. Cambia de estrategia IMMEDIATAMENTE. Prueba otro enfoque completamente diferente.]",
			"[SISTEMA: Sigue en loop. Es tu ULTIMA oportunidad de auto-correccion. Si no puedes resolverlo, di ESCALANDO y explica el problema.]",
		];
		pi.sendMessage(
			{
				customType: "system_intervention",
				content: [{ type: "text", text: strategies[Math.min(loopCount - 1, strategies.length - 1)] }],
				display: "none",
			},
			{ triggerTurn: true },
		);
		return true;
	};
}

/**
 * Verify that code changes include real evidence (test output, diff, build).
 * Returns true if intervention was sent.
 */
export function createVerificationGate(pi: ExtensionAPI, mutatedFiles: Set<string>) {
	return function checkVerification(assistantText: string): boolean {
		if (mutatedFiles.size === 0) return false;

		// Real evidence — clear and pass
		if (hasVerificationEvidence(assistantText)) {
			mutatedFiles.clear();
			pi.logger.debug("Verification Gate: Evidence detected. Clearing mutation tracking.");
			return false;
		}

		// VERIFICADO declared but no evidence
		if (/\bVERIFICADO\b/.test(assistantText)) {
			pi.sendMessage(
				{
					customType: "system_intervention",
					content: [
						{
							type: "text",
							text: "[SISTEMA: Declaraste VERIFICADO pero no hay evidencia de verificacion (output de test/diff/build). Ejecuta el comando correspondiente y muestra el output REAL.]",
						},
					],
					display: "none",
				},
				{ triggerTurn: true },
			);
			return true;
		}

		// Honest NO_VERIFICADO — pass without clearing
		if (/\bNO_VERIFICADO\b/.test(assistantText)) {
			pi.logger.debug("Verification Gate: NO_VERIFICADO declared. Mutations remain tracked.");
			return false;
		}

		// Completion claim after mutation — catch incomplete verification
		if (hasCompletionClaim(assistantText)) {
			pi.sendMessage(
				{
					customType: "system_intervention",
					content: [
						{
							type: "text",
							text: `[SISTEMA: Modificaste ${mutatedFiles.size} archivo(s) y declaraste completado sin verificacion real. Ejecuta ${getVerificationSuggestion()} y muestra el output REAL, o declara NO_VERIFICADO si no verificaste.]`,
						},
					],
					display: "none",
				},
				{ triggerTurn: true },
			);
			return true;
		}

		// Still working — no intervention
		pi.logger.debug("Verification: Mutations pending verification. Files: %o", Array.from(mutatedFiles));
		return false;
	};
}

// -- Extension orchestrator ------------------------------------------------------

/**
 * Reliability Extension
 *
 * Core safety protocols for p247:
 * 1. Verification Gate — evidence check after code mutations.
 * 2. Anti-Loop Protocol — detect and break tool-call cycles.
 */
export default function (pi: ExtensionAPI) {
	const { loopHistory, mutatedFiles } = createMutationTracker(pi);
	const checkLoop = createAntiLoopGuard(pi, loopHistory);
	const checkVerification = createVerificationGate(pi, mutatedFiles);

	pi.on("turn_end", async (event, _ctx: ExtensionContext) => {
		const { message } = event;
		if (message.role !== "assistant") return;

		const assistantText = extractText(message);
		if (checkLoop(assistantText)) return;
		checkVerification(assistantText);
	});

	pi.on("agent_start", () => {
		loopHistory.length = 0;
		mutatedFiles.clear();
	});
}
