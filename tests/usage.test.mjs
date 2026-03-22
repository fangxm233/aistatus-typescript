import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// input: built UsageTracker and UsageStorage classes from dist with temporary on-disk JSONL storage
// output: regression tests for usage persistence, aggregation, and optional billing_mode recording
// pos: usage storage tests protecting gateway usage record schema and readback behavior
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

// We import from the gateway build which re-exports, or directly from dist
// UsageTracker and UsageStorage are in src/usage.ts, built into dist/

test("UsageTracker records and summarizes usage", async () => {
  // Create a temp directory for storage
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-usage-test-"));

  try {
    // Dynamic import to get the classes
    const mod = await import("../dist/gateway/index.js");
    // UsageTracker is not re-exported from gateway, import from main
    // Actually we need to import from the build output directly
    // Let's use a workaround: import the chunk that contains UsageTracker
    const { UsageTracker, UsageStorage } = await import("../dist/index.js");

    const storage = new UsageStorage(tmpDir, "/test/project");
    const tracker = new UsageTracker(storage);

    // Record some usage
    tracker.recordUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 100,
      output_tokens: 50,
      latency_ms: 200,
      fallback: false,
    });

    tracker.recordUsage({
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 200,
      output_tokens: 100,
      latency_ms: 300,
      fallback: true,
    });

    // Test summary
    const summary = tracker.summary("all");
    assert.equal(summary.requests, 2);
    assert.equal(summary.input_tokens, 300);
    assert.equal(summary.output_tokens, 150);
    assert.equal(summary.fallback_requests, 1);

    // Test byModel
    const models = tracker.byModel("all");
    assert.equal(models.length, 2);

    // Test byProvider
    const providers = tracker.byProvider("all");
    assert.equal(providers.length, 2);
    const anthropicP = providers.find((p) => p.provider === "anthropic");
    assert.ok(anthropicP);
    assert.equal(anthropicP.requests, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker records optional billing_mode", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-billing-mode-test-"));

  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/project3");
    const tracker = new UsageTracker(storage);

    const record = tracker.recordUsage({
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 10,
      output_tokens: 20,
      latency_ms: 123,
      fallback: false,
      billing_mode: "plan",
    });

    assert.equal(record.billing_mode, "plan");
    const records = storage.read("all");
    assert.equal(records.length, 1);
    assert.equal(records[0].billing_mode, "plan");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageStorage persists records to JSONL files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-storage-test-"));

  try {
    const { UsageStorage } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/project2");

    storage.append({
      ts: new Date().toISOString(),
      provider: "test",
      model: "test-model",
      in: 10,
      out: 5,
    });

    // Read back
    const records = storage.read("all");
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "test");
    assert.equal(records[0].model, "test-model");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
