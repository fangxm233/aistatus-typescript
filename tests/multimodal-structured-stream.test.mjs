import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckResult,
  ProviderAdapter,
  RouteResponse,
  Router,
  Status,
  registerAdapterType,
  streamToReadable,
  extractTextFromContent,
  normalizeContent,
} from "../dist/index.js";

// --- Test adapters ---

class EchoAdapter extends ProviderAdapter {
  async call(modelId, messages, timeoutSeconds, options) {
    // Echo back the first message content as-is for inspection
    const firstMsg = messages.find((m) => m.role !== "system");
    const content =
      typeof firstMsg?.content === "string"
        ? firstMsg.content
        : JSON.stringify(firstMsg?.content);
    return new RouteResponse({
      content,
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: 10,
      outputTokens: 20,
    });
  }
}

class ErrorStreamAdapter extends ProviderAdapter {
  async call(modelId) {
    const err = new Error("provider-error");
    err.status = 500;
    throw err;
  }

  async *callStream(modelId, messages, timeoutSeconds, options) {
    yield { type: "text", text: "partial" };
    const err = new Error("stream-mid-error");
    err.status = 500;
    throw err;
  }
}

class StreamAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: "full",
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
    });
  }

  async *callStream(modelId) {
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

class AbortableAdapter extends ProviderAdapter {
  async call(modelId, messages, timeoutSeconds, options) {
    // Simulate a long call that respects AbortSignal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new RouteResponse({
            content: "ok",
            modelUsed: modelId,
            providerUsed: this.slug,
            wasFallback: false,
          }),
        );
      }, 5000);

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }
    });
  }
}

registerAdapterType("test-echo", EchoAdapter);
registerAdapterType("test-error-stream", ErrorStreamAdapter);
registerAdapterType("test-stream-mss", StreamAdapter);
registerAdapterType("test-abortable", AbortableAdapter);

function makeRouter(slug, adapterType, extraConfig) {
  const router = new Router({ autoDiscover: false });
  router.registerProvider({ slug, adapterType, ...extraConfig });
  router.api.checkModel = async () =>
    new CheckResult({ provider: slug, status: Status.OPERATIONAL });
  return router;
}

// ==================================================================
// Gap 2: Multimodal Message types
// ==================================================================

test("ChatMessage accepts string content (backward compat)", async () => {
  const router = makeRouter("echo", "test-echo");
  const result = await router.route("hello plain string", { model: "m1" });
  assert.equal(result.content, "hello plain string");
});

test("ChatMessage accepts ContentBlock[] content", async () => {
  const router = makeRouter("echo", "test-echo");
  const result = await router.route(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this image" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/img.png", detail: "low" },
          },
        ],
      },
    ],
    { model: "m1" },
  );
  // The echo adapter JSON.stringifies non-string content
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, "text");
  assert.equal(parsed[1].type, "image_url");
});

test("ChatMessage accepts ImageBase64Block content", async () => {
  const router = makeRouter("echo", "test-echo");
  const result = await router.route(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANS...",
            },
          },
        ],
      },
    ],
    { model: "m1" },
  );
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].type, "image");
  assert.equal(parsed[1].source.media_type, "image/png");
});

// ==================================================================
// Content helpers
// ==================================================================

test("extractTextFromContent works with string", () => {
  assert.equal(extractTextFromContent("hello"), "hello");
});

