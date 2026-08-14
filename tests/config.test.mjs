// input:  built config exports, temp env and filesystem
// output: Gateway and SDK configuration regression tests
// pos:    Configuration parser and persistence test suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Config tests: test autoDiscover, fromDict mode parsing, generateConfig, and SDK persistent config helpers

test("autoDiscover creates endpoints from env vars", async () => {
  // Save and set env
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };

  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENROUTER_API_KEY;

  try {
    // Dynamic import to pick up env changes
    const { autoDiscover } = await import("../dist/gateway/index.js");
    const config = autoDiscover("0.0.0.0", 8080);

    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 8080);
    assert.ok("anthropic" in config.endpoints);
    assert.ok("openai" in config.endpoints);
    assert.equal(config.endpoints.anthropic.keys[0], "sk-ant-test");
    assert.equal(config.endpoints.anthropic.auth_style, "anthropic");
    assert.equal(config.endpoints.openai.keys[0], "sk-test");
    assert.equal(config.endpoints.openai.auth_style, "openai");
    // No openrouter fallbacks since key not set
    assert.equal(config.endpoints.anthropic.fallbacks.length, 0);
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("autoDiscover adds OpenRouter fallbacks when OPENROUTER_API_KEY is set", async () => {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };

  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test";

  try {
    const { autoDiscover } = await import("../dist/gateway/index.js");
    const config = autoDiscover();

    assert.ok("anthropic" in config.endpoints);
    assert.equal(config.endpoints.anthropic.fallbacks.length, 1);
    assert.equal(config.endpoints.anthropic.fallbacks[0].name, "openrouter");
    assert.equal(config.endpoints.anthropic.fallbacks[0].translate, "anthropic-to-openai");
    assert.equal(config.endpoints.anthropic.fallbacks[0].model_prefix, "anthropic/");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("fromDict parses nested mode-aware endpoint config", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    mode: "api",
    anthropic: {
      api: {
        base_url: "https://right.codes/o2a",
        auth_style: "anthropic",
        passthrough: true,
        keys: ["sk-api"],
      },
      plan: {
        base_url: "https://api.anthropic.com",
        auth_style: "bearer",
        passthrough: true,
      },
    },
  });

  assert.equal(config.mode, "api");
  assert.deepEqual(Object.keys(config.endpoint_modes).sort(), ["api", "plan"]);
  assert.equal(config.endpoints.anthropic.base_url, "https://right.codes/o2a");
  assert.equal(config.endpoint_modes.api.anthropic.keys[0], "sk-api");
  assert.equal(config.endpoint_modes.plan.anthropic.base_url, "https://api.anthropic.com");
});

test("fromDict keeps flat config backward compatible", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    openai: {
      base_url: "https://api.openai.com",
      auth_style: "openai",
      keys: ["sk-test"],
      passthrough: false,
    },
  });

  assert.equal(config.mode, "default");
  assert.deepEqual(Object.keys(config.endpoint_modes), ["default"]);
  assert.equal(config.endpoints.openai.base_url, "https://api.openai.com");
  assert.equal(config.endpoint_modes.default.openai.keys[0], "sk-test");
});

test("fromDict defaults max_body_size_mb to 100", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  assert.equal(fromDict({}).max_body_size_mb, 100);
});

test("fromDict parses max_body_size_mb as reserved gateway config", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    max_body_size_mb: 64,
    openai: {
      base_url: "https://api.openai.com",
      auth_style: "openai",
    },
  });

  assert.equal(config.max_body_size_mb, 64);
  assert.ok(!("max_body_size_mb" in config.endpoints));
});

test("fromDict rejects invalid max_body_size_mb values", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  for (const value of [0, -1, Number.POSITIVE_INFINITY, "100"]) {
    assert.throws(
      () => fromDict({ max_body_size_mb: value }),
      /max_body_size_mb must be a finite number greater than zero/,
    );
  }
});

// ─── Fix 1: arbitrary endpoint names (no hardcoded provider whitelist) ─────

