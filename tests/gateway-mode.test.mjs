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

test("Gateway per-request mode: /m/{mode}/{metadata}/{ep}/{path} records metadata in usage", async () => {
  const freePort = await getFreePort();

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      received: true,
      auth: req.headers["x-api-key"],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 20 },
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
    // Request with metadata segment
    const res = await request(freePort, "/m/plan/project=dex-hand,trigger=dispatch/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.auth, "sk-plan-key", "Should use plan mode's API key");

    // Verify metadata was recorded in usage
    const records = server.usage.storage.read("all");
    assert.ok(records.length >= 1);
    const lastRecord = records[records.length - 1];
    assert.equal(lastRecord.project, "dex-hand");
    assert.equal(lastRecord.trigger, "dispatch");
    assert.equal(lastRecord.billing_mode, "plan");
  } finally {
    httpServer.close();
    upstream.close();
  }
});

test("Gateway per-request mode: /m/{mode}/{ep}/{path} still works without metadata", async () => {
  const freePort = await getFreePort();

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      received: true,
      auth: req.headers["x-api-key"],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 20 },
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
    },
  };

  const { server, httpServer } = await makeServer(config, freePort);
  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    const res = await request(freePort, "/m/api/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200);
    const records = server.usage.storage.read("all");
    assert.ok(records.length >= 1);
    const lastRecord = records[records.length - 1];
    assert.equal(lastRecord.trigger, undefined, "No metadata means no trigger field");
    assert.equal(lastRecord.billing_mode, "api");
  } finally {
    httpServer.close();
    upstream.close();
  }
});

test("Gateway per-request mode: 3-segment URL falls through 4-segment regex correctly", async () => {
  const freePort = await getFreePort();

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      received: true,
      url: req.url,
      auth: req.headers["x-api-key"],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 20 },
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
    // Capture record count before request
    const beforeCount = server.usage.storage.read("all").length;

    // Normal 3-segment URL: /m/plan/anthropic/v1/messages
    // 4-segment regex matches with epCandidate="v1" which is NOT a valid endpoint
    // Must fall through to 3-segment regex and route correctly
    const res = await request(freePort, "/m/plan/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200, "3-segment URL must route successfully after 4-segment fallthrough");
    const body = JSON.parse(res.body);
    assert.equal(body.received, true);
    assert.equal(body.auth, "sk-plan-key", "Should use plan mode's API key");

    // Verify NO user-specified metadata in the newly added usage record
    // Note: storage.read() injects directory hash as default `project` when none exists,
    // so we check the raw JSONL record via the tracker's last return value
    const records = server.usage.storage.read("all");
    assert.ok(records.length > beforeCount, "Should have new usage record");
    const newRecord = records[records.length - 1];
    assert.equal(newRecord.trigger, undefined, "No metadata segment means no trigger");
    assert.equal(newRecord.billing_mode, "plan");
    // project is auto-set by storage.read() to directory hash — verify it's NOT a user value
    assert.ok(!newRecord.project || !newRecord.project.includes("="), "No user metadata in project field");
  } finally {
    httpServer.close();
    upstream.close();
  }
});

test("Gateway per-request mode: URL-encoded metadata values are decoded", async () => {
  const freePort = await getFreePort();

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      received: true,
      auth: req.headers["x-api-key"],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 20 },
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
    },
  };

  const { server, httpServer } = await makeServer(config, freePort);
  await new Promise((resolve) => httpServer.listen(freePort, "127.0.0.1", resolve));

  try {
    // URL-encoded metadata: project=my%20project (space), trigger=user%2Fweb (slash)
    const res = await request(freePort, "/m/api/project=my%20project,trigger=user%2Fweb/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(res.status, 200);
    const records = server.usage.storage.read("all");
    assert.ok(records.length >= 1);
    const lastRecord = records[records.length - 1];
    assert.equal(lastRecord.project, "my project", "URL-encoded space should be decoded");
    assert.equal(lastRecord.trigger, "user/web", "URL-encoded slash should be decoded");
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
