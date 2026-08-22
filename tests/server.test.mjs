// input:  built GatewayServer, stubbed fetch, ephemeral stores
// output: endpoint, quota, usage, stream, and pricing regressions
// pos:    Gateway HTTP runtime integration regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import test, { after } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = process.env.HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-server-home-"));
process.env.HOME = suiteHome;

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

function makeTempUsageTrackerConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-server-test-"));
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("aborted", () => reject(new Error("response aborted")));
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestAbortedBody(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: options.headers ?? {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => {});
      res.on("aborted", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("end", () => reject(new Error("stream ended normally")));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}


test("Gateway server serves /health endpoint", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0, // Will be overridden
    status_check: false,
    endpoints: {
      openai: {
        name: "openai",
        base_url: "https://api.openai.com",
        auth_style: "bearer",
        keys: [],
        passthrough: true,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
  };

  // Find a free port
  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;

  const server = new GatewayServer(config);

  // Start server in background (it blocks, so we manually create it)
  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) =>
    httpServer.listen(freePort, "127.0.0.1", resolve)
  );

  try {
    // Test /health
    const healthRes = await request(freePort, "/health");
    assert.equal(healthRes.status, 200);
    const healthBody = JSON.parse(healthRes.body);
    assert.equal(healthBody.status, "ok");
    assert.deepEqual(healthBody.endpoints, ["openai"]);

    // Test /status
    const statusRes = await request(freePort, "/status");
    assert.equal(statusRes.status, 200);
    const statusBody = JSON.parse(statusRes.body);
    assert.ok("endpoints" in statusBody);
    assert.ok("openai" in statusBody.endpoints);

    // Test /usage
    const usageRes = await request(freePort, "/usage?period=today");
    assert.equal(usageRes.status, 200);
    const usageBody = JSON.parse(usageRes.body);
    assert.ok("summary" in usageBody);
    assert.equal(usageBody.summary.period, "today");

    // Test unknown endpoint
    const notFoundRes = await request(freePort, "/nonexistent/v1/chat/completions");
    assert.equal(notFoundRes.status, 404);

    // Test 404 on root
    const rootRes = await request(freePort, "/");
    assert.equal(rootRes.status, 404);
  } finally {
    httpServer.close();
  }
});

test("Gateway server returns 503 when no backends available", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: "https://api.anthropic.com",
        auth_style: "anthropic",
        keys: [],
        passthrough: true,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);

  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) =>
    httpServer.listen(freePort, "127.0.0.1", resolve)
  );

  try {
    // No API key in headers, no managed keys → should get 503
    const res = await request(freePort, "/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error.message.includes("All backends unavailable"));
  } finally {
    httpServer.close();
  }
});

