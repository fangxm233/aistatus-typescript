import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// input: built GatewayServer class from dist and local HTTP requests against ephemeral test servers
// output: integration regression tests for gateway health/status/usage/mode endpoints and request handling
// pos: gateway server integration tests covering public HTTP surface including mode switching and raw usage records
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

// Server integration test: start gateway, hit endpoints, verify responses

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

test("Gateway server rejects invalid POST /mode requests", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");

  const config = {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    mode: "api",
    endpoints: {},
    endpoint_modes: { api: {} },
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
    const res = await request(freePort, "/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /Unknown mode: plan/);
  } finally {
    httpServer.close();
  }
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
