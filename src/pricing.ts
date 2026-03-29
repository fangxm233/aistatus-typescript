/**
 * CostCalculator — pricing lookup via aistatus.cc API with memory + file caching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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

  constructor(baseUrl = BASE_URL, ttlSeconds = CACHE_TTL_SECONDS) {
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this._ttlSeconds = ttlSeconds;
    this._cachePath = path.join(os.homedir(), ".aistatus", "usage", "pricing-cache.json");
  }

  calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const pricing = this.getPricing(provider, model);
    if (!pricing) return 0;

    const { input_per_million, output_per_million } = pricing;
    if (input_per_million == null && output_per_million == null) return 0;

    let cost = 0;
    if (input_per_million != null) {
      cost += (Math.max(inputTokens, 0) / 1_000_000) * input_per_million;
    }
    if (output_per_million != null) {
      cost += (Math.max(outputTokens, 0) / 1_000_000) * output_per_million;
    }
    return Math.round(cost * 1e8) / 1e8;
  }

  calculateCostWithCache(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
  ): number {
    const pricing = this.getPricing(provider, model);
    if (!pricing) return 0;

    const { input_per_million, output_per_million, input_cache_read_per_million, input_cache_write_per_million } = pricing;
    if (input_per_million == null && output_per_million == null) return 0;

    let cost = 0;
    if (input_per_million != null) {
      cost += (Math.max(inputTokens, 0) / 1_000_000) * input_per_million;
      // Cache creation: use fetched price, fallback to 1.25x input price
      const cacheWritePrice = input_cache_write_per_million ?? (input_per_million * 1.25);
      cost += (Math.max(cacheCreationInputTokens, 0) / 1_000_000) * cacheWritePrice;
      // Cache read: use fetched price, fallback to 0.10x input price
      const cacheReadPrice = input_cache_read_per_million ?? (input_per_million * 0.10);
      cost += (Math.max(cacheReadInputTokens, 0) / 1_000_000) * cacheReadPrice;
    }
    if (output_per_million != null) {
      cost += (Math.max(outputTokens, 0) / 1_000_000) * output_per_million;
    }
    return Math.round(cost * 1e8) / 1e8;
  }

  getPricing(provider: string, model: string): PricingInfo | null {
    const cacheKey = this._normalizeKey(provider, model);
    const now = Date.now() / 1000;

    // Check memory cache
    const memEntry = this._memoryCache.get(cacheKey);
    if (memEntry && this._isFresh(memEntry, now)) {
      return memEntry.pricing;
    }

    // Check file cache
    const fileCache = this._readFileCache();
    const fileEntry = fileCache[cacheKey];
    if (fileEntry && this._isFresh(fileEntry, now)) {
      this._memoryCache.set(cacheKey, fileEntry);
      return fileEntry.pricing;
    }

    // Fetch from API (synchronous http — same approach as Python SDK)
    const pricing = this._fetchPricing(provider, model);
    if (pricing == null) return null;

    const entry: CacheEntry = { ts: now, pricing };
    this._memoryCache.set(cacheKey, entry);
    fileCache[cacheKey] = entry;
    this._writeFileCache(fileCache);
    return pricing;
  }

  private _fetchPricing(provider: string, model: string): PricingInfo | null {
    const [providerSlug, modelName] = this._splitModel(provider, model);
    const queries = this._candidateQueries(modelName);

    let models: Array<Record<string, unknown>> = [];

    for (const query of queries) {
      try {
        // Synchronous fetch using child_process
        const url = `${this._baseUrl}/api/models?q=${encodeURIComponent(query)}`;
        const result = execFileSync("node", [
          "-e",
          `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(d=>process.stdout.write(JSON.stringify(d))).catch(()=>process.stdout.write("{}"))`,
        ], { timeout: 5000, encoding: "utf-8" });
        const data = JSON.parse(result);
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
    fs.writeFileSync(this._cachePath, JSON.stringify(cache, null, 2), "utf-8");
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