test("extractTextFromContent works with ContentBlock[]", () => {
  const blocks = [
    { type: "text", text: "part1" },
    { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    { type: "text", text: "part2" },
  ];
  assert.equal(extractTextFromContent(blocks), "part1\npart2");
});

test("normalizeContent wraps string to ContentBlock[]", () => {
  const result = normalizeContent("hello");
  assert.deepEqual(result, [{ type: "text", text: "hello" }]);
});

test("normalizeContent passes through ContentBlock[]", () => {
  const blocks = [{ type: "text", text: "hello" }];
  assert.equal(normalizeContent(blocks), blocks);
});

// ==================================================================
// Gap 3: Structured Output (ResponseFormat)
// ==================================================================

test("ResponseFormat type: json_object is accepted in options", async () => {
  const router = makeRouter("echo", "test-echo");
  // Should not throw — responseFormat is accepted as an option
  const result = await router.route("return json", {
    model: "m1",
    responseFormat: { type: "json_object" },
  });
  assert.ok(result.content);
});

test("ResponseFormat type: json_schema is accepted in options", async () => {
  const router = makeRouter("echo", "test-echo");
  const result = await router.route("return structured data", {
    model: "m1",
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "person",
        schema: { type: "object", properties: { name: { type: "string" } } },
        strict: true,
      },
    },
  });
  assert.ok(result.content);
});

test("ResponseFormat type: text is a no-op", async () => {
  const router = makeRouter("echo", "test-echo");
  const result = await router.route("hello", {
    model: "m1",
    responseFormat: { type: "text" },
  });
  assert.ok(result.content);
});

// ==================================================================
// Gap 6: Streaming enhancements
// ==================================================================

test("StreamChunk supports error type", async () => {
  const router = makeRouter("err-stream", "test-error-stream");
  const chunks = [];
  for await (const chunk of router.routeStream("hello", {
    model: "m1",
    allowFallback: false,
  })) {
    chunks.push(chunk);
  }
  const errorChunks = chunks.filter((c) => c.type === "error");
  assert.equal(errorChunks.length, 1);
  assert.ok(errorChunks[0].error instanceof Error);
});

test("routeStreamCallbacks calls onToken for each text chunk", async () => {
  const router = makeRouter("stream-cb", "test-stream-mss");
  const tokens = [];
  let usageData = null;
  let completed = false;

  await router.routeStreamCallbacks("hello", {
    model: "m1",
    callbacks: {
      onToken: (text) => tokens.push(text),
      onUsage: (usage) => { usageData = usage; },
      onComplete: () => { completed = true; },
    },
  });

  assert.deepEqual(tokens, ["Hello ", "world"]);
  assert.ok(usageData);
  assert.equal(usageData.inputTokens, 10);
  assert.equal(usageData.outputTokens, 5);
  assert.equal(usageData.cacheCreationInputTokens, 2);
  assert.equal(usageData.cacheReadInputTokens, 1);
  assert.equal(completed, true);
});

test("routeStreamCallbacks calls onError on stream failure", async () => {
  const router = makeRouter("err-stream-cb", "test-error-stream");
  let errorReceived = null;

  await router.routeStreamCallbacks("hello", {
    model: "m1",
    allowFallback: false,
    callbacks: {
      onError: (error) => { errorReceived = error; },
    },
  });

  assert.ok(errorReceived instanceof Error);
});

test("streamToReadable converts async generator to ReadableStream", async () => {
  const router = makeRouter("stream-rs", "test-stream-mss");
  const gen = router.routeStream("hello", { model: "m1" });
  const readable = streamToReadable(gen);

  const reader = readable.getReader();
  const parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }

  assert.deepEqual(parts, ["Hello ", "world"]);
});

test("streamToReadable closes on done chunk", async () => {
  async function* fakeStream() {
    yield { type: "text", text: "hi" };
    yield { type: "done" };
    // This should not be reached
    yield { type: "text", text: "should-not-appear" };
  }

  const readable = streamToReadable(fakeStream());
  const reader = readable.getReader();
  const parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }

  assert.deepEqual(parts, ["hi"]);
});

// ==================================================================
// AbortSignal
// ==================================================================

test("AbortSignal cancels a route() call", async () => {
  const router = makeRouter("abort-test", "test-abortable");
  const controller = new AbortController();

  // Abort after a short delay
  setTimeout(() => controller.abort(new Error("user-cancelled")), 50);

  await assert.rejects(
    () => router.route("hello", { model: "m1", signal: controller.signal }),
    (err) => {
      // The error might be wrapped, just check it was rejected
      return err instanceof Error;
    },
  );
});
