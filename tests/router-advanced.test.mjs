import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import {
  CheckResult,
  ProviderAdapter,
  RouteResponse,
  Router,
  Status,
  registerAdapterType,
} from "../dist/index.js";

// --- Test adapters ---

let callLog = [];

class CountingAdapter extends ProviderAdapter {
  async call(modelId, messages, timeoutSeconds, options) {
    callLog.push({ slug: this.slug, modelId, ts: Date.now() });
    return new RouteResponse({
      content: `ok:${this.slug}`,
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 3,
    });
  }
}

class FailOnceAdapter extends ProviderAdapter {
  _failCount = 0;
  _maxFails;
  _statusCode;

  constructor(config) {
    super(config);
    this._maxFails = config._maxFails ?? 1;
    this._statusCode = config._statusCode ?? 429;
  }

  async call(modelId) {
    callLog.push({ slug: this.slug, modelId, ts: Date.now() });
    if (this._failCount < this._maxFails) {
      this._failCount++;
      const err = new Error(`HTTP ${this._statusCode}`);
      err.status = this._statusCode;
      throw err;
    }
    return new RouteResponse({
      content: `recovered:${this.slug}`,
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }
}

class AlwaysFailAdapter extends ProviderAdapter {
  _statusCode;

  constructor(config) {
    super(config);
    this._statusCode = config._statusCode ?? 500;
  }

  async call(modelId) {
    callLog.push({ slug: this.slug, modelId, ts: Date.now() });
    const err = new Error(`HTTP ${this._statusCode}`);
    err.status = this._statusCode;
    throw err;
  }
}

class StreamingAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: "full response",
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }

  async *callStream(modelId, messages, timeoutSeconds, options) {
    yield { type: "text", text: "Hello " };
    yield { type: "text", text: "world" };
    yield {
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 1,
    };
    yield { type: "done" };
  }
}

class StreamFailThenWorkAdapter extends ProviderAdapter {
  constructor(config) {
    super(config);
    this._failCount = 0;
  }

  async call(modelId) {
    return new RouteResponse({
      content: `fallback:${this.slug}`,
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }

  async *callStream(modelId) {
    callLog.push({ slug: this.slug, modelId, ts: Date.now(), kind: "stream" });
    if (this._failCount === 0) {
      this._failCount++;
      const err = new Error("HTTP 500");
      err.status = 500;
      throw err;
    }
    yield { type: "text", text: `stream:${this.slug}` };
    yield { type: "done" };
  }
}

class StreamTierAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: `tier-call:${modelId}`,
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }

  async *callStream(modelId) {
    callLog.push({ slug: this.slug, modelId, ts: Date.now(), kind: "stream" });
    yield { type: "text", text: `tier:${modelId}` };
    yield { type: "done" };
  }
}

registerAdapterType("test-counting", CountingAdapter);
registerAdapterType("test-fail-once", FailOnceAdapter);
registerAdapterType("test-always-fail", AlwaysFailAdapter);
registerAdapterType("test-streaming", StreamingAdapter);
registerAdapterType("test-stream-fail-then-work", StreamFailThenWorkAdapter);
registerAdapterType("test-stream-tier", StreamTierAdapter);

// Reset call log before each test
test.beforeEach(() => {
  callLog = [];
});

// ------------------------------------------------------------------
// Health tracking
// ------------------------------------------------------------------

test("Router remembers provider failures across route() calls (health tracking)", async () => {
  const router = new Router({ autoDiscover: false });

  router.registerProvider({ slug: "primary", adapterType: "test-always-fail", _statusCode: 429 });
  router.registerProvider({ slug: "backup", adapterType: "test-counting" });

  // Mock: both providers are candidates
  router.api.checkModel = async () =>
    new CheckResult({
      provider: "primary",
      status: Status.OPERATIONAL,
      alternatives: [
        { slug: "backup", name: "Backup", status: Status.OPERATIONAL, suggestedModel: "m1" },
      ],
    });

  // First call: primary fails (429), falls back to backup
  const r1 = await router.route("hello", { model: "m1" });
  assert.equal(r1.providerUsed, "backup");

  // Second call: primary should be skipped (in cooldown), goes directly to backup
  callLog = [];
  const r2 = await router.route("hello", { model: "m1" });
  assert.equal(r2.providerUsed, "backup");

  // Primary should NOT have been called in the second request
  const primaryCalls = callLog.filter((c) => c.slug === "primary");
  assert.equal(primaryCalls.length, 0, "Primary should be skipped due to health cooldown");
});

// ------------------------------------------------------------------
// Model fallback chains
// ------------------------------------------------------------------

test("Router supports model fallback chains (opus → sonnet → haiku)", async () => {
  const router = new Router({ autoDiscover: false });

  // Only provider always fails — forces model fallback chain
  router.registerProvider({ slug: "anthropic", adapterType: "test-always-fail", _statusCode: 500 });

  // Mock: anthropic is the only provider for each model
  router.api.checkModel = async (model) =>
    new CheckResult({
      provider: "anthropic",
      status: Status.OPERATIONAL,
      model,
    });

  // claude-opus will fail on all providers → should try claude-sonnet → also fails → try claude-haiku
  // To make a fallback model succeed, we need a working provider for it.
  // Register a second provider that works, but only as alternative for fallback models.
  router.registerProvider({ slug: "backup", adapterType: "test-counting" });

  // For claude-opus: only anthropic (fails). For fallback models: anthropic (fails) + backup (works).
  router.api.checkModel = async (model) => {
    if (model === "claude-opus") {
      return new CheckResult({
        provider: "anthropic",
        status: Status.OPERATIONAL,
        model,
      });
    }
    // Fallback models have backup as alternative
    return new CheckResult({
      provider: "anthropic",
      status: Status.OPERATIONAL,
      model,
      alternatives: [
        { slug: "backup", name: "Backup", status: Status.OPERATIONAL, suggestedModel: model },
      ],
    });
  };

  const result = await router.route("hello", {
    model: "claude-opus",
    modelFallbacks: {
      "claude-opus": ["claude-sonnet", "claude-haiku"],
    },
  });

  // anthropic fails for all models, but backup succeeds for fallback models
  assert.ok(result.content.includes("ok:"), "Should succeed on a fallback model via backup provider");
  assert.ok(
    result.modelUsed.includes("claude-sonnet") || result.modelUsed.includes("claude-haiku"),
    `Should use a fallback model, got: ${result.modelUsed}`,
  );
});

