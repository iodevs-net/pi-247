import { asRecord } from "@oh-my-pi/pi-utils";
import type { Model, Tool } from "../types";
import { compactGrammarDefinition } from "./grammar";
import { supportsFreeformApplyPatchCodex } from "./openai-codex-responses";
import { adaptSchemaForStrict, NO_STRICT } from "../utils/schema";

const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;

type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

/** @internal Exported for tests. */
export function convertTools(tools: Tool[], model: Model<"openai-codex-responses">): CodexToolPayload[] {
	const allowFreeform = supportsFreeformApplyPatchCodex(model);
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = tool.parameters as unknown as Record<string, unknown>;
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		};
	});
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code?: string;

	constructor(message: string, retryable: boolean, code?: string) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
	}
}

function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	return !!message && CODEX_RETRYABLE_EVENT_MESSAGE.test(message);
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	const status = getString(response?.status) ?? getString(rawEvent.status);

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		return `Codex response failed: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		return `Codex error event: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex error event";
	}
}

export function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const code = getString(rawEvent.code) ?? "";
	const message = getString(rawEvent.message) ?? "";
	const formattedMessage =
		typeof rawEvent.type === "string" && rawEvent.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, isRetryableCodexFailureEvent(rawEvent), code || undefined);
}

export function isRetryableCodexProviderError(error: unknown): boolean {
	return error instanceof CodexProviderStreamError && error.retryable;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…[truncated ${text.length - limit}]`;
}
