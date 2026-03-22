import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

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
