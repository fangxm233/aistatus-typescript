import assert from "node:assert/strict";
import test from "node:test";

import { HealthTracker, isServerError } from "../dist/gateway/index.js";

// --- isServerError ---

test("isServerError: 4xx codes are NOT server errors", () => {
  assert.equal(isServerError(400), false);
  assert.equal(isServerError(401), false);
  assert.equal(isServerError(403), false);
  assert.equal(isServerError(429), false);
  assert.equal(isServerError(404), false);
});

test("isServerError: 5xx codes ARE server errors", () => {
  assert.equal(isServerError(500), true);
  assert.equal(isServerError(502), true);
  assert.equal(isServerError(503), true);
  assert.equal(isServerError(529), true);
});

// --- 4xx no longer affects health ---

test("HealthTracker: 429 does NOT mark backend unhealthy (4xx is caller-side)", () => {
  const ht = new HealthTracker();
  assert.equal(ht.isHealthy("a:key:0"), true);

  ht.recordError("a:key:0", 429);
  // 429 is a 4xx — backend stays healthy
  assert.equal(ht.isHealthy("a:key:0"), true);
  // No server-side error recorded
  assert.equal(ht.errorCount("a:key:0"), 0);
});

test("HealthTracker: 5xx marks backend unhealthy with cooldown", () => {
  const ht = new HealthTracker();
  assert.equal(ht.isHealthy("a:key:0"), true);

  ht.recordError("a:key:0", 500);
  assert.equal(ht.isHealthy("a:key:0"), false);
  assert.equal(ht.errorCount("a:key:0"), 1);
});

test("HealthTracker recovers after recordSuccess", () => {
  const ht = new HealthTracker();
  ht.recordError("b:key:0", 500);
  assert.equal(ht.isHealthy("b:key:0"), false);

  ht.recordSuccess("b:key:0");
  assert.equal(ht.isHealthy("b:key:0"), true);
});

test("HealthTracker tracks model-level health independently", () => {
  const ht = new HealthTracker();
  ht.recordError("a:key:0", 503, "claude-opus");
  // Backend itself should still be healthy
  assert.equal(ht.isHealthy("a:key:0"), true);
  // Model should be unhealthy (5xx)
  assert.equal(ht.isHealthy("a:key:0", "claude-opus"), false);
  // Other model should be healthy
  assert.equal(ht.isHealthy("a:key:0", "claude-sonnet"), true);
});

test("HealthTracker: 429 at model level does NOT affect model health", () => {
  const ht = new HealthTracker();
  ht.recordError("a:key:0", 429, "claude-opus");
  assert.equal(ht.isHealthy("a:key:0", "claude-opus"), true);
});

test("HealthTracker summary includes both backend and model health", () => {
  const ht = new HealthTracker();
  ht.recordError("x:key:0", 500);
  ht.recordError("x:key:0", 503, "my-model");

  const summary = ht.summary();
  assert.ok("x:key:0" in summary);
  assert.ok("model_health" in summary);
  const modelHealth = summary.model_health;
  assert.ok("x:key:0/my-model" in modelHealth);
});

test("HealthTracker marks unhealthy after MAX_ERRORS_IN_WINDOW errors", () => {
  const ht = new HealthTracker();
  // Record 5 errors (the max) — should still be unhealthy because cooldown
  for (let i = 0; i < 5; i++) {
    ht.recordError("z:key:0", 502);
  }
  assert.equal(ht.isHealthy("z:key:0"), false);

  // Clear cooldown via success
  ht.recordSuccess("z:key:0");
  // Still unhealthy because of sliding window (5 errors in window)
  assert.equal(ht.isHealthy("z:key:0"), false);
  assert.equal(ht.errorCount("z:key:0"), 5);
});

// --- soonestCooldown ---

test("HealthTracker.soonestCooldown picks the backend closest to recovery", () => {
  const ht = new HealthTracker();
  ht.recordError("a:key:0", 503); // 10s cooldown
  ht.recordError("b:key:0", 500); // 15s cooldown

  const best = ht.soonestCooldown(["a:key:0", "b:key:0"]);
  assert.ok(best);
  assert.equal(best.id, "a:key:0");
  assert.ok(best.remaining > 0 && best.remaining <= 10);
});

test("HealthTracker.soonestCooldown returns 0 remaining for healthy backends", () => {
  const ht = new HealthTracker();
  // Never errored — should be 0 remaining
  const best = ht.soonestCooldown(["a:key:0"]);
  assert.ok(best);
  assert.equal(best.remaining, 0);
});
