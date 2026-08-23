// input:  built usage classes and temporary JSONL storage
// output: persistence, incremental index and aggregation regressions
// pos:    Usage storage and reporting boundary tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("UsageTracker forwards records to uploader after persistence", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-uploader-forward-test-"));

  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/project4");
    const uploaded = [];
    const tracker = new UsageTracker(storage, {
      upload(record) {
        uploaded.push(record);
      },
    });

    const record = tracker.recordUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 7,
      output_tokens: 8,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
      latency_ms: 90,
      fallback: true,
      cost: 0.123,
    });

    const stored = storage.read("all");
    assert.equal(stored.length, 1);
    assert.equal(uploaded.length, 1);
    assert.deepEqual(uploaded[0], record);
    assert.equal(uploaded[0].fallback, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker records optional metadata fields", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-metadata-test-"));

  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/project5");
    const tracker = new UsageTracker(storage);

    const record = tracker.recordUsage({
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 10,
      output_tokens: 20,
      latency_ms: 123,
      fallback: false,
      billing_mode: "plan",
      metadata: { project: "dex-hand", trigger: "dispatch" },
    });

    assert.equal(record.project, "dex-hand");
    assert.equal(record.trigger, "dispatch");
    assert.equal(record.billing_mode, "plan");

    const records = storage.read("all");
    assert.equal(records.length, 1);
    assert.equal(records[0].project, "dex-hand");
    assert.equal(records[0].trigger, "dispatch");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker metadata does not overwrite reserved fields", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-meta-reserved-test-"));

  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/project6");
    const tracker = new UsageTracker(storage);

    const record = tracker.recordUsage({
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 10,
      output_tokens: 20,
      latency_ms: 123,
      fallback: false,
      metadata: { model: "evil-override", project: "legit" },
    });

    assert.equal(record.model, "claude-opus-4-6", "Reserved 'model' field should not be overwritten");
    assert.equal(record.project, "legit", "Non-reserved metadata should be written");
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

function storedUsage(ts, overrides = {}) {
  return {
    ts, provider: "anthropic", model: "claude-test", in: 10, out: 5,
    cost: 0.25, fallback: false, latency_ms: 100, ...overrides,
  };
}

function usageProjectDir(baseDir) {
  const projectsDir = path.join(baseDir, "projects");
  return path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
}

function onlyUsageFile(baseDir) {
  const dir = usageProjectDir(baseDir);
  return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dir, name)).sort().at(-1);
}

test("UsageTracker prewarms rolling reports and ingests appended tails", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-index-tail-test-"));
  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/index-tail");
    const tracker = new UsageTracker(storage);
    const now = Date.now();
    storage.append(storedUsage(new Date(now - 29 * 86400_000).toISOString()));
    storage.append(storedUsage(new Date(now - 31 * 86400_000).toISOString(), { cost: 9 }));

    tracker.prewarm("month");
    assert.equal(tracker.report("month", "provider").summary.requests, 1);

    storage.append(storedUsage(new Date().toISOString(), { provider: "deepseek" }));
    assert.equal(tracker.report("month").summary.requests, 2);
    storage.append(storedUsage(new Date().toISOString(), { provider: "Qwen" }));
    const file = onlyUsageFile(tmpDir);
    fs.appendFileSync(file, JSON.stringify(storedUsage(new Date().toISOString(), { provider: "openai" })) + "\n");
    const report = tracker.report("month", "provider");
    assert.equal(report.summary.requests, 4);
    assert.deepEqual(report.providers.map((row) => row.provider).sort(), ["Qwen", "anthropic", "deepseek", "openai"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker includes recently modified legacy month files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-index-legacy-test-"));
  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/index-legacy");
    const tracker = new UsageTracker(storage);
    const legacy = path.join(usageProjectDir(tmpDir), "2000-01.jsonl");
    fs.writeFileSync(legacy, JSON.stringify(storedUsage(new Date().toISOString())) + "\n");

    assert.equal(tracker.report("today").summary.requests, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker waits for complete tail lines and rebuilds replaced files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-index-rebuild-test-"));
  try {
    const { UsageStorage, UsageTracker } = await import("../dist/index.js");
    const storage = new UsageStorage(tmpDir, "/test/index-rebuild");
    const tracker = new UsageTracker(storage);
    storage.append(storedUsage(new Date().toISOString()));
    tracker.prewarm("today");
    const file = onlyUsageFile(tmpDir);
    const partial = JSON.stringify(storedUsage(new Date().toISOString(), { provider: "deepseek" }));
    fs.appendFileSync(file, partial.slice(0, -2));
    assert.equal(tracker.summary("today").requests, 1);
    fs.appendFileSync(file, partial.slice(-2) + "\n");
    assert.equal(tracker.summary("today").requests, 2);

    fs.writeFileSync(file, JSON.stringify(storedUsage(new Date().toISOString(), { provider: "Qwen", cost: 1 })) + "\n");
    const report = tracker.report("today", "provider");
    assert.equal(report.summary.requests, 1);
    assert.equal(report.providers[0].provider, "Qwen");

    const sameSize = fs.readFileSync(file, "utf8").replace("Qwen", "Zwen");
    fs.writeFileSync(file, sameSize);
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(file, future, future);
    assert.equal(tracker.report("today", "provider").providers[0].provider, "Zwen");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("UsageTracker builds a grouped report from one storage read", async () => {
  const { UsageTracker } = await import("../dist/index.js");
  let reads = 0;
  const tracker = new UsageTracker({
    read(period) {
      reads++;
      assert.equal(period, "all");
      return [
        { provider: "anthropic", in: 10, out: 4, cost: 0.1, latency_ms: 100, fallback: false },
        { provider: "anthropic", in: 20, out: 6, cost: 0.2, latency_ms: 200, fallback: true },
        { in: 5, out: 2, cost: 0.3, latency_ms: 300, fallback: false },
      ];
    },
  });

  const report = tracker.report("all", "provider");

  assert.equal(reads, 1);
  assert.deepEqual(report, {
    summary: {
      period: "all", requests: 3, input_tokens: 35, output_tokens: 12,
      cost_usd: 0.6, avg_latency_ms: 200, fallback_requests: 1,
    },
    providers: [
      {
        provider: "anthropic", requests: 2, input_tokens: 30, output_tokens: 10,
        cost_usd: 0.3, avg_latency_ms: 150, fallback_requests: 1,
      },
      {
        provider: "unknown", requests: 1, input_tokens: 5, output_tokens: 2,
        cost_usd: 0.3, avg_latency_ms: 300, fallback_requests: 0,
      },
    ],
  });
});