test("Gateway server supports POST /mode and records mode in health/status", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    mode: "api",
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: "https://right.codes/o2a",
        auth_style: "anthropic",
        keys: ["sk-api"],
        passthrough: true,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
    endpoint_modes: {
      api: {
        anthropic: {
          name: "anthropic",
          base_url: "https://right.codes/o2a",
          auth_style: "anthropic",
          keys: ["sk-api"],
          passthrough: true,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
      plan: {
        anthropic: {
          name: "anthropic",
          base_url: "https://api.anthropic.com",
          auth_style: "bearer",
          keys: [],
          passthrough: true,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
    },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);
  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const beforeHealth = JSON.parse((await request(freePort, "/health")).body);
    assert.equal(beforeHealth.mode, "api");

    const switchRes = await request(freePort, "/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    assert.equal(switchRes.status, 200);
    assert.deepEqual(JSON.parse(switchRes.body), { ok: true, mode: "plan", previous: "api" });

    const statusBody = JSON.parse((await request(freePort, "/status")).body);
    assert.equal(statusBody.mode, "plan");
    assert.deepEqual(statusBody.available_modes.sort(), ["api", "plan"]);
    assert.equal(statusBody.endpoints.anthropic.mode, "passthrough");

    const afterHealth = JSON.parse((await request(freePort, "/health")).body);
    assert.equal(afterHealth.mode, "plan");
    assert.deepEqual(afterHealth.endpoints, ["anthropic"]);
    assert.equal(server.config.endpoints.anthropic.base_url, "https://api.anthropic.com");
  } finally {
    httpServer.close();
  }
});

test("Gateway server paginates /usage?format=records with limit and offset", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const { UsageTracker, UsageStorage } = await import("../dist/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    endpoints: {
      openai: {
        name: "openai",
        base_url: "https://api.openai.com",
        auth_style: "bearer",
        keys: [],
        passthrough: true,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);
  const tmpDir = makeTempUsageTrackerConfig();
  server.usage = new UsageTracker(new UsageStorage(tmpDir, `/test/server-paginate-${Date.now()}`));
  server.usage.recordUsage({ provider: "openai", model: "m1", input_tokens: 1, output_tokens: 1, latency_ms: 1, fallback: false });
  server.usage.recordUsage({ provider: "openai", model: "m2", input_tokens: 2, output_tokens: 2, latency_ms: 2, fallback: false });
  server.usage.recordUsage({ provider: "openai", model: "m3", input_tokens: 3, output_tokens: 3, latency_ms: 3, fallback: false });

  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const paged = JSON.parse((await request(freePort, "/usage?format=records&limit=2&offset=1")).body);
    assert.equal(paged.records.length, 2);
    assert.equal(paged.records[0].model, "m2");
    assert.equal(paged.records[1].model, "m3");
  } finally {
    httpServer.close();
  }
});

test("Gateway server uploads usage records after a successful proxied request", async () => {
  const { GatewayServer } = await import(`../dist/gateway/index.js?server-upload=${Date.now()}`);
  const { configure } = await import(`../dist/index.js?server-upload=${Date.now()}`);

  const savedFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    if (String(input) === "https://aistatus.cc/api/usage/upload") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({
      id: "msg_123",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 12, output_tokens: 34 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  configure({
    name: "Gateway User",
    org: "Gateway Org",
    email: "gateway@example.com",
    uploadEnabled: true,
  });

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: "https://api.anthropic.com",
        auth_style: "anthropic",
        keys: ["sk-ant-test"],
        passthrough: false,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);
  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const res = await request(freePort, "/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200);
    const uploadCall = fetchCalls.find((call) => String(call.input) === "https://aistatus.cc/api/usage/upload");
    assert.ok(uploadCall, "expected usage upload fetch call");
    const payload = JSON.parse(uploadCall.init.body);
    assert.equal(payload.records[0].name, "Gateway User");
    assert.equal(payload.records[0].email, "gateway@example.com");
    assert.equal(payload.records[0].provider, "anthropic");
    assert.equal(payload.records[0].model, "claude-sonnet-4-6");
    assert.equal(payload.records[0].input_tokens, 12);
    assert.equal(payload.records[0].output_tokens, 34);
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
  }
});

function interruptedStreamResponse() {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      setTimeout(() => controller.error(new Error("reader-secret-must-not-cross")), 20);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function interruptedAfterDoneResponse() {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":5}}\n\n'));
      controller.enqueue(Buffer.from('data: [DONE]\n\n'));
      setTimeout(() => controller.error(new Error("late-reader-secret")), 20);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function streamTestConfig(port) {
  return {
    host: "127.0.0.1", port, status_check: false,
    endpoints: { openai: {
      name: "openai", base_url: "https://example.com/v1", auth_style: "bearer",
      keys: ["sk-test"], passthrough: false, fallbacks: [], model_fallbacks: {},
    } },
  };
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

test("Gateway aborts downstream HTTP when an upstream SSE reader fails", async () => {
  const { GatewayServer } = await import(`../dist/gateway/index.js?stream-abort=${Date.now()}`);
  const { UsageStorage, UsageTracker } = await import(`../dist/index.js?stream-abort=${Date.now()}`);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => interruptedStreamResponse();
  const port = await freePort();
  const server = new GatewayServer(streamTestConfig(port));
  server.usage = new UsageTracker(new UsageStorage(makeTempUsageTrackerConfig(), "/stream-abort"));
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  try {
    const body = await requestAbortedBody(port, "/openai/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }),
    });
    assert.match(body, /partial/);
    assert.doesNotMatch(body, /reader-secret|stream_error|type":"error/);
    assert.equal(server.usage.storage.read("all").length, 0);
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
  }
});

test("Gateway completes an accounted SSE that fails after its terminal event", async () => {
  const marker = Date.now();
  const { GatewayServer } = await import(`../dist/gateway/index.js?late-stream=${marker}`);
  const { UsageStorage, UsageTracker } = await import(`../dist/index.js?late-stream=${marker}`);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => interruptedAfterDoneResponse();
  const port = await freePort();
  const server = new GatewayServer(streamTestConfig(port));
  server.usage = new UsageTracker(new UsageStorage(makeTempUsageTrackerConfig(), "/late-stream"));
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  try {
    const response = await request(port, "/openai/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }),
    });
    assert.match(response.body, /\[DONE\]/);
    assert.doesNotMatch(response.body, /late-reader-secret|stream_error/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const records = server.usage.storage.read("all");
    assert.equal(records.length, 1);
    assert.equal(records[0].in, 8);
    assert.equal(records[0].out, 5);
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
  }
});

test("Gateway server records usage for translated streaming responses", async () => {
  const { GatewayServer } = await import(`../dist/gateway/index.js?server-translate=${Date.now()}`);
  const { configure, UsageTracker, UsageStorage } = await import(`../dist/index.js?server-translate=${Date.now()}`);

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input) === "https://aistatus.cc/api/usage/upload") {
      return new Response(null, { status: 204 });
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n'));
        controller.enqueue(Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":8,"completion_tokens":5}}\n\n'));
        controller.enqueue(Buffer.from('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  configure({
    name: "Gateway User",
    org: "Gateway Org",
    email: "gateway@example.com",
    uploadEnabled: true,
  });

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: "https://example.com/v1",
        auth_style: "anthropic",
        keys: [],
        passthrough: false,
        fallbacks: [
          {
            name: "openai-fallback",
            base_url: "https://example.com/v1",
            api_key: "sk-openai",
            auth_style: "bearer",
            model_prefix: "",
            model_map: {},
            translate: "anthropic-to-openai",
          },
        ],
        model_fallbacks: {},
      },
    },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);
  const tmpDir = makeTempUsageTrackerConfig();
  server.usage = new UsageTracker(new UsageStorage(tmpDir, `/test/server-translate-${Date.now()}`));
  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const res = await request(freePort, "/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [], stream: true }),
    });

    assert.equal(res.status, 200);
    const records = server.usage.storage.read("all");
    assert.equal(records.length, 1);
    assert.equal(records[0].in, 8);
    assert.equal(records[0].out, 5);
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
  }
});


function anthropicUsageStreamResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":1000000,"cache_creation_input_tokens":1000000,"cache_read_input_tokens":1000000}}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":1000000}}\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("Gateway prices the first SSE usage record after a missing-cache refresh", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const { UsageStorage, UsageTracker } = await import("../dist/index.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-sse-pricing-"));
  const savedFetch = globalThis.fetch;
  let pricingFetchCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://aistatus.cc/api/models?")) {
      pricingFetchCalls += 1;
      return pricingApiResponse();
    }
    return anthropicUsageStreamResponse();
  };

  const endpoint = {
    name: "anthropic", base_url: "https://upstream.test", auth_style: "anthropic",
    keys: ["sk-test"], passthrough: false, fallbacks: [], model_fallbacks: {},
  };
  const server = new GatewayServer({ host: "127.0.0.1", port: 0, status_check: false, endpoints: { anthropic: endpoint } });
  server.usage = new UsageTracker(new UsageStorage(tmpDir, "/sse-pricing"), null);
  server.pricing._cachePath = path.join(tmpDir, "missing-pricing-cache.json");
  let resolveRecorded;
  const recorded = new Promise((resolve) => { resolveRecorded = resolve; });
  const recordUsage = server.usage.recordUsage.bind(server.usage);
  server.usage.recordUsage = (options) => {
    const record = recordUsage(options);
    resolveRecorded(record);
    return record;
  };
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  try {
    const port = httpServer.address().port;
    const response = await request(port, "/anthropic/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6", messages: [], stream: true }),
    });
    const record = await recorded;
    assert.equal(response.status, 200);
    assert.equal(pricingFetchCalls, 1);
    assert.equal(record.cost, 36.75);
    assert.equal(server.usage.storage.read("all").length, 1);
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


const PRICING_RESPONSE = Buffer.from(JSON.stringify({
  model: "claude-opus-4-6",
  usage: {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  },
}));

const PRICING_BACKEND = {
  id: "anthropic:key:0",
  base_url: "https://api.anthropic.com",
  api_key: "sk-test",
  auth_style: "anthropic",
  model_prefix: "",
  model_map: {},
  translate: null,
};

