// input:  a client WebSocket upgrade, the selected backend, accounting dependencies
// output: a byte-transparent upstream tunnel plus per-response usage records
// pos:    Gateway WebSocket upgrade proxy and passive accounting
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";
import * as net from "node:net";
import * as stream from "node:stream";
import * as tls from "node:tls";

import { AUTH_STYLES } from "./config.js";
import type { HealthTracker } from "./health.js";
import type { CostCalculator } from "../pricing.js";
import type { UsageTracker } from "../usage.js";
import type { Backend } from "./server-types.js";
import { StreamUsageParser } from "./stream-response.js";
import { recordGatewayUsage } from "./usage-accounting.js";
import { WebSocketMessageSniffer } from "./websocket-frames.js";

/** Headers the gateway supplies itself, or that must not leak the caller's own credentials. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host", "authorization", "x-api-key", "x-goog-api-key",
  "content-length", "transfer-encoding",
  // Suppressing extension negotiation keeps every frame uncompressed, which is what lets the
  // sniffer read usage without owning a permessage-deflate implementation.
  "sec-websocket-extensions",
]);

/** Ceiling on the upstream handshake response before the attempt is abandoned. */
const MAX_HANDSHAKE_HEAD_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface WebSocketProxyOptions {
  req: http.IncomingMessage;
  socket: stream.Duplex;
  head: Buffer;
  backend: Backend;
  /** Path below the backend's base URL, as resolved by `resolveProxyRoute`. */
  pathStr: string;
  search: string;
  billingMode?: string;
  defaultBillingMode?: string;
  metadata?: Record<string, string>;
  health: HealthTracker;
  pricing: CostCalculator;
  tracker: UsageTracker;
}

/**
 * Proxy one WebSocket upgrade to the backend and account the usage flowing back over it.
 *
 * The tunnel is deliberately byte-transparent: the gateway replays the handshake with rewritten
 * auth headers and then forwards raw bytes in both directions, never re-framing them. Usage is read
 * off a passive tap on the upstream direction, because a client such as PI treats a WebSocket that
 * breaks *after* the stream started as a hard failure — it will not fall back to SSE — so nothing
 * in the accounting path is allowed to interfere with the stream.
 *
 * One connection carries many responses (PI pools and reuses Codex sockets), so the tap records a
 * usage row per terminal Responses event and then resets.
 */
export async function proxyWebSocket(options: WebSocketProxyOptions): Promise<void> {
  const { socket, backend } = options;
  socket.on("error", () => { /* a dead client is not an error worth logging */ });

  const target = new URL(backend.base_url);
  const basePath = target.pathname.replace(/\/+$/, "");
  const requestPath = `${basePath}/${options.pathStr}${options.search}`;

  let upstream: net.Socket;
  try {
    upstream = await connectUpstream(target);
  } catch (error) {
    options.health.recordError(backend.id, 502);
    return refuseUpgrade(socket, 502, `Upstream connection error: ${error}`);
  }
  upstream.on("error", () => { /* surfaced through the handshake/tunnel teardown below */ });

  try {
    upstream.write(buildHandshakeRequest(options.req, backend, target, requestPath));
    const handshake = await readHandshakeResponse(upstream);

    if (handshake.status !== 101) {
      options.health.recordError(backend.id, handshake.status);
      socket.write(handshake.raw);
      upstream.pipe(socket).on("end", () => socket.end());
      return;
    }

    options.health.recordSuccess(backend.id);
    socket.write(handshake.raw);
    if (options.head.length > 0) upstream.write(options.head);
    tunnel(options, upstream, handshake.rest);
  } catch (error) {
    upstream.destroy();
    options.health.recordError(backend.id, 502);
    refuseUpgrade(socket, 502, `Upstream handshake failed: ${error}`);
  }
}

function connectUpstream(target: URL): Promise<net.Socket> {
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const port = target.port ? Number(target.port) : (secure ? 443 : 80);
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname, ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: target.hostname, port });
    const onReady = () => {
      socket.setNoDelay(true);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once(secure ? "secureConnect" : "connect", onReady);
    socket.once("error", onError);
  });
}

