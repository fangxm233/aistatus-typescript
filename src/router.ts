import { StatusAPI } from "./api";
import { AUTO_PROVIDERS, MODEL_PREFIX_MAP, normalizeProviderSlug } from "./defaults";
import { AllProvidersDown, ProviderCallFailed } from "./errors";
import { readEnv } from "./http";
import type {
  ChatMessage,
  ProviderCallOptions,
  ProviderConfig,
  RouteOptions,
  RouteResponse as RouteResponseShape,
} from "./models";
import { RouteResponse } from "./models";
import { createAdapter, type ProviderAdapter } from "./providers/base";

export interface RouterOptions {
  baseUrl?: string;
  checkTimeout?: number;
  providers?: string[];
  autoDiscover?: boolean;
}

interface Candidate {
  providerSlug: string;
  modelId: string;
}

interface ResolvedCandidate extends Candidate {
  adapterKey: string;
}

export class Router {
  readonly api: StatusAPI;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly adapterIndex = new Map<string, string>();
  private readonly tiers = new Map<string, string[]>();

  constructor(options: RouterOptions = {}) {
    this.api = new StatusAPI(
      options.baseUrl,
      options.checkTimeout ?? 3,
    );

    if (options.autoDiscover !== false) {
      this.autoDiscover(options.providers);
    }
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
      maxTokens,
      temperature,
      topP,
      providerOptions,
      headers,
      signal,
      ...extraProviderOptions
    } = options;

    return {
      maxTokens,
      temperature,
      topP,
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

    for (const candidate of candidates) {
      const adapter = this.adapters.get(candidate.adapterKey);

      if (!adapter) {
        continue;
      }

      try {
        const response = await adapter.call(
          candidate.modelId,
          messages,
          options.timeout ?? 30,
          callOptions,
        );
        const usedModel = response.modelUsed.includes("/")
          ? response.modelUsed
          : `${candidate.providerSlug}/${response.modelUsed}`;
        const isFallback =
          candidate.providerSlug !== first.providerSlug ||
          candidate.modelId !== first.modelId;

        return new RouteResponse({
          content: response.content,
          modelUsed: usedModel,
          providerUsed: candidate.providerSlug,
          wasFallback: isFallback,
          fallbackReason: isFallback
            ? `${first.providerSlug} unavailable`
            : null,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: response.costUsd,
          raw: response.raw,
        });
      } catch (error) {
        tried.push(`${candidate.providerSlug}[error]`);

        if (options.allowFallback === false) {
          throw new ProviderCallFailed(
            candidate.providerSlug,
            candidate.modelId,
            error,
          );
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
