import { type Api, type Model, type ThinkingConfig, enrichModelThinking } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { type ConfigError, ConfigFile } from "../config";
import { parseModelString } from "../config/model-resolver";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import {
	type CanonicalModelIndex,
	type CanonicalModelRecord,
	type CanonicalModelVariant,
	type ModelEquivalenceConfig,
} from "./model-equivalence";
import { type Settings, settings } from "./settings";

export type { CanonicalModelIndex, CanonicalModelRecord, CanonicalModelVariant, ModelEquivalenceConfig };

export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

export type ModelRole = "default" | "smol" | "slow" | "vision" | "plan" | "designer" | "commit" | "task";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success" },
	smol: { tag: "SMOL", name: "Fast", color: "warning" },
	slow: { tag: "SLOW", name: "Thinking", color: "accent" },
	vision: { tag: "VISION", name: "Vision", color: "error" },
	plan: { tag: "PLAN", name: "Architect", color: "muted" },
	designer: { tag: "DESIGNER", name: "Designer", color: "muted" },
	commit: { tag: "COMMIT", name: "Commit", color: "dim" },
	task: { tag: "TASK", name: "Subtask", color: "muted" },
};

export const MODEL_ROLE_IDS: ModelRole[] = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "task"];

/** Alias for ModelRoleInfo - used for both built-in and custom roles */
export type RoleInfo = ModelRoleInfo;

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = [...MODEL_ROLE_IDS] as string[];
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) addRole(role);
	for (const role of Object.keys(settings.getModelRoles())) addRole(role);
	for (const role of Object.keys(settings.get("modelTags"))) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined;
	const configured = settings.get("modelTags")[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}

const OpenRouterRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for OpenAI compatibility settings
const ReasoningEffortMapSchema = Type.Object({
	minimal: Type.Optional(Type.String()),
	low: Type.Optional(Type.String()),
	medium: Type.Optional(Type.String()),
	high: Type.Optional(Type.String()),
	xhigh: Type.Optional(Type.String()),
});

const OpenAICompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	toolStrictMode: Type.Optional(Type.Union([Type.Literal("all_strict"), Type.Literal("none")])),
});

const EffortSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const ThinkingControlModeSchema = Type.Union([
	Type.Literal("effort"),
	Type.Literal("budget"),
	Type.Literal("google-level"),
	Type.Literal("anthropic-adaptive"),
	Type.Literal("anthropic-budget-effort"),
]);

const ModelThinkingSchema = Type.Object({
	minLevel: EffortSchema,
	maxLevel: EffortSchema,
	mode: ThinkingControlModeSchema,
});

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("openai-codex-responses"),
			Type.Literal("azure-openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("google-vertex"),
		]),
	),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinking: Type.Optional(ModelThinkingSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		}),
	),
	premiumMultiplier: Type.Optional(Type.Number()),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(OpenAICompatSchema),
	contextPromotionTarget: Type.Optional(Type.String({ minLength: 1 })),
});

// Schema for per-model overrides (all fields optional, merged with built-in model)
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinking: Type.Optional(ModelThinkingSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
		}),
	),
	premiumMultiplier: Type.Optional(Type.Number()),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(OpenAICompatSchema),
	contextPromotionTarget: Type.Optional(Type.String({ minLength: 1 })),
});

export type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderDiscoverySchema = Type.Object({
	type: Type.Union([Type.Literal("ollama"), Type.Literal("llama.cpp"), Type.Literal("lm-studio")]),
});

const ProviderAuthSchema = Type.Union([Type.Literal("apiKey"), Type.Literal("none")]);

const ProviderConfigSchema = Type.Object({
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("openai-codex-responses"),
			Type.Literal("azure-openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("google-vertex"),
		]),
	),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(OpenAICompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	auth: Type.Optional(ProviderAuthSchema),
	discovery: Type.Optional(ProviderDiscoverySchema),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const EquivalenceConfigSchema = Type.Object({
	overrides: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1 }))),
	exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Optional(Type.Record(Type.String(), ProviderConfigSchema)),
	equivalence: Type.Optional(EquivalenceConfigSchema),
});

