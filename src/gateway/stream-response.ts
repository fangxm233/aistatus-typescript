// input:  upstream SSE response, Gateway accounting dependencies
// output: forwarded/aborted SSE, the reusable stream usage parser, and complete-stream usage records
// pos:    Gateway streaming response and usage pipeline
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";

import type { CostCalculator } from "../pricing.js";
import type { UsageTracker } from "../usage.js";
import { openaiSseToAnthropicSse } from "./translate.js";
import { asInt, forwardUpstreamHeaders, parseResponsesUsage } from "./server-helpers.js";
import type { Backend, GatewayUsage } from "./server-types.js";
import { recordGatewayUsage } from "./usage-accounting.js";

/**
 * OpenAI Responses API events that close a response and carry its final usage. `response.done` is
 * the name the ChatGPT Codex WebSocket transport uses for what SSE calls `response.completed`.
 */
const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed", "response.incomplete", "response.done",
]);

function emptyUsage(model: string): GatewayUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

interface StreamResponseOptions {
  res: http.ServerResponse;
  upstream: Response;
  backend: Backend;
  originalModel: string;
  fallbackHeader: string;
  elapsedMs: number;
  billingMode?: string;
  defaultBillingMode?: string;
  requestBody?: Buffer;
  metadata?: Record<string, string>;
  pricing: CostCalculator;
  tracker: UsageTracker;
  /** Overrides `upstream.body`, for a stream whose first chunk was already read to classify it. */
  bodyReader?: ChunkReader;
  dumpApiCall: (
    requestBody: Buffer | undefined,
    responseBody: Buffer | undefined,
    model: string,
    backendId: string,
    elapsedMs: number,
  ) => void;
}

/**
 * Classify an upstream body that did not announce itself as SSE.
 *
 * The ChatGPT Codex backend answers a streaming request with `content-type: application/json` and
 * then writes an event stream anyway, so trusting the header alone would buffer the whole stream and
 * leave its usage unparsed. Sniffing the first chunk is provider-agnostic and costs nothing: a
 * genuine JSON response has to be read in full regardless.
 */
export type BodyProbe =
  | { kind: "event-stream"; reader: ChunkReader }
  | { kind: "buffer"; body: Buffer };

export async function probeUpstreamBody(upstream: Response): Promise<BodyProbe> {
  if (!upstream.body) return { kind: "buffer", body: Buffer.alloc(0) };
  const reader = upstream.body.getReader();

  const first = await reader.read();
  if (first.done || !first.value) return { kind: "buffer", body: Buffer.alloc(0) };
  const head = Buffer.from(first.value);
  if (looksLikeEventStream(head)) return { kind: "event-stream", reader: replayingReader(head, reader) };

  const chunks = [head];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value) chunks.push(Buffer.from(next.value));
  }
  return { kind: "buffer", body: Buffer.concat(chunks) };
}

/** SSE payloads open with a field name or a comment line (RFC 8895 §7 / WHATWG event-stream). */
function looksLikeEventStream(head: Buffer): boolean {
  const start = head.subarray(0, 64).toString("utf-8").replace(/^[\s﻿]+/, "");
  return /^(event|data|id|retry):/.test(start) || start.startsWith(":");
}

/** Hands back the already-consumed chunk before continuing with the live reader. */
function replayingReader(head: Buffer, reader: ReadableStreamDefaultReader<Uint8Array>): ChunkReader {
  let pending: Buffer | null = head;
  return {
    async read() {
      if (pending) {
        const value = pending;
        pending = null;
        return { done: false, value };
      }
      return reader.read();
    },
  };
}

export async function streamGatewayResponse(options: StreamResponseOptions): Promise<void> {
  const reader = options.bodyReader ?? options.upstream.body?.getReader();
  writeStreamHeaders(options);
  if (!reader) {
    options.res.end();
    return;
  }

  const parser = new StreamUsageParser(options.originalModel);
  const dumpChunks: Buffer[] = [];
  let completed: boolean;
  try {
    completed = await pipeStreamWithErrors(options, reader, parser, dumpChunks);
  } catch (error) {
    abortStream(options.res);
    throw error;
  }
  if (!completed) {
    abortStream(options.res);
    return;
  }
  options.res.end();
  const streamedResponse = dumpChunks.length > 0 ? Buffer.concat(dumpChunks) : undefined;
  options.dumpApiCall(
    options.requestBody, streamedResponse, options.originalModel,
    options.backend.id, options.elapsedMs,
  );
  if (parser.hasUsage()) await persistStreamUsage(options, parser.usage);
}

function abortStream(res: http.ServerResponse): void {
  res.once("error", () => {});
  res.destroy(new Error("upstream stream interrupted"));
}

function writeStreamHeaders(options: StreamResponseOptions): void {
  const headers: Record<string, string> = {};
  forwardUpstreamHeaders(options.upstream, headers);
  headers["content-type"] = "text/event-stream";
  headers["cache-control"] = "no-cache";
  headers.connection = "keep-alive";
  headers["x-gateway-backend"] = options.backend.id;
  if (options.fallbackHeader) headers["x-gateway-model-fallback"] = options.fallbackHeader;
  options.res.writeHead(200, headers);
}

async function pipeStreamWithErrors(
  options: StreamResponseOptions,
  reader: ChunkReader,
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): Promise<boolean> {
  try {
    await pipeStream(options, reader, parser, dumpChunks);
    return true;
  } catch (error) {
    if (error instanceof UpstreamStreamReadError) return parser.hasTerminalEvent();
    throw error;
  }
}

