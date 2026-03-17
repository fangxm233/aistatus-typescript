export enum Status {
  OPERATIONAL = "operational",
  DEGRADED = "degraded",
  DOWN = "down",
  UNKNOWN = "unknown",
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole | (string & {});
  content: string;
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

export interface ProviderCallOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
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
    this.costUsd = init.costUsd ?? 0;
    this.raw = init.raw ?? null;
  }

  toString(): string {
    return this.content;
  }
}
