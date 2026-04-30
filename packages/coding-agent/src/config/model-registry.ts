import * as path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createModelManager,
	DEFAULT_LOCAL_TOKEN,
	enrichModelThinking,
	getBundledModels,
	getBundledProviders,
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	type Model,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	readModelCache,
	registerCustomApi,
	registerOAuthProvider,
	type SimpleStreamOptions,
	type ThinkingConfig,
	unregisterCustomApis,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { type ConfigError, ConfigFile } from "../config";
import { parseModelString, resolveProviderModelReference } from "../config/model-resolver";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import {
	buildCanonicalModelIndex,
	type CanonicalModelIndex,
	type CanonicalModelRecord,
	type CanonicalModelVariant,
	formatCanonicalVariantSelector,
	type ModelEquivalenceConfig,
} from "./model-equivalence";
import { type Settings, settings } from "./settings";

import {
	kNoAuth,
	isAuthenticated,
	ModelsConfigFile,
	type ProviderDiscoveryStatus,
	type ProviderDiscoveryState,
	type CanonicalModelQueryOptions,
	type ProviderOverride,
	type DiscoveryProviderConfig,
	type CustomModelsResult,
	type CustomModelOverlay,
	type CustomModelDefinitionLike,
	type OllamaDiscoveredModelMetadata,
	type LlamaCppDiscoveredServerMetadata,
	type ModelOverride,
	type ProviderAuthMode,
	type ProviderValidationMode,
	type ProviderValidationModel,
	type ModelsConfig,
	validateProviderConfiguration,
	resolveApiKeyConfig,
	extractOllamaContextWindow,
	extractLlamaCppContextWindow,
	extractLlamaCppInputCapabilities,
	extractGoogleOAuthToken,
	resolveOAuthAccountIdForAccessToken,
	mergeCompat,
	applyModelOverride,
	buildCustomModelOverlay,
	finalizeCustomModel,
	normalizeSuppressedSelector,
	getDisabledProviderIdsFromSettings,
	getConfiguredProviderOrderFromSettings,
} from "./model-registry-types";

export {
	kNoAuth,
	isAuthenticated,
	type ModelRole,
	type ModelRoleInfo,
	MODEL_ROLES,
	MODEL_ROLE_IDS,
	type RoleInfo,
	getKnownRoleIds,
	getRoleInfo,
	type ProviderDiscoveryStatus,
	type ProviderDiscoveryState,
	type CanonicalModelQueryOptions,
	type CanonicalModelIndex,
	type CanonicalModelRecord,
	type CanonicalModelVariant,
	type ModelEquivalenceConfig,
	ModelsConfigFile,
} from "./model-registry-types";

export class ModelRegistry {
	#models: Model<Api>[] = [];
	#canonicalIndex: CanonicalModelIndex = { records: [], byId: new Map(), bySelector: new Map() };
	#customProviderApiKeys: Map<string, string> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoverableProviders: DiscoveryProviderConfig[] = [];
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#equivalenceConfig: ModelEquivalenceConfig | undefined;
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#registeredProviderSources: Set<string> = new Set();
	#providerDiscoveryStates: Map<string, ProviderDiscoveryState> = new Map();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();
	// Runtime extension model overlays — persist across refresh() cycles so that
	// models registered by extensions survive the model selector's offline reload.
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();