// ------------------------------------------------------------------
// Retry on rate limit
// ------------------------------------------------------------------

test("Router retries on 429 before falling to next candidate", async () => {
  const router = new Router({ autoDiscover: false });

  // Adapter that fails once with 429, then succeeds
  router.registerProvider({
    slug: "provider-a",
    adapterType: "test-fail-once",
    _maxFails: 1,
    _statusCode: 429,
  });

  router.api.checkModel = async () =>
    new CheckResult({ provider: "provider-a", status: Status.OPERATIONAL });

  const result = await router.route("hello", {
    model: "m1",
    retryOnRateLimit: true,
    retryDelay: 50, // 50ms for fast test
  });

  assert.equal(result.providerUsed, "provider-a");
  assert.equal(result.content, "recovered:provider-a");

  // Should have been called twice (fail + retry)
  const calls = callLog.filter((c) => c.slug === "provider-a");
  assert.equal(calls.length, 2, "Should retry once on 429");
});

// ------------------------------------------------------------------
// Cache tokens in RouteResponse
// ------------------------------------------------------------------

test("RouteResponse includes cache token fields", () => {
  const resp = new RouteResponse({
    content: "test",
    modelUsed: "m1",
    providerUsed: "p1",
    wasFallback: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 5,
  });

  assert.equal(resp.cacheCreationInputTokens, 10);
  assert.equal(resp.cacheReadInputTokens, 5);
});

test("RouteResponse cache tokens default to 0", () => {
  const resp = new RouteResponse({
    content: "test",
    modelUsed: "m1",
    providerUsed: "p1",
    wasFallback: false,
  });

  assert.equal(resp.cacheCreationInputTokens, 0);
  assert.equal(resp.cacheReadInputTokens, 0);
});

test("Router propagates cache tokens from adapter response", async () => {
  const router = new Router({ autoDiscover: false });
  router.registerProvider({ slug: "cached-provider", adapterType: "test-counting" });

  router.api.checkModel = async () =>
    new CheckResult({ provider: "cached-provider", status: Status.OPERATIONAL });

  const result = await router.route("hello", { model: "m1" });
  assert.equal(result.cacheCreationInputTokens, 5);
  assert.equal(result.cacheReadInputTokens, 3);
});

// ------------------------------------------------------------------
// Streaming
// ------------------------------------------------------------------

test("Router.routeStream returns async iterable of chunks", async () => {
  const router = new Router({ autoDiscover: false });
  router.registerProvider({ slug: "stream-provider", adapterType: "test-streaming" });

  router.api.checkModel = async () =>
    new CheckResult({ provider: "stream-provider", status: Status.OPERATIONAL });

  const chunks = [];
  for await (const chunk of router.routeStream("hello", { model: "m1" })) {
    chunks.push(chunk);
  }

  const textChunks = chunks.filter((c) => c.type === "text");
  assert.equal(textChunks.length, 2);
  assert.equal(textChunks[0].text, "Hello ");
  assert.equal(textChunks[1].text, "world");

  const usageChunks = chunks.filter((c) => c.type === "usage");
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].inputTokens, 10);
  assert.equal(usageChunks[0].cacheCreationInputTokens, 2);
});

test("Router.routeStream uses tier candidates when only tier is provided", async () => {
  const router = new Router({ autoDiscover: false });
  router.registerProvider({ slug: "anthropic", adapterType: "test-stream-tier" });
  router.addTier("fast", ["anthropic/claude-haiku-4-5"]);

  const chunks = [];
  for await (const chunk of router.routeStream("hello", { tier: "fast" })) {
    chunks.push(chunk);
  }

  assert.equal(chunks[0].type, "text");
  assert.equal(chunks[0].text, "tier:anthropic/claude-haiku-4-5");
});

test("Provider adapters cache clients and rebuild when API key changes", async () => {
  const { createAdapter } = await import(`../dist/index.js?client-cache=${Date.now()}`);

  process.env.OPENAI_API_KEY = "key-one";
  const openai = createAdapter({ slug: "openai", adapterType: "openai" });
  const client1 = openai.getClient();
  const client2 = openai.getClient();
  assert.equal(client1, client2);

  process.env.OPENAI_API_KEY = "key-two";
  const client3 = openai.getClient();
  assert.notEqual(client1, client3);

  const anthropic = createAdapter({ slug: "anthropic", adapterType: "anthropic" });
  const ant1 = anthropic.getClient("ant-one");
  const ant2 = anthropic.getClient("ant-one");
  assert.equal(ant1, ant2);
  const ant3 = anthropic.getClient("ant-two");
  assert.notEqual(ant1, ant3);
});