function pricingApiResponse() {
  return new Response(JSON.stringify({
    models: [{
      id: "anthropic/claude-opus-4-6",
      pricing: {
        prompt: 0.000005,
        completion: 0.000025,
        input_cache_read: 0.0000005,
        input_cache_write: 0.00000625,
      },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function recordFirstUsage(cacheEntry, fetchImpl) {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const { UsageStorage, UsageTracker } = await import("../dist/index.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-pricing-refresh-"));
  const cachePath = path.join(tmpDir, "pricing-cache.json");
  if (cacheEntry) fs.writeFileSync(cachePath, JSON.stringify({ "anthropic/claude-opus-4-6": cacheEntry }));

  const server = new GatewayServer({ host: "127.0.0.1", port: 0, status_check: false, endpoints: {} });
  server.usage = new UsageTracker(new UsageStorage(tmpDir, "/pricing-refresh"), null);
  server.pricing._cachePath = cachePath;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    const accounting = server._recordUsageIfPossible(PRICING_BACKEND, PRICING_RESPONSE, "claude-opus-4-6", 10);
    const pendingRefreshes = [...server.pricing._pendingRefreshes.values()];
    await accounting;
    await Promise.allSettled(pendingRefreshes);
    return server.usage.storage.read("all");
  } finally {
    globalThis.fetch = savedFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("Gateway prices the first usage record after missing or expired cache refresh", async (t) => {
  for (const cacheState of ["missing", "expired"]) {
    await t.test(cacheState, async () => {
      const cacheEntry = cacheState === "expired"
        ? { ts: 0, pricing: { input_per_million: 1, output_per_million: 1 } }
        : null;
      let fetchCalls = 0;
      const records = await recordFirstUsage(cacheEntry, async () => {
        fetchCalls += 1;
        return pricingApiResponse();
      });

      assert.equal(fetchCalls, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0].cost, 36.75);
    });
  }
});

test("Gateway records zero cost when pricing refresh fails", async () => {
  const records = await recordFirstUsage(null, async () => {
    throw new Error("pricing unavailable");
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].cost, 0);
});


test("Gateway server /usage supports format=records and since filtering", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const { UsageTracker, UsageStorage } = await import("../dist/index.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    mode: "default",
    endpoints: {},
    endpoint_modes: { default: {} },
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-server-usage-test-"));

  config.port = freePort;
  const server = new GatewayServer(config);
  server.usage = new UsageTracker(new UsageStorage(tmpDir, "/test/server-usage-records"));
  server.usage.storage.append({ ts: "2026-03-22T10:00:00.000Z", provider: "anthropic", model: "claude-sonnet-4-6", in: 1, out: 2, cost: 0.1, fallback: false, latency_ms: 100, billing_mode: "api" });
  server.usage.storage.append({ ts: "2026-03-22T10:05:00.000Z", provider: "anthropic", model: "claude-sonnet-4-6", in: 3, out: 4, cost: 0.2, fallback: false, latency_ms: 200, billing_mode: "plan" });

  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const allRes = await request(freePort, "/usage?format=records");
    assert.equal(allRes.status, 200);
    const allBody = JSON.parse(allRes.body);
    assert.equal(allBody.records.length, 2);
    assert.equal(allBody.records[0].billing_mode, "api");
    assert.equal(allBody.records[1].billing_mode, "plan");

    const filteredRes = await request(freePort, "/usage?format=records&since=2026-03-22T10:02:00.000Z");
    assert.equal(filteredRes.status, 200);
    const filteredBody = JSON.parse(filteredRes.body);
    assert.equal(filteredBody.records.length, 1);
    assert.equal(filteredBody.records[0].billing_mode, "plan");
  } finally {
    httpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Gateway server /usage validates query params", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    endpoints: {},
  };

  const freePort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

  config.port = freePort;
  const server = new GatewayServer(config);

  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) =>
    httpServer.listen(freePort, "127.0.0.1", resolve)
  );

  try {
    // Invalid period
    const res = await request(freePort, "/usage?period=invalid");
    assert.equal(res.status, 400);

    // Invalid group_by
    const res2 = await request(freePort, "/usage?group_by=invalid");
    assert.equal(res2.status, 400);
  } finally {
    httpServer.close();
  }
});

test("Gateway server reads usage once for a grouped report", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const { UsageTracker, UsageStorage } = await import("../dist/index.js");
  const config = {
    host: "127.0.0.1", port: 0, status_check: false, mode: "default",
    endpoints: {}, endpoint_modes: { default: {} },
  };
  const server = new GatewayServer(config);
  const tmpDir = makeTempUsageTrackerConfig();
  const storage = new UsageStorage(tmpDir, `/test/grouped-report-${Date.now()}`);
  storage.append({
    ts: new Date().toISOString(), provider: "deepseek", model: "deepseek-v4",
    in: 3, out: 2, cost: 0.5, latency_ms: 100, fallback: false,
  });
  const originalRead = storage.read.bind(storage);
  let reads = 0;
  storage.read = (...args) => { reads++; return originalRead(...args); };
  server.usage = new UsageTracker(storage);
  const httpServer = http.createServer((req, res) => {
    server._handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));

  try {
    const port = httpServer.address().port;
    const response = await request(port, "/usage?period=today&group_by=provider");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(reads, 1);
    assert.equal(body.summary.requests, 1);
    assert.equal(body.providers[0].provider, "deepseek");
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function subscriptionGatewayConfig() {
  const anthropic = {
    name: "anthropic", base_url: "https://api.anthropic.test", auth_style: "bearer",
    keys: [], passthrough: true, fallbacks: [], model_fallbacks: {},
  };
  return {
    host: "127.0.0.1", port: 0, status_check: false, mode: "plan",
    endpoints: { anthropic }, endpoint_modes: { plan: { anthropic } },
  };
}

async function withQuotaGateway(fetchImpl, run) {
  const { GatewayServer, QuotaSnapshotStore } = await import("../dist/gateway/index.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-quota-snapshot-"));
  const server = new GatewayServer(subscriptionGatewayConfig());
  server.quota = new QuotaSnapshotStore(path.join(tmpDir, "quota.json"));
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    await run(httpServer.address().port, server, tmpDir);
  } finally {
    globalThis.fetch = savedFetch;
    await new Promise(resolve => httpServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function quotaStream(headers) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

async function sendSubscriptionRequest(port) {
  return request(port, "/m/plan/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret-never-persist" },
    body: JSON.stringify({ model: "claude-opus-5", messages: [], stream: true }),
  });
}

test("Gateway snapshots and forwards Anthropic 5h/7d quota headers", async () => {
  const quotaHeaders = {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.34",
    "anthropic-ratelimit-unified-5h-reset": "1787428800",
    "anthropic-ratelimit-unified-7d-utilization": "0.61",
    "anthropic-ratelimit-unified-7d-reset": "1787860800",
  };
  await withQuotaGateway(async () => quotaStream(quotaHeaders), async (port, _server, tmpDir) => {
    const proxied = await sendSubscriptionRequest(port);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers["anthropic-ratelimit-unified-5h-utilization"], "0.34");

    const response = await request(port, "/quota?provider=anthropic");
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0].provider, "anthropic");
    assert.equal(payload.providers[0].mode, "plan");
    assert.deepEqual(payload.providers[0].windows, [
      { type: "five_hour", utilization: 0.34, resets_at: 1787428800 },
      { type: "seven_day", utilization: 0.61, resets_at: 1787860800 },
    ]);
    assert.equal(typeof payload.providers[0].observed_at, "number");
    assert.equal(fs.readFileSync(path.join(tmpDir, "quota.json"), "utf8").includes("secret-never-persist"), false);
  });
});

