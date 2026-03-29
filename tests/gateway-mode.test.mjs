import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// Tests for per-request mode routing in gateway server

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

function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function makeServer(config, port) {
  return import("../dist/gateway/index.js").then(({ GatewayServer }) => {
    config.port = port;
    const server = new GatewayServer(config);
    const httpServer = http.createServer((req, res) => {
      server._handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
    return { server, httpServer };
  });
}

test("Gateway per-request mode: /m/{mode}/{ep}/{path} resolves correct endpoint", async () => {
  const freePort = await getFreePort();

  // Create a mock upstream that echoes back what it receives
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      received: true,
      url: req.url,
      auth: req.headers["x-api-key"] || req.headers.authorization,
    }));
  });

  const upstreamPort = await getFreePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

  const config = {
    host: "127.0.0.1",
    port: freePort,
    status_check: false,
    mode: "api",
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: `http://127.0.0.1:${upstreamPort}`,
        auth_style: "anthropic",
        keys: ["sk-api-key"],
        passthrough: false,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
    endpoint_modes: {
      api: {
        anthropic: {
          name: "anthropic",
          base_url: `http://127.0.0.1:${upstreamPort}`,
          auth_style: "anthropic",
          keys: ["sk-api-key"],
          passthrough: false,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
      plan: {
        anthropic: {
          name: "anthropic",
          base_url: `http://127.0.0.1:${upstreamPort}`,
          auth_style: "anthropic",
          keys: ["sk-plan-key"],
          passthrough: false,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
    },
  };

  const { server, httpServer } = await makeServer(config, freePort);
  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    // Request with plan mode override — should use plan endpoint's key
    const res = await request(freePort, "/m/plan/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.received, true);
    assert.equal(body.auth, "sk-plan-key", "Should use plan mode's API key");
  } finally {
    httpServer.close();
    upstream.close();
  }
});

test("Gateway per-request mode: rejects unknown mode", async () => {
  const freePort = await getFreePort();
  const config = {
    host: "127.0.0.1",
    port: freePort,
    status_check: false,
    mode: "api",
    endpoints: {},
    endpoint_modes: { api: {} },
  };

  const { server, httpServer } = await makeServer(config, freePort);
  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const res = await request(freePort, "/m/nonexistent/anthropic/v1/messages");
    assert.equal(res.status, 400);
    assert.match(res.body, /Unknown mode/);
  } finally {
    httpServer.close();
  }
});
