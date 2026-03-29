// input: ChatMessage, ProviderCallOptions, RouteOptions, RouteResponse types from models
// output: Middleware interface with beforeRequest, afterResponse, onError hooks
// pos: middleware hook definitions for request/response interception in the Router
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import type {
  ChatMessage,
  ProviderCallOptions,
  RouteOptions,
  RouteResponse,
} from "./models";

/** Context passed to beforeRequest hooks */
export interface BeforeRequestContext {
  messages: ChatMessage[];
  options: RouteOptions;
  callOptions: ProviderCallOptions;
  /** The provider slug about to be called (set during candidate iteration) */
  provider?: string;
  /** The model ID about to be called */
  model?: string;
}

/** Context passed to afterResponse hooks */
export interface AfterResponseContext {
  response: RouteResponse;
  provider: string;
  model: string;
  /** Wall-clock time in ms */
  latencyMs: number;
  /** Was this a fallback route? */
  wasFallback: boolean;
}

/** A middleware function that can intercept requests/responses */
export interface Middleware {
  /** Called before each provider call. Can modify context or throw to abort. */
  beforeRequest?: (ctx: BeforeRequestContext) => void | Promise<void>;
  /** Called after a successful response. Can modify or log the response. */
  afterResponse?: (ctx: AfterResponseContext) => void | Promise<void>;
  /** Called when a provider call fails (before fallback). For logging/metrics. */
  onError?: (
    error: unknown,
    ctx: { provider: string; model: string },
  ) => void | Promise<void>;
}
