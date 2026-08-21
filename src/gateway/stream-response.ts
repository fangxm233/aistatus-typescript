// input:  upstream SSE response, Gateway accounting dependencies
// output: forwarded/aborted SSE and complete-stream usage records
// pos:    Gateway streaming response and usage pipeline
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";

import type { CostCalculator } from "../pricing.js";
import type { UsageTracker } from "../usage.js";
import { openaiSseToAnthropicSse } from "./translate.js";
import { asInt, forwardUpstreamHeaders } from "./server-helpers.js";
import type { Backend, GatewayUsage } from "./server-types.js";
import { recordGatewayUsage } from "./usage-accounting.js";

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
  dumpApiCall: (
    requestBody: Buffer | undefined,
    responseBody: Buffer | undefined,
    model: string,
    backendId: string,
    elapsedMs: number,
  ) => void;
}

export async function streamGatewayResponse(options: StreamResponseOptions): Promise<void> {
  writeStreamHeaders(options);
  if (!options.upstream.body) {
    options.res.end();
    return;
  }

  const parser = new StreamUsageParser(options.originalModel);
  const dumpChunks: Buffer[] = [];
  let completed: boolean;
  try {
    completed = await pipeStreamWithErrors(options, parser, dumpChunks);
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
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): Promise<boolean> {
  try {
    await pipeStream(options, parser, dumpChunks);
    return true;
  } catch (error) {
    if (error instanceof UpstreamStreamReadError) return parser.hasTerminalEvent();
    throw error;
  }
}

async function pipeStream(
  options: StreamResponseOptions,
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): Promise<void> {
  const chunks = sourceChunks(options.upstream.body!.getReader(), parser, dumpChunks);
  if (options.backend.translate === "anthropic-to-openai") {
    for await (const translated of openaiSseToAnthropicSse(chunks, options.originalModel)) {
      options.res.write(translated);
    }
    return;
  }
  for await (const chunk of chunks) options.res.write(chunk);
}

class UpstreamStreamReadError extends Error {}

async function readSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch {
    throw new UpstreamStreamReadError("upstream stream read failed");
  }
}

async function* sourceChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: StreamUsageParser,
  dumpChunks: Buffer[],
): AsyncGenerator<Buffer> {
  while (true) {
    const { done, value } = await readSource(reader);
    if (done) return;
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

class StreamUsageParser {
  readonly usage: GatewayUsage;
  private buffer = "";
  private terminalEvent = false;

  constructor(model: string) {
    this.usage = {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
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
