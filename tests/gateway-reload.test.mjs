/**
 * Hot-reload tests for the gateway config (GatewayServer.reloadConfig(), watchConfigFile())
 * and the upload config ~/.aistatus/config.yaml (watchUploadConfigFile(), reloadUploadConfig(),
 * startGateway() wiring). Upload requests are captured by fetch stubs and never leave the process.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GatewayServer,
  loadConfig,
  watchConfigFile,
  watchUploadConfigFile,
} from "../dist/gateway/index.js";
import { flushUsageUploads } from "../dist/index.js";

const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const DIST_INDEX = pathToFileURL(path.join(DIST_DIR, "index.js")).href;
const DIST_GATEWAY = pathToFileURL(path.join(DIST_DIR, "gateway/index.js")).href;
const UPLOAD_URL = "https://aistatus.cc/api/usage/upload";

// Keep usage/quota files written by GatewayServer out of the real home directory.
const originalHome = process.env.HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-reload-home-"));
process.env.HOME = suiteHome;

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

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

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("upload config hot reload: enable, identity change, parse error, disable, delete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-upload-reload-"));
  const file = path.join(dir, "config.yaml");
  const uploads = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === UPLOAD_URL) uploads.push(...JSON.parse(init.body).records);
    return new Response("{}", { status: 200 });
  };
  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

  const server = new GatewayServer({ host: "127.0.0.1", port: 0, status_check: false, endpoints: {} });
  const reloads = [];
  // env stands in for process.env (where tests/setup.mjs forces uploads off); AISTATUS_ORG checks env > file.
  const stop = watchUploadConfigFile(
    next => { reloads.push(next); server.reloadUploadConfig(next); },
    { filePath: file, intervalMs: 20, env: { AISTATUS_ORG: "Env Org" } },
  );
  // fs.watchFile takes its baseline stat asynchronously; a write before that is never reported.
  await new Promise(resolve => setTimeout(resolve, 100));
  const writeAndWait = async (content) => {
    const seen = reloads.length;
    if (content === null) fs.rmSync(file);
    else fs.writeFileSync(file, content, "utf-8");
    await waitFor(() => reloads.length > seen, "upload config reload");
  };
  let n = 0;
  const recordAndFlush = async () => {
    n += 1;
    server.usage.recordUsage({ provider: "p", model: "m", input_tokens: n, output_tokens: 1, latency_ms: 1, fallback: false });
    await flushUsageUploads();
  };

  try {
    assert.equal(server.uploader.enabled, false);
    await recordAndFlush();
    assert.equal(uploads.length, 0, "no upload before the config exists");

    await writeAndWait("name: Alice\norg: File Org\nemail: alice@example.com\nuploadEnabled: true\n");
    assert.equal(server.uploader.enabled, true);
    await recordAndFlush();
    assert.equal(uploads.length, 1, "enabling after start begins uploading");
    assert.deepEqual(
      [uploads[0].input_tokens, uploads[0].name, uploads[0].email, uploads[0].organization],
      [2, "Alice", "alice@example.com", "Env Org"],
    );

    await writeAndWait("name: Bob\nemail: bob@example.com\nuploadEnabled: true\n");
    await recordAndFlush();
    assert.deepEqual([uploads[1].input_tokens, uploads[1].name, uploads[1].email], [3, "Bob", "bob@example.com"]);

    const warned = warnings.length;
    fs.writeFileSync(file, "name: [unclosed\nuploadEnabled: false\n", "utf-8");
    await waitFor(() => warnings.length > warned, "parse-error warning");
    assert.match(warnings.at(-1), /Config reload failed/);
    await recordAndFlush();
    assert.deepEqual([uploads[2].input_tokens, uploads[2].name], [4, "Bob"], "parse error keeps the previous config");

    await writeAndWait("name: Bob\nemail: bob@example.com\nuploadEnabled: false\n");
    assert.equal(server.uploader.enabled, false);
    await recordAndFlush();
    assert.equal(uploads.length, 3, "disabling stops uploads");

    await writeAndWait("name: Bob\nemail: bob@example.com\nuploadEnabled: true\n");
    assert.equal(server.uploader.enabled, true);
    await writeAndWait(null);
    assert.equal(server.uploader.enabled, false, "deleting the file falls back to defaults");
  } finally {
    stop();
    await flushUsageUploads();
    globalThis.fetch = savedFetch;
    console.warn = savedWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startGateway watches ~/.aistatus/config.yaml unless watchConfig is false", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-upload-start-"));
  const script = `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const uploads = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) === ${JSON.stringify(UPLOAD_URL)}) uploads.push(...JSON.parse(init.body).records);
      return new Response("{}", { status: 200 });
    };
    const { startGateway } = await import(${JSON.stringify(DIST_GATEWAY)});
    const { flushUsageUploads } = await import(${JSON.stringify(DIST_INDEX)});
    const dir = path.join(process.env.HOME, ".aistatus");
    fs.mkdirSync(dir, { recursive: true });
    const gatewayYaml = path.join(dir, "gateway.yaml");
    fs.writeFileSync(gatewayYaml, "status_check: false\\n");
    const userConfig = path.join(dir, "config.yaml");
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const record = (server, n) => server.usage.recordUsage({ provider: "p", model: "m", input_tokens: n, output_tokens: 1, latency_ms: 1, fallback: false });

    const frozen = await startGateway({ configPath: gatewayYaml, port: 0, watchConfig: false });
    const live = await startGateway({ configPath: gatewayYaml, port: 0 });
    record(live, 1);
    await flushUsageUploads();
    // Let fs.watchFile take its baseline stat before the first write.
    await new Promise(resolve => setTimeout(resolve, 100));

    fs.writeFileSync(userConfig, "name: Alice\\nemail: alice@example.com\\nuploadEnabled: true\\n");
    await waitFor(() => live.uploader.enabled, "enable");
    record(live, 2);
    record(frozen, 3);
    await flushUsageUploads();

    fs.writeFileSync(userConfig, "name: Alice\\nemail: alice@example.com\\nuploadEnabled: false\\n");
    await waitFor(() => !live.uploader.enabled, "disable");
    record(live, 4);
    await flushUsageUploads();

    console.log("RESULT " + JSON.stringify({ uploads, frozenEnabled: frozen.uploader.enabled }));
    process.exit(0);
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AISTATUS_UPLOAD_ENABLED;
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 20_000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(result.error, null, result.stderr);
    const line = result.stdout.split("\n").find(l => l.startsWith("RESULT "));
    assert.ok(line, result.stdout);
    const { uploads, frozenEnabled } = JSON.parse(line.slice("RESULT ".length));
    assert.equal(frozenEnabled, false, "watchConfig: false does not reload the upload config");
    assert.deepEqual(uploads.map(r => [r.input_tokens, r.name, r.email]), [[2, "Alice", "alice@example.com"]]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