test("fromDict accepts arbitrary endpoint names beyond hardcoded providers", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  // PI exposes ~22 built-in providers (xai, openrouter, github-copilot, kimi-coding, ...).
  // None of these should be silently dropped just because they aren't in a code-level allowlist.
  const config = fromDict({
    xai: {
      base_url: "https://api.x.ai/v1",
      auth_style: "bearer",
      keys: ["xai-test"],
    },
    "github-copilot": {
      base_url: "https://api.individual.githubcopilot.com",
      auth_style: "bearer",
      passthrough: true,
    },
    "kimi-coding": {
      base_url: "https://api.kimi.com/coding",
      auth_style: "bearer",
      passthrough: true,
    },
  });

  assert.ok("xai" in config.endpoints, "xai endpoint should be parsed");
  assert.ok("github-copilot" in config.endpoints, "github-copilot endpoint should be parsed");
  assert.ok("kimi-coding" in config.endpoints, "kimi-coding endpoint should be parsed");
  assert.equal(config.endpoints.xai.base_url, "https://api.x.ai/v1");
  assert.equal(config.endpoints.xai.keys[0], "xai-test");
});

test("fromDict reserves system keys and does not treat them as endpoints", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    host: "127.0.0.1",
    port: 9880,
    status_check: true,
    auth: { keys: [], enabled: false },
    mode: "default",
    customEndpoint: {
      base_url: "https://custom.example.com",
      auth_style: "bearer",
    },
  });

  // System keys must NOT become endpoints
  assert.ok(!("host" in config.endpoints), "host must not be an endpoint");
  assert.ok(!("port" in config.endpoints), "port must not be an endpoint");
  assert.ok(!("status_check" in config.endpoints), "status_check must not be an endpoint");
  assert.ok(!("auth" in config.endpoints), "auth must not be an endpoint");
  assert.ok(!("mode" in config.endpoints), "mode must not be an endpoint");
  // Non-reserved key is a normal endpoint
  assert.ok("customEndpoint" in config.endpoints, "customEndpoint should be parsed");
});

test("fromDict accepts nested mode-aware config under arbitrary endpoint name", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    mode: "production",
    "openai-codex": {
      production: {
        base_url: "https://chatgpt.com/backend-api",
        auth_style: "bearer",
        passthrough: true,
      },
      sandbox: {
        base_url: "https://sandbox.chatgpt.com/backend-api",
        auth_style: "bearer",
      },
    },
  });

  assert.equal(config.mode, "production");
  assert.deepEqual(Object.keys(config.endpoint_modes).sort(), ["production", "sandbox"]);
  assert.equal(
    config.endpoint_modes.production["openai-codex"].base_url,
    "https://chatgpt.com/backend-api",
  );
});

// ─── Fix 2: openai-codex default base_url ──────────────────────────────

test("DEFAULT_BASE_URLS['openai-codex'] points to ChatGPT backend, not OpenAI Platform", async () => {
  const { DEFAULT_BASE_URLS } = await import("../dist/gateway/index.js");

  // OpenAI Codex uses the ChatGPT backend (OAuth bearer to ChatGPT Plus/Pro subscription),
  // NOT api.openai.com (which is the separately-billed Platform API).
  // Reference: PI source node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js
  //   `const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"`
  assert.equal(DEFAULT_BASE_URLS["openai-codex"], "https://chatgpt.com/backend-api");
});

test("fromDict uses correct codex default base_url when YAML omits base_url", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");
  const config = fromDict({
    "openai-codex": {
      auth_style: "bearer",
      passthrough: true,
    },
  });
  assert.equal(config.endpoints["openai-codex"].base_url, "https://chatgpt.com/backend-api");
});

// ─── Fix 3: OPENAI_CODEX_API_KEY removed from AUTO_DISCOVER_MAP ──────

