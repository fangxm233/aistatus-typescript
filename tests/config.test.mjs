import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// input: built gateway config exports from dist, SDK config exports, and temporary environment variables/filesystem state
// output: regression tests for gateway config parsing plus SDK persistent config precedence and YAML file I/O
// pos: config compatibility tests covering gateway config parsing and the public SDK upload configuration surface
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

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
