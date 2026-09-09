// input:  GatewayServer upgrade handler, a fake upstream WebSocket server
// output: WebSocket tunnelling and per-response usage accounting regressions
// pos:    Gateway WebSocket proxy integration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import test, { after } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const originalHome = process.env.HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-ws-home-"));
process.env.HOME = suiteHome;

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

function tempUsageDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-ws-usage-"));
}

async function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function completedEvent(usage, model = "gpt-5.6-sol") {
  return JSON.stringify({
    type: "response.completed",
    response: { id: `resp_${Math.random()}`, model, status: "completed", usage },
  });
}

/**
 * Fake ChatGPT Codex upstream. `onConnection` drives the server side of each accepted socket;
 * `reject` makes the HTTP upgrade fail instead, standing in for an expired OAuth token.
 */
async function startUpstream({ onConnection, reject } = {}) {
  const server = http.createServer((_req, res) => res.end());
  const received = [];
  const handshakes = [];

  if (reject) {
    server.on("upgrade", (req, socket) => {
      handshakes.push(req.headers);
      socket.end(`HTTP/1.1 ${reject} Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    });
  } else {
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
      handshakes.push(req.headers);
      ws.on("message", (data) => received.push(data.toString()));
      onConnection?.(ws);
    });
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, received, handshakes };
}

function gatewayConfig(port, upstreamPort, overrides = {}) {
  return {
    host: "127.0.0.1", port, status_check: false, mode: "openai-codex", websocket: true,
    endpoints: {
      "openai-codex": {
        name: "openai-codex", base_url: `http://127.0.0.1:${upstreamPort}/backend-api`,
        auth_style: "bearer", keys: [], passthrough: true, fallbacks: [], model_fallbacks: {},
      },
    },
    ...overrides,
  };
}

async function startGateway(tag, config) {
  const { GatewayServer } = await import(`../dist/gateway/index.js?${tag}=${Date.now()}`);
  const { UsageStorage, UsageTracker } = await import(`../dist/index.js?${tag}=${Date.now()}`);

  const server = new GatewayServer(config);
  server.usage = new UsageTracker(new UsageStorage(tempUsageDir(), `/${tag}`));
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  httpServer.on("upgrade", (req, socket, head) => {
    server._handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  await new Promise((resolve) => httpServer.listen(config.port, "127.0.0.1", resolve));
  return { server, httpServer };
}

const WS_PATH = "/m/openai-codex/project=demo,trigger=user/openai-codex/codex/responses";

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("Gateway tunnels a WebSocket upgrade and rewrites the upstream auth header", async () => {
  const upstream = await startUpstream({
    onConnection: (ws) => ws.on("message", (data) => ws.send(`echo:${data}`)),
  });
  const port = await freePort();
  const { httpServer } = await startGateway("ws-tunnel", gatewayConfig(port, upstream.port));

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { authorization: "Bearer sk-caller-oauth", originator: "pi" },
    });
    const replies = [];
    client.on("message", (data) => replies.push(data.toString()));
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });

    client.send("hello");
    await waitFor(() => replies.length === 1);
    assert.equal(replies[0], "echo:hello");
    assert.deepEqual(upstream.received, ["hello"]);
    // passthrough endpoints forward the caller's own bearer, and custom headers survive.
    assert.equal(upstream.handshakes[0].authorization, "Bearer sk-caller-oauth");
    assert.equal(upstream.handshakes[0].originator, "pi");
    client.close();
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});