test("autoDiscover does NOT pick up OPENAI_CODEX_API_KEY (codex is OAuth, no static key)", async () => {
  const saved = {
    OPENAI_CODEX_API_KEY: process.env.OPENAI_CODEX_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  process.env.OPENAI_CODEX_API_KEY = "should-be-ignored";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const { autoDiscover } = await import(`../dist/gateway/index.js?codex-discover=${Date.now()}`);
    const config = autoDiscover();
    assert.ok(
      !("openai-codex" in config.endpoints),
      "openai-codex must not be auto-discovered from env: it requires OAuth bearer, not a static API key",
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("fromDict defaults nested mode to first discovered mode when top-level mode missing", async () => {
  const { fromDict } = await import("../dist/gateway/index.js");

  const config = fromDict({
    anthropic: {
      plan: {
        base_url: "https://api.anthropic.com",
        auth_style: "bearer",
      },
      api: {
        base_url: "https://right.codes/o2a",
        auth_style: "anthropic",
        keys: ["sk-api"],
      },
    },
  });

  assert.equal(config.mode, "plan");
  assert.equal(config.endpoints.anthropic.base_url, "https://api.anthropic.com");
  assert.deepEqual(Object.keys(config.endpoint_modes).sort(), ["api", "plan"]);
});


test("AIStatus config falls back to defaults", async () => {
  const { getConfig, configure } = await import(`../dist/index.js?defaults=${Date.now()}`);

  configure(null);
  const config = getConfig({ env: {}, skipFile: true, filePath: "/nonexistent/config.yaml" });

  assert.equal(config.name, null);
  assert.equal(config.org, null);
  assert.equal(config.email, null);
  assert.equal(config.uploadEnabled, false);
});

test("AIStatus config loads YAML file values", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-config-file-"));
  const filePath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(filePath, "name: File User\norg: File Org\nemail: file@example.com\nuploadEnabled: true\n", "utf-8");

  try {
    const { getConfig, configure } = await import(`../dist/index.js?file=${Date.now()}`);
    configure(null);

    const config = getConfig({ env: {}, filePath });
    assert.equal(config.name, "File User");
    assert.equal(config.org, "File Org");
    assert.equal(config.email, "file@example.com");
    assert.equal(config.uploadEnabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AIStatus config prefers env over file and configure over env", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-config-priority-"));
  const filePath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(filePath, "name: File User\norg: File Org\nemail: file@example.com\nuploadEnabled: false\n", "utf-8");

  try {
    const { getConfig, configure } = await import(`../dist/index.js?priority=${Date.now()}`);
    configure(null);

    const envConfig = getConfig({
      env: {
        AISTATUS_NAME: "Env User",
        AISTATUS_ORG: "Env Org",
        AISTATUS_EMAIL: "env@example.com",
        AISTATUS_UPLOAD_ENABLED: "true",
      },
      filePath,
    });
    assert.equal(envConfig.name, "Env User");
    assert.equal(envConfig.org, "Env Org");
    assert.equal(envConfig.email, "env@example.com");
    assert.equal(envConfig.uploadEnabled, true);

    configure({
      name: "Configured User",
      org: "Configured Org",
      uploadEnabled: false,
    });
    const configured = getConfig({
      env: {
        AISTATUS_NAME: "Env User",
        AISTATUS_ORG: "Env Org",
        AISTATUS_EMAIL: "env@example.com",
        AISTATUS_UPLOAD_ENABLED: "true",
      },
      filePath,
    });
    assert.equal(configured.name, "Configured User");
    assert.equal(configured.org, "Configured Org");
    assert.equal(configured.email, "env@example.com");
    assert.equal(configured.uploadEnabled, false);

    configure(null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AIStatus config saves and loads canonical YAML file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-config-save-"));
  const filePath = path.join(tmpDir, "nested", "config.yaml");

  try {
    const { saveToFile, loadFromFile } = await import(`../dist/index.js?save=${Date.now()}`);

    saveToFile(
      {
        name: "Saved User",
        org: "Saved Org",
        email: "saved@example.com",
        uploadEnabled: true,
      },
      filePath,
    );

    assert.equal(fs.existsSync(filePath), true);
    const content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /name: Saved User/);
    assert.match(content, /uploadEnabled: true/);

    const loaded = loadFromFile(filePath);
    assert.deepEqual(loaded, {
      name: "Saved User",
      org: "Saved Org",
      email: "saved@example.com",
      uploadEnabled: true,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
