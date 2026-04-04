import { StatusAPI } from "./api";
import { AUTO_PROVIDERS, MODEL_PREFIX_MAP, normalizeProviderSlug } from "./defaults";
import { AllProvidersDown, ProviderCallFailed } from "./errors";
import { HealthTracker } from "./gateway/health";
import { readEnv } from "./http";
import { CostCalculator } from "./pricing";
import { getConfig } from "./config";
import { UsageUploader } from "./uploader";
import { UsageTracker } from "./usage";
import type {
  Middleware,
  BeforeRequestContext,
  AfterResponseContext,
} from "./middleware";
import type {
  ChatMessage,
  ProviderCallOptions,
  ProviderConfig,
  RouteOptions,
  RouteResponse as RouteResponseShape,
  StreamChunk,
} from "./models";
import { RouteResponse } from "./models";
import { createAdapter, type ProviderAdapter } from "./providers/base";

export interface RouterOptions {
  baseUrl?: string;
  checkTimeout?: number;
  providers?: string[];
  autoDiscover?: boolean;
  /** Enable health tracking across route() calls (default: true). */
  healthTracking?: boolean;
  /** Middleware hooks executed on each route() call */
  middleware?: Middleware[];
}

export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onError?: (error: Error) => void;
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  }) => void;
  onComplete?: () => void;
}

interface Candidate {
  providerSlug: string;
  modelId: string;
}

interface ResolvedCandidate extends Candidate {
  adapterKey: string;
}

const DEFAULT_RETRY_DELAY = 1000;

export class Router {
  readonly api: StatusAPI;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly adapterIndex = new Map<string, string>();
  private readonly tiers = new Map<string, string[]>();
  private readonly health: HealthTracker | null;
  private readonly middleware: Middleware[];
  private readonly pricing: CostCalculator;
  private readonly usage: UsageTracker;

  constructor(options: RouterOptions = {}) {
    this.api = new StatusAPI(
      options.baseUrl,
      options.checkTimeout ?? 3,
    );

    this.health = options.healthTracking !== false ? new HealthTracker() : null;
    this.middleware = options.middleware ?? [];
    this.pricing = new CostCalculator();
    this.usage = new UsageTracker(undefined, new UsageUploader(getConfig()));

    if (options.autoDiscover !== false) {
      this.autoDiscover(options.providers);
    }
  }

  use(mw: Middleware): void {
    this.middleware.push(mw);
  }

  registerProvider(config: ProviderConfig): void {
    const adapter = createAdapter(config);
    this.adapters.set(adapter.slug, adapter);
    this.indexAdapter(adapter);
  }

  addTier(name: string, models: string[]): void {
    this.tiers.set(name, [...models]);
  }

  async route(
    messages: string | ChatMessage[],
    options: RouteOptions = {},
  ): Promise<RouteResponseShape> {
    const normalizedMessages = this.normalizeMessages(messages, options.system);
    const callOptions = this.extractCallOptions(options);

    if (!options.model && !options.tier) {
      throw new Error("Either 'model' or 'tier' must be specified");
    }

    if (options.tier) {
      return this.routeTier(normalizedMessages, options.tier, options, callOptions);
    }

    return this.routeModel(
      normalizedMessages,
      options.model as string,
      options,
      callOptions,
    );
  }

  async aroute(
    messages: string | ChatMessage[],
    options: RouteOptions = {},
  ): Promise<RouteResponseShape> {
    return this.route(messages, options);
  }

  async *routeStream(
    messages: string | ChatMessage[],
    options: RouteOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const normalizedMessages = this.normalizeMessages(messages, options.system);
    const callOptions = this.extractCallOptions(options);

    if (!options.model && !options.tier) {
      throw new Error("Either 'model' or 'tier' must be specified");
    }

    const model = options.model as string;
    const candidates = await this.resolveModel(model, options.prefer);

    if (candidates.length === 0) {
      throw new AllProvidersDown([`no adapter for model '${model}'`]);
    }

    for (const candidate of candidates) {
      const adapter = this.adapters.get(candidate.adapterKey);
      if (!adapter) continue;

      // Skip unhealthy providers
      if (this.health && !this.health.isHealthy(candidate.providerSlug)) continue;

      try {
        if (adapter.callStream) {
          // Use native streaming
          yield* adapter.callStream(
            candidate.modelId,
            normalizedMessages,
            options.timeout ?? 30,
            callOptions,
          );
          if (this.health) this.health.recordSuccess(candidate.providerSlug);
          return;
        }

        // Fallback: call() then emit as chunks
        const response = await adapter.call(
          candidate.modelId,
          normalizedMessages,
          options.timeout ?? 30,
          callOptions,
        );
        if (this.health) this.health.recordSuccess(candidate.providerSlug);

        yield { type: "text", text: response.content };
        yield {
          type: "usage",
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cacheCreationInputTokens: response.cacheCreationInputTokens,
          cacheReadInputTokens: response.cacheReadInputTokens,
        };
        yield { type: "done" };
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (this.health && status) {
          this.health.recordError(candidate.providerSlug, status);
        }
        if (options.allowFallback === false) {
          yield {
            type: "error" as const,
            error: error instanceof Error ? error : new Error(String(error)),
          };
          return;
        }
      }
    }

    throw new AllProvidersDown([`no streaming adapter for model '${model}'`]);
  }

