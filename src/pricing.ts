// input:  model-search responses, token counts, pricing cache files
// output: synchronous and refresh-aware token cost calculations
// pos:    Shared SDK and Gateway pricing cache
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BASE_URL = "https://aistatus.cc";
const CACHE_TTL_SECONDS = 3600;

interface PricingInfo {
  input_per_million: number | null;
  output_per_million: number | null;
  input_cache_read_per_million: number | null;
  input_cache_write_per_million: number | null;
}

interface CacheEntry {
  ts: number;
  pricing: PricingInfo;
}

export class CostCalculator {
  private _baseUrl: string;
  private _ttlSeconds: number;
  private _memoryCache = new Map<string, CacheEntry>();
  private _cachePath: string;
  private _pendingRefreshes = new Map<string, Promise<void>>();

  constructor(baseUrl = BASE_URL, ttlSeconds = CACHE_TTL_SECONDS) {
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this._ttlSeconds = ttlSeconds;
    this._cachePath = path.join(os.homedir(), ".aistatus", "usage", "pricing-cache.json");
  }

  calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    return calculateStandardCost(this.getPricing(provider, model), inputTokens, outputTokens);
  }

  async calculateCostAsync(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<number> {
    return calculateStandardCost(await this._getPricingAfterRefresh(provider, model), inputTokens, outputTokens);
  }

  calculateCostWithCache(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
  ): number {
    return calculateCacheCost(
      this.getPricing(provider, model), inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens,
    );
  }

  async calculateCostWithCacheAsync(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
  ): Promise<number> {
    const pricing = await this._getPricingAfterRefresh(provider, model);
    return calculateCacheCost(pricing, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens);
  }

  getPricing(provider: string, model: string): PricingInfo | null {
    const cacheKey = this._normalizeKey(provider, model);
    const now = Date.now() / 1000;

    const memEntry = this._memoryCache.get(cacheKey);
    if (memEntry && this._isFresh(memEntry, now)) {
      return memEntry.pricing;
    }

    const fileCache = this._readFileCache();
    const fileEntry = fileCache[cacheKey];
    if (fileEntry && this._isFresh(fileEntry, now)) {
      this._memoryCache.set(cacheKey, fileEntry);
      return fileEntry.pricing;
    }

    this._refreshPricing(cacheKey, provider, model, fileCache);
    return null;
  }

  private async _getPricingAfterRefresh(provider: string, model: string): Promise<PricingInfo | null> {
    const cacheKey = this._normalizeKey(provider, model);
    const cached = this.getPricing(provider, model);
    if (cached) return cached;

    await this._pendingRefreshes.get(cacheKey);
    const now = Date.now() / 1000;
    const memoryEntry = this._memoryCache.get(cacheKey);
    if (memoryEntry && this._isFresh(memoryEntry, now)) return memoryEntry.pricing;

    const fileEntry = this._readFileCache()[cacheKey];
    if (!fileEntry || !this._isFresh(fileEntry, now)) return null;
    this._memoryCache.set(cacheKey, fileEntry);
    return fileEntry.pricing;
  }

  private _refreshPricing(
    cacheKey: string,
    provider: string,
    model: string,
    fileCache: Record<string, CacheEntry>,
  ): Promise<void> {
    const pending = this._pendingRefreshes.get(cacheKey);
    if (pending) return pending;

    const refresh = this._fetchAndCachePricing(cacheKey, provider, model, fileCache)
      .catch(() => undefined)
      .finally(() => this._pendingRefreshes.delete(cacheKey));
    this._pendingRefreshes.set(cacheKey, refresh);
    return refresh;
  }

  private async _fetchAndCachePricing(
    cacheKey: string,
    provider: string,
    model: string,
    fileCache: Record<string, CacheEntry>,
  ): Promise<void> {
    const pricing = await this._fetchPricing(provider, model);
    if (pricing == null) return;

    const entry: CacheEntry = { ts: Date.now() / 1000, pricing };
    this._memoryCache.set(cacheKey, entry);
    fileCache[cacheKey] = entry;
    this._writeFileCache(fileCache);
  }

  private async _fetchPricing(provider: string, model: string): Promise<PricingInfo | null> {
    const [providerSlug, modelName] = this._splitModel(provider, model);
    const queries = this._candidateQueries(modelName);

    let models: Array<Record<string, unknown>> = [];

    for (const query of queries) {
      try {
        const url = `${this._baseUrl}/api/models?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) continue;
        const data = await response.json() as { models?: Array<Record<string, unknown>> };
        models = data.models ?? [];
        if (models.length > 0) break;
      } catch {
        continue;
      }
    }

    const match = this._pickModelMatch(providerSlug, modelName, models);
    if (!match) return null;

    const pricing = (match.pricing as Record<string, unknown>) ?? {};
    const prompt = toFloat(pricing.prompt);
    const completion = toFloat(pricing.completion);
    if (prompt == null && completion == null) return null;

    const cacheRead = toFloat(pricing.input_cache_read);
    const cacheWrite = toFloat(pricing.input_cache_write);

    return {
      input_per_million: prompt == null ? null : prompt * 1_000_000,
      output_per_million: completion == null ? null : completion * 1_000_000,
      input_cache_read_per_million: cacheRead == null ? null : cacheRead * 1_000_000,
      input_cache_write_per_million: cacheWrite == null ? null : cacheWrite * 1_000_000,
    };
  }

  private _pickModelMatch(
    provider: string,
    model: string,
    models: Array<Record<string, unknown>>,
  ): Record<string, unknown> | null {
    const targetFull = normalizeModelId(`${provider}/${model}`);
    const targetName = normalizeModelId(model);

    for (const item of models) {
      if (normalizeModelId(String(item.id ?? "")) === targetFull) return item;
    }
    for (const item of models) {
      if (normalizeModelId(String(item.id ?? "")).endsWith(`/${targetName}`)) return item;
    }
    for (const item of models) {
      if (normalizeModelId(String(item.id ?? "")).includes(targetName)) return item;
    }
    return models[0] ?? null;
  }

  private _readFileCache(): Record<string, CacheEntry> {
    try {
      if (!fs.existsSync(this._cachePath)) return {};
      const data = JSON.parse(fs.readFileSync(this._cachePath, "utf-8"));
      if (typeof data === "object" && data !== null) return data;
    } catch { /* ignore */ }
    return {};
  }

  private _writeFileCache(cache: Record<string, CacheEntry>): void {
    const dir = path.dirname(this._cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this._cachePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
    fs.renameSync(tmp, this._cachePath);
  }

  private _normalizeKey(provider: string, model: string): string {
    const [providerSlug, modelName] = this._splitModel(provider, model);
    return `${providerSlug}/${modelName}`;
  }

  private _splitModel(provider: string, model: string): [string, string] {
    if (model.includes("/")) {
      const idx = model.indexOf("/");
      return [model.slice(0, idx), model.slice(idx + 1)];
    }
    return [provider, model];
  }

  private _isFresh(entry: CacheEntry | undefined, now: number): boolean {
    if (!entry) return false;
    const ts = toFloat(entry.ts);
    return ts != null && (now - ts) < this._ttlSeconds;
  }

  private _candidateQueries(modelName: string): string[] {
    const variants = [modelName];
    const normalized = normalizeModelId(modelName);
    if (normalized !== modelName) variants.push(normalized);
    const versions = versionAliases(modelName);
    variants.push(...versions);
    variants.push(...versions.map(v => v.replace(/\./g, "-")));
    variants.push(normalized.replace(/\./g, "-"));
    variants.push(normalized.replace(/-/g, " "));

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const v of variants) {
      const trimmed = v.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    return deduped;
  }
}

function calculateStandardCost(
  pricing: PricingInfo | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing) return 0;
  const { input_per_million: inputPrice, output_per_million: outputPrice } = pricing;
  if (inputPrice == null && outputPrice == null) return 0;

  const inputCost = inputPrice == null ? 0 : (Math.max(inputTokens, 0) / 1_000_000) * inputPrice;
  const outputCost = outputPrice == null ? 0 : (Math.max(outputTokens, 0) / 1_000_000) * outputPrice;
  return roundCost(inputCost + outputCost);
}

function calculateCacheCost(
  pricing: PricingInfo | null,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
): number {
  if (!pricing) return 0;
  const { input_per_million: inputPrice, output_per_million: outputPrice } = pricing;
  if (inputPrice == null && outputPrice == null) return 0;

  const inputCost = inputPrice == null ? 0 : (Math.max(inputTokens, 0) / 1_000_000) * inputPrice;
  const outputCost = outputPrice == null ? 0 : (Math.max(outputTokens, 0) / 1_000_000) * outputPrice;
  const writePrice = inputPrice == null ? 0 : pricing.input_cache_write_per_million ?? inputPrice * 1.25;
  const readPrice = inputPrice == null ? 0 : pricing.input_cache_read_per_million ?? inputPrice * 0.10;
  const writeCost = (Math.max(cacheCreationInputTokens, 0) / 1_000_000) * writePrice;
  const readCost = (Math.max(cacheReadInputTokens, 0) / 1_000_000) * readPrice;
  return roundCost(inputCost + outputCost + writeCost + readCost);
}

function roundCost(cost: number): number {
  return Math.round(cost * 1e8) / 1e8;
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().trim().replace(/(?<=\d)-(?=\d)/g, ".");
}

function versionAliases(modelName: string): string[] {
  const match = modelName.toLowerCase().trim().match(/^(.+?)-(\d+)-(\d+)-(\d{8})$/);
  if (!match) return [];
  const [, prefix, major, minor] = match;
  return [`${prefix}-${major}.${minor}`];
}

function toFloat(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
