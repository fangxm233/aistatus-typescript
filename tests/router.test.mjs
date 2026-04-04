import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckResult,
  ProviderAdapter,
  RouteResponse,
  Router,
  Status,
  registerAdapterType,
} from "../dist/index.js";

class FailingOpenAIAdapter extends ProviderAdapter {
  async call(modelId) {
    throw new Error(`boom:${modelId}`);
  }
}

class WorkingGoogleAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: "ok",
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }
}

registerAdapterType("test-openai", FailingOpenAIAdapter);
registerAdapterType("test-google", WorkingGoogleAdapter);

test("Router falls back to the next provider when the first provider fails", async () => {
  const router = new Router({ autoDiscover: false });

  router.registerProvider({
    slug: "openai",
    adapterType: "test-openai",
  });
  router.registerProvider({
    slug: "google",
    adapterType: "test-google",
  });

  router.api.checkModel = async () =>
    new CheckResult({
      provider: "openai",
      status: Status.OPERATIONAL,
      model: "openai/gpt-4o-mini",
      alternatives: [
        {
          slug: "google",
          name: "Google",
          status: Status.OPERATIONAL,
          suggestedModel: "google/gemini-2.5-flash",
        },
      ],
    });

  const result = await router.route("hello", {
    model: "gpt-4o-mini",
  });

  assert.equal(result.content, "ok");
  assert.equal(result.providerUsed, "google");
  assert.equal(result.modelUsed, "google/gemini-2.5-flash");
  assert.equal(result.wasFallback, true);
  assert.equal(result.fallbackReason, "openai unavailable");
});

test("Router uploads usage records after successful route()", async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;

  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  try {
    const sdk = await import(`../dist/index.js?router-upload=${Date.now()}`);
    const { Router, CheckResult, Status, registerAdapterType, ProviderAdapter, RouteResponse, configure } = sdk;

    class UploadingAdapter extends ProviderAdapter {
      async call(modelId) {
        return new RouteResponse({
          content: "ok",
          modelUsed: modelId,
          providerUsed: this.slug,
          wasFallback: false,
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          costUsd: 0.55,
        });
      }
    }

    registerAdapterType("test-uploading", UploadingAdapter);
    configure({
      name: "Router User",
      org: "Router Org",
      email: "router@example.com",
      uploadEnabled: true,
    });

    const router = new Router({ autoDiscover: false });
    router.registerProvider({ slug: "anthropic", adapterType: "test-uploading" });
    router.api.checkModel = async () => new CheckResult({
      provider: "anthropic",
      status: Status.OPERATIONAL,
      model: "anthropic/claude-sonnet-4-6",
    });

    const result = await router.route("hello", { model: "claude-sonnet-4-6" });
    assert.equal(result.content, "ok");
    assert.equal(calls.length, 1);

    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.records[0].provider, "anthropic");
    assert.equal(payload.records[0].model, "anthropic/claude-sonnet-4-6");
    assert.equal(payload.records[0].input_tokens, 11);
    assert.equal(payload.records[0].output_tokens, 22);
    assert.equal(payload.records[0].cache_creation_input_tokens, 3);
    assert.equal(payload.records[0].cache_read_input_tokens, 4);
    assert.equal(payload.records[0].cost_usd, 0.55);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

