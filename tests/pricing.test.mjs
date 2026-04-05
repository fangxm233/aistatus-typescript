import assert from "node:assert/strict";
import test from "node:test";

test("CostCalculator.calculateCost computes correctly with cached pricing", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator("https://aistatus.cc", 3600);

  // Manually inject pricing into memory cache for testing
  // We access the private cache via the getPricing path — but let's just test
  // calculateCost with a known pricing structure by monkey-patching getPricing
  const originalGetPricing = calc.getPricing.bind(calc);
  calc.getPricing = (provider, model) => {
    return {
      input_per_million: 3.0, // $3 per million input tokens
      output_per_million: 15.0, // $15 per million output tokens
    };
  };

  const cost = calc.calculateCost("anthropic", "claude-sonnet-4-6", 1000, 500);
  // 1000/1M * 3 + 500/1M * 15 = 0.003 + 0.0075 = 0.0105
  assert.equal(cost, 0.0105);
});

test("CostCalculator.calculateCost returns 0 when no pricing", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator();
  calc.getPricing = () => null;

  const cost = calc.calculateCost("unknown", "unknown-model", 1000, 500);
  assert.equal(cost, 0);
});

test("CostCalculator.calculateCost handles partial pricing", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator();
  calc.getPricing = () => ({
    input_per_million: 2.0,
    output_per_million: null,
  });

  const cost = calc.calculateCost("test", "test-model", 1_000_000, 500_000);
  // Only input: 1M/1M * 2 = 2.0
  assert.equal(cost, 2);
});

test("CostCalculator.calculateCostWithCache uses fetched cache prices", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator();
  calc.getPricing = () => ({
    input_per_million: 3.0,   // $3/M input
    output_per_million: 15.0, // $15/M output
    input_cache_read_per_million: 0.3,  // $0.30/M (0.10x input)
    input_cache_write_per_million: 3.75, // $3.75/M (1.25x input)
  });

  const cost = calc.calculateCostWithCache(
    "anthropic", "claude-sonnet-4-6",
    1000,    // input tokens
    500,     // output tokens
    2000,    // cache creation tokens
    5000,    // cache read tokens
  );

  // input: 1000/1M * 3 = 0.003
  // output: 500/1M * 15 = 0.0075
  // cache_write: 2000/1M * 3.75 = 0.0075
  // cache_read: 5000/1M * 0.3 = 0.0015
  // total = 0.003 + 0.0075 + 0.0075 + 0.0015 = 0.0195
  assert.equal(cost, 0.0195);
});

test("CostCalculator.calculateCostWithCache uses different cache prices per provider", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator();
  // Google-style pricing: cache read 0.10x, cache write 0.30x (not 1.25x like Anthropic)
  calc.getPricing = () => ({
    input_per_million: 1.25,
    output_per_million: 5.0,
    input_cache_read_per_million: 0.125,  // 0.10x
    input_cache_write_per_million: 0.375, // 0.30x (Google's rate)
  });

  const cost = calc.calculateCostWithCache(
    "google", "gemini-2.5-pro",
    1000, 500, 2000, 5000,
  );

  // input: 1000/1M * 1.25 = 0.00125
  // output: 500/1M * 5.0 = 0.0025
  // cache_write: 2000/1M * 0.375 = 0.00075
  // cache_read: 5000/1M * 0.125 = 0.000625
  // total = 0.00125 + 0.0025 + 0.00075 + 0.000625 = 0.005125
  assert.equal(cost, 0.005125);
});

test("CostCalculator.calculateCostWithCache falls back to multipliers when cache prices missing", async () => {
  const { CostCalculator } = await import("../dist/index.js");

  const calc = new CostCalculator();
  calc.getPricing = () => ({
    input_per_million: 3.0,
    output_per_million: 15.0,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  });

  const cost = calc.calculateCostWithCache(
    "anthropic", "claude-sonnet-4-6",
    1000, 500, 2000, 5000,
  );

  // Fallback: cache_write = 1.25x input, cache_read = 0.10x input
  // Same result as before: 0.0195
  assert.equal(cost, 0.0195);
});

test("CostCalculator.getPricing returns cache miss immediately and refreshes asynchronously", async () => {
  const { CostCalculator } = await import("../dist/index.js");
  const os = await import("node:os");
  const path = await import("node:path");

  const calc = new CostCalculator("https://aistatus.cc", 3600);
  calc._cachePath = path.join(os.tmpdir(), `aistatus-pricing-${Date.now()}.json`);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            pricing: { prompt: 0.000003, completion: 0.000015 },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const first = calc.getPricing("anthropic", "claude-sonnet-4-6");
    assert.equal(first, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 1);

    const second = calc.getPricing("anthropic", "claude-sonnet-4-6");
    assert.deepEqual(second, {
      input_per_million: 3,
      output_per_million: 15,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
