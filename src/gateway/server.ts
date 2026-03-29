/**
 * Gateway HTTP server — transparent proxy with failover and key rotation.
 * Uses Node.js native http.createServer (no express dependency).
 */

// input: GatewayConfig, inbound HTTP requests, upstream provider responses, and usage tracker storage
// output: gateway HTTP responses, mode/status/usage endpoints, and persisted per-request usage records
// pos: core gateway runtime that routes requests across configured endpoints and exposes operational APIs
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import * as http from "node:http";
import * as url from "node:url";

import {
  type EndpointConfig,
  type GatewayConfig,
  AUTH_STYLES,
} from "./config.js";
import { checkGatewayAuth } from "./auth.js";
import { HealthTracker } from "./health.js";
import { anthropicRequestToOpenai, openaiResponseToAnthropic, openaiSseToAnthropicSse } from "./translate.js";
import { UsageTracker } from "../usage.js";
import { CostCalculator } from "../pricing.js";

interface Backend {
  id: string;
  base_url: string;
  api_key: string;
  auth_style: string;
  model_prefix: string;
  model_map: Record<string, string>;
  translate: string | null;
}

class ProxyError extends Error {
  status: number;
  body: Buffer;
  constructor(status: number, body: Buffer) {
    super(`Upstream error: ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class GatewayServer {
  config: GatewayConfig;
  health: HealthTracker;
  usage: UsageTracker;
  pricing: CostCalculator;
  private _keyIdx: Record<string, number> = {};
  private _pidFile: string | null;
  private _server: http.Server | null = null;

  constructor(config: GatewayConfig, pidFile?: string) {
    if (!(config as Partial<GatewayConfig>).endpoint_modes) {
      config.endpoint_modes = { [config.mode ?? "default"]: config.endpoints };
    }
    if (!config.mode) {
      config.mode = Object.keys(config.endpoint_modes)[0] ?? "default";
    }
    if (!config.endpoints) {
      config.endpoints = config.endpoint_modes[config.mode] ?? {};
    }

    this.config = config;
    this.health = new HealthTracker();
    this.usage = new UsageTracker();
    this.pricing = new CostCalculator();
    this._pidFile = pidFile ?? null;
  }

  async run(): Promise<void> {
    await this._applyGlobalModelHealthPrecheck();

    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch(err => {
        console.error("[gateway] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal server error", type: "gateway_error" } }));
        }
      });
    });

    this._server = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(this.config.port, this.config.host, () => resolve());
      server.on("error", reject);
    });

    this._writePidFile();
    this._printBanner();

    // Graceful shutdown
    const shutdown = () => {
      console.log("[gateway] Shutdown signal received, stopping gracefully...");
      this._removePidFile();
      server.close(() => {
        console.log("[gateway] Gateway stopped");
        process.exit(0);
      });
      // Force close after 5s
      setTimeout(() => process.exit(0), 5000).unref();
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  // ------------------------------------------------------------------
  // Request dispatcher
  // ------------------------------------------------------------------

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = url.parse(req.url ?? "/", true);
    const pathname = parsedUrl.pathname ?? "/";

    // Auth check
    if (!checkGatewayAuth(this.config.auth, pathname, req.headers as Record<string, string | string[] | undefined>)) {
      return jsonResponse(res, 401, {
        error: { message: "Unauthorized: invalid or missing API key", type: "auth_error" },
      });
    }

    // Info endpoints
    if (pathname === "/health" && req.method === "GET") {
      return this._handleHealth(res);
    }
    if (pathname === "/status" && req.method === "GET") {
      return this._handleStatus(res);
    }
    if (pathname === "/usage" && req.method === "GET") {
      return this._handleUsage(parsedUrl.query as Record<string, string>, res);
    }
    if (pathname === "/mode" && req.method === "POST") {
      return this._handleModeSwitch(req, res);
    }

    // Per-request mode: /m/{mode}/{epName}/{pathStr}
    const modeMatch = pathname.match(/^\/m\/([^/]+)\/([^/]+)\/(.*)$/);
    if (modeMatch) {
      const [, requestMode, epName, pathStr] = modeMatch;
      if (!this.config.endpoint_modes[requestMode]) {
        return jsonResponse(res, 400, {
          error: { message: `Unknown mode: ${requestMode}`, type: "gateway_error" },
        });
      }
      await this._handleProxy(req, res, epName, pathStr, parsedUrl.query as Record<string, string>, requestMode);
      return;
    }

    // Proxy: /{endpoint}/{path...}
    const match = pathname.match(/^\/([^/]+)\/(.*)$/);
    if (!match) {
      return jsonResponse(res, 404, {
        error: { message: `Not found: ${pathname}`, type: "gateway_error" },
      });
    }

    const [, epName, pathStr] = match;
    await this._handleProxy(req, res, epName, pathStr, parsedUrl.query as Record<string, string>);
  }

  // ------------------------------------------------------------------
  // Proxy handler
  // ------------------------------------------------------------------

  private async _handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    epName: string,
    pathStr: string,
    query: Record<string, string>,
    modeOverride?: string,
  ): Promise<void> {
    // Use per-request mode endpoints if specified, otherwise global config
    const endpoints = modeOverride
      ? this.config.endpoint_modes[modeOverride] ?? this.config.endpoints
      : this.config.endpoints;
    const billingMode = modeOverride || this.config.mode;

    const endpoint = endpoints[epName];
    if (!endpoint) {
      return jsonResponse(res, 404, {
        error: { message: `Unknown endpoint: ${epName}`, type: "gateway_error" },
      });
    }

    const body = await readBody(req);
    const originalModel = extractModel(body);
    const backends = this._buildBackendList(endpoint, req);

    if (backends.length === 0) {
      return jsonResponse(res, 503, {
        error: { message: "All backends unavailable", type: "gateway_error" },
      });
    }

    let lastErr: ProxyError | null = null;
    for (const backend of backends) {
      const [model, effectiveBody, fallbackHeader] = this._applyModelFallback(
        endpoint, backend.id, body, originalModel,
      );
      try {
        return await this._forward(req, res, backend, pathStr, effectiveBody, query, model, fallbackHeader, billingMode);
      } catch (e) {
        if (e instanceof ProxyError) {
          lastErr = e;
          this.health.recordError(backend.id, e.status);
          if (model) {
            this.health.recordError(backend.id, e.status, model);
          }
          console.warn(`[gateway] ${backend.id} → ${e.status}, trying next backend`);
        } else {
          throw e;
        }
      }
    }

    // All failed
    if (lastErr) {
      res.writeHead(lastErr.status, { "content-type": "application/json" });
      res.end(lastErr.body);
    } else {
      jsonResponse(res, 503, {
        error: { message: "All backends failed", type: "gateway_error" },
      });
    }
  }

  // ------------------------------------------------------------------
  // Backend selection
  // ------------------------------------------------------------------

  private _buildBackendList(endpoint: EndpointConfig, req: http.IncomingMessage): Backend[] {
    const backends: Backend[] = [];
    const ep = endpoint.name;

    // 1. Managed keys
    if (endpoint.keys.length > 0) {
      const idx = this._keyIdx[ep] ?? 0;
      const n = endpoint.keys.length;
      for (let i = 0; i < n; i++) {
        const ki = (idx + i) % n;
        const bid = `${ep}:key:${ki}`;
        if (this.health.isHealthy(bid)) {
          backends.push(primaryBackend(bid, endpoint, endpoint.keys[ki]));
        }
      }
      this._keyIdx[ep] = (idx + 1) % n;
    }

    // 2. Passthrough
    if (endpoint.keys.length === 0 || endpoint.passthrough) {
      const bid = `${ep}:passthrough`;
      if (this.health.isHealthy(bid)) {
        const incomingKey = extractIncomingKey(req, endpoint.auth_style);
        if (incomingKey) {
          backends.push(primaryBackend(bid, endpoint, incomingKey));
        }
      }
    }

    // 3. Fallbacks
    for (const fb of endpoint.fallbacks) {
      const bid = `${ep}:fb:${fb.name}`;
      if (!this.health.isHealthy(bid) || !fb.api_key) continue;
      backends.push({
        id: bid,
        base_url: fb.base_url,
        api_key: fb.api_key,
        auth_style: fb.auth_style,
        model_prefix: fb.model_prefix,
        model_map: fb.model_map,
        translate: fb.translate,
      });
    }

    return backends;
  }

  // ------------------------------------------------------------------
  // Forward to upstream
  // ------------------------------------------------------------------

  private async _forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    backend: Backend,
    pathStr: string,
    body: Buffer,
    query: Record<string, string>,
    model: string,
    fallbackHeader: string,
    billingMode?: string,
  ): Promise<void> {
    const needsTranslate = backend.translate === "anthropic-to-openai";

    let originalModel = model;
    if (!originalModel && needsTranslate && body.length > 0) {
      try {
        originalModel = JSON.parse(body.toString("utf-8")).model ?? "";
      } catch { /* ignore */ }
    }

    // Build target URL
    let effectivePath = pathStr;
    if (needsTranslate && pathStr.includes("v1/messages")) {
      effectivePath = "v1/chat/completions";
    }

    const base = backend.base_url.replace(/\/+$/, "");
    let targetUrl = `${base}/${effectivePath}`;
    const qs = new url.URLSearchParams(query).toString();
    if (qs) targetUrl += `?${qs}`;

    // Headers
    const headers = buildUpstreamHeaders(req, backend);

    // Body translation
    let upstreamBody: Buffer = body;
    if (needsTranslate && body.length > 0) {
      upstreamBody = anthropicRequestToOpenai(body);
    }

    // Model mapping / prefix
    if (body.length > 0 && (Object.keys(backend.model_map).length > 0 || backend.model_prefix)) {
      upstreamBody = mapModel(upstreamBody, backend);
    }

    // Send request
    const t0 = Date.now();

    let upstreamRes: Response;
    try {
      const fetchBody: BodyInit | undefined = upstreamBody.length > 0
        ? new Uint8Array(upstreamBody.buffer as ArrayBuffer, upstreamBody.byteOffset, upstreamBody.byteLength)
        : undefined;
      upstreamRes = await fetch(targetUrl, {
        method: req.method ?? "POST",
        headers,
        body: fetchBody,
      });
    } catch (e) {
      throw new ProxyError(502, Buffer.from(JSON.stringify({
        error: { message: `Upstream connection error: ${e}`, type: "gateway_error" },
      })));
    }

    const elapsedMs = Date.now() - t0;

    // Check retryable status
    if ([429, 500, 502, 503, 529].includes(upstreamRes.status)) {
      const errAb = await upstreamRes.arrayBuffer();
      throw new ProxyError(upstreamRes.status, Buffer.from(errAb as ArrayBuffer));
    }

    this.health.recordSuccess(backend.id);
    if (model) this.health.recordSuccess(backend.id, model);

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const isStreaming = contentType.includes("text/event-stream");

    if (isStreaming) {
      await this._stream(res, upstreamRes, backend, originalModel, fallbackHeader, elapsedMs, billingMode);
    } else {
      await this._respond(res, upstreamRes, backend, originalModel, elapsedMs, fallbackHeader, billingMode);
    }
  }

  private async _respond(
    res: http.ServerResponse,
    upstream: Response,
    backend: Backend,
    originalModel: string,
    elapsedMs: number,
    fallbackHeader: string,
    billingMode?: string,
  ): Promise<void> {
    const ab = await upstream.arrayBuffer();
    let respBody: Buffer = Buffer.from(ab as ArrayBuffer);

    let contentType: string;
    let charset: string | undefined;

    if (backend.translate === "anthropic-to-openai") {
      respBody = openaiResponseToAnthropic(respBody, originalModel);
      contentType = "application/json";
    } else {
      const rawCt = upstream.headers.get("content-type") ?? "application/json";
      const [ct, ...params] = rawCt.split(";");
      contentType = ct.trim() || "application/json";
      for (const param of params) {
        const [key, value] = param.split("=").map(s => s.trim());
        if (key?.toLowerCase() === "charset" && value) {
          charset = value.replace(/"/g, "");
        }
      }
    }

    // Record usage
    this._recordUsageIfPossible(backend, respBody, originalModel, elapsedMs, billingMode);

    // Build response headers
    const resHeaders: Record<string, string> = {
      "content-type": charset ? `${contentType}; charset=${charset}` : contentType,
      "x-gateway-backend": backend.id,
      "x-gateway-ms": String(elapsedMs),
    };
    if (fallbackHeader) {
      resHeaders["x-gateway-model-fallback"] = fallbackHeader;
    }
    for (const h of ["x-request-id", "openai-organization", "anthropic-ratelimit-requests-remaining"]) {
      const v = upstream.headers.get(h);
      if (v) resHeaders[h] = v;
    }

    res.writeHead(upstream.status, resHeaders);
    res.end(respBody);
  }

  private async _stream(
    res: http.ServerResponse,
    upstream: Response,
    backend: Backend,
    originalModel: string,
    fallbackHeader: string,
    elapsedMs?: number,
    billingMode?: string,
  ): Promise<void> {
    const needsTranslate = backend.translate === "anthropic-to-openai";

    const resHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-gateway-backend": backend.id,
    };
    if (fallbackHeader) {
      resHeaders["x-gateway-model-fallback"] = fallbackHeader;
    }
    if (!needsTranslate) {
      for (const h of ["x-request-id", "openai-organization"]) {
        const v = upstream.headers.get(h);
        if (v) resHeaders[h] = v;
      }
    }

    res.writeHead(200, resHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();

    // Accumulate SSE data to extract usage from stream events
    let sseBuffer = "";
    const streamUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    const parseSSEForUsage = (chunk: string): void => {
      sseBuffer += chunk;
      while (sseBuffer.includes("\n\n")) {
        const idx = sseBuffer.indexOf("\n\n");
        const eventStr = sseBuffer.slice(0, idx).trim();
        sseBuffer = sseBuffer.slice(idx + 2);
        for (const line of eventStr.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const data = JSON.parse(payload);
            // message_start contains input usage (including cache tokens)
            if (data.type === "message_start" && data.message?.usage) {
              const u = data.message.usage;
              streamUsage.input_tokens = asInt(u.input_tokens ?? 0);
              streamUsage.cache_creation_input_tokens = asInt(u.cache_creation_input_tokens ?? 0);
              streamUsage.cache_read_input_tokens = asInt(u.cache_read_input_tokens ?? 0);
            }
            // message_delta contains output usage
            if (data.type === "message_delta" && data.usage) {
              streamUsage.output_tokens = asInt(data.usage.output_tokens ?? 0);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    };

    if (needsTranslate) {
      // OpenAI SSE → Anthropic SSE
      const chunks = async function* (): AsyncGenerator<Buffer> {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield Buffer.from(value);
        }
      };

      for await (const translated of openaiSseToAnthropicSse(chunks(), originalModel)) {
        res.write(translated);
      }
    } else {
      // Direct SSE passthrough with usage extraction
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        res.write(buf);
        try { parseSSEForUsage(buf.toString("utf-8")); } catch { /* ignore */ }
      }
    }

    res.end();

    // Record usage extracted from stream
    if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
      const model = originalModel || "";
      const provider = inferProvider(backend, model);
      const resolvedModel = model || `${provider}/unknown`;
      const cost = (streamUsage.cache_creation_input_tokens > 0 || streamUsage.cache_read_input_tokens > 0)
        ? this.pricing.calculateCostWithCache(provider, resolvedModel, streamUsage.input_tokens, streamUsage.output_tokens, streamUsage.cache_creation_input_tokens, streamUsage.cache_read_input_tokens)
        : this.pricing.calculateCost(provider, resolvedModel, streamUsage.input_tokens, streamUsage.output_tokens);
      this.usage.recordUsage({
        provider,
        model: resolvedModel,
        input_tokens: streamUsage.input_tokens,
        output_tokens: streamUsage.output_tokens,
        cache_creation_input_tokens: streamUsage.cache_creation_input_tokens,
        cache_read_input_tokens: streamUsage.cache_read_input_tokens,
        latency_ms: elapsedMs ?? 0,
        fallback: backend.id.includes(":fb:"),
        billing_mode: billingMode || this.config.mode,
        cost,
      });
    }
  }

  // ------------------------------------------------------------------
  // Model fallback
  // ------------------------------------------------------------------

  private _applyModelFallback(
    endpoint: EndpointConfig,
    backendId: string,
    body: Buffer,
    originalModel: string,
  ): [string, Buffer, string] {
    if (body.length === 0 || !originalModel) {
      return [originalModel, body, ""];
    }

    if (this.health.isHealthy(backendId, originalModel)) {
      return [originalModel, body, ""];
    }

    const candidates = endpoint.model_fallbacks[originalModel] ?? [];
    for (const candidate of candidates) {
      if (!this.health.isHealthy(backendId, candidate)) continue;
      const rewritten = replaceModel(body, candidate);
      if (!rewritten.equals(body)) {
        return [candidate, rewritten, `${originalModel}->${candidate}`];
      }
    }

    return [originalModel, body, ""];
  }

  // ------------------------------------------------------------------
  // Usage recording
  // ------------------------------------------------------------------

  private _recordUsageIfPossible(
    backend: Backend,
    responseBody: Buffer,
    originalModel: string,
    elapsedMs: number,
    billingMode?: string,
  ): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(responseBody.toString("utf-8"));
    } catch {
      return;
    }

    const model = originalModel || (payload.model as string) || "";
    const usage = (payload.usage as Record<string, unknown>) ?? {};

    const inputTokens = asInt(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const outputTokens = asInt(usage.output_tokens ?? usage.completion_tokens ?? 0);
    const cacheCreationInputTokens = asInt(usage.cache_creation_input_tokens ?? 0);
    const cacheReadInputTokens = asInt(usage.cache_read_input_tokens ?? 0);
    if (!model && !inputTokens && !outputTokens) return;

    const provider = inferProvider(backend, model);
    const resolvedModel = model || `${provider}/unknown`;
    const cost = (cacheCreationInputTokens > 0 || cacheReadInputTokens > 0)
      ? this.pricing.calculateCostWithCache(provider, resolvedModel, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens)
      : this.pricing.calculateCost(provider, resolvedModel, inputTokens, outputTokens);
    this.usage.recordUsage({
      provider,
      model: resolvedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      latency_ms: elapsedMs,
      fallback: backend.id.includes(":fb:"),
      billing_mode: billingMode || this.config.mode,
      cost,
    });
  }

  // ------------------------------------------------------------------
  // Info endpoints
  // ------------------------------------------------------------------

  private _handleHealth(res: http.ServerResponse): void {
    jsonResponse(res, 200, {
      status: "ok",
      mode: this.config.mode,
      endpoints: Object.keys(this.config.endpoints),
    });
  }

  private _handleStatus(res: http.ServerResponse): void {
    const info: Record<string, unknown> = {};
    for (const [epName, ep] of Object.entries(this.config.endpoints)) {
      const epInfo: { backends: Array<Record<string, unknown>>; mode: string } = {
        backends: [],
        mode: "passthrough",
      };
      for (let i = 0; i < ep.keys.length; i++) {
        const bid = `${epName}:key:${i}`;
        epInfo.backends.push({ id: bid, type: "primary", healthy: this.health.isHealthy(bid) });
      }
      if (ep.keys.length === 0 || ep.passthrough) {
        const bid = `${epName}:passthrough`;
        epInfo.backends.push({ id: bid, type: "passthrough", healthy: this.health.isHealthy(bid) });
      }
      if (ep.keys.length > 0 && ep.passthrough) {
        epInfo.mode = "hybrid";
      } else if (ep.keys.length > 0) {
        epInfo.mode = "managed";
      }
      for (const fb of ep.fallbacks) {
        const bid = `${epName}:fb:${fb.name}`;
        epInfo.backends.push({
          id: bid, type: "fallback", name: fb.name,
          healthy: this.health.isHealthy(bid),
        });
      }
      info[epName] = epInfo;
    }

    const healthSummary = this.health.summary();
    const modelHealth = healthSummary.model_health;
    delete healthSummary.model_health;

    jsonResponse(res, 200, {
      mode: this.config.mode,
      available_modes: Object.keys(this.config.endpoint_modes),
      endpoints: info,
      health_detail: healthSummary,
      model_health: modelHealth ?? {},
    });
  }

  private async _handleModeSwitch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = body.length > 0 ? JSON.parse(body.toString("utf-8")) : {};
    } catch {
      return jsonResponse(res, 400, {
        error: { message: "Invalid JSON body", type: "gateway_error" },
      });
    }

    const mode = typeof payload.mode === "string" ? payload.mode : "";
    if (!mode || !this.config.endpoint_modes[mode]) {
      return jsonResponse(res, 400, {
        error: { message: `Unknown mode: ${mode}`, type: "gateway_error" },
      });
    }

    const previous = this.config.mode;
    this.config.mode = mode;
    this.config.endpoints = this.config.endpoint_modes[mode];
    console.log(`[gateway] Switched mode ${previous} -> ${mode}`);
    return jsonResponse(res, 200, { ok: true, mode, previous });
  }

  private _handleUsage(query: Record<string, string>, res: http.ServerResponse): void {
    if (query.format === "records") {
      const records = this.usage.storage.read("all");
      let filtered = records;
      if (query.since) {
        const sinceDate = new Date(query.since);
        if (!isNaN(sinceDate.getTime())) {
          filtered = records.filter(record => {
            const ts = new Date(record.ts as string);
            return !isNaN(ts.getTime()) && ts > sinceDate;
          });
        }
      }
      return jsonResponse(res, 200, { records: filtered });
    }

    const period = query.period ?? "today";
    const groupBy = query.group_by ?? "";

    const validPeriods = ["today", "week", "month", "all"];
    if (!validPeriods.includes(period)) {
      return jsonResponse(res, 400, {
        error: { message: `Invalid period: ${period}. Must be one of ${validPeriods.join(",")}`, type: "gateway_error" },
      });
    }

    const validGroups = ["", "model", "provider"];
    if (!validGroups.includes(groupBy)) {
      return jsonResponse(res, 400, {
        error: { message: `Invalid group_by: ${groupBy}. Must be one of model,provider`, type: "gateway_error" },
      });
    }

    const result: Record<string, unknown> = { summary: this.usage.summary(period) };
    if (groupBy === "model") result.models = this.usage.byModel(period);
    else if (groupBy === "provider") result.providers = this.usage.byProvider(period);

    jsonResponse(res, 200, result);
  }

  // ------------------------------------------------------------------
  // Global model health precheck
  // ------------------------------------------------------------------

  private async _applyGlobalModelHealthPrecheck(): Promise<void> {
    if (!this.config.status_check) return;

    const modelTargets = new Set<string>();
    for (const endpoint of Object.values(this.config.endpoints)) {
      for (const model of Object.keys(endpoint.model_fallbacks)) {
        modelTargets.add(model);
      }
      for (const candidates of Object.values(endpoint.model_fallbacks)) {
        for (const c of candidates) modelTargets.add(c);
      }
    }

    if (modelTargets.size === 0) return;

    // Import StatusAPI from the SDK
    const { StatusAPI } = await import("../api.js");
    const { Status } = await import("../models.js");
    const client = new StatusAPI();

    const sorted = [...modelTargets].sort();
    const results = await Promise.allSettled(
      sorted.map(m => client.checkModel(m))
    );

    const degradedModels = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        const check = result.value;
        if (check.status === Status.DEGRADED || check.status === Status.DOWN) {
          degradedModels.add(sorted[i]);
        }
      }
    }

    if (degradedModels.size === 0) return;

    for (const endpoint of Object.values(this.config.endpoints)) {
      const epModels = new Set<string>(Object.keys(endpoint.model_fallbacks));
      for (const candidates of Object.values(endpoint.model_fallbacks)) {
        for (const c of candidates) epModels.add(c);
      }
      const unhealthyModels = [...epModels].filter(m => degradedModels.has(m));
      if (unhealthyModels.length === 0) continue;

      const backendIds: string[] = [];
      for (let i = 0; i < endpoint.keys.length; i++) {
        backendIds.push(`${endpoint.name}:key:${i}`);
      }
      if (endpoint.keys.length === 0 || endpoint.passthrough) {
        backendIds.push(`${endpoint.name}:passthrough`);
      }
      for (const fb of endpoint.fallbacks) {
        backendIds.push(`${endpoint.name}:fb:${fb.name}`);
      }

      for (const backendId of backendIds) {
        for (const model of unhealthyModels) {
          this.health.recordError(backendId, 529, model);
          console.log(`[gateway] Pre-marked ${backendId} model unhealthy from global status: ${model}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // PID file
  // ------------------------------------------------------------------

  private _writePidFile(): void {
    if (!this._pidFile) return;
    const fs = require("node:fs");
    const path = require("node:path");
    fs.mkdirSync(path.dirname(this._pidFile), { recursive: true });
    fs.writeFileSync(this._pidFile, String(process.pid), "utf-8");
    console.log(`[gateway] PID ${process.pid} written to ${this._pidFile}`);
  }

  private _removePidFile(): void {
    if (!this._pidFile) return;
    try {
      require("node:fs").unlinkSync(this._pidFile);
      console.log(`[gateway] PID file removed: ${this._pidFile}`);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Banner
  // ------------------------------------------------------------------

  private _printBanner(): void {
    const base = `http://${this.config.host}:${this.config.port}`;
    console.log();
    console.log(`  aistatus gateway running on ${base}`);
    if (this.config.auth?.enabled) {
      const nKeys = this.config.auth.keys.length;
      const publicPaths = (this.config.auth.public_paths ?? ["/health"]).join(", ");
      console.log(`  Auth: ${nKeys} key${nKeys !== 1 ? "s" : ""} configured (public: ${publicPaths})`);
    }
    console.log();
    for (const [epName, ep] of Object.entries(this.config.endpoints)) {
      const nk = ep.keys.length;
      const nf = ep.fallbacks.length;
      let keyInfo: string;
      if (nk > 0 && ep.passthrough) {
        keyInfo = `${nk} key${nk !== 1 ? "s" : ""} + passthrough`;
      } else if (nk > 0) {
        keyInfo = `${nk} key${nk !== 1 ? "s" : ""}`;
      } else {
        keyInfo = "passthrough";
      }
      const fbNames = ep.fallbacks.map(f => f.name).join(", ");
      const fbInfo = fbNames ? ` → fallback: ${fbNames}` : "";
      console.log(`  /${epName}/*  (${keyInfo}${fbInfo})`);
    }
    console.log();
    console.log("  Configure your CLI tools:");
    if ("anthropic" in this.config.endpoints) {
      console.log(`    export ANTHROPIC_BASE_URL=${base}/anthropic`);
    }
    if ("openai" in this.config.endpoints) {
      console.log(`    export OPENAI_BASE_URL=${base}/openai/v1`);
    }
    console.log();
    console.log(`  Status:  ${base}/status`);
    console.log(`  Health:  ${base}/health`);
    console.log(`  Usage:   ${base}/usage?period=today&group_by=model`);
    console.log();
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractModel(body: Buffer): string {
  if (body.length === 0) return "";
  try {
    return JSON.parse(body.toString("utf-8")).model ?? "";
  } catch {
    return "";
  }
}

function primaryBackend(bid: string, endpoint: EndpointConfig, apiKey: string): Backend {
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

function extractIncomingKey(req: http.IncomingMessage, authStyle: string): string {
  if (authStyle === "anthropic") {
    return (req.headers["x-api-key"] as string) ?? "";
  }
  if (authStyle === "google") {
    return (req.headers["x-goog-api-key"] as string) ?? "";
  }
  // bearer
  const auth = (req.headers.authorization as string) ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7);
  }
  return auth;
}

function buildUpstreamHeaders(req: http.IncomingMessage, backend: Backend): Record<string, string> {
  const headers: Record<string, string> = {};
  const skip = new Set([
    "host", "authorization", "x-api-key", "x-goog-api-key",
    "content-length", "transfer-encoding", "connection",
  ]);

  for (const [k, v] of Object.entries(req.headers)) {
    if (!skip.has(k.toLowerCase()) && typeof v === "string") {
      headers[k] = v;
    }
  }

  // Set upstream auth
  const style = AUTH_STYLES[backend.auth_style] ?? AUTH_STYLES.bearer;
  const [headerName, prefix] = style;
  headers[headerName] = prefix + backend.api_key;

  return headers;
}

function replaceModel(body: Buffer, model: string): Buffer {
  try {
    const data = JSON.parse(body.toString("utf-8"));
    if (!data.model) return body;
    data.model = model;
    return Buffer.from(JSON.stringify(data), "utf-8");
  } catch {
    return body;
  }
}

function mapModel(body: Buffer, backend: Backend): Buffer {
  try {
    const data = JSON.parse(body.toString("utf-8"));
    const model = data.model;
    if (!model) return body;

    if (model in backend.model_map) {
      data.model = backend.model_map[model];
    } else if (backend.model_prefix) {
      data.model = backend.model_prefix + model;
    }
    return Buffer.from(JSON.stringify(data), "utf-8");
  } catch {
    return body;
  }
}

function inferProvider(backend: Backend, model: string): string {
  if (model.includes("/")) return model.split("/", 1)[0];
  const bid = backend.id;
  if (bid.startsWith("anthropic")) return "anthropic";
  if (bid.startsWith("openai")) return "openai";
  if (bid.startsWith("google")) return "google";
  if (bid.startsWith("openrouter")) return "openrouter";
  return bid.split(":", 1)[0] || "unknown";
}

function asInt(value: unknown): number {
  try {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}
