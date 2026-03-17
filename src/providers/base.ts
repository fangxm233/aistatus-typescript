import { normalizeProviderSlug } from "../defaults";
import type {
  ChatMessage,
  ProviderCallOptions,
  ProviderConfig,
  RouteResponse,
} from "../models";

export abstract class ProviderAdapter {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      ...config,
      slug: normalizeProviderSlug(config.slug),
      aliases: (config.aliases ?? []).map((alias) => normalizeProviderSlug(alias)),
    };
  }

  get slug(): string {
    return this.config.slug;
  }

  get aliases(): string[] {
    return this.config.aliases ?? [];
  }

  supportsProvider(slug: string): boolean {
    const normalized = normalizeProviderSlug(slug);
    return normalized === this.slug || this.aliases.includes(normalized);
  }

  stripProvider(modelId: string): string {
    if (!modelId.includes("/")) {
      return modelId;
    }

    return modelId.slice(modelId.indexOf("/") + 1);
  }

  abstract call(
    modelId: string,
    messages: ChatMessage[],
    timeoutSeconds: number,
    options: ProviderCallOptions,
  ): Promise<RouteResponse>;
}

type ProviderAdapterConstructor = new (config: ProviderConfig) => ProviderAdapter;

const ADAPTER_TYPES = new Map<string, ProviderAdapterConstructor>();

export function registerAdapterType(
  typeName: string,
  ctor: ProviderAdapterConstructor,
): void {
  ADAPTER_TYPES.set(typeName.toLowerCase(), ctor);
}

export function createAdapter(config: ProviderConfig): ProviderAdapter {
  const ctor = ADAPTER_TYPES.get(config.adapterType.toLowerCase());

  if (!ctor) {
    throw new Error(`Unknown adapter type: ${config.adapterType}`);
  }

  return new ctor(config);
}
