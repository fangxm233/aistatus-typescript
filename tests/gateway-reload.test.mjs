/**
 * Smoke test for hot-reload of gateway config.
 * Exercises GatewayServer.reloadConfig() and watchConfigFile().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  GatewayServer,
  loadConfig,
  watchConfigFile,
} from "../dist/gateway/index.js";

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-reload-"));
  return path.join(dir, name);
}

test("reloadConfig swaps endpoints in place and preserves bound host/port", () => {
  const initial = loadConfig.call(null, undefined); // unused
  // Build initial config inline
  const cfg = {
    host: "127.0.0.1",
    port: 9999,
    status_check: false,
    mode: "default",
    endpoints: {
      anthropic: {
        name: "anthropic",
        base_url: "https://api.anthropic.com",
        auth_style: "anthropic",
        keys: ["k1"],
        passthrough: false,
        fallbacks: [],
        model_fallbacks: {},
      },
    },
    endpoint_modes: {
      default: {
        anthropic: {
          name: "anthropic",
          base_url: "https://api.anthropic.com",
          auth_style: "anthropic",
          keys: ["k1"],
          passthrough: false,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
    },
  };
  const server = new GatewayServer(cfg);

  const newCfg = {
    host: "0.0.0.0", // should be ignored — server is already bound
    port: 1234,      // should be ignored
    status_check: false,
    mode: "default",
    endpoints: {},
    endpoint_modes: {
      default: {
        openai: {
          name: "openai",
          base_url: "https://api.openai.com",
          auth_style: "bearer",
          keys: ["k2"],
          passthrough: false,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
    },
  };

  server.reloadConfig(newCfg);

  assert.equal(server.config.host, "127.0.0.1");
  assert.equal(server.config.port, 9999);
  assert.equal(server.config.mode, "default");
  assert.deepEqual(Object.keys(server.config.endpoints), ["openai"]);
});

test("reloadConfig falls back to first available mode when active mode disappears", () => {
  const cfg = {
    host: "127.0.0.1",
    port: 9999,
    status_check: false,
    mode: "prod",
    endpoints: {},
    endpoint_modes: {
      prod: { openai: { name: "openai", base_url: "u", auth_style: "bearer", keys: ["a"], passthrough: false, fallbacks: [], model_fallbacks: {} } },
      dev: { openai: { name: "openai", base_url: "u", auth_style: "bearer", keys: ["b"], passthrough: false, fallbacks: [], model_fallbacks: {} } },
    },
  };
  cfg.endpoints = cfg.endpoint_modes.prod;
  const server = new GatewayServer(cfg);
  assert.equal(server.config.mode, "prod");

  const newCfg = {
    host: "127.0.0.1",
    port: 9999,
    status_check: false,
    mode: "dev",
    endpoints: {},
    endpoint_modes: {
      // 'prod' disappeared; only 'staging' available
      staging: { openai: { name: "openai", base_url: "u", auth_style: "bearer", keys: ["c"], passthrough: false, fallbacks: [], model_fallbacks: {} } },
    },
  };
  server.reloadConfig(newCfg);
  assert.equal(server.config.mode, "staging");
  assert.equal(server.config.endpoints.openai.keys[0], "c");
});

test("watchConfigFile triggers callback when file changes", async () => {
  const file = tmpFile("gateway.yaml");
  fs.writeFileSync(file, "port: 9880\nopenai:\n  keys:\n    - k1\n", "utf-8");

  let calls = 0;
  let lastConfig = null;
  const stop = watchConfigFile(
    file,
    cfg => {
      calls += 1;
      lastConfig = cfg;
    },
    { intervalMs: 50 },
  );

  try {
    // Wait a tick, then mutate the file
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(file, "port: 9880\nopenai:\n  keys:\n    - k1\n    - k2\n", "utf-8");

    // Poll for up to 3s for the callback to fire
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && calls === 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.ok(calls >= 1, `expected callback to fire, got ${calls}`);
    assert.ok(lastConfig);
    assert.deepEqual(lastConfig.endpoints.openai.keys, ["k1", "k2"]);
  } finally {
    stop();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
