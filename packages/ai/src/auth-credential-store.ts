import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { OAuthCredentials } from "./utils/oauth/types";
import type { AuthCredential, OAuthCredential, StoredAuthCredential } from "./auth-types";

// ─────────────────────────────────────────────────────────────────────────────
// AuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape for auth_credentials table queries */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	identity_key: string | null;
};

type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

const AUTH_SCHEMA_VERSION = 4;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		return {
			credentialType: "api_key",
			data: JSON.stringify({ key: credential.key }),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			return { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause.trim();
	return normalized.length > 0 ? normalized : "disabled";
}

function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if ((provider === "openai-codex" || provider === "anthropic") && emailIdentifier) return emailIdentifier;
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier) return accountIdentifier;
	if (emailIdentifier) return emailIdentifier;
	return null;
}

export function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		return existing.type === "api_key" && existing.key === incoming.key;
	}
	const incomingIdentityKey = resolveCredentialIdentityKey(provider, incoming);
	return incomingIdentityKey !== null && incomingIdentityKey === existingIdentityKey;
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email) identifiers.add(`email:${email}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return [...identifiers];
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
		const identifiers = new Set<string>();
		const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
		if (directEmail) identifiers.add(`email:${directEmail}`);
		const openAiProfile = payload["https://api.openai.com/profile"];
		if (typeof openAiProfile === "object" && openAiProfile !== null && !Array.isArray(openAiProfile)) {
			const claimEmail = normalizeStoredEmail(
				(openAiProfile as Record<string, unknown>).email as string | undefined,
			);
			if (claimEmail) identifiers.add(`email:${claimEmail}`);
		}
		const openAiAuth = payload["https://api.openai.com/auth"];
		const authClaims =
			typeof openAiAuth === "object" && openAiAuth !== null && !Array.isArray(openAiAuth)
				? (openAiAuth as Record<string, unknown>)
				: undefined;
		const accountId = normalizeStoredAccountId(
			typeof payload.account_id === "string"
				? payload.account_id
				: typeof payload.accountId === "string"
					? payload.accountId
					: typeof payload.user_id === "string"
						? payload.user_id
						: typeof payload.sub === "string"
							? payload.sub
							: typeof authClaims?.chatgpt_account_id === "string"
								? authClaims.chatgpt_account_id
								: undefined,
		);
		if (accountId) identifiers.add(`account:${accountId}`);
		return identifiers.size > 0 ? [...identifiers] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Standalone SQLite-backed implementation of AuthCredentialStore interface.
 * Used by the pi-ai CLI and as the default store for AuthStorage.create().
 * Also has convenience methods for simple CRUD (saveOAuth, getOAuth, etc.).
 */
export class AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();

		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
		this.#updateStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteByProviderStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
		);
		this.#hardDeleteStmt = this.#db.prepare("DELETE FROM auth_credentials WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#upsertCacheStmt = this.#db.prepare(
			"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
		);
		this.#deleteExpiredCacheStmt = this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<AuthCredentialStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		const db = new Database(dbPath);
		try {
			await fs.chmod(dbPath, 0o600);
		} catch {
			// Ignore chmod failures (e.g., Windows)
		}

		return new AuthCredentialStore(db);
	}

	#initializeSchema(): void {
		this.#db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
		`);

		if (!this.#authCredentialsTableExists()) {
			this.#createAuthCredentialsTable();
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
			return;
		}

		const schemaVersion = this.#readAuthSchemaVersion() ?? this.#inferAuthSchemaVersion();
		const shouldWriteSchemaVersion = schemaVersion <= AUTH_SCHEMA_VERSION;
		if (schemaVersion > AUTH_SCHEMA_VERSION) {
			logger.warn("AuthCredentialStore schema version mismatch", {
				current: schemaVersion,
				expected: AUTH_SCHEMA_VERSION,
			});
		} else if (schemaVersion < AUTH_SCHEMA_VERSION) {
			this.#migrateAuthSchema(schemaVersion);
		}

		this.#createAuthCredentialIndexes();
		this.#backfillCredentialIdentityKeys();
		if (shouldWriteSchemaVersion) {
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
		}
	}

	#authCredentialsTableExists(): boolean {
		const row = this.#db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'")
			.get() as { present?: number } | undefined;
		return row?.present === 1;
	}

	#readAuthSchemaVersion(): number | null {
		const row = this.#db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	}

	#writeAuthSchemaVersion(version: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO auth_schema_version(id, version) VALUES (1, ?)").run(version);
	}

	#inferAuthSchemaVersion(): number {
		const cols = this.#db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: string }>;
		const hasDisabledCause = cols.some(column => column.name === "disabled_cause");
		const hasIdentityKey = cols.some(column => column.name === "identity_key");
		const hasAccountId = cols.some(column => column.name === "account_id");
		const hasEmail = cols.some(column => column.name === "email");
		if (hasIdentityKey) return 3;
		if (hasAccountId || hasEmail) return 2;
		if (hasDisabledCause) return 1;
		return 0;
	}

	#createAuthCredentialsTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
				updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
			);
		`);
		this.#createAuthCredentialIndexes();
	}

	#createAuthCredentialIndexes(): void {
		this.#db.run(`
			CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;
		`);
	}

	#migrateAuthSchema(fromVersion: number): void {
		if (fromVersion < 1) {
			this.#migrateAuthSchemaV0ToV1();
		}
		if (fromVersion < 3) {
			this.#migrateAuthSchemaV1OrV2ToV3();
		}
		if (fromVersion < 4) {
			this.#migrateAuthSchemaV3ToV4();
		}
	}

	#migrateAuthSchemaV0ToV1(): void {
		const migrate = this.#db.transaction(() => {
			const v0Cols = this.#db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: string }>;
			const hasDisabled = v0Cols.some(col => col.name === "disabled");

			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v0");
			this.#db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
					updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
				);
			`);
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					${hasDisabled ? "CASE WHEN disabled = 1 THEN 'disabled' ELSE NULL END" : "NULL"},
					created_at,
					updated_at
				FROM auth_credentials_v0
			`);
			this.#db.run("DROP TABLE auth_credentials_v0");
		});
		migrate();
	}

	#migrateAuthSchemaV1OrV2ToV3(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_legacy");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					NULL,
					created_at,
					updated_at
				FROM auth_credentials_legacy
			`);
			this.#db.run("DROP TABLE auth_credentials_legacy");
		});
		migrate();
	}

	#migrateAuthSchemaV3ToV4(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v3");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					identity_key,
					created_at,
					updated_at
				FROM auth_credentials_v3
			`);
			this.#db.run("DROP TABLE auth_credentials_v3");
		});
		migrate();
	}

	#backfillCredentialIdentityKeys(): void {
		const rows = this.#db
			.prepare(
				"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE identity_key IS NULL ORDER BY id ASC",
			)
			.all() as AuthRow[];
		if (rows.length === 0) return;

		const updateIdentity = this.#db.prepare("UPDATE auth_credentials SET identity_key = ? WHERE id = ?");
		for (const row of rows) {
			const identityKey = resolveRowCredentialIdentityKey(row.provider, row);
			updateIdentity.run(identityKey, row.id);
		}
	}

	// ─── AuthCredentialStore interface ──────────────────────────────────────

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows =
			(provider
				? (this.#listActiveByProviderStmt.all(provider) as AuthRow[])
				: (this.#listActiveStmt.all() as AuthRow[])) ?? [];

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			const result: StoredAuthCredential[] = [];
			const matchedExistingIds = new Set<number>();

			for (const credential of items) {
				const serialized = serializeCredential(providerName, credential);
				if (!serialized) continue;
				const match = existing.find(
					entry =>
						!matchedExistingIds.has(entry.id) &&
						matchesReplacementCredential(providerName, entry.credential, entry.identityKey, credential),
				);
				if (match) {
					matchedExistingIds.add(match.id);
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, match.id);
					result.push({ id: match.id, provider: providerName, credential, disabledCause: null });
				} else {
					const row = this.#insertStmt.get(
						providerName,
						serialized.credentialType,
						serialized.data,
						serialized.identityKey,
					) as { id?: number } | undefined;
					if (row?.id) {
						result.push({ id: row.id, provider: providerName, credential, disabledCause: null });
					}
				}
			}

			for (const row of existing) {
				if (!matchedExistingIds.has(row.id)) {
					this.#deleteStmt.run("replaced by newer credential", row.id);
				}
			}

			return result;
		});

		const result = replace(provider, credentials);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			let targetId: number | null = null;
			for (const row of existing) {
				if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
				if (targetId === null) {
					targetId = row.id;
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, row.id);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) {
				const row = this.#insertStmt.get(
					providerName,
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
				) as { id?: number } | undefined;
				targetId = row?.id ?? null;
			}

			const activeRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const result: StoredAuthCredential[] = [];
			for (const row of activeRows) {
				const activeCredential = deserializeCredential(row);
				if (!activeCredential) continue;
				result.push(toStoredAuthCredential(row, activeCredential));
			}
			return result;
		});

		const result = upsert(provider, credential);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	/**
	 * Hard-deletes disabled rows for a provider when an active row with the same identity exists.
	 * This prevents unbounded accumulation of soft-deleted credentials while preserving
	 * disabled rows that have no active replacement (safety net for recovery).
	 */
	#purgeSupersededDisabledRows(provider: string, activeRows: StoredAuthCredential[]): void {
		try {
			const activeIdentityKeys = new Set<string>();
			for (const row of activeRows) {
				const identityKey = resolveCredentialIdentityKey(provider, row.credential);
				if (identityKey) activeIdentityKeys.add(identityKey);
			}
			if (activeIdentityKeys.size === 0) return;

			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
			for (const row of disabledRows) {
				const identityKey = resolveRowCredentialIdentityKey(provider, row);
				if (identityKey && activeIdentityKeys.has(identityKey)) {
					this.#hardDeleteStmt.run(row.id);
				}
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		try {
			const providerRow = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?").get(id) as
				| { provider?: string }
				| undefined;
			const provider = providerRow?.provider ?? "";
			const serialized = serializeCredential(provider, credential);
			if (!serialized) return;
			this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, id);
			if (provider) {
				this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
			}
		} catch {
			// Ignore update failures
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		try {
			this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
		} catch {
			// Ignore delete failures
		}
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		try {
			this.#deleteByProviderStmt.run(normalizeDisabledCause(disabledCause), provider);
		} catch {
			// Ignore delete failures
		}
	}

	getCache(key: string): string | null {
		try {
			const row = this.#getCacheStmt.get(key) as { value?: string } | undefined;
			return row?.value ?? null;
		} catch {
			return null;
		}
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		try {
			this.#upsertCacheStmt.run(key, value, expiresAtSec);
		} catch {
			// Ignore cache set failures
		}
	}

	cleanExpiredCache(): void {
		try {
			this.#deleteExpiredCacheStmt.run();
		} catch {
			// Ignore cleanup errors
		}
	}

	// ─── Convenience methods for CLI ────────────────────────────────────────

	/**
	 * Save OAuth credentials for a provider.
	 * Preserves unrelated identities and replaces only the matching credential.
	 */
	saveOAuth(provider: string, credentials: OAuthCredentials): void {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		this.upsertAuthCredentialForProvider(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "oauth") {
				const { type: _type, ...oauth } = credential;
				return oauth as OAuthCredentials;
			}
		}
		return null;
	}

	/**
	 * Save API key for a provider (replaces existing).
	 */
	saveApiKey(provider: string, apiKey: string): void {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "api_key") {
				return credential.key;
			}
		}
		return null;
	}

	/**
	 * List all providers with credentials.
	 */
	listProviders(): string[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		const providers = new Set<string>();
		for (const row of rows) {
			providers.add(row.provider);
		}
		return Array.from(providers);
	}

	/**
	 * Delete all credentials for a provider.
	 */
	deleteProvider(provider: string): void {
		this.deleteAuthCredentialsForProvider(provider, "deleted by user");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listActiveStmt.finalize();
		this.#listActiveByProviderStmt.finalize();
		this.#listDisabledByProviderStmt.finalize();
		this.#insertStmt.finalize();
		this.#updateStmt.finalize();
		this.#deleteStmt.finalize();
		this.#deleteByProviderStmt.finalize();
		this.#hardDeleteStmt.finalize();
		this.#getCacheStmt.finalize();
		this.#upsertCacheStmt.finalize();
		this.#deleteExpiredCacheStmt.finalize();
		this.#db.close();
	}
}