  async routeStreamCallbacks(
    messages: string | ChatMessage[],
    options: RouteOptions & { callbacks: StreamCallbacks },
  ): Promise<void> {
    const { callbacks, ...routeOptions } = options;
    const stream = this.routeStream(messages, routeOptions);

    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case "text":
            callbacks.onToken?.(chunk.text ?? "");
            break;
          case "error":
            callbacks.onError?.(chunk.error ?? new Error("Unknown streaming error"));
            break;
          case "usage":
            callbacks.onUsage?.({
              inputTokens: chunk.inputTokens ?? 0,
              outputTokens: chunk.outputTokens ?? 0,
              cacheCreationInputTokens: chunk.cacheCreationInputTokens ?? 0,
              cacheReadInputTokens: chunk.cacheReadInputTokens ?? 0,
            });
            break;
          case "done":
            callbacks.onComplete?.();
            break;
        }
      }
    } catch (error) {
      if (callbacks.onError) {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      } else {
        throw error;
      }
    }
  }

  // ------------------------------------------------------------------
  // Private methods
  // ------------------------------------------------------------------

  private autoDiscover(only?: string[]): void {
    for (const [slug, spec] of Object.entries(AUTO_PROVIDERS)) {
      if (only && !only.includes(slug)) {
        continue;
      }

      if (!readEnv(spec.envVar)) {
        continue;
      }

      this.registerProvider({
        slug,
        adapterType: spec.adapterType,
        env: spec.envVar,
        aliases: spec.aliases,
      });
    }
  }

  private indexAdapter(adapter: ProviderAdapter): void {
    this.adapterIndex.set(adapter.slug, adapter.slug);
    for (const alias of adapter.aliases) {
      this.adapterIndex.set(alias, adapter.slug);
    }
  }

  private normalizeMessages(
    messages: string | ChatMessage[],
    system?: string,
  ): ChatMessage[] {
    const normalized = typeof messages === "string"
      ? [{ role: "user", content: messages }]
      : [...messages];

    if (system) {
      normalized.unshift({ role: "system", content: system });
    }

    return normalized;
  }

  private extractCallOptions(options: RouteOptions): ProviderCallOptions {
    const {
      model: _model,
      tier: _tier,
      system: _system,
      allowFallback: _allowFallback,
      timeout: _timeout,
      prefer: _prefer,
      modelFallbacks: _modelFallbacks,
      retryOnRateLimit: _retryOnRateLimit,
      retryDelay: _retryDelay,
      maxTokens,
      temperature,
      topP,
      responseFormat,
      providerOptions,
      headers,
      signal,
      ...extraProviderOptions
    } = options;

    return {
      maxTokens,
      temperature,
      topP,
      responseFormat,
      providerOptions: {
        ...extraProviderOptions,
        ...(providerOptions ?? {}),
      },
      headers,
      signal,
    };
  }

  private async resolveModel(
    model: string,
    prefer?: string[],
  ): Promise<ResolvedCandidate[]> {
    try {
      const check = await this.api.checkModel(model);
      const primaryProvider =
        check.provider || this.guessProvider(model)[0]?.providerSlug;
      const primary: Candidate = {
        providerSlug: primaryProvider,
        modelId: check.model ?? model,
      };
      const alternatives = check.alternatives
        .filter((alternative) => alternative.status === "operational")
        .map<Candidate>((alternative) => ({
          providerSlug: alternative.slug,
          modelId: alternative.suggestedModel || model,
        }));
      const ordered = check.isAvailable
        ? [primary, ...alternatives]
        : [...alternatives, primary];

      return this.sortAndBindCandidates(ordered, prefer);
    } catch {
      return this.sortAndBindCandidates(this.guessProvider(model), prefer);
    }
  }

  private guessProvider(model: string): Candidate[] {
    const normalizedModel = model.toLowerCase();
    const directProvider = normalizeProviderSlug(model.split("/", 1)[0]);

    if (model.includes("/") && this.adapterIndex.has(directProvider)) {
      return [{ providerSlug: directProvider, modelId: model }];
    }

    for (const [prefix, providerSlug] of Object.entries(MODEL_PREFIX_MAP)) {
      if (normalizedModel.startsWith(prefix)) {
        return [{ providerSlug, modelId: model }];
      }
    }

    return Array.from(this.adapters.keys()).map((adapterKey) => ({
      providerSlug: adapterKey,
      modelId: model,
    }));
  }

  private sortAndBindCandidates(
    candidates: Candidate[],
    prefer?: string[],
  ): ResolvedCandidate[] {
    const preferOrder = (prefer ?? []).map((item) => normalizeProviderSlug(item));
    const resolved = candidates
      .map<ResolvedCandidate | null>((candidate) => {
        const providerSlug = normalizeProviderSlug(candidate.providerSlug);
        const adapterKey = this.adapterIndex.get(providerSlug);

        if (!adapterKey) {
          return null;
        }

        return {
          providerSlug,
          adapterKey,
          modelId: candidate.modelId,
        };
      })
      .filter((candidate): candidate is ResolvedCandidate => candidate !== null);

    resolved.sort((left, right) => {
      if (preferOrder.length === 0) {
        return 0;
      }

      return preferenceScore(left, preferOrder) - preferenceScore(right, preferOrder);
    });

    return dedupeCandidates(resolved);
  }

  private async routeModel(
    messages: ChatMessage[],
    model: string,
    options: RouteOptions,
    callOptions: ProviderCallOptions,
  ): Promise<RouteResponseShape> {
    const candidates = await this.resolveModel(model, options.prefer);

    if (candidates.length === 0) {
      throw new AllProvidersDown([`no adapter for model '${model}'`]);
    }

    const tried: string[] = [];
    const first = candidates[0];
    const shouldRetry = options.retryOnRateLimit !== false;
    const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;

    for (const candidate of candidates) {
      const adapter = this.adapters.get(candidate.adapterKey);

      if (!adapter) {
        continue;
      }

      // Skip providers in health cooldown
      if (this.health && !this.health.isHealthy(candidate.providerSlug)) {
        tried.push(`${candidate.providerSlug}[cooldown]`);
        continue;
      }

      try {
        const t0 = Date.now();

        // Execute beforeRequest middleware
        for (const mw of this.middleware) {
          if (mw.beforeRequest) {
            await mw.beforeRequest({
              messages,
              options,
              callOptions,
              provider: candidate.providerSlug,
              model: candidate.modelId,
            });
          }
        }

        const response = await adapter.call(
          candidate.modelId,
          messages,
          options.timeout ?? 30,
          callOptions,
        );

        if (this.health) this.health.recordSuccess(candidate.providerSlug);

        const usedModel = response.modelUsed.includes("/")
          ? response.modelUsed
          : `${candidate.providerSlug}/${response.modelUsed}`;
        const isFallback =
          candidate.providerSlug !== first.providerSlug ||
          candidate.modelId !== first.modelId;

        const routeResponse = new RouteResponse({
          content: response.content,
          modelUsed: usedModel,
          providerUsed: candidate.providerSlug,
          wasFallback: isFallback,
          fallbackReason: isFallback
            ? `${first.providerSlug} unavailable`
            : null,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cacheCreationInputTokens: response.cacheCreationInputTokens,
          cacheReadInputTokens: response.cacheReadInputTokens,
          costUsd: response.costUsd,
          raw: response.raw,
        });

        // Execute afterResponse middleware
        const latencyMs = Date.now() - t0;
        for (const mw of this.middleware) {
          if (mw.afterResponse) {
            await mw.afterResponse({
              response: routeResponse,
              provider: candidate.providerSlug,
              model: candidate.modelId,
              latencyMs,
              wasFallback: isFallback,
            });
          }
        }

        this.recordUsage(routeResponse, candidate.providerSlug, latencyMs, isFallback);
        return routeResponse;
      } catch (error) {
        const status = (error as { status?: number }).status;

        // Record health
        if (this.health && status) {
          this.health.recordError(candidate.providerSlug, status);
        }

        // Execute onError middleware
        for (const mw of this.middleware) {
          if (mw.onError) {
            await mw.onError(error, {
              provider: candidate.providerSlug,
              model: candidate.modelId,
            });
          }
        }

        // Retry on 429 before falling to next candidate
        if (shouldRetry && status === 429) {
          try {
            const t0Retry = Date.now();
            await sleep(retryDelay);

            // Execute beforeRequest middleware for retry
            for (const mw of this.middleware) {
              if (mw.beforeRequest) {
                await mw.beforeRequest({
                  messages,
                  options,
                  callOptions,
                  provider: candidate.providerSlug,
                  model: candidate.modelId,
                });
              }
            }

            const response = await adapter.call(
              candidate.modelId,
              messages,
              options.timeout ?? 30,
              callOptions,
            );

            if (this.health) this.health.recordSuccess(candidate.providerSlug);

            const usedModel = response.modelUsed.includes("/")
              ? response.modelUsed
              : `${candidate.providerSlug}/${response.modelUsed}`;
            const isFallback =
              candidate.providerSlug !== first.providerSlug ||
              candidate.modelId !== first.modelId;

            const routeResponse = new RouteResponse({
              content: response.content,
              modelUsed: usedModel,
              providerUsed: candidate.providerSlug,
              wasFallback: isFallback,
              fallbackReason: isFallback
                ? `${first.providerSlug} unavailable`
                : null,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              cacheCreationInputTokens: response.cacheCreationInputTokens,
              cacheReadInputTokens: response.cacheReadInputTokens,
              costUsd: response.costUsd,
              raw: response.raw,
            });

            // Execute afterResponse middleware for retry path
            const latencyMsRetry = Date.now() - t0Retry;
            for (const mw of this.middleware) {
              if (mw.afterResponse) {
                await mw.afterResponse({
                  response: routeResponse,
                  provider: candidate.providerSlug,
                  model: candidate.modelId,
                  latencyMs: latencyMsRetry,
                  wasFallback: isFallback,
                });
              }
            }

            this.recordUsage(routeResponse, candidate.providerSlug, latencyMsRetry, isFallback);
            return routeResponse;
          } catch (retryError) {
            const retryStatus = (retryError as { status?: number }).status;
            if (this.health && retryStatus) {
              this.health.recordError(candidate.providerSlug, retryStatus);
            }

            // Execute onError middleware for retry failure
            for (const mw of this.middleware) {
              if (mw.onError) {
                await mw.onError(retryError, {
                  provider: candidate.providerSlug,
                  model: candidate.modelId,
                });
              }
            }

            tried.push(`${candidate.providerSlug}[retry-failed]`);
          }
        } else {
          tried.push(`${candidate.providerSlug}[error]`);
        }

        if (options.allowFallback === false) {
          throw new ProviderCallFailed(
            candidate.providerSlug,
            candidate.modelId,
            error,
          );
        }
      }
    }

    // Model fallback: try alternative models
    const fallbacks = options.modelFallbacks?.[model];
    if (fallbacks && fallbacks.length > 0) {
      for (const fallbackModel of fallbacks) {
        try {
          return await this.routeModel(
            messages,
            fallbackModel,
            { ...options, modelFallbacks: undefined },
            callOptions,
          );
        } catch (error) {
          if (error instanceof AllProvidersDown) {
            tried.push(...error.tried);
            continue;
          }
          if (error instanceof ProviderCallFailed && options.allowFallback === false) {
            throw error;
          }
        }
      }
    }

    throw new AllProvidersDown(tried);
  }

  private async routeTier(
    messages: ChatMessage[],
    tier: string,
    options: RouteOptions,
    callOptions: ProviderCallOptions,
  ): Promise<RouteResponseShape> {
    const models = this.tiers.get(tier);

    if (!models) {
      throw new Error(
        `Tier '${tier}' not configured. Use router.addTier('${tier}', ['model-a']) first.`,
      );
    }

    const tried: string[] = [];

    for (const model of models) {
      try {
        return await this.routeModel(messages, model, options, callOptions);
      } catch (error) {
        if (error instanceof AllProvidersDown) {
          tried.push(...error.tried);
          continue;
        }

        if (error instanceof ProviderCallFailed && options.allowFallback === false) {
          throw error;
        }
      }
    }

    throw new AllProvidersDown(tried);
  }
  private recordUsage(
    response: RouteResponse,
    provider: string,
    latencyMs: number,
    wasFallback: boolean,
  ): void {
    const model = response.modelUsed || `${provider}/unknown`;
    const cost = response.costUsd > 0
      ? response.costUsd
      : ((response.cacheCreationInputTokens > 0 || response.cacheReadInputTokens > 0)
        ? this.pricing.calculateCostWithCache(
            provider,
            model,
            response.inputTokens,
            response.outputTokens,
            response.cacheCreationInputTokens,
            response.cacheReadInputTokens,
          )
        : this.pricing.calculateCost(provider, model, response.inputTokens, response.outputTokens));

    this.usage.recordUsage({
      provider,
      model,
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
      cache_creation_input_tokens: response.cacheCreationInputTokens,
      cache_read_input_tokens: response.cacheReadInputTokens,
      latency_ms: latencyMs,
      fallback: wasFallback,
      cost,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preferenceScore(
  candidate: ResolvedCandidate,
  preferOrder: string[],
): number {
  const providerIndex = preferOrder.indexOf(candidate.providerSlug);
  if (providerIndex !== -1) {
    return providerIndex;
  }

  const adapterIndex = preferOrder.indexOf(candidate.adapterKey);
  if (adapterIndex !== -1) {
    return adapterIndex;
  }

  return preferOrder.length;
}

function dedupeCandidates(candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const seen = new Set<string>();
  const result: ResolvedCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.adapterKey}:${candidate.modelId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(candidate);
  }

  return result;
}