	/**
	 * @param authStorage - Auth storage for API key resolution
	 */
	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
	) {
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath);
		this.#cacheDbPath = modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined;
		// Set up fallback resolver for custom provider API keys
		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			if (keyConfig) {
				return resolveApiKeyConfig(keyConfig);
			}
			return undefined;
		});
		// Load models synchronously in constructor
		this.#loadModels();
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#reloadStaticModels();
		this.#suppressedSelectors.clear();
		await this.#refreshRuntimeDiscoveries(strategy);
	}

	refreshInBackground(strategy: ModelRefreshStrategy = "online-if-uncached"): void {
		if (this.#backgroundRefresh) {
			return;
		}
		const refreshPromise = this.refresh(strategy)
			.catch(error => {
				logger.warn("background model refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#backgroundRefresh === refreshPromise) {
					this.#backgroundRefresh = undefined;
				}
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#reloadStaticModels();
		for (const selector of this.#suppressedSelectors.keys()) {
			if (selector.startsWith(`${providerId}/`)) {
				this.#suppressedSelectors.delete(selector);
			}
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));
	}

	#reloadStaticModels(): void {
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#keylessProviders.clear();
		this.#discoverableProviders = [];
		// Restore runtime API keys before #loadModels — survives because
		// #loadModels only calls .set() on #customProviderApiKeys, never reassigns it.
		for (const [k, v] of this.#runtimeProviderApiKeys) {
			this.#customProviderApiKeys.set(k, v);
		}
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#equivalenceConfig = undefined;
		this.#configError = undefined;
		this.#providerDiscoveryStates.clear();
		this.#loadModels();
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		// Load custom models from models.json first (to know which providers to override)
		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set(),
			discoverableProviders = [],
			configuredProviders = new Set(),
			equivalence,
			error: configError,
		} = this.#loadCustomModels();
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoverableProviders = discoverableProviders;
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;
		this.#equivalenceConfig = equivalence;

		this.#addImplicitDiscoverableProviders(configuredProviders);
		const builtInModels = this.#applyHardcodedModelPolicies(this.#loadBuiltInModels(overrides));
		const cachedDiscoveries = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
		const resolvedDefaults = this.#mergeResolvedModels(builtInModels, cachedDiscoveries);
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, this.#customModelOverlays);
		// Merge runtime extension models so they survive refresh() cycles
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(combined, this.#modelOverrides);
		this.#models = this.#applyRuntimeProviderOverrides(withModelOverrides);
		this.#rebuildCanonicalIndex();
	}

	/** Load built-in models, applying provider-level overrides only.
	 *  Per-model overrides are applied later by #applyModelOverrides. */
	#loadBuiltInModels(overrides: Map<string, ProviderOverride>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				return {
					...m,
					baseUrl: providerOverride.baseUrl ?? m.baseUrl,
					headers: providerOverride.headers ? { ...m.headers, ...providerOverride.headers } : m.headers,
					compat: mergeCompat(m.compat, providerOverride.compat),
				};
			});
		});
	}

	#mergeResolvedModels(baseModels: Model<Api>[], replacementModels: Model<Api>[]): Model<Api>[] {
		const merged = [...baseModels];
		for (const replacementModel of replacementModels) {
			const existingIndex = merged.findIndex(
				m => m.provider === replacementModel.provider && m.id === replacementModel.id,
			);
			if (existingIndex >= 0) {
				merged[existingIndex] = replacementModel;
			} else {
				merged.push(replacementModel);
			}
		}
		return merged;
	}

	/** Merge custom models with built-in, replacing by provider+id match */
	#mergeCustomModels(builtInModels: Model<Api>[], customModels: CustomModelOverlay[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex(m => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				const existingModel = merged[existingIndex];
				merged[existingIndex] = enrichModelThinking({
					...existingModel,
					id: customModel.id,
					provider: customModel.provider,
					api: customModel.api,
					baseUrl: customModel.baseUrl,
					name: customModel.name ?? existingModel.name,
					reasoning: customModel.reasoning ?? existingModel.reasoning,
					thinking: customModel.thinking ?? existingModel.thinking,
					input: customModel.input ?? existingModel.input,
					cost: customModel.cost ?? existingModel.cost,
					contextWindow: customModel.contextWindow ?? existingModel.contextWindow,
					maxTokens: customModel.maxTokens ?? existingModel.maxTokens,
					// Same-id custom definitions replace bundled transport behavior. Provider-level
					// headers/compat were already folded into customModel during parsing; do not
					// re-merge bundled transport metadata here.
					headers: customModel.headers,
					compat: customModel.compat,
					contextPromotionTarget: customModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
					premiumMultiplier: customModel.premiumMultiplier ?? existingModel.premiumMultiplier,
				} as Model<Api>);
			} else {
				merged.push(finalizeCustomModel(customModel, { useDefaults: true }));
			}
		}
		return merged;
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoverableProviders) {
			const cache = readModelCache<Api>(providerConfig.provider, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "idle",
					optional: providerConfig.optional ?? false,
					stale: false,
					models: [],
				});
				continue;
			}
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(providerConfig.compat, cache.models),
				),
			);
			cachedModels.push(...models);
			this.#providerDiscoveryStates.set(providerConfig.provider, {
				provider: providerConfig.provider,
				status: "cached",
				optional: providerConfig.optional ?? false,
				stale: !cache.fresh || !cache.authoritative,
				fetchedAt: cache.updatedAt,
				models: models.map(model => model.id),
			});
		}
		return cachedModels;
	}

	#applyProviderCompat(compat: Model<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model => ({ ...model, compat: mergeCompat(model.compat, compat) }));
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		if (providerConfig.provider !== "ollama" || providerConfig.api !== "openai-responses") {
			return models;
		}

		return models.map(model => (model.api === "openai-completions" ? { ...model, api: "openai-responses" } : model));
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		if (!configuredProviders.has("ollama")) {
			this.#discoverableProviders.push({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: Bun.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
				discovery: { type: "ollama" },
				optional: true,
			});
			this.#keylessProviders.add("ollama");
		}
		if (!configuredProviders.has("llama.cpp")) {
			this.#discoverableProviders.push({
				provider: "llama.cpp",
				api: "openai-responses",
				baseUrl: Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
				discovery: { type: "llama.cpp" },
				optional: true,
			});
			// Only mark as keyless if no API key is configured
			if (!this.authStorage.hasAuth("llama.cpp")) {
				this.#keylessProviders.add("llama.cpp");
			}
		}
		if (!configuredProviders.has("lm-studio")) {
			this.#discoverableProviders.push({
				provider: "lm-studio",
				api: "openai-completions",
				baseUrl: Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
				discovery: { type: "lm-studio" },
				optional: true,
			});
			this.#keylessProviders.add("lm-studio");
		}
	}

	#loadCustomModels(): CustomModelsResult {
		const { value, error, status } = this.#modelsConfigFile.tryLoad();

		if (status === "error") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				error,
				found: true,
			};
		} else if (status === "not-found") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}

		const overrides = new Map<string, ProviderOverride>();
		const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
		const keylessProviders = new Set<string>();
		const discoverableProviders: DiscoveryProviderConfig[] = [];
		const providerEntries = Object.entries(value.providers ?? {});
		const configuredProviders = new Set(Object.keys(value.providers ?? {}));

		for (const [providerName, providerConfig] of providerEntries) {
			// Always set overrides when baseUrl/headers/apiKey/compat are present
			if (providerConfig.baseUrl || providerConfig.headers || providerConfig.apiKey || providerConfig.compat) {
				overrides.set(providerName, {
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerConfig.apiKey,
					compat: providerConfig.compat,
				});
			}

			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			if (providerConfig.discovery && providerConfig.api) {
				discoverableProviders.push({
					provider: providerName,
					api: providerConfig.api as Api,
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					compat: providerConfig.compat,
					discovery: providerConfig.discovery,
					optional: false,
				});
			}

			// Always store API key for fallback resolver
			if (providerConfig.apiKey) {
				this.#customProviderApiKeys.set(providerName, providerConfig.apiKey);
			}

			// Parse per-model overrides
			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					perModel.set(modelId, override);
				}
				allModelOverrides.set(providerName, perModel);
			}
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			equivalence: value.equivalence,
			found: true,
		};
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const selectedDiscoverableProviders = providerFilter
			? this.#discoverableProviders.filter(provider => providerFilter.has(provider.provider))
			: this.#discoverableProviders;
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<Model<Api>[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(provider => this.#discoverProviderModels(provider, strategy)),
					).then(results => results.flat());
		const [configuredDiscovered, builtInDiscovered] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		const discovered = [...configuredDiscovered, ...builtInDiscovered];
		if (discovered.length === 0) {
			return;
		}
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model => {
				const existing = this.find(model.provider, model.id);
				if (existing) {
					return {
						...model,
						baseUrl: existing.baseUrl,
						headers: existing.headers ? { ...existing.headers, ...model.headers } : model.headers,
					};
				}
				const providerOverride = this.#providerOverrides.get(model.provider);
				return providerOverride
					? {
							...model,
							baseUrl: providerOverride.baseUrl ?? model.baseUrl,
							headers: providerOverride.headers
								? { ...model.headers, ...providerOverride.headers }
								: model.headers,
						}
					: model;
			}),
		);
		const resolved = this.#mergeResolvedModels(this.#models, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		// Merge runtime extension models so they survive online discovery completion
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(combined, this.#modelOverrides);
		this.#models = this.#applyRuntimeProviderOverrides(withModelOverrides);
		this.#rebuildCanonicalIndex();
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		const cached = readModelCache<Api>(providerConfig.provider, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
		const requiresAuth = !this.#keylessProviders.has(providerConfig.provider);
		if (requiresAuth) {
			const apiKey = await this.#peekApiKeyForProvider(providerConfig.provider);
			if (!isAuthenticated(apiKey)) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "unauthenticated",
					optional: providerConfig.optional ?? false,
					stale: cached !== null,
					fetchedAt: cached?.updatedAt,
					models: cached?.models.map(model => model.id) ?? [],
				});
				this.#lastDiscoveryWarnings.delete(providerConfig.provider);
				return cached?.models ?? [];
			}
		}

		const providerId = providerConfig.provider;
		let discoveryError: string | undefined;
		const fetchDynamicModels = async (): Promise<readonly Model<Api>[] | null> => {
			try {
				const models = await this.#discoverModelsByProviderType(providerConfig);
				this.#lastDiscoveryWarnings.delete(providerId);
				return models;
			} catch (error) {
				discoveryError = error instanceof Error ? error.message : String(error);
				return null;
			}
		};

		const manager = createModelManager<Api>({
			providerId,
			staticModels: [],
			cacheDbPath: this.#cacheDbPath,
			cacheTtlMs: 24 * 60 * 60 * 1000,
			fetchDynamicModels,
		});
		const result = await manager.refresh(strategy);
		const status = discoveryError
			? result.models.length > 0
				? "cached"
				: "unavailable"
			: result.models.length > 0 && strategy !== "offline"
				? "ok"
				: cached
					? "cached"
					: "idle";
		this.#providerDiscoveryStates.set(providerId, {
			provider: providerId,
			status,
			optional: providerConfig.optional ?? false,
			stale: result.stale || status === "cached",
			fetchedAt: discoveryError ? cached?.updatedAt : Date.now(),
			models: result.models.map(model => model.id),
			error: discoveryError,
		});
		if (discoveryError) {
			this.#warnProviderDiscoveryFailure(providerConfig, discoveryError);
		}
		return this.#applyProviderModelOverrides(
			providerId,
			this.#normalizeDiscoverableModels(
				providerConfig,
				this.#applyProviderCompat(providerConfig.compat, result.models),
			),
		);
	}

	#discoverModelsByProviderType(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		switch (providerConfig.discovery.type) {
			case "ollama":
				return this.#discoverOllamaModels(providerConfig);
			case "llama.cpp":
				return this.#discoverLlamaCppModels(providerConfig);
			case "lm-studio":
				return this.#discoverLmStudioModels(providerConfig);
		}
	}

	#warnProviderDiscoveryFailure(providerConfig: DiscoveryProviderConfig, error: string): void {
		const previous = this.#lastDiscoveryWarnings.get(providerConfig.provider);
		if (previous === error) {
			return;
		}
		this.#lastDiscoveryWarnings.set(providerConfig.provider, error);
		logger.warn("model discovery failed for provider", {
			provider: providerConfig.provider,
			url: providerConfig.baseUrl,
			error,
		});
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<Model<Api>[]> {
		// Skip providers already handled by configured discovery (e.g. user-configured ollama with discovery.type)
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(p => p.provider));
		const managerOptions = (await this.#collectBuiltInModelManagerOptions()).filter(opts => {
			if (configuredDiscoveryProviders.has(opts.providerId)) {
				return false;
			}
			return providerFilter ? providerFilter.has(opts.providerId) : true;
		});
		if (managerOptions.length === 0) {
			return [];
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		return discoveries.flat();
	}

	async #collectBuiltInModelManagerOptions(): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-antigravity"),
					}),
			},
			{
				providerId: "google-gemini-cli",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-gemini-cli"),
					}),
			},
			{
				providerId: "openai-codex",
				resolveKey: value => value,
				createOptions: accessToken => {
					const accountId = resolveOAuthAccountIdForAccessToken(this.authStorage, "openai-codex", accessToken);
					return openaiCodexModelManagerOptions({
						accessToken,
						accountId,
					});
				},
			},
		];
		// Use peekApiKey to avoid OAuth token refresh during discovery.
		// The token is only needed if the dynamic fetch fires (cache miss),
		// and failures there are handled gracefully.
		const peekKey = (descriptor: { providerId: string }) => this.#peekApiKeyForProvider(descriptor.providerId);
		const [standardProviderKeys, specialKeys] = await Promise.all([
			Promise.all(PROVIDER_DESCRIPTORS.map(peekKey)),
			Promise.all(specialProviderDescriptors.map(peekKey)),
		]);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < PROVIDER_DESCRIPTORS.length; i++) {
			const descriptor = PROVIDER_DESCRIPTORS[i];
			const apiKey = standardProviderKeys[i];
			if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated) {
				options.push(
					descriptor.createModelManagerOptions({
						apiKey: isAuthenticated(apiKey) ? apiKey : undefined,
						baseUrl: this.getProviderBaseUrl(descriptor.providerId),
					}),
				);
			}
		}

		for (let i = 0; i < specialProviderDescriptors.length; i++) {
			const descriptor = specialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key));
		}
		return options;
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		try {
			const manager = createModelManager({ ...options, cacheDbPath: this.#cacheDbPath });
			const result = await manager.refresh(strategy);
			return result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
		} catch (error) {
			logger.warn("model discovery failed for provider", {
				provider: options.providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	async #discoverOllamaModelMetadata(
		endpoint: string,
		modelId: string,
		headers: Record<string, string> | undefined,
	): Promise<OllamaDiscoveredModelMetadata | null> {
		const showUrl = `${endpoint}/api/show`;
		try {
			const response = await fetch(showUrl, {
				method: "POST",
				headers: { ...(headers ?? {}), "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelId }),
				signal: AbortSignal.timeout(150),
			});
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as unknown;
			if (!isRecord(payload)) {
				return null;
			}
			const contextWindow = extractOllamaContextWindow(payload);
			const capabilities = payload.capabilities;
			if (Array.isArray(capabilities)) {
				const normalized = new Set(
					capabilities.flatMap(capability => (typeof capability === "string" ? [capability.toLowerCase()] : [])),
				);
				const supportsVision = normalized.has("vision") || normalized.has("image");
				return {
					reasoning: normalized.has("thinking"),
					input: supportsVision ? ["text", "image"] : ["text"],
					contextWindow,
				};
			}
			if (!isRecord(capabilities)) {
				return {
					reasoning: false,
					input: ["text"],
					contextWindow,
				};
			}
			const supportsVision = capabilities.vision === true || capabilities.image === true;
			return {
				reasoning: capabilities.thinking === true,
				input: supportsVision ? ["text", "image"] : ["text"],
				contextWindow,
			};
		} catch {
			return null;
		}
	}

	async #discoverOllamaModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const endpoint = this.#normalizeOllamaBaseUrl(providerConfig.baseUrl);
		const tagsUrl = `${endpoint}/api/tags`;
		const headers = { ...(providerConfig.headers ?? {}) };
		const response = await fetch(tagsUrl, {
			headers,
			signal: AbortSignal.timeout(250),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${tagsUrl}`);
		}
		const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
		const entries = (payload.models ?? []).flatMap(item => {
			const id = item.model || item.name;
			return id ? [{ id, name: item.name || id }] : [];
		});
		const metadataById = new Map(
			await Promise.all(
				entries.map(
					async entry => [entry.id, await this.#discoverOllamaModelMetadata(endpoint, entry.id, headers)] as const,
				),
			),
		);
		const discovered = entries.map(entry => {
			const metadata = metadataById.get(entry.id);
			return enrichModelThinking({
				id: entry.id,
				name: entry.name,
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl: `${endpoint}/v1`,
				reasoning: metadata?.reasoning ?? false,
				input: metadata?.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata?.contextWindow ?? 128000,
				maxTokens: Math.min(metadata?.contextWindow ?? Number.POSITIVE_INFINITY, 8192),
				headers: providerConfig.headers,
			});
		});
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	async #discoverLlamaCppServerMetadata(
		baseUrl: string,
		headers: Record<string, string> | undefined,
	): Promise<LlamaCppDiscoveredServerMetadata | null> {
		const propsUrl = `${this.#toLlamaCppNativeBaseUrl(baseUrl)}/props`;
		try {
			const response = await fetch(propsUrl, {
				headers,
				signal: AbortSignal.timeout(150),
			});
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as unknown;
			if (!isRecord(payload)) {
				return null;
			}
			return {
				contextWindow: extractLlamaCppContextWindow(payload),
				input: extractLlamaCppInputCapabilities(payload),
			};
		} catch {
			return null;
		}
	}

	async #discoverLlamaCppModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeLlamaCppBaseUrl(providerConfig.baseUrl);
		const modelsUrl = `${baseUrl}/models`;

		const headers: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey = await this.authStorage.getApiKey(providerConfig.provider);
		if (apiKey && apiKey !== DEFAULT_LOCAL_TOKEN && apiKey !== kNoAuth) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const [response, serverMetadata] = await Promise.all([
			fetch(modelsUrl, {
				headers,
				signal: AbortSignal.timeout(250),
			}),
			this.#discoverLlamaCppServerMetadata(baseUrl, headers),
		]);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id: string }> };
		const models = payload.data ?? [];
		const discovered: Model<Api>[] = [];
		for (const item of models) {
			const id = item.id;
			if (!id) continue;
			discovered.push(
				enrichModelThinking({
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl,
					reasoning: false,
					input: serverMetadata?.input ?? ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: serverMetadata?.contextWindow ?? 128000,
					maxTokens: Math.min(serverMetadata?.contextWindow ?? Number.POSITIVE_INFINITY, 8192),
					headers,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				}),
			);
		}
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	async #discoverLmStudioModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeLmStudioBaseUrl(providerConfig.baseUrl);
		const modelsUrl = `${baseUrl}/models`;

		const headers: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey = await this.authStorage.getApiKey(providerConfig.provider);
		if (apiKey && apiKey !== DEFAULT_LOCAL_TOKEN && apiKey !== kNoAuth) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(modelsUrl, {
			headers,
			signal: AbortSignal.timeout(250),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id: string }> };
		const models = payload.data ?? [];
		const discovered: Model<Api>[] = [];
		for (const item of models) {
			const id = item.id;
			if (!id) continue;
			discovered.push(
				enrichModelThinking({
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					headers,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				}),
			);
		}
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	#normalizeLlamaCppBaseUrl(baseUrl?: string): string {
		const defaultBaseUrl = "http://127.0.0.1:8080";
		const raw = baseUrl || defaultBaseUrl;
		try {
			const parsed = new URL(raw);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			return `${parsed.protocol}//${parsed.host}${trimmedPath}`;
		} catch {
			return raw;
		}
	}

	#toLlamaCppNativeBaseUrl(baseUrl: string): string {
		try {
			const parsed = new URL(baseUrl);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) || "/" : trimmedPath || "/";
			const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
			return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
		} catch {
			return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
		}
	}

	#normalizeLmStudioBaseUrl(baseUrl?: string): string {
		const defaultBaseUrl = "http://127.0.0.1:1234/v1";
		const raw = baseUrl || defaultBaseUrl;
		try {
			const parsed = new URL(raw);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
			return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		} catch {
			return raw;
		}
	}
	#normalizeOllamaBaseUrl(baseUrl?: string): string {
		const raw = baseUrl || "http://127.0.0.1:11434";
		try {
			const parsed = new URL(raw);
			return `${parsed.protocol}//${parsed.host}`;
		} catch {
			return "http://127.0.0.1:11434";
		}
	}

	#applyProviderModelOverrides(provider: string, models: Model<Api>[]): Model<Api>[] {
		const overrides = this.#modelOverrides.get(provider);
		if (!overrides || overrides.size === 0) return models;
		return models.map(model => {
			const override = overrides.get(model.id);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			headers: override.headers ? { ...(baseOverride?.headers ?? {}), ...override.headers } : baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
		};
	}
	#applyProviderTransportOverride<T extends { baseUrl?: string; headers?: Record<string, string> }>(
		entry: T,
		override: Pick<ProviderOverride, "baseUrl" | "headers">,
	): T {
		return {
			...entry,
			baseUrl: override.baseUrl ?? entry.baseUrl,
			headers: override.headers ? { ...entry.headers, ...override.headers } : entry.headers,
		};
	}
	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverride(model, override);
		});
	}
	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		if (overrides.size === 0) return models;
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			if (!providerOverrides) return model;
			const override = providerOverrides.get(model.id);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}
	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider)?.get(model.id);
			if (!overrides) {
				return applyModelOverride(model, { contextWindow: 1_000_000 });
			}
			return applyModelOverride(model, {
				contextWindow: overrides.contextWindow ?? 1_000_000,
				...overrides,
			});
		});
	}

	#rebuildCanonicalIndex(): void {
		this.#canonicalIndex = buildCanonicalModelIndex(this.#models, this.#equivalenceConfig);
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];

		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			if (providerConfig.apiKey) {
				this.#customProviderApiKeys.set(providerName, providerConfig.apiKey);
			}
			for (const modelDef of modelDefs) {
				const model = buildCustomModelOverlay(
					providerName,
					providerConfig.baseUrl!,
					providerConfig.api as Api | undefined,
					providerConfig.headers,
					providerConfig.apiKey,
					providerConfig.authHeader,
					providerConfig.compat,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.#models;
	}

	#isModelAvailable(model: Model<Api>): boolean {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		return (
			!disabledProviders.has(model.provider) &&
			(this.#keylessProviders.has(model.provider) || this.authStorage.hasAuth(model.provider))
		);
	}

	#filterCanonicalVariants(
		record: CanonicalModelRecord,
		options: CanonicalModelQueryOptions | undefined,
	): CanonicalModelVariant[] {
		const candidateKeys = options?.candidates
			? new Set(options.candidates.map(candidate => formatCanonicalVariantSelector(candidate)))
			: undefined;
		return record.variants.filter(variant => {
			if (candidateKeys && !candidateKeys.has(variant.selector)) {
				return false;
			}
			if (options?.availableOnly && !this.#isModelAvailable(variant.model)) {
				return false;
			}
			return true;
		});
	}

	#providerRank(models: readonly Model<Api>[]): Map<string, number> {
		const configuredProviders = getConfiguredProviderOrderFromSettings();
		const result = new Map<string, number>();
		let nextRank = 0;
		for (const provider of configuredProviders) {
			const normalized = provider.trim().toLowerCase();
			if (!normalized || result.has(normalized)) {
				continue;
			}
			result.set(normalized, nextRank);
			nextRank += 1;
		}
		for (const model of models) {
			const normalized = model.provider.toLowerCase();
			if (result.has(normalized)) {
				continue;
			}
			result.set(normalized, nextRank);
			nextRank += 1;
		}
		return result;
	}

	#resolveCanonicalVariant(
		variants: readonly CanonicalModelVariant[],
		allCandidates: readonly Model<Api>[],
	): CanonicalModelVariant | undefined {
		if (variants.length === 0) {
			return undefined;
		}
		const providerRank = this.#providerRank(allCandidates);
		const modelOrder = new Map<string, number>();
		for (let index = 0; index < allCandidates.length; index += 1) {
			modelOrder.set(formatCanonicalVariantSelector(allCandidates[index]!), index);
		}
		const sourceRank: Record<CanonicalModelVariant["source"], number> = {
			override: 1,
			bundled: 1,
			heuristic: 2,
			fallback: 3,
		};
		return [...variants].sort((left, right) => {
			const leftProviderRank = providerRank.get(left.model.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
			const rightProviderRank = providerRank.get(right.model.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
			if (leftProviderRank !== rightProviderRank) {
				return leftProviderRank - rightProviderRank;
			}
			const leftExact = left.model.id === left.canonicalId ? 0 : 1;
			const rightExact = right.model.id === right.canonicalId ? 0 : 1;
			if (leftExact !== rightExact) {
				return leftExact - rightExact;
			}
			if (sourceRank[left.source] !== sourceRank[right.source]) {
				return sourceRank[left.source] - sourceRank[right.source];
			}
			if (left.model.id.length !== right.model.id.length) {
				return left.model.id.length - right.model.id.length;
			}
			const leftOrder = modelOrder.get(left.selector) ?? Number.MAX_SAFE_INTEGER;
			const rightOrder = modelOrder.get(right.selector) ?? Number.MAX_SAFE_INTEGER;
			return leftOrder - rightOrder;
		})[0];
	}

	getCanonicalModels(options?: CanonicalModelQueryOptions): CanonicalModelRecord[] {
		const records: CanonicalModelRecord[] = [];
		for (const record of this.#canonicalIndex.records) {
			const variants = this.#filterCanonicalVariants(record, options);
			if (variants.length === 0) {
				continue;
			}
			records.push({
				id: record.id,
				name: record.name,
				variants,
			});
		}
		return records;
	}

	getCanonicalVariants(canonicalId: string, options?: CanonicalModelQueryOptions): CanonicalModelVariant[] {
		const record = this.#canonicalIndex.byId.get(canonicalId.trim().toLowerCase());
		if (!record) {
			return [];
		}
		return this.#filterCanonicalVariants(record, options);
	}

	resolveCanonicalModel(canonicalId: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined {
		const variants = this.getCanonicalVariants(canonicalId, options);
		if (variants.length === 0) {
			return undefined;
		}
		const candidates = options?.candidates ?? (options?.availableOnly ? this.getAvailable() : this.getAll());
		return this.#resolveCanonicalVariant(variants, candidates)?.model;
	}

	getCanonicalId(model: Model<Api>): string | undefined {
		return this.#canonicalIndex.bySelector.get(formatCanonicalVariantSelector(model).toLowerCase());
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.#models.filter(model => this.#isModelAvailable(model));
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		return this.#discoverableProviders
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#providerDiscoveryStates.get(provider);
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#models);
	}

	/**
	 * Get the base URL associated with a provider, if any model defines one.
	 */
	getProviderBaseUrl(provider: string): string | undefined {
		return this.#models.find(m => m.provider === provider && m.baseUrl)?.baseUrl;
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined> {
		if (this.#keylessProviders.has(model.provider) && !this.authStorage.hasAuth(model.provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(model.provider, sessionId, { baseUrl: model.baseUrl, modelId: model.id });
	}

	/**
	 * Get API key for a provider (e.g., "openai").
	 */
	async getApiKeyForProvider(provider: string, sessionId?: string, baseUrl?: string): Promise<string | undefined> {
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(provider, sessionId, { baseUrl });
	}

	async #peekApiKeyForProvider(provider: string): Promise<string | undefined> {
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.peekApiKey(provider);
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
	}

	/**
	 * Remove custom API/OAuth registrations for a specific extension source.
	 */
	clearSourceRegistrations(sourceId: string): void {
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
		if (!sourceProviders || sourceProviders.size === 0) {
			return;
		}
		this.#runtimeProvidersBySource.delete(sourceId);
		for (const providerName of sourceProviders) {
			if (this.#runtimeProviderSourceByName.get(providerName) !== sourceId) {
				continue;
			}
			this.#runtimeProviderSourceByName.delete(providerName);
			this.#clearRuntimeProviderState(providerName);
		}
		this.#reloadStaticModels();
		this.#rebuildCanonicalIndex();
	}

	/**
	 * Remove registrations for extension sources that are no longer active.
	 */
	syncExtensionSources(activeSourceIds: string[]): void {
		const activeSources = new Set(activeSourceIds);
		for (const sourceId of this.#registeredProviderSources) {
			if (activeSources.has(sourceId)) {
				continue;
			}
			this.clearSourceRegistrations(sourceId);
			this.#registeredProviderSources.delete(sourceId);
		}
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has streamSimple: registers a custom API streaming function.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		validateProviderConfiguration(
			providerName,
			{
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				api: config.api,
				oauthConfigured: Boolean(config.oauth),
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);

		if (config.streamSimple && config.api) {
			const streamSimple = config.streamSimple;
			registerCustomApi(config.api, streamSimple, sourceId, (model, context, options) =>
				streamSimple(model, context, options as SimpleStreamOptions),
			);
		}

		if (config.oauth) {
			registerOAuthProvider({
				...config.oauth,
				id: providerName,
				sourceId,
			});
		}

		let sourceHandoff = false;
		if (sourceId) {
			this.#registeredProviderSources.add(sourceId);
			const previousSourceId = this.#runtimeProviderSourceByName.get(providerName);
			if (previousSourceId && previousSourceId !== sourceId) {
				const previousProviders = this.#runtimeProvidersBySource.get(previousSourceId);
				previousProviders?.delete(providerName);
				if (previousProviders && previousProviders.size === 0) {
					this.#runtimeProvidersBySource.delete(previousSourceId);
				}
				this.#clearRuntimeProviderState(providerName);
				sourceHandoff = true;
			}
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId) ?? new Set<string>();
			sourceProviders.add(providerName);
			this.#runtimeProvidersBySource.set(sourceId, sourceProviders);
			this.#runtimeProviderSourceByName.set(providerName, sourceId);
		}
		if (sourceHandoff) {
			this.#reloadStaticModels();
		}

		if (config.apiKey) {
			this.#customProviderApiKeys.set(providerName, config.apiKey);
			// Persist runtime API keys so they survive #reloadStaticModels() cycles
			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
		}

		if (config.models && config.models.length > 0) {
			// Build model overlays that persist across refresh() cycles
			const newOverlays: CustomModelOverlay[] = [];
			for (const modelDef of config.models) {
				const overlay = buildCustomModelOverlay(
					providerName,
					config.baseUrl!,
					config.api,
					config.headers,
					config.apiKey,
					config.authHeader,
					config.compat,
					modelDef as CustomModelDefinitionLike,
				);
				if (!overlay) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
				}
				newOverlays.push(overlay);
			}
			// Store as runtime overlays so they survive #reloadStaticModels()
			this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(m => m.provider !== providerName);
			this.#runtimeModelOverlays.push(...newOverlays);

			// Also update #models immediately for the current cycle
			const nextModels = this.#models.filter(m => m.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const withRuntimeTransportOverride = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverride(model, runtimeTransportOverride);
					})
				: nextModels;

			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.getOAuthCredential(providerName);
				if (credential) {
					this.#models = config.oauth.modifyModels(withRuntimeTransportOverride, credential);
					this.#rebuildCanonicalIndex();
					return;
				}
			}

			this.#models = withRuntimeTransportOverride;
			this.#rebuildCanonicalIndex();
			return;
		}

		if (config.baseUrl || config.headers) {
			const transportOverride = { baseUrl: config.baseUrl, headers: config.headers };
			const nextRuntimeOverride = this.#mergeProviderOverride(
				this.#runtimeProviderOverrides.get(providerName),
				transportOverride,
			);
			this.#runtimeProviderOverrides.set(providerName, nextRuntimeOverride);
			this.#models = this.#models.map(m => {
				if (m.provider !== providerName) return m;
				return this.#applyProviderTransportOverride(m, transportOverride);
			});
			this.#rebuildCanonicalIndex();
		}
	}

	/**
	 * Suppress a specific model selector (e.g., "provider/id") until a specific timestamp.
	 */
	suppressSelector(selector: string, untilMs: number): void {
		this.#suppressedSelectors.set(normalizeSuppressedSelector(selector), untilMs);
	}

	/**
	 * Check if a model selector is currently suppressed due to rate limits.
	 */
	isSelectorSuppressed(selector: string): boolean {
		const normalizedSelector = normalizeSuppressedSelector(selector);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return false;
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return false;
		}
		return true;
	}
}

/**
 * Input type for registerProvider API (from extensions).
 */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	authHeader?: boolean;
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinking?: ThinkingConfig;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
		contextPromotionTarget?: string;
		premiumMultiplier?: number;
	}>;
}
