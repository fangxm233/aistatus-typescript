import assert from "node:assert/strict";
import test from "node:test";

// Config tests: test autoDiscover and generateConfig
// (loadConfig with YAML requires a file, so we test autoDiscover which is pure logic)

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

test("generateConfig returns a non-empty YAML string", async () => {
  const { generateConfig } = await import("../dist/gateway/index.js");
  const content = generateConfig();
  assert.ok(content.length > 100);
  assert.ok(content.includes("port: 9880"));
  assert.ok(content.includes("anthropic:"));
  assert.ok(content.includes("openai:"));
});
