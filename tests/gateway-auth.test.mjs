import assert from "node:assert/strict";
import test from "node:test";

// input: checkGatewayAuth function and fromDict config parser
// output: regression tests for gateway authentication behavior
// pos: validates auth bypass, key matching, public paths, custom headers, env var resolution, and backward compatibility
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

const { checkGatewayAuth, fromDict } = await import("../dist/gateway/index.js");

// ─── checkGatewayAuth pure function tests ────────────────────────

test("no auth config → all requests pass (backward compatible)", () => {
  assert.equal(checkGatewayAuth(undefined, "/anthropic/v1/messages", {}), true);
  assert.equal(checkGatewayAuth(undefined, "/openai/v1/chat/completions", {}), true);
});

test("auth.enabled=false → all requests pass even with keys configured", () => {
  const auth = { enabled: false, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", {}), true);
});

test("auth.enabled=true, no key → returns false (401)", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", {}), false);
});

test("auth.enabled=true, correct Bearer token → returns true", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  const headers = { authorization: "Bearer secret-key" };
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", headers), true);
});

test("auth.enabled=true, wrong key → returns false", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  const headers = { authorization: "Bearer wrong-key" };
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", headers), false);
});

test("/health bypasses auth (default public_paths)", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/health", {}), true);
});

test("/health sub-path also bypasses auth", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/health/detailed", {}), true);
});

test("public_paths defaults to ['/health'] when omitted", () => {
  const auth = { enabled: true, keys: ["secret-key"], header: "authorization" };
  // public_paths is undefined → defaults to ["/health"]
  assert.equal(checkGatewayAuth(auth, "/health", {}), true);
  assert.equal(checkGatewayAuth(auth, "/status", {}), false);
});

test("custom header (non-authorization) auth works", () => {
  const auth = { enabled: true, keys: ["my-api-key"], header: "x-api-key", public_paths: ["/health"] };
  // With correct custom header
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { "x-api-key": "my-api-key" }), true);
  // With wrong value
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { "x-api-key": "wrong" }), false);
  // Custom header should NOT use Bearer parsing
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { "x-api-key": "Bearer my-api-key" }), false);
});

test("multiple keys all authenticate successfully", () => {
  const auth = { enabled: true, keys: ["key-1", "key-2", "key-3"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/openai/v1/chat", { authorization: "Bearer key-1" }), true);
  assert.equal(checkGatewayAuth(auth, "/openai/v1/chat", { authorization: "Bearer key-2" }), true);
  assert.equal(checkGatewayAuth(auth, "/openai/v1/chat", { authorization: "Bearer key-3" }), true);
  assert.equal(checkGatewayAuth(auth, "/openai/v1/chat", { authorization: "Bearer key-4" }), false);
});

test("authorization header without Bearer prefix still matches", () => {
  const auth = { enabled: true, keys: ["raw-key"], header: "authorization", public_paths: ["/health"] };
  // Sending the key directly without "Bearer " prefix
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { authorization: "raw-key" }), true);
});

test("empty key in request returns false", () => {
  const auth = { enabled: true, keys: ["secret"], header: "authorization", public_paths: ["/health"] };
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { authorization: "" }), false);
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", { authorization: "Bearer " }), false);
});

test("multiple public_paths all bypass auth", () => {
  const auth = { enabled: true, keys: ["secret"], header: "authorization", public_paths: ["/health", "/status", "/metrics"] };
  assert.equal(checkGatewayAuth(auth, "/health", {}), true);
  assert.equal(checkGatewayAuth(auth, "/status", {}), true);
  assert.equal(checkGatewayAuth(auth, "/metrics", {}), true);
  assert.equal(checkGatewayAuth(auth, "/anthropic/v1/messages", {}), false);
});

// ─── fromDict auth config parsing tests ──────────────────────────

test("fromDict without auth field → config.auth is undefined", () => {
  const config = fromDict({ port: 9880 });
  assert.equal(config.auth, undefined);
});

test("fromDict with auth config parses correctly", () => {
  const config = fromDict({
    port: 9880,
    auth: {
      keys: ["literal-key"],
      header: "x-gateway-key",
      public_paths: ["/health", "/status"],
    },
  });
  assert.ok(config.auth);
  assert.equal(config.auth.enabled, true);
  assert.deepEqual(config.auth.keys, ["literal-key"]);
  assert.equal(config.auth.header, "x-gateway-key");
  assert.deepEqual(config.auth.public_paths, ["/health", "/status"]);
});

test("fromDict auth with $ENV_VAR resolves from environment", () => {
  const envKey = "__TEST_GW_AUTH_KEY_" + Date.now();
  process.env[envKey] = "resolved-secret";
  try {
    const config = fromDict({
      port: 9880,
      auth: { keys: [`$${envKey}`] },
    });
    assert.ok(config.auth);
    assert.equal(config.auth.enabled, true);
    assert.deepEqual(config.auth.keys, ["resolved-secret"]);
  } finally {
    delete process.env[envKey];
  }
});

test("fromDict auth with unset $ENV_VAR → empty keys → enabled=false", () => {
  const config = fromDict({
    port: 9880,
    auth: { keys: ["$NONEXISTENT_VAR_THAT_SHOULD_NOT_EXIST_12345"] },
  });
  assert.ok(config.auth);
  assert.equal(config.auth.enabled, false);
  assert.deepEqual(config.auth.keys, []);
});

test("fromDict auth with enabled=false explicitly → disabled even with keys", () => {
  const config = fromDict({
    port: 9880,
    auth: { enabled: false, keys: ["a-key"] },
  });
  assert.ok(config.auth);
  assert.equal(config.auth.enabled, false);
});

test("fromDict auth defaults: header=authorization, public_paths=['/health']", () => {
  const config = fromDict({
    port: 9880,
    auth: { keys: ["k"] },
  });
  assert.ok(config.auth);
  assert.equal(config.auth.header, "authorization");
  assert.deepEqual(config.auth.public_paths, ["/health"]);
});
