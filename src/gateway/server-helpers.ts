// input:  HTTP messages, endpoint config, provider payloads
// output: Gateway HTTP, body, model, and usage transforms
// pos:    Pure helpers for the Gateway HTTP runtime
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";

import { AUTH_STYLES, DEFAULT_MAX_BODY_SIZE_MB, type EndpointConfig } from "./config.js";
import type { Backend, GatewayUsage } from "./server-types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "content-encoding", "content-type",
]);
const BYTES_PER_MIB = 1024 * 1024;

export function forwardUpstreamHeaders(upstream: Response, target: Record<string, string>): void {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith("x-gateway-")) return;
    target[key] = value;
  });
}

export function parseUrlMetadata(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) continue;
    result[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
  }
  return result;
}

export function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

export function readBody(
  req: http.IncomingMessage,
  maxBodySizeMb = DEFAULT_MAX_BODY_SIZE_MB,
): Promise<Buffer> {
  const maxBodySizeBytes = maxBodySizeMb * BYTES_PER_MIB;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodySizeBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function extractModel(body: Buffer): string {
  if (body.length === 0) return "";
  try {
    return JSON.parse(body.toString("utf-8")).model ?? "";
  } catch {
    return "";
  }
}

export function primaryBackend(bid: string, endpoint: EndpointConfig, apiKey: string): Backend {
  return {
    id: bid,
    base_url: endpoint.base_url,
    api_key: apiKey,
    auth_style: endpoint.auth_style,
    model_prefix: "",
    model_map: {},
    translate: null,
  };
}

export function extractIncomingKey(req: http.IncomingMessage, authStyle: string): string {
  if (authStyle === "anthropic") return (req.headers["x-api-key"] as string) ?? "";
  if (authStyle === "google") return (req.headers["x-goog-api-key"] as string) ?? "";

  const auth = (req.headers.authorization as string) ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : auth;
}

export function buildUpstreamHeaders(req: http.IncomingMessage, backend: Backend): Record<string, string> {
  const headers: Record<string, string> = {};
  const skip = new Set([
    "host", "authorization", "x-api-key", "x-goog-api-key",
    "content-length", "transfer-encoding", "connection",
  ]);
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skip.has(key.toLowerCase()) && typeof value === "string") headers[key] = value;
  }

  const [headerName, prefix] = AUTH_STYLES[backend.auth_style] ?? AUTH_STYLES.bearer;
  headers[headerName] = prefix + backend.api_key;
  return headers;
}

export function replaceModel(body: Buffer, model: string): Buffer {
  try {
    const data = JSON.parse(body.toString("utf-8"));
    if (!data.model) return body;
    data.model = model;
    return Buffer.from(JSON.stringify(data), "utf-8");
  } catch {
    return body;
  }
}

export function mapModel(body: Buffer, backend: Backend): Buffer {
  try {
    const data = JSON.parse(body.toString("utf-8"));
    const model = data.model;
    if (!model) return body;
    if (model in backend.model_map) data.model = backend.model_map[model];
    else if (backend.model_prefix) data.model = backend.model_prefix + model;
    return Buffer.from(JSON.stringify(data), "utf-8");
  } catch {
    return body;
  }
}

export function parseUsageResponse(responseBody: Buffer, originalModel: string): GatewayUsage | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseBody.toString("utf-8"));
  } catch {
    return null;
  }

  const model = originalModel || (payload.model as string) || "";
  const usage = (payload.usage as Record<string, unknown>) ?? {};
  const parsed = parseUsageFields(model, usage);
  return model || parsed.inputTokens || parsed.outputTokens ? parsed : null;
}

function parseUsageFields(model: string, usage: Record<string, unknown>): GatewayUsage {
  const responses = parseResponsesUsage(model, usage);
  if (responses) return responses;
  return {
    model,
    inputTokens: asInt(usage.input_tokens ?? usage.prompt_tokens ?? 0),
    outputTokens: asInt(usage.output_tokens ?? usage.completion_tokens ?? 0),
    cacheCreationInputTokens: asInt(usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: asInt(usage.cache_read_input_tokens ?? 0),
  };
}

/**
 * Normalize an OpenAI Responses API usage block (`/v1/responses`, ChatGPT Codex backend).
 *
 * Unlike Anthropic — where `input_tokens` counts only the uncached prefix — the Responses API
 * reports a TOTAL `input_tokens` that already includes cached and cache-write tokens, with the
 * breakdown in `input_tokens_details`. Recording it verbatim would double-count the cached prefix,
 * so the cached parts are subtracted out into their own fields (this mirrors what PI itself does in
 * `@earendil-works/pi-ai/dist/api/openai-responses-shared.js`).
 *
 * Returns null for any other usage shape: the presence of `input_tokens_details` is the
 * discriminator, and Anthropic / chat-completions payloads never carry it, so their existing
 * handling is untouched.
 */
export function parseResponsesUsage(
  model: string,
  usage: Record<string, unknown>,
): GatewayUsage | null {
  const details = usage.input_tokens_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;

  const detail = details as Record<string, unknown>;
  const cacheReadInputTokens = asInt(detail.cached_tokens ?? 0);
  const cacheCreationInputTokens = asInt(detail.cache_write_tokens ?? 0);
  const totalInputTokens = asInt(usage.input_tokens ?? 0);
  return {
    model,
    inputTokens: Math.max(0, totalInputTokens - cacheReadInputTokens - cacheCreationInputTokens),
    outputTokens: asInt(usage.output_tokens ?? 0),
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

export function inferProvider(backend: Backend, model: string): string {
  if (model.includes("/")) return model.split("/", 1)[0];
  if (backend.id.startsWith("anthropic")) return "anthropic";
  if (backend.id.startsWith("openai")) return "openai";
  if (backend.id.startsWith("google")) return "google";
  if (backend.id.startsWith("openrouter")) return "openrouter";
  return backend.id.split(":", 1)[0] || "unknown";
}

export function hasThinkingEnabled(body: Buffer): boolean {
  try {
    const thinking = JSON.parse(body.toString("utf-8")).thinking;
    if (!thinking || typeof thinking !== "object") return false;
    return thinking.type === "enabled" || thinking.type === "auto";
  } catch {
    return false;
  }
}

export function ensureThinkingBlocks(body: Buffer): Buffer {
  try {
    const data = JSON.parse(body.toString("utf-8"));
    if (!Array.isArray(data.messages)) return body;
    let modified = false;
    for (const message of data.messages) {
      if (addMissingThinkingBlock(message)) modified = true;
    }
    return modified ? Buffer.from(JSON.stringify(data), "utf-8") : body;
  } catch {
    return body;
  }
}

function addMissingThinkingBlock(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  const content = message.content as Array<Record<string, unknown>>;
  if (content.some(block => block.type === "thinking")) return false;
  const textIndex = content.findIndex(block => block.type === "text");
  if (textIndex < 0) return false;
  content.splice(textIndex, 0, { type: "thinking", thinking: "" });
  return true;
}

export function asInt(value: unknown): number {
  try {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.floor(number) : 0;
  } catch {
    return 0;
  }
}