test("Gateway records usage per completed response on one pooled WebSocket", async () => {
  const upstream = await startUpstream({
    onConnection: (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ type: "response.created", response: { model: "gpt-5.6-sol" } }));
        ws.send(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
        ws.send(completedEvent({
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens: 50,
        }));
      });
    },
  });
  const port = await freePort();
  const { server, httpServer } = await startGateway("ws-usage", gatewayConfig(port, upstream.port));

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { authorization: "Bearer sk-caller-oauth" },
    });
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });

    // Two turns over the SAME connection: PI pools and reuses Codex sockets.
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol" }));
    await waitFor(() => server.usage.storage.read("all").length === 1);
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol" }));
    await waitFor(() => server.usage.storage.read("all").length === 2);

    const records = server.usage.storage.read("all");
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.model, "gpt-5.6-sol");
      assert.equal(record.in, 200);
      assert.equal(record.cache_read_in, 800);
      assert.equal(record.out, 50);
      assert.equal(record.billing_mode, "openai-codex");
      assert.equal(record.project, "demo");
      assert.equal(record.trigger, "user");
    }
    client.close();
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});

test("Gateway accounts a large binary-framed response split across TCP chunks", async () => {
  // Exercises the frame reader's 64-bit length path and its partial-frame buffering: a payload this
  // size arrives as many TCP chunks, and `ws.send(Buffer)` frames it as binary rather than text.
  const padding = "x".repeat(200_000);
  const upstream = await startUpstream({
    onConnection: (ws) => {
      ws.on("message", () => {
        ws.send(Buffer.from(JSON.stringify({
          type: "response.completed",
          response: {
            model: "gpt-6-astra", status: "completed", padding,
            usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 0 }, output_tokens: 9 },
          },
        })));
      });
    },
  });
  const port = await freePort();
  const { server, httpServer } = await startGateway("ws-large", gatewayConfig(port, upstream.port));

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { authorization: "Bearer sk-caller-oauth" },
    });
    const replies = [];
    client.on("message", (data) => replies.push(data));
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });

    client.send("go");
    await waitFor(() => server.usage.storage.read("all").length === 1, 8000);
    const [record] = server.usage.storage.read("all");
    assert.equal(record.model, "gpt-6-astra");
    assert.equal(record.in, 90);
    assert.equal(record.out, 9);
    // The tunnel must still have delivered the payload intact to the client.
    assert.equal(replies.length, 1);
    assert.equal(JSON.parse(replies[0].toString()).response.padding.length, padding.length);
    client.close();
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});

test("Gateway relays an upstream handshake rejection to the client", async () => {
  const upstream = await startUpstream({ reject: 401 });
  const port = await freePort();
  const { server, httpServer } = await startGateway("ws-reject", gatewayConfig(port, upstream.port));

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { authorization: "Bearer sk-expired-oauth" },
    });
    const error = await new Promise((resolve) => {
      client.on("error", resolve);
      client.on("open", () => resolve(new Error("handshake unexpectedly succeeded")));
    });
    assert.match(String(error), /401/);
    assert.equal(server.health.isHealthy("openai-codex:passthrough"), true, "one 401 must not cool the backend down");
    assert.equal(server.usage.storage.read("all").length, 0);
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});

test("Gateway refuses upgrades when websocket proxying is disabled", async () => {
  const upstream = await startUpstream({ onConnection: () => {} });
  const port = await freePort();
  const config = gatewayConfig(port, upstream.port, { websocket: false });
  const { httpServer } = await startGateway("ws-disabled", config);

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const error = await new Promise((resolve) => {
      client.on("error", resolve);
      client.on("open", () => resolve(new Error("handshake unexpectedly succeeded")));
    });
    assert.match(String(error), /501/);
    // The client can still fall back to plain HTTP against the same gateway.
    assert.equal(upstream.handshakes.length, 0);
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});

test("Gateway refuses an upgrade to an unknown endpoint without touching upstream", async () => {
  const upstream = await startUpstream({ onConnection: () => {} });
  const port = await freePort();
  const { httpServer } = await startGateway("ws-unknown", gatewayConfig(port, upstream.port));

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/m/openai-codex/nope/v1/x`);
    const error = await new Promise((resolve) => {
      client.on("error", resolve);
      client.on("open", () => resolve(new Error("handshake unexpectedly succeeded")));
    });
    assert.match(String(error), /404/);
    assert.equal(upstream.handshakes.length, 0);
  } finally {
    httpServer.close();
    upstream.server.close();
  }
});
