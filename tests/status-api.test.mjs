import assert from "node:assert/strict";
import test from "node:test";

import { Status, StatusAPI } from "../dist/index.js";

test("StatusAPI parses the current check model response shape", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "openai/gpt-4o-mini",
        available: true,
        providerStatus: "operational",
        alternatives: [
          {
            slug: "google",
            name: "Google",
            status: "operational",
            suggestedModel: "google/gemini-2.5-flash",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  try {
    const api = new StatusAPI();
    const result = await api.checkModel("gpt-4o-mini");

    assert.equal(result.provider, "openai");
    assert.equal(result.status, Status.OPERATIONAL);
    assert.equal(result.isAvailable, true);
    assert.equal(result.alternatives[0].slug, "google");
    assert.equal(
      result.alternatives[0].suggestedModel,
      "google/gemini-2.5-flash",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("StatusAPI normalizes provider aliases from provider lists", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        providers: [
          {
            slug: "x-ai",
            name: "xAI",
            status: "operational",
            statusDetail: null,
            modelCount: 10,
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  try {
    const api = new StatusAPI();
    const providers = await api.providers();

    assert.equal(providers[0].slug, "xai");
    assert.equal(providers[0].status, Status.OPERATIONAL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("StatusAPI.model encodes provider/model IDs as a single path segment", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        context_length: 128000,
        modality: "text",
        pricing: { prompt: 0.000005, completion: 0.000015 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const api = new StatusAPI("https://aistatus.cc");
    await api.model("openai/gpt-4o");
    assert.ok(requestedUrl.includes("/api/models/openai%2Fgpt-4o"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