async function pipeStream(
  options: StreamResponseOptions,
  reader: ChunkReader,
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): Promise<void> {
  const chunks = sourceChunks(reader, parser, dumpChunks);
  if (options.backend.translate === "anthropic-to-openai") {
    for await (const translated of openaiSseToAnthropicSse(chunks, options.originalModel)) {
      options.res.write(translated);
    }
    return;
  }
  for await (const chunk of chunks) options.res.write(chunk);
}

class UpstreamStreamReadError extends Error {}

/** The slice of a stream reader the Gateway uses, so a sniffed stream can be replayed into it. */
export interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readSource(reader: ChunkReader): Promise<{ done: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch {
    throw new UpstreamStreamReadError("upstream stream read failed");
  }
}

async function* sourceChunks(
  reader: ChunkReader,
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): AsyncGenerator<Buffer> {
  while (true) {
    const { done, value } = await readSource(reader);
    if (done || !value) return;
    const chunk = Buffer.from(value);
    parser.push(chunk.toString("utf-8"));
    dumpChunks.push(chunk);
    yield chunk;
  }
}

async function persistStreamUsage(
  options: StreamResponseOptions,
  usage: GatewayUsage,
): Promise<void> {
  await recordGatewayUsage({
    backend: options.backend,
    usage,
    elapsedMs: options.elapsedMs,
    billingMode: options.billingMode,
    defaultBillingMode: options.defaultBillingMode,
    metadata: options.metadata,
    pricing: options.pricing,
    tracker: options.tracker,
  });
}

/**
 * Accumulates provider usage off a response stream. Understands three protocols: Anthropic Messages
 * SSE, OpenAI chat-completions SSE, and the OpenAI Responses API (SSE or, via `applyMessage`, the
 * Codex WebSocket transport, which frames the very same JSON events).
 */
export class StreamUsageParser {
  usage: GatewayUsage;
  private readonly initialModel: string;
  private buffer = "";
  private terminalEvent = false;

  constructor(model: string) {
    this.initialModel = model;
    this.usage = emptyUsage(model);
  }

  /** Feed one already-framed JSON event (WebSocket transport). Malformed payloads are ignored. */
  applyMessage(payload: string): void {
    try {
      this.applyPayload(JSON.parse(payload));
    } catch { /* ignore malformed payloads */ }
  }

  /** Drop accumulated usage so one long-lived connection can account several responses. */
  reset(): void {
    this.usage = emptyUsage(this.initialModel);
    this.terminalEvent = false;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n\n")) {
      const index = this.buffer.indexOf("\n\n");
      const event = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 2);
      for (const line of event.split("\n")) this.parseLine(line);
    }
  }

  hasUsage(): boolean {
    return this.usage.inputTokens > 0 || this.usage.outputTokens > 0;
  }

  hasTerminalEvent(): boolean {
    return this.terminalEvent;
  }

  private parseLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      this.terminalEvent = true;
      return;
    }
    try {
      this.applyPayload(JSON.parse(payload));
    } catch { /* ignore malformed SSE payloads */ }
  }

  private applyPayload(data: any): void {
    if (this.applyResponsesPayload(data)) return;
    if (data.type === "message_stop") this.terminalEvent = true;
    if (data.type === "message_start" && data.message?.usage) {
      const usage = data.message.usage;
      this.usage.inputTokens = asInt(usage.input_tokens ?? 0);
      this.usage.cacheCreationInputTokens = asInt(usage.cache_creation_input_tokens ?? 0);
      this.usage.cacheReadInputTokens = asInt(usage.cache_read_input_tokens ?? 0);
    }
    if (data.type === "message_delta" && data.usage) {
      this.usage.outputTokens = asInt(data.usage.output_tokens ?? 0);
    }
    if (data.usage) this.applyGenericUsage(data.usage);
  }

  /**
   * Handle one OpenAI Responses API stream event (`/v1/responses`, ChatGPT Codex backend), where
   * usage hangs off the terminal event's `response` object rather than the top level. Returns true
   * when the event belonged to that protocol, so the caller skips the Anthropic / chat-completions
   * branches — Responses delta events never carry a top-level `usage`, and letting the generic
   * branch see them could overwrite the normalized totals.
   *
   * The model name is taken from `response.model` when the caller could not supply one. That is the
   * case for Codex: PI zstd-compresses the request body, so the gateway's `extractModel()` cannot
   * read it and would otherwise record the request as `<provider>/unknown`.
   */
  private applyResponsesPayload(data: any): boolean {
    const type = typeof data?.type === "string" ? data.type : "";
    if (!type.startsWith("response.")) return false;

    const response = data.response;
    if (!response || typeof response !== "object") return true;
    if (!this.usage.model && typeof response.model === "string") this.usage.model = response.model;
    if (!RESPONSES_TERMINAL_EVENTS.has(type)) return true;

    this.terminalEvent = true;
    const usage = response.usage;
    if (!usage || typeof usage !== "object") return true;
    const parsed = parseResponsesUsage(this.usage.model, usage);
    if (!parsed) return true;
    this.usage.inputTokens = parsed.inputTokens;
    this.usage.outputTokens = parsed.outputTokens;
    this.usage.cacheCreationInputTokens = parsed.cacheCreationInputTokens;
    this.usage.cacheReadInputTokens = parsed.cacheReadInputTokens;
    return true;
  }

  private applyGenericUsage(usage: any): void {
    this.usage.inputTokens = asInt(usage.input_tokens ?? usage.prompt_tokens ?? this.usage.inputTokens);
    this.usage.outputTokens = asInt(usage.output_tokens ?? usage.completion_tokens ?? this.usage.outputTokens);
    this.usage.cacheCreationInputTokens = asInt(
      usage.cache_creation_input_tokens ?? this.usage.cacheCreationInputTokens,
    );
    this.usage.cacheReadInputTokens = asInt(
      usage.cache_read_input_tokens ?? this.usage.cacheReadInputTokens,
    );
  }
}