test("Gateway snapshots a rejected representative claim before the 429 body path", async () => {
  const headers = {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "7d",
    "anthropic-ratelimit-unified-reset": "1787860800",
  };
  await withQuotaGateway(async () => new Response('{"error":{"type":"rate_limit_error"}}', {
    status: 429, headers,
  }), async (port) => {
    const proxied = await sendSubscriptionRequest(port);
    assert.equal(proxied.status, 429);
    const payload = JSON.parse((await request(port, "/quota?provider=anthropic")).body);
    assert.deepEqual(payload.providers[0].windows, [
      { type: "seven_day", utilization: 1, resets_at: 1787860800 },
    ]);
  });
});

test("Gateway quota cold/malformed reads are non-destructive and snapshots survive recreation", async () => {
  let responseHeaders = {
    "anthropic-ratelimit-unified-5h-utilization": "0.4",
    "anthropic-ratelimit-unified-5h-reset": "1787428800",
  };
  await withQuotaGateway(async () => quotaStream(responseHeaders), async (port, server, tmpDir) => {
    assert.deepEqual(JSON.parse((await request(port, "/quota?provider=missing")).body), { providers: [] });
    await sendSubscriptionRequest(port);
    responseHeaders = {
      "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
      "anthropic-ratelimit-unified-5h-reset": "1787429900",
    };
    await sendSubscriptionRequest(port);

    const first = JSON.parse((await request(port, "/quota?provider=anthropic")).body);
    assert.equal(first.providers[0].windows[0].utilization, 0.4);
    const { QuotaSnapshotStore } = await import("../dist/gateway/index.js");
    server.quota = new QuotaSnapshotStore(path.join(tmpDir, "quota.json"));
    const restarted = JSON.parse((await request(port, "/quota?provider=anthropic")).body);
    assert.deepEqual(restarted, first);
  });
});
