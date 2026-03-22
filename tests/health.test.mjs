import assert from "node:assert/strict";
import test from "node:test";

import { HealthTracker } from "../dist/gateway/index.js";

test("HealthTracker marks backend unhealthy after cooldown", () => {
  const ht = new HealthTracker();
  assert.equal(ht.isHealthy("a:key:0"), true);

  ht.recordError("a:key:0", 429);
  // After a 429 the backend should be unhealthy (30s cooldown)
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
  ht.recordError("a:key:0", 429, "claude-opus");
  // Backend itself should still be healthy
  assert.equal(ht.isHealthy("a:key:0"), true);
  // Model should be unhealthy
  assert.equal(ht.isHealthy("a:key:0", "claude-opus"), false);
  // Other model should be healthy
  assert.equal(ht.isHealthy("a:key:0", "claude-sonnet"), true);
});

test("HealthTracker summary includes both backend and model health", () => {
  const ht = new HealthTracker();
  ht.recordError("x:key:0", 500);
  ht.recordError("x:key:0", 429, "my-model");

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
