// input:  GatewayConfig, HTTP requests, provider responses
// output: Proxy responses plus persisted usage and quota snapshots
// pos:    Gateway HTTP routing, accounting and quota runtime
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";
import * as stream from "node:stream";
import * as url from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

import { type EndpointConfig, type GatewayConfig } from "./config.js";
import { checkGatewayAuth } from "./auth.js";
import { HealthTracker } from "./health.js";
import { anthropicRequestToOpenai, openaiResponseToAnthropic } from "./translate.js";
import { UsageTracker } from "../usage.js";
import { CostCalculator } from "../pricing.js";
import { QuotaSnapshotStore } from "./quota-snapshot.js";
import { getConfig } from "../config.js";
import { UsageUploader } from "../uploader.js";
import {
  buildUpstreamHeaders,
  ensureThinkingBlocks,
  extractIncomingKey,
  extractModel,
  forwardUpstreamHeaders,
  hasThinkingEnabled,
  jsonResponse,
  mapModel,
  parseUsageResponse,
  primaryBackend,
  readBody,
  replaceModel,
  resolveProxyRoute,
} from "./server-helpers.js";
import {
  applyGlobalModelHealthPrecheck,
  handleHealth,
  handleQuota,
  handleStatus,
  handleUsage,
} from "./server-info.js";
import { probeUpstreamBody, streamGatewayResponse, type ChunkReader } from "./stream-response.js";
import { proxyWebSocket, refuseUpgrade } from "./websocket-proxy.js";
import type { Backend } from "./server-types.js";
import { recordGatewayUsage } from "./usage-accounting.js";

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
  quota: QuotaSnapshotStore;
  pricing: CostCalculator;
  private _keyIdx: Record<string, number> = {};
  private _pidFile: string | null;
  private _server: http.Server | null = null;
  private _dumpDir: string | null;

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
    this.usage = new UsageTracker(undefined, new UsageUploader(getConfig()));
    this.quota = new QuotaSnapshotStore();
    this.pricing = new CostCalculator();
    this._pidFile = pidFile ?? null;
    this._dumpDir = process.env.GATEWAY_DUMP_DIR || null;
    if (this._dumpDir) {
      fs.mkdirSync(this._dumpDir, { recursive: true });
    }
  }

  /**
   * Hot-reload the gateway configuration in place. Preserves bound host/port,
   * health and usage trackers; resets round-robin key index. Falls back to a
   * still-available mode if the active mode disappeared from the new config.
   */
  reloadConfig(newConfig: GatewayConfig): void {
    if (newConfig.host !== this.config.host || newConfig.port !== this.config.port) {
      console.warn(
        `[gateway] host/port change ignored on reload (already bound to ${this.config.host}:${this.config.port})`,
      );
    }
    newConfig.host = this.config.host;
    newConfig.port = this.config.port;

    if (!newConfig.endpoint_modes || Object.keys(newConfig.endpoint_modes).length === 0) {
      newConfig.endpoint_modes = { [newConfig.mode ?? "default"]: newConfig.endpoints ?? {} };
    }
    const availableModes = Object.keys(newConfig.endpoint_modes);
    const desiredMode = this.config.mode;
    const activeMode = newConfig.endpoint_modes[desiredMode]
      ? desiredMode
      : (availableModes[0] ?? "default");
    newConfig.mode = activeMode;
    newConfig.endpoints = newConfig.endpoint_modes[activeMode] ?? {};

    this.config = newConfig;
    this._keyIdx = {};
    console.log("[gateway] Config reloaded");
    void applyGlobalModelHealthPrecheck(this.config, this.health).catch(err => {
      console.warn("[gateway] post-reload health precheck failed:", err);
    });
  }

  async run(): Promise<void> {
    await applyGlobalModelHealthPrecheck(this.config, this.health);

    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch(err => {
        console.error("[gateway] Unhandled error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal server error", type: "gateway_error" } }));
        }
      });
    });

    server.on("upgrade", (req, socket, head) => {
      this._handleUpgrade(req, socket, head).catch(err => {
        console.error("[gateway] Unhandled upgrade error:", err);
        socket.destroy();
      });
    });

    this._server = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(this.config.port, this.config.host, () => resolve());
      server.on("error", reject);
    });

    this._prewarmUsage();
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

  private _prewarmUsage(): void {
    try {
      this.usage.prewarm("month");
    } catch (error) {
      console.warn("[gateway] Usage index prewarm failed:", error);
    }
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
      return handleHealth(this.config, res);
    }
    if (pathname === "/status" && req.method === "GET") {
      return handleStatus(this.config, this.health, res);
    }
    if (pathname === "/usage" && req.method === "GET") {
      return handleUsage(this.usage, parsedUrl.query as Record<string, string>, res);
    }
    if (pathname === "/quota" && req.method === "GET") {
      return handleQuota(this.quota, parsedUrl.query as Record<string, string>, res);
    }
    if (pathname === "/mode" && req.method === "POST") {
      return this._handleModeSwitch(req, res);
    }

    // Proxy: /m/{mode}/{metadata?}/{endpoint}/{path...} or /{endpoint}/{path...}
    const route = resolveProxyRoute(pathname, this.config.endpoint_modes);
    if (route.kind === "unknown-mode") {
      return jsonResponse(res, 400, {
        error: { message: `Unknown mode: ${route.mode}`, type: "gateway_error" },
      });
    }
    if (route.kind === "not-found") {
      return jsonResponse(res, 404, {
        error: { message: `Not found: ${pathname}`, type: "gateway_error" },
      });
    }

    await this._handleProxy(
      req, res, route.epName, route.pathStr,
      parsedUrl.query as Record<string, string>, route.mode, route.metadata,
    );
  }

  // ------------------------------------------------------------------
  // WebSocket upgrade dispatcher
  // ------------------------------------------------------------------

  /**
   * Route a WebSocket upgrade through the same endpoint/mode/metadata resolution as an HTTP request.
   *
   * Every rejection path answers with a plain HTTP error rather than hanging the socket: clients
   * that speak both transports — PI's Codex backend tries WebSocket first — then fall back to SSE,
   * so a gateway that cannot serve the upgrade degrades instead of breaking the session.
   */
  async _handleUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer): Promise<void> {
    const parsedUrl = url.parse(req.url ?? "/", true);
    const pathname = parsedUrl.pathname ?? "/";

    if (!this.config.websocket) {
      return refuseUpgrade(socket, 501, "WebSocket proxying is disabled");
    }
    if (!checkGatewayAuth(this.config.auth, pathname, req.headers as Record<string, string | string[] | undefined>)) {
      return refuseUpgrade(socket, 401, "Unauthorized: invalid or missing API key");
    }

    const route = resolveProxyRoute(pathname, this.config.endpoint_modes);
    if (route.kind === "unknown-mode") return refuseUpgrade(socket, 400, `Unknown mode: ${route.mode}`);
    if (route.kind === "not-found") return refuseUpgrade(socket, 404, `Not found: ${pathname}`);

    const resolved = this._resolveEndpoint(route.epName, route.mode);
    if (!resolved) return refuseUpgrade(socket, 404, `Unknown endpoint: ${route.epName}`);

    const backends = this._buildBackendList(resolved.endpoint, req);
    const backend = backends[0] ?? this._pickSoonestCooldownBackend(resolved.endpoint, req);
    if (!backend) return refuseUpgrade(socket, 503, "All backends unavailable");

    const query = new url.URLSearchParams(parsedUrl.query as Record<string, string>).toString();
    await proxyWebSocket({
      req, socket, head, backend,
      pathStr: route.pathStr,
      search: query ? `?${query}` : "",
      billingMode: resolved.billingMode,
      defaultBillingMode: this.config.mode,
      metadata: route.metadata,
      health: this.health,
      pricing: this.pricing,
      tracker: this.usage,
    });
  }

  // ------------------------------------------------------------------
  // Proxy handler
  // ------------------------------------------------------------------

  /**
   * Pick the endpoint an incoming request names, and the billing mode it should be recorded under.
   *
   * Without an explicit `/m/{mode}/` override, an endpoint missing from the active mode is looked up
   * in the other modes: `gateway.yaml` groups endpoints by mode, and a caller hitting `/deepseek`
   * while the gateway sits in `plan` mode still means the deepseek endpoint. The mode it was found
   * in becomes the billing mode, so the record says which set of keys actually served it.
   */
  private _resolveEndpoint(
    epName: string,
    modeOverride?: string,
  ): { endpoint: EndpointConfig; billingMode: string } | null {
    const endpoints = modeOverride
      ? this.config.endpoint_modes[modeOverride] ?? this.config.endpoints
      : this.config.endpoints;

    const endpoint = endpoints[epName];
    if (endpoint) return { endpoint, billingMode: modeOverride || this.config.mode };
    if (modeOverride) return null;

    for (const [modeName, modeEndpoints] of Object.entries(this.config.endpoint_modes)) {
      if (modeName === this.config.mode) continue;
      const found = modeEndpoints[epName];
      if (found) return { endpoint: found, billingMode: modeName };
    }
    return null;
  }

  private async _handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    epName: string,
    pathStr: string,
    query: Record<string, string>,
    modeOverride?: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const resolved = this._resolveEndpoint(epName, modeOverride);
    if (!resolved) {
      return jsonResponse(res, 404, {
        error: { message: `Unknown endpoint: ${epName}`, type: "gateway_error" },
      });
    }
    const { endpoint, billingMode } = resolved;

    const body = await readBody(req, this.config.max_body_size_mb);
    const originalModel = extractModel(body);
    let backends = this._buildBackendList(endpoint, req);

    // When all backends are in cooldown, pick the one whose cooldown expires soonest
    // and try it anyway. This prevents a single transient 5xx from blackholing all
    // traffic for the full cooldown window — the retry may succeed if the upstream
    // recovered. The worst case is one extra failed attempt before the real cooldown
    // error surfaces (same as before, just without the instant 503 give-up).
    if (backends.length === 0) {
      const fallbackBackend = this._pickSoonestCooldownBackend(endpoint, req);
      if (fallbackBackend) {
        backends = [fallbackBackend];
      } else {
        return jsonResponse(res, 503, {
          error: { message: "All backends unavailable", type: "gateway_error" },
        });
      }
    }

    let lastErr: ProxyError | null = null;
    for (const backend of backends) {
      const [model, effectiveBody, fallbackHeader] = this._applyModelFallback(
        endpoint, backend.id, body, originalModel,
      );
      try {
        return await this._forward(req, res, backend, pathStr, effectiveBody, query, model, fallbackHeader, billingMode, metadata);
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

  /**
   * Last-resort fallback: when _buildBackendList returns [] (all backends in cooldown),
   * enumerate every possible backend for the endpoint and return the one whose cooldown
   * expires soonest. This avoids an instant 503 when a single transient error marked
   * the only backend unhealthy — the retry often succeeds because the upstream has
   * already recovered by the time the real request arrives.
   */
  private _pickSoonestCooldownBackend(endpoint: EndpointConfig, req: http.IncomingMessage): Backend | null {
    const ep = endpoint.name;
    const candidates: Array<{ id: string; backend: Backend }> = [];

    // Managed keys
    for (let i = 0; i < endpoint.keys.length; i++) {
      const bid = `${ep}:key:${i}`;
      candidates.push({ id: bid, backend: primaryBackend(bid, endpoint, endpoint.keys[i]) });
    }
    // Passthrough
    if (endpoint.keys.length === 0 || endpoint.passthrough) {
      const bid = `${ep}:passthrough`;
      const incomingKey = extractIncomingKey(req, endpoint.auth_style);
      if (incomingKey) {
        candidates.push({ id: bid, backend: primaryBackend(bid, endpoint, incomingKey) });
      }
    }
    // Fallbacks
    for (const fb of endpoint.fallbacks) {
      if (!fb.api_key) continue;
      const bid = `${ep}:fb:${fb.name}`;
      candidates.push({
        id: bid,
        backend: {
          id: bid, base_url: fb.base_url, api_key: fb.api_key,
          auth_style: fb.auth_style, model_prefix: fb.model_prefix,
          model_map: fb.model_map, translate: fb.translate,
        },
      });
    }

    if (candidates.length === 0) return null;

    const best = this.health.soonestCooldown(candidates.map(c => c.id));
    if (!best) return candidates[0].backend;
    return candidates.find(c => c.id === best.id)?.backend ?? null;
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
    metadata?: Record<string, string>,
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

    // DeepSeek: inject empty thinking blocks for assistant messages that lack them.
    // DeepSeek API requires every assistant message in a multi-turn conversation to
    // carry its reasoning_content (even if empty). When the upstream returns
    // thinking="" the client may drop it; the gateway restores it before forwarding.
    if (billingMode?.includes("deepseek") && upstreamBody.length > 0 && hasThinkingEnabled(upstreamBody)) {
      upstreamBody = ensureThinkingBlocks(upstreamBody);
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
    this._observeQuota(upstreamRes, backend, billingMode);

    // Check retryable status
    if ([429, 500, 502, 503, 529].includes(upstreamRes.status)) {
      const errAb = await upstreamRes.arrayBuffer();
      throw new ProxyError(upstreamRes.status, Buffer.from(errAb as ArrayBuffer));
    }

    this.health.recordSuccess(backend.id);
    if (model) this.health.recordSuccess(backend.id, model);

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await this._stream(res, upstreamRes, backend, originalModel, fallbackHeader, elapsedMs, billingMode, body, metadata);
      return;
    }

    // The ChatGPT Codex backend labels its event streams `application/json`, so the body decides.
    const probe = await probeUpstreamBody(upstreamRes);
    if (probe.kind === "event-stream") {
      await this._stream(res, upstreamRes, backend, originalModel, fallbackHeader, elapsedMs, billingMode, body, metadata, probe.reader);
      return;
    }
    await this._respond(res, upstreamRes, probe.body, backend, originalModel, elapsedMs, fallbackHeader, billingMode, body, metadata);
  }

  private _observeQuota(upstream: Response, backend: Backend, billingMode?: string): void {
    if (!backend.id.startsWith("anthropic:") || !backend.id.endsWith(":passthrough")) return;
    if (backend.auth_style !== "bearer") return;
    this.quota.observe(upstream.headers, {
      provider: "anthropic",
      mode: billingMode ?? this.config.mode,
      status: upstream.status,
    });
  }

  private async _respond(
    res: http.ServerResponse,
    upstream: Response,
    responseBody: Buffer,
    backend: Backend,
    originalModel: string,
    elapsedMs: number,
    fallbackHeader: string,
    billingMode?: string,
    requestBody?: Buffer,
    metadata?: Record<string, string>,
  ): Promise<void> {
    let respBody: Buffer = responseBody;

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
    await this._recordUsageIfPossible(backend, respBody, originalModel, elapsedMs, billingMode, metadata);

    // Dump request + response
    this._dumpApiCall(requestBody, respBody, originalModel, backend.id, elapsedMs);

    // Build response headers — forward all upstream headers, then set our own
    const resHeaders: Record<string, string> = {};
    forwardUpstreamHeaders(upstream, resHeaders);
    resHeaders["content-type"] = charset ? `${contentType}; charset=${charset}` : contentType;
    resHeaders["x-gateway-backend"] = backend.id;
    resHeaders["x-gateway-ms"] = String(elapsedMs);
    if (fallbackHeader) {
      resHeaders["x-gateway-model-fallback"] = fallbackHeader;
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
    elapsedMs = 0,
    billingMode?: string,
    requestBody?: Buffer,
    metadata?: Record<string, string>,
    bodyReader?: ChunkReader,
  ): Promise<void> {
    await streamGatewayResponse({
      res, upstream, backend, originalModel, fallbackHeader, elapsedMs,
      billingMode,
      defaultBillingMode: this.config.mode,
      requestBody,
      metadata,
      bodyReader,
      pricing: this.pricing,
      tracker: this.usage,
      dumpApiCall: this._dumpApiCall.bind(this),
    });
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
  // API call dump
  // ------------------------------------------------------------------

  private _dumpApiCall(
    requestBody: Buffer | undefined,
    responseBody: Buffer | undefined,
    model: string,
    backendId: string,
    elapsedMs: number,
  ): void {
    if (!this._dumpDir || !requestBody || requestBody.length === 0) return;
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(this._dumpDir, `${ts}.json`);
      let request: unknown;
      try { request = JSON.parse(requestBody.toString("utf-8")); } catch { request = requestBody.toString("utf-8"); }
      let response: unknown;
      if (responseBody && responseBody.length > 0) {
        const text = responseBody.toString("utf-8");
        try { response = JSON.parse(text); } catch { response = text; }
      }
      const dump: Record<string, unknown> = {
        ts: new Date().toISOString(),
        model: model || undefined,
        backend: backendId,
        latency_ms: elapsedMs,
        request,
      };
      if (response !== undefined) dump.response = response;
      fs.writeFileSync(filePath, JSON.stringify(dump) + "\n", "utf-8");
    } catch { /* dump failure should never break the proxy */ }
  }

  // ------------------------------------------------------------------
  // Usage recording
  // ------------------------------------------------------------------

  private async _recordUsageIfPossible(
    backend: Backend,
    responseBody: Buffer,
    originalModel: string,
    elapsedMs: number,
    billingMode?: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const usage = parseUsageResponse(responseBody, originalModel);
    if (!usage) return;
    await recordGatewayUsage({
      backend, usage, elapsedMs, billingMode, metadata,
      defaultBillingMode: this.config.mode,
      pricing: this.pricing,
      tracker: this.usage,
    });
  }

  // ------------------------------------------------------------------
  // Mode switch
  // ------------------------------------------------------------------

  private async _handleModeSwitch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req, this.config.max_body_size_mb);
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

  // ------------------------------------------------------------------
  // PID file
  // ------------------------------------------------------------------

  private _writePidFile(): void {
    if (!this._pidFile) return;
    fs.mkdirSync(path.dirname(this._pidFile), { recursive: true });
    fs.writeFileSync(this._pidFile, String(process.pid), "utf-8");
    console.log(`[gateway] PID ${process.pid} written to ${this._pidFile}`);
  }

  private _removePidFile(): void {
    if (!this._pidFile) return;
    try {
      fs.unlinkSync(this._pidFile);
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
