// Barrel — re-exports internal session modules consumed within the package.
// Main package exports are in packages/coding-agent/src/index.ts.

export { CURRENT_SESSION_VERSION } from "./types";
export type {
	SessionHeader,
	NewSessionOptions,
	SessionEntryBase,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
	ModelChangeEntry,
	ServiceTierChangeEntry,
	CompactionEntry,
	BranchSummaryEntry,
	CustomEntry,
	LabelEntry,
	TtsrInjectionEntry,
	MCPToolSelectionEntry,
	SessionInitEntry,
	ModeChangeEntry,
	CustomMessageEntry,
	SessionEntry,
	FileEntry,
	SessionTreeNode,
	SessionContext,
	SessionInfo,
	UsageStatistics,
	ResolvedSessionMatch,
	AgentSessionEvent,
	AgentSessionEventListener,
	AsyncJobSnapshot,
	AsyncJobSnapshotItem,
	PromptOptions,
	ModelCycleResult,
	RoleModelCycleResult,
	SessionStats,
	HandoffResult,
} from "./types";

export {
	createSessionId,
	generateId,
	migrateToCurrentVersion,
	migrateSessionEntries,
} from "./session-migrations";

export { buildSessionContext } from "./session-context-builder";

export {
	findMostRecentSession,
	getRecentSessions,
	collectSessionsFromFiles,
	resolveResumableSession,
} from "./session-discovery";

export { parseSessionEntries, loadEntriesFromFile, SessionManager } from "./session-manager";
export type { ReadonlySessionManager } from "./session-manager";
