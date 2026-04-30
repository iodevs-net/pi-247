import { create } from "@bufbuild/protobuf";
import type { ToolResultMessage } from "../types";
import {
	DeleteErrorSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
	ReadErrorSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	ShellFailureSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	ShellSuccessSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteSuccessSchema,
} from "./cursor/gen/agent_pb";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function toolResultWasTruncated(toolResult: ToolResultMessage): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const truncation = (toolResult.details as { truncation?: { truncated?: boolean } }).truncation;
	return !!truncation?.truncated;
}

function toolResultDetailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const value = (toolResult.details as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : false;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function buildReadResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildReadErrorResult(path, text || "Read failed");
	}
	const totalLines = text ? text.split("\n").length : 0;
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(Buffer.byteLength(text, "utf-8")),
				truncated: toolResultWasTruncated(toolResult),
				output: { case: "content", value: text },
			}),
		},
	});
}

export function buildReadErrorResult(path: string, error: string) {
	return create(ReadResultSchema, {
		result: {
			case: "error",
			value: create(ReadErrorSchema, { path, error }),
		},
	});
}

export function buildReadRejectedResult(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: {
			case: "rejected",
			value: create(ReadRejectedSchema, { path, reason }),
		},
	});
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function buildWriteResultFromToolResult(
	args: { path: string; fileText?: string; fileBytes?: Uint8Array; returnFileContentAfterWrite?: boolean },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildWriteErrorResult(args.path, text || "Write failed");
	}
	const fileText = args.fileText ?? "";
	const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
	const linesCreated = fileText ? fileText.split("\n").length : 0;
	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: args.path,
				linesCreated,
				fileSize,
				fileContentAfterWrite: args.returnFileContentAfterWrite ? fileText : undefined,
			}),
		},
	});
}

export function buildWriteErrorResult(path: string, error: string) {
	return create(WriteResultSchema, {
		result: {
			case: "error",
			value: create(WriteErrorSchema, { path, error }),
		},
	});
}

export function buildWriteRejectedResult(path: string, reason: string) {
	return create(WriteResultSchema, {
		result: {
			case: "rejected",
			value: create(WriteRejectedSchema, { path, reason }),
		},
	});
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function buildDeleteResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDeleteErrorResult(path, text || "Delete failed");
	}
	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path,
				deletedFile: path,
				fileSize: BigInt(0),
				prevContent: "",
			}),
		},
	});
}

export function buildDeleteErrorResult(path: string, error: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "error",
			value: create(DeleteErrorSchema, { path, error }),
		},
	});
}

export function buildDeleteRejectedResult(path: string, reason: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "rejected",
			value: create(DeleteRejectedSchema, { path, reason }),
		},
	});
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function buildShellResultFromToolResult(
	args: { command: string; workingDirectory: string },
	toolResult: ToolResultMessage,
) {
	const output = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildShellFailureResult(args.command, args.workingDirectory, output || "Shell failed");
	}
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command: args.command,
				workingDirectory: args.workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: output,
				stderr: "",
				executionTime: 0,
			}),
		},
	});
}

export function buildShellFailureResult(command: string, workingDirectory: string, error: string) {
	return create(ShellResultSchema, {
		result: {
			case: "failure",
			value: create(ShellFailureSchema, {
				command,
				workingDirectory,
				exitCode: 1,
				signal: "",
				stdout: "",
				stderr: error,
				executionTime: 0,
				aborted: false,
			}),
		},
	});
}

export function buildShellRejectedResult(command: string, workingDirectory: string, reason: string) {
	return create(ShellResultSchema, {
		result: {
			case: "rejected",
			value: create(ShellRejectedSchema, {
				command,
				workingDirectory,
				reason,
				isReadonly: false,
			}),
		},
	});
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export function buildGrepResultFromToolResult(
	args: { pattern: string; path?: string; outputMode?: string },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildGrepErrorResult(text || "Grep failed");
	}

	const outputMode = args.outputMode || "content";
	const clientTruncated = toolResultDetailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	const workspaceKey = args.path || ".";
	let unionResult: GrepUnionResult;

	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts = lines
			.map(line => {
				const separatorIndex = line.lastIndexOf(":");
				if (separatorIndex === -1) {
					return null;
				}
				const file = line.slice(0, separatorIndex);
				const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
				if (!file || Number.isNaN(count)) {
					return null;
				}
				return create(GrepFileCountSchema, { file, count });
			})
			.filter((entry): entry is GrepFileCount => entry !== null);
		const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	} else {
		const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;

		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) {
				continue;
			}
			const [, file, lineNumber, content] = match;
			const isContextLine = Boolean(contextLine);
			const list = matchMap.get(file) ?? [];
			list.push({ line: Number(lineNumber), content, isContextLine });
			matchMap.set(file, list);
			if (!isContextLine) {
				totalMatchedLines += 1;
			}
		}

		const matches = Array.from(matchMap.entries()).map(([file, matches]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: matches.map(entry =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines,
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
				}),
			},
		});
	}

	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

export function buildGrepErrorResult(error: string) {
	return create(GrepResultSchema, {
		result: {
			case: "error",
			value: create(GrepErrorSchema, { error }),
		},
	});
}
