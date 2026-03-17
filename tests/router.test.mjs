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

test("Router can match provider aliases registered on custom adapters", async () => {
  const router = new Router({ autoDiscover: false });

  router.registerProvider({
    slug: "my-openai",
    aliases: ["openai"],
    adapterType: "test-google",
  });

  router.api.checkModel = async () =>
    new CheckResult({
      provider: "openai",
      status: Status.OPERATIONAL,
      model: "openai/gpt-4o-mini",
    });

  const result = await router.route("hello", {
    model: "gpt-4o-mini",
  });

  assert.equal(result.providerUsed, "openai");
  assert.equal(result.modelUsed, "openai/gpt-4o-mini");
});
