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
  type MessageRole,
  type ModelInfo,
  type ProviderCallOptions,
  type ProviderConfig,
  type ProviderStatus,
  type RouteConfig,
  type RouteOptions,
} from "./models";
export { Router, type RouterOptions } from "./router";
export { ProviderAdapter, createAdapter, registerAdapterType } from "./providers/base";

export const VERSION = "0.0.2";

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