export type ModelsConfig = Static<typeof ModelsConfigSchema>;

export type ProviderAuthMode = Static<typeof ProviderAuthSchema>;
type ProviderDiscovery = Static<typeof ProviderDiscoverySchema>;

export type ProviderValidationMode = "models-config" | "runtime-register";

export interface ProviderValidationModel {
	id: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ProviderValidationConfig {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	api?: Api;
	auth?: ProviderAuthMode;
	oauthConfigured?: boolean;
	discovery?: ProviderDiscovery;
	compat?: Model<Api>["compat"];
	modelOverrides?: Record<string, unknown>;
	models: ProviderValidationModel[];
}

export function validateProviderConfiguration(
	providerName: string,
	config: ProviderValidationConfig,
	mode: ProviderValidationMode,
): void {
	const hasProviderApi = !!config.api;
	const models = config.models;

	if (models.length === 0) {
		if (mode === "models-config") {
			const hasModelOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
			if (!config.baseUrl && !config.headers && !config.compat && !hasModelOverrides && !config.discovery) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", "discovery", or "models"`,
				);
			}
		}
	} else {
		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
		}
		const requiresAuth =
			mode === "runtime-register"
				? !config.apiKey && !config.oauthConfigured
				: !config.apiKey && (config.auth ?? "apiKey") !== "none";
		if (requiresAuth) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`
					: `Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none".`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api) {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}

	for (const modelDef of models) {
		if (!hasProviderApi && !modelDef.api) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}, model ${modelDef.id}: no "api" specified.`
					: `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		if (!modelDef.id) {
			throw new Error(`Provider ${providerName}: model missing "id"`);
		}
		if (mode === "models-config") {
			if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", ModelsConfigSchema).withValidation(
	"models",
	config => {
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			validateProviderConfiguration(
				providerName,
				{
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerConfig.apiKey,
					api: providerConfig.api as Api | undefined,
					auth: (providerConfig.auth ?? "apiKey") as ProviderAuthMode,
					discovery: providerConfig.discovery as ProviderDiscovery | undefined,
					compat: providerConfig.compat,
					modelOverrides: providerConfig.modelOverrides,
					models: (providerConfig.models ?? []) as ProviderValidationModel[],
				},
				"models-config",
			);
		}
	},
);

/** Provider override config (baseUrl, headers, apiKey, compat) without custom models */
export interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	compat?: Model<Api>["compat"];
}

export interface DiscoveryProviderConfig {
	provider: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	discovery: ProviderDiscovery;
	optional?: boolean;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	models: string[];
	error?: string;
}

export interface CanonicalModelQueryOptions {
	availableOnly?: boolean;
	candidates?: readonly Model<Api>[];
}

/** Result of loading custom models from models.json */
export interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	equivalence?: ModelEquivalenceConfig;
	error?: ConfigError;
	found: boolean;
}

export type OllamaDiscoveredModelMetadata = {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
};

export type LlamaCppDiscoveredServerMetadata = {
	contextWindow?: number;
	input?: ("text" | "image")[];
};

/**
 * Resolve an API key config value to an actual key.
 * Checks environment variable first, then treats as literal.
 */
export function resolveApiKeyConfig(keyConfig: string): string | undefined {
	const envValue = Bun.env[keyConfig];
	if (envValue) return envValue;
	return keyConfig;
}

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

export function extractOllamaContextWindow(payload: Record<string, unknown>): number | undefined {
	const modelInfo = payload.model_info;
	if (isRecord(modelInfo)) {
		for (const [key, value] of Object.entries(modelInfo)) {
			if (key === "context_length" || key.endsWith(".context_length")) {
				const contextWindow = toPositiveNumberOrUndefined(value);
				if (contextWindow !== undefined) {
					return contextWindow;
				}
			}
		}
	}

	const parameters = payload.parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

export function extractLlamaCppContextWindow(payload: Record<string, unknown>): number | undefined {
	const generationSettings = payload.default_generation_settings;
	if (isRecord(generationSettings)) {
		const contextWindow = toPositiveNumberOrUndefined(generationSettings.n_ctx);
		if (contextWindow !== undefined) {
			return contextWindow;
		}
	}
	return toPositiveNumberOrUndefined(payload.n_ctx);
}

export function extractLlamaCppInputCapabilities(payload: Record<string, unknown>): ("text" | "image")[] | undefined {
	const modalities = payload.modalities;
	if (!isRecord(modalities)) {
		return undefined;
	}
	return modalities.vision === true ? ["text", "image"] : ["text"];
}

export function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {
		// OAuth values for Google providers are expected to be JSON, but custom setups may already provide raw token.
	}
	return value;
}

