export enum Status {
  OPERATIONAL = "operational",
  DEGRADED = "degraded",
  DOWN = "down",
  UNKNOWN = "unknown",
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type TextBlock = { type: "text"; text: string };
export type ImageUrlBlock = { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
export type ImageBase64Block = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
export type ContentBlock = TextBlock | ImageUrlBlock | ImageBase64Block;

export interface ChatMessage {
  role: MessageRole | (string & {});
  content: string | ContentBlock[];
  name?: string;
  toolCallId?: string;
}

export interface ProviderConfig {
  slug: string;
  adapterType: string;
  apiKey?: string;
  env?: string;
  baseUrl?: string;
  aliases?: string[];
  headers?: Record<string, string>;
}

export interface RouteConfig {
  tier?: string;
  model?: string;
  prefer?: string[];
  allowFallback?: boolean;
  providerTimeout?: number;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

export interface ProviderCallOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: ResponseFormat;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RouteOptions extends ProviderCallOptions {
  model?: string;
  tier?: string;
  system?: string;
  allowFallback?: boolean;
  timeout?: number;
  prefer?: string[];
  /** Model fallback chains: when all providers fail for a model, try the next model. */
  modelFallbacks?: Record<string, string[]>;
  /** Retry on 429 before falling to next candidate (default: true). */
  retryOnRateLimit?: boolean;
  /** Delay in ms before retrying on 429 (default: 1000). */
  retryDelay?: number;
  [key: string]: unknown;
}

export interface Alternative {
  slug: string;
  name: string;
  status: Status;
  suggestedModel: string;
}

export class CheckResult {
  provider: string;
  status: Status;
  statusDetail: string | null;
  model: string | null;
  alternatives: Alternative[];

  constructor(init: {
    provider: string;
    status: Status;
    statusDetail?: string | null;
    model?: string | null;
    alternatives?: Alternative[];
  }) {
    this.provider = init.provider;
    this.status = init.status;
    this.statusDetail = init.statusDetail ?? null;
    this.model = init.model ?? null;
    this.alternatives = init.alternatives ?? [];
  }

  get isAvailable(): boolean {
    return this.status === Status.OPERATIONAL;
  }
}

export interface ModelInfo {
  id: string;
  name: string;
  providerSlug: string;
  contextLength: number;
  modality: string;
  promptPrice: number;
  completionPrice: number;
}

export interface ProviderStatus {
  slug: string;
  name: string;
  status: Status;
  statusDetail: string | null;
  modelCount: number;
}

export interface RouteResponseInit {
  content: string;
  modelUsed: string;
  providerUsed: string;
  wasFallback: boolean;
  fallbackReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  raw?: unknown;
}

export class RouteResponse {
  content: string;
  modelUsed: string;
  providerUsed: string;
  wasFallback: boolean;
  fallbackReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  raw: unknown;

  constructor(init: RouteResponseInit) {
    this.content = init.content;
    this.modelUsed = init.modelUsed;
    this.providerUsed = init.providerUsed;
    this.wasFallback = init.wasFallback;
    this.fallbackReason = init.fallbackReason ?? null;
    this.inputTokens = init.inputTokens ?? 0;
    this.outputTokens = init.outputTokens ?? 0;
    this.cacheCreationInputTokens = init.cacheCreationInputTokens ?? 0;
    this.cacheReadInputTokens = init.cacheReadInputTokens ?? 0;
    this.costUsd = init.costUsd ?? 0;
    this.raw = init.raw ?? null;
  }

  toString(): string {
    return this.content;
  }
}

/** Chunk emitted by Router.routeStream() */
export interface StreamChunk {
  type: "text" | "usage" | "done" | "error";
  text?: string;
  error?: Error;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
