// input: provider adapter registrations plus route/status/usage/pricing/config modules from the SDK runtime
// output: public aistatus SDK exports, default router helpers, version constant, and persistent upload config helpers for consumers
// pos: root SDK module that wires provider registrations and exposes the package's main API surface
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import "./providers/openai";
import "./providers/openrouter";
import "./providers/anthropic";
import "./providers/google";
import "./providers/compatible";

import { Router } from "./router";

export { StatusAPI } from "./api";
export {
  AIStatusError,
  AllProvidersDown,
  CheckAPIUnreachable,
  NoBudgetMatch,
  ProviderCallFailed,
  ProviderNotConfigured,
  ProviderNotInstalled,
} from "./errors";
export {
  CheckResult,
  RouteResponse,
  Status,
  type Alternative,
  type ChatMessage,
  type ContentBlock,
  type ImageBase64Block,
  type ImageUrlBlock,
  type MessageRole,
  type ModelInfo,
  type ProviderCallOptions,
  type ProviderConfig,
  type ProviderStatus,
  type ResponseFormat,
  type RouteConfig,
  type RouteOptions,
  type RouteResponseInit,
  type StreamChunk,
  type TextBlock,
} from "./models";
export { Router, type RouterOptions, type StreamCallbacks } from "./router";
export { streamToReadable } from "./stream";
export { ProviderAdapter, createAdapter, registerAdapterType } from "./providers/base";
export { extractTextFromContent, normalizeContent } from "./content";
export { UsageTracker, UsageStorage } from "./usage";
export {
  configure,
  getConfig,
  loadFromFile,
  saveToFile,
  type AIStatusConfig,
} from "./config";
export { CostCalculator } from "./pricing";
export type { Middleware, BeforeRequestContext, AfterResponseContext } from "./middleware";

export const VERSION = "0.0.3";

let defaultRouter: Router | null = null;

function getDefaultRouter(): Router {
  defaultRouter ??= new Router();
  return defaultRouter;
}

export async function route(
  messages: string | import("./models").ChatMessage[],
  options: import("./models").RouteOptions = {},
) {
  return getDefaultRouter().route(messages, options);
}

export async function aroute(
  messages: string | import("./models").ChatMessage[],
  options: import("./models").RouteOptions = {},
) {
  return route(messages, options);
}
