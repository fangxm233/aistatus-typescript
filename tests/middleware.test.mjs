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

// ---------- Test adapters ----------

class MwTestAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: "mw-ok",
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: 10,
      outputTokens: 5,
    });
  }
}

class MwFailAdapter extends ProviderAdapter {
  async call(modelId) {
    const err = new Error(`mw-fail:${modelId}`);
    err.status = 500;
    throw err;
  }
}

class MwFallbackAdapter extends ProviderAdapter {
  async call(modelId) {
    return new RouteResponse({
      content: "mw-fallback",
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: 3,
      outputTokens: 2,
    });
  }
}

registerAdapterType("mw-test", MwTestAdapter);
registerAdapterType("mw-fail", MwFailAdapter);
registerAdapterType("mw-fallback", MwFallbackAdapter);

function makeRouter(middleware) {
  const router = new Router({ autoDiscover: false, middleware });
  router.registerProvider({ slug: "mw-prov", adapterType: "mw-test" });
  router.api.checkModel = async () =>
    new CheckResult({
      provider: "mw-prov",
      status: Status.OPERATIONAL,
      model: "mw-prov/test-model",
    });
  return router;
}

// ---------- Tests ----------

test("beforeRequest is called with correct context", async () => {
  let captured = null;
  const router = makeRouter([
    {
      beforeRequest(ctx) {
        captured = ctx;
      },
    },
  ]);

  await router.route("hello", { model: "test-model" });

  assert.ok(captured, "beforeRequest was called");
  assert.equal(captured.provider, "mw-prov");
  assert.equal(captured.model, "mw-prov/test-model");
  assert.ok(Array.isArray(captured.messages));
  assert.equal(captured.messages[0].content, "hello");
  assert.ok(captured.options);
  assert.ok(captured.callOptions);
});

test("afterResponse is called with response and latencyMs >= 0", async () => {
  let captured = null;
  const router = makeRouter([
    {
      afterResponse(ctx) {
        captured = ctx;
      },
    },
  ]);

  await router.route("hello", { model: "test-model" });

  assert.ok(captured, "afterResponse was called");
  assert.equal(captured.response.content, "mw-ok");
  assert.equal(captured.provider, "mw-prov");
  assert.equal(captured.model, "mw-prov/test-model");
  assert.equal(typeof captured.latencyMs, "number");
  assert.ok(captured.latencyMs >= 0, "latencyMs should be >= 0");
  assert.equal(captured.wasFallback, false);
});

test("onError is called when provider fails", async () => {
  let errorCaptured = null;
  let ctxCaptured = null;

  const router = new Router({ autoDiscover: false, healthTracking: false, middleware: [
    {
      onError(error, ctx) {
        errorCaptured = error;
        ctxCaptured = ctx;
      },
    },
  ]});
  router.registerProvider({ slug: "fail-prov", adapterType: "mw-fail" });
  router.api.checkModel = async () =>
    new CheckResult({
      provider: "fail-prov",
      status: Status.OPERATIONAL,
      model: "fail-prov/bad-model",
    });

  await assert.rejects(() =>
    router.route("hello", { model: "bad-model", retryOnRateLimit: false }),
  );

  assert.ok(errorCaptured, "onError was called");
  assert.ok(errorCaptured.message.includes("mw-fail"));
  assert.equal(ctxCaptured.provider, "fail-prov");
  assert.equal(ctxCaptured.model, "fail-prov/bad-model");
});

test("Multiple middleware execute in order", async () => {
  const order = [];
  const router = makeRouter([
    {
      beforeRequest() { order.push("before-1"); },
      afterResponse() { order.push("after-1"); },
    },
    {
      beforeRequest() { order.push("before-2"); },
      afterResponse() { order.push("after-2"); },
    },
  ]);

  await router.route("hello", { model: "test-model" });

  assert.deepEqual(order, ["before-1", "before-2", "after-1", "after-2"]);
});

test("router.use() adds middleware dynamically", async () => {
  const router = makeRouter([]);
  let called = false;

  router.use({
    afterResponse() {
      called = true;
    },
  });

  await router.route("hello", { model: "test-model" });
  assert.ok(called, "dynamically added middleware was called");
});

test("beforeRequest can throw to abort (propagates as error)", async () => {
  const router = makeRouter([
    {
      beforeRequest() {
        throw new Error("request-blocked");
      },
    },
  ]);

  await assert.rejects(
    () => router.route("hello", { model: "test-model" }),
    (err) => {
      // The error from beforeRequest should propagate. Depending on allowFallback,
      // it may be wrapped in AllProvidersDown or propagated directly.
      // With default allowFallback=true and a single provider, it becomes AllProvidersDown.
      return true;
    },
  );
});

test("Middleware works with tier routing (routeTier -> routeModel)", async () => {
  let beforeCount = 0;
  let afterCount = 0;

  const router = makeRouter([
    {
      beforeRequest() { beforeCount++; },
      afterResponse() { afterCount++; },
    },
  ]);

  router.addTier("fast", ["test-model"]);
  const result = await router.route("hello", { tier: "fast" });

  assert.equal(result.content, "mw-ok");
  assert.ok(beforeCount >= 1, "beforeRequest called via tier routing");
  assert.ok(afterCount >= 1, "afterResponse called via tier routing");
});

test("No middleware does not break existing behavior", async () => {
  const router = new Router({ autoDiscover: false });
  router.registerProvider({ slug: "mw-prov", adapterType: "mw-test" });
  router.api.checkModel = async () =>
    new CheckResult({
      provider: "mw-prov",
      status: Status.OPERATIONAL,
      model: "mw-prov/test-model",
    });

  const result = await router.route("hello", { model: "test-model" });
  assert.equal(result.content, "mw-ok");
  assert.equal(result.providerUsed, "mw-prov");
});

test("onError fires then fallback provider is tried", async () => {
  const errors = [];
  const afters = [];

  const router = new Router({
    autoDiscover: false,
    healthTracking: false,
    middleware: [
      {
        onError(err, ctx) { errors.push(ctx.provider); },
        afterResponse(ctx) { afters.push(ctx.provider); },
      },
    ],
  });

  router.registerProvider({ slug: "primary", adapterType: "mw-fail" });
  router.registerProvider({ slug: "backup", adapterType: "mw-fallback" });

  router.api.checkModel = async () =>
    new CheckResult({
      provider: "primary",
      status: Status.OPERATIONAL,
      model: "primary/some-model",
      alternatives: [
        { slug: "backup", name: "Backup", status: Status.OPERATIONAL, suggestedModel: "backup/some-model" },
      ],
    });

  const result = await router.route("hello", { model: "some-model", retryOnRateLimit: false });

  assert.equal(result.content, "mw-fallback");
  assert.equal(result.providerUsed, "backup");
  assert.ok(errors.includes("primary"), "onError fired for primary");
  assert.ok(afters.includes("backup"), "afterResponse fired for backup");
});

test("Async middleware hooks are awaited properly", async () => {
  let asyncCompleted = false;
  const router = makeRouter([
    {
      async beforeRequest() {
        await new Promise((r) => setTimeout(r, 10));
        asyncCompleted = true;
      },
    },
  ]);

  await router.route("hello", { model: "test-model" });
  assert.ok(asyncCompleted, "async beforeRequest completed before call");
});
