// input:  parsed Gateway usage, backend metadata, pricing and storage
// output: one refresh-priced persisted usage record
// pos:    Shared JSON and SSE Gateway accounting boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import type { CostCalculator } from "../pricing.js";
import type { UsageTracker } from "../usage.js";
import { inferProvider } from "./server-helpers.js";
import type { Backend, GatewayUsage } from "./server-types.js";

export interface UsageAccountingOptions {
  backend: Backend;
  usage: GatewayUsage;
  elapsedMs: number;
  billingMode?: string;
  defaultBillingMode?: string;
  metadata?: Record<string, string>;
  pricing: CostCalculator;
  tracker: UsageTracker;
}

export async function recordGatewayUsage(options: UsageAccountingOptions): Promise<void> {
  const { backend, usage, elapsedMs, metadata, pricing, tracker } = options;
  const provider = inferProvider(backend, usage.model);
  const model = usage.model || `${provider}/unknown`;
  const cost = await calculateUsageCost(pricing, provider, model, usage);
  tracker.recordUsage({
    provider, model, cost, metadata,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    latency_ms: elapsedMs,
    fallback: backend.id.includes(":fb:"),
    billing_mode: options.billingMode || options.defaultBillingMode,
  });
}

async function calculateUsageCost(
  pricing: CostCalculator,
  provider: string,
  model: string,
  usage: GatewayUsage,
): Promise<number> {
  if (usage.cacheCreationInputTokens > 0 || usage.cacheReadInputTokens > 0) {
    return pricing.calculateCostWithCacheAsync(
      provider, model, usage.inputTokens, usage.outputTokens,
      usage.cacheCreationInputTokens, usage.cacheReadInputTokens,
    );
  }
  return pricing.calculateCostAsync(provider, model, usage.inputTokens, usage.outputTokens);
}
