import type { OAuthCredentials } from "./utils/oauth/types";

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Serialized representation of AuthStorage for passing to subagent workers.
 * Contains only the essential credential data, not runtime state.
 */
export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

/**
 * Auth credential with database row ID for updates/deletes.
 * Wraps AuthCredential with storage metadata.
 */
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}
