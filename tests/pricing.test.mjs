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
