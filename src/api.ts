import { extractProviderSlug, normalizeProviderSlug } from "./defaults";
import { HTTPStatusError, fetchJson, isRecord } from "./http";
import {
  CheckResult,
  type Alternative,
  type ModelInfo,
  type ProviderStatus,
  Status,
} from "./models";

const BASE_URL = "https://aistatus.cc";

export class StatusAPI {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl = BASE_URL, timeoutSeconds = 3) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutSeconds * 1_000;
  }

  async checkProvider(slug: string): Promise<CheckResult> {
    const data = await this.get("/api/check", {
      provider: slug,
    });
    return this.parseCheck(data);
  }

  async checkModel(modelId: string): Promise<CheckResult> {
    const data = await this.get("/api/check", {
      model: modelId,
    });
    return this.parseCheck(data);
  }

  async acheckProvider(slug: string): Promise<CheckResult> {
    return this.checkProvider(slug);
  }

  async acheckModel(modelId: string): Promise<CheckResult> {
    return this.checkModel(modelId);
  }

  async providers(): Promise<ProviderStatus[]> {
    const data = await this.get("/api/providers");
    const providers = Array.isArray(data.providers) ? data.providers : [];

    return providers
      .map((provider) => this.parseProviderStatus(provider))
      .filter((provider): provider is ProviderStatus => provider !== null);
  }

  async model(modelId: string): Promise<ModelInfo | null> {
    try {
      const data = await this.get(`/api/models/${encodeURI(modelId)}`);
      return this.parseModel(data);
    } catch (error) {
      if (error instanceof HTTPStatusError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async searchModels(query: string): Promise<ModelInfo[]> {
    const data = await this.get("/api/models", {
      q: query,
    });
    const models = Array.isArray(data.models) ? data.models : [];

    return models
      .map((model) => this.parseModel(model))
      .filter((model): model is ModelInfo => model !== null);
  }

  private async get(
    path: string,
    params?: Record<string, string | undefined>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    return fetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: this.timeoutMs,
    });
  }

  private parseCheck(data: Record<string, unknown>): CheckResult {
    const model = asString(data.model) ?? null;
    const provider =
      normalizeProviderSlug(
        asString(data.provider) ??
          asString(data.slug) ??
          extractProviderSlug(model) ??
          "",
      ) || "";
    const status = parseStatus(
      asString(data.status) ??
        asString(data.providerStatus) ??
        availableToStatus(data.available),
    );
    const alternatives = Array.isArray(data.alternatives)
      ? data.alternatives
          .map((alternative) => parseAlternative(alternative))
          .filter((alternative): alternative is Alternative => alternative !== null)
      : [];

    return new CheckResult({
      provider,
      status,
      statusDetail:
        asString(data.statusDetail) ?? asString(data.providerStatusDetail) ?? null,
      model,
      alternatives,
    });
  }

  private parseProviderStatus(value: unknown): ProviderStatus | null {
    if (!isRecord(value)) {
      return null;
    }

    return {
      slug: normalizeProviderSlug(asString(value.slug) ?? ""),
      name: asString(value.name) ?? asString(value.slug) ?? "",
      status: parseStatus(asString(value.status)),
      statusDetail: asString(value.statusDetail) ?? null,
      modelCount: asNumber(value.modelCount),
    };
  }

  private parseModel(value: unknown): ModelInfo | null {
    if (!isRecord(value)) {
      return null;
    }

    const pricing = isRecord(value.pricing) ? value.pricing : {};
    const provider = isRecord(value.provider) ? value.provider : {};

    return {
      id: asString(value.id) ?? "",
      name: asString(value.name) ?? "",
      providerSlug: normalizeProviderSlug(
        asString(provider.slug) ??
          extractProviderSlug(asString(value.id) ?? "") ??
          "",
      ),
      contextLength: asNumber(value.context_length),
      modality: asString(value.modality) ?? "text->text",
      promptPrice: asFloat(pricing.prompt),
      completionPrice: asFloat(pricing.completion),
    };
  }
}

function parseAlternative(value: unknown): Alternative | null {
  if (!isRecord(value)) {
    return null;
  }

  const suggestedModel =
    asString(value.suggestedModel) ??
    asString(value.model) ??
    asString(value.id) ??
    "";
  const slug = normalizeProviderSlug(
    asString(value.slug) ??
      asString(value.provider) ??
      extractProviderSlug(suggestedModel) ??
      "",
  );

  return {
    slug,
    name: asString(value.name) ?? slug,
    status: parseStatus(
      asString(value.status) ??
        asString(value.providerStatus) ??
        availableToStatus(value.available),
    ),
    suggestedModel,
  };
}

function availableToStatus(value: unknown): string | undefined {
  if (value === true) {
    return Status.OPERATIONAL;
  }

  if (value === false) {
    return Status.DOWN;
  }

  return undefined;
}

function parseStatus(value: string | undefined): Status {
  switch (value) {
    case Status.OPERATIONAL:
      return Status.OPERATIONAL;
    case Status.DEGRADED:
      return Status.DEGRADED;
    case Status.DOWN:
      return Status.DOWN;
    default:
      return Status.UNKNOWN;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function asFloat(value: unknown): number {
  return asNumber(value);
}
