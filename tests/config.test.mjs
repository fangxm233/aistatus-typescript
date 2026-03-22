import assert from "node:assert/strict";
import test from "node:test";

// input: built gateway config exports from dist and temporary environment variables
// output: regression tests for autoDiscover, generateConfig, and mode-aware fromDict parsing
// pos: gateway config compatibility tests covering flat legacy config and nested mode config parsing
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

// Config tests: test autoDiscover, fromDict mode parsing, and generateConfig

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

test("generateConfig returns a non-empty YAML string", async () => {
  const { generateConfig } = await import("../dist/gateway/index.js");
  const content = generateConfig();
  assert.ok(content.length > 100);
  assert.ok(content.includes("port: 9880"));
  assert.ok(content.includes("anthropic:"));
  assert.ok(content.includes("openai:"));
});