function buildHandshakeRequest(
  req: http.IncomingMessage,
  backend: Backend,
  target: URL,
  requestPath: string,
): string {
  const lines = [`GET ${requestPath} HTTP/1.1`, `host: ${target.host}`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") lines.push(`${key}: ${value}`);
    else if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
  }
  const [headerName, prefix] = AUTH_STYLES[backend.auth_style] ?? AUTH_STYLES.bearer;
  lines.push(`${headerName}: ${prefix}${backend.api_key}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

interface HandshakeResponse {
  status: number;
  /** The response head verbatim, including its terminating blank line, for relaying to the client. */
  raw: Buffer;
  /** Bytes already received past the head — the first frames of the upgraded stream. */
  rest: Buffer;
}

function readHandshakeResponse(upstream: net.Socket): Promise<HandshakeResponse> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("upstream handshake timed out")), HANDSHAKE_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) {
        if (buffer.length > MAX_HANDSHAKE_HEAD_BYTES) finish(new Error("upstream handshake head too large"));
        return;
      }
      const headEnd = separator + 4;
      const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
      const status = Number.parseInt(statusLine.split(" ")[1] ?? "", 10);
      if (!Number.isFinite(status)) return finish(new Error(`malformed upstream status line: ${statusLine}`));
      finish(null, { status, raw: buffer.subarray(0, headEnd), rest: buffer.subarray(headEnd) });
    };

    const finish = (error: Error | null, value?: HandshakeResponse) => {
      clearTimeout(timer);
      upstream.removeListener("data", onData);
      upstream.removeListener("error", onError);
      upstream.removeListener("close", onClose);
      if (error) reject(error);
      else resolve(value!);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("upstream closed before completing the handshake"));

    upstream.on("data", onData);
    upstream.once("error", onError);
    upstream.once("close", onClose);
  });
}

/** Wire both directions together and hang the usage tap off the upstream side. */
function tunnel(options: WebSocketProxyOptions, upstream: net.Socket, earlyBytes: Buffer): void {
  const { socket } = options;
  if (socket instanceof net.Socket) socket.setNoDelay(true);

  const sniffer = new WebSocketMessageSniffer(usageRecorder(options));
  const tap = new stream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sniffer.push(chunk);
      callback(null, chunk);
    },
  });

  const teardown = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", teardown);
  socket.on("close", teardown);
  upstream.on("error", teardown);
  upstream.on("close", teardown);

  if (earlyBytes.length > 0) {
    sniffer.push(earlyBytes);
    socket.write(earlyBytes);
  }
  upstream.pipe(tap).pipe(socket);
  socket.pipe(upstream);
}

/**
 * One usage record per completed response. `StreamUsageParser` already knows the Responses protocol
 * from the SSE path; over WebSocket every frame carries exactly one of the same JSON events.
 */
function usageRecorder(options: WebSocketProxyOptions): (payload: string) => void {
  const parser = new StreamUsageParser("");
  let responseStartedAt: number | null = null;

  return (payload: string) => {
    if (responseStartedAt === null) responseStartedAt = Date.now();
    parser.applyMessage(payload);
    if (!parser.hasTerminalEvent()) return;

    const elapsedMs = Date.now() - responseStartedAt;
    const usage = parser.usage;
    const hadUsage = parser.hasUsage();
    responseStartedAt = null;
    parser.reset();
    if (!hadUsage) return;

    options.health.recordSuccess(options.backend.id);
    if (usage.model) options.health.recordSuccess(options.backend.id, usage.model);
    void recordGatewayUsage({
      backend: options.backend,
      usage,
      elapsedMs,
      billingMode: options.billingMode,
      defaultBillingMode: options.defaultBillingMode,
      metadata: options.metadata,
      pricing: options.pricing,
      tracker: options.tracker,
    }).catch((error) => console.warn("[gateway] websocket usage accounting failed:", error));
  };
}

/** Reject an upgrade with a plain HTTP response, which is all the raw socket can carry. */
export function refuseUpgrade(socket: stream.Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: { message, type: "gateway_error" } });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n`
    + "content-type: application/json\r\n"
    + `content-length: ${Buffer.byteLength(body)}\r\n`
    + "connection: close\r\n"
    + `\r\n${body}`,
  );
}