function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

export function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
): string | undefined {
	const oauthCredentials = getOAuthCredentialsForProvider(authStorage, provider);
	const matchingCredential = oauthCredentials.find(credential => credential.access === accessToken);
	if (matchingCredential) {
		return matchingCredential.accountId;
	}
	if (oauthCredentials.length === 1) {
		return oauthCredentials[0].accountId;
	}
	return undefined;
}

export function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;
	const base = baseCompat ?? {};
	const override = overrideCompat;
	const merged: NonNullable<Model<Api>["compat"]> = { ...base, ...override };
	if (baseCompat?.reasoningEffortMap || overrideCompat.reasoningEffortMap) {
		merged.reasoningEffortMap = { ...baseCompat?.reasoningEffortMap, ...overrideCompat.reasoningEffortMap };
	}
	if (baseCompat?.openRouterRouting || overrideCompat.openRouterRouting) {
		merged.openRouterRouting = { ...baseCompat?.openRouterRouting, ...overrideCompat.openRouterRouting };
	}
	if (baseCompat?.vercelGatewayRouting || overrideCompat.vercelGatewayRouting) {
		merged.vercelGatewayRouting = { ...baseCompat?.vercelGatewayRouting, ...overrideCompat.vercelGatewayRouting };
	}
	if (baseCompat?.extraBody || overrideCompat.extraBody) {
		merged.extraBody = { ...baseCompat?.extraBody, ...overrideCompat.extraBody };
	}
	return merged;
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinking !== undefined) result.thinking = override.thinking as ThinkingConfig;
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;
	if (override.contextPromotionTarget !== undefined) result.contextPromotionTarget = override.contextPromotionTarget;
	if (override.premiumMultiplier !== undefined) result.premiumMultiplier = override.premiumMultiplier;
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}
	if (override.headers) {
		result.headers = { ...model.headers, ...override.headers };
	}
	result.compat = mergeCompat(model.compat, override.compat);
	return enrichModelThinking(result);
}

export interface CustomModelDefinitionLike {
	id: string;
	name?: string;
	api?: Api;
	baseUrl?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
}

interface CustomModelBuildOptions {
	useDefaults: boolean;
}

export type CustomModelOverlay = {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
};

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined;
	if (authHeader && apiKeyConfig) {
		const resolvedKey = resolveApiKeyConfig(apiKeyConfig);
		if (resolvedKey) {
			headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
		}
	}
	return headers;
}

export function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: Model<Api>["compat"] | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking as ThinkingConfig | undefined,
		input: modelDef.input as ("text" | "image")[] | undefined,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		premiumMultiplier: modelDef.premiumMultiplier,
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

export function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const cost =
		resolvedModel.cost ?? (options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? (options.useDefaults ? ["text"] : undefined);
	return enrichModelThinking({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking,
		input: input as ("text" | "image")[],
		cost,
		contextWindow: resolvedModel.contextWindow ?? (options.useDefaults ? 128000 : undefined),
		maxTokens: resolvedModel.maxTokens ?? (options.useDefaults ? 16384 : undefined),
		headers: resolvedModel.headers,
		compat: resolvedModel.compat,
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		premiumMultiplier: resolvedModel.premiumMultiplier,
	} as Model<Api>);
}

export function normalizeSuppressedSelector(selector: string): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed);
	if (!parsed) return trimmed;
	return `${parsed.provider}/${parsed.id}`;
}

export function getDisabledProviderIdsFromSettings(): Set<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

export function getConfiguredProviderOrderFromSettings(): string[] {
	try {
		return settings.get("modelProviderOrder");
	} catch {
		return [];
	}
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
