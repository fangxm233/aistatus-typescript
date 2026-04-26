/**
 * Usage tracking with JSONL persistence.
 * Records API usage per request and provides summary/grouping.
 */

// input: per-request usage payloads from gateway/router code, optional upload bridge, and optional filesystem base dir
// output: persisted JSONL usage records plus aggregate summaries/groupings for reporting APIs and optional uploader fan-out
// pos: shared usage storage/tracking layer used by the gateway /usage endpoint and SDK usage reporting
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

interface UsageUploadRecord extends Record<string, unknown> {
  ts: string;
  provider: string;
  model: string;
  in?: number;
  out?: number;
  cache_creation_in?: number;
  cache_read_in?: number;
  cost?: number;
  latency_ms?: number;
  fallback?: boolean;
  billing_mode?: string;
}

interface UsageUploadTarget {
  upload(record: UsageUploadRecord): void;
}

// ---------------------------------------------------------------------------
// UsageStorage — JSONL file persistence
// ---------------------------------------------------------------------------

export class UsageStorage {
  private _baseDir: string;
  private _projectDir: string;

  constructor(baseDir?: string, cwd?: string) {
    this._baseDir = baseDir ?? path.join(os.homedir(), ".aistatus", "usage");
    const cwdPath = cwd ?? process.cwd();
    const hash = crypto.createHash("sha256").update(cwdPath).digest("hex").slice(0, 12);
    this._projectDir = path.join(this._baseDir, "projects", hash);
    fs.mkdirSync(this._projectDir, { recursive: true });
    this._ensureManifest(cwdPath);
  }

  append(record: Record<string, unknown>): void {
    const monthKey = this._monthKey(record.ts as string | undefined);
    const filePath = path.join(this._projectDir, `${monthKey}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  }

  read(period = "month", allProjects = false): Array<Record<string, unknown>> {
    const dirs = allProjects ? this._allProjectDirs() : [this._projectDir];
    const since = periodSince(period);
    const records: Array<Record<string, unknown>> = [];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
      for (const file of files) {
        const filePath = path.join(dir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (since) {
            const ts = parseTs(record.ts as string | undefined);
            if (!ts || ts < since) continue;
          }
          if (!record.project) record.project = path.basename(dir);
          records.push(record);
        }
      }
    }

    return records;
  }

  exportCsv(records: Array<Record<string, unknown>>, outputPath: string): void {
    const fields = ["ts", "project", "provider", "model", "in", "out", "cost", "fallback", "latency_ms"];
    const header = fields.join(",");
    const rows = records.map(r => fields.map(f => String(r[f] ?? "")).join(","));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, [header, ...rows].join("\n") + "\n", "utf-8");
  }

  exportJson(payload: unknown, outputPath: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private _ensureManifest(cwdPath: string): void {
    const manifestPath = path.join(this._projectDir, "manifest.json");
    if (fs.existsSync(manifestPath)) return;
    const manifest = {
      path: cwdPath,
      created: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  private _allProjectDirs(): string[] {
    const root = path.join(this._baseDir, "projects");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
      .map(d => path.join(root, d))
      .filter(d => fs.statSync(d).isDirectory());
  }

  private _monthKey(ts?: string): string {
    const dt = parseTs(ts) ?? new Date();
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
}

function parseTs(value?: string): Date | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function periodSince(period: string): Date | null {
  const now = new Date();
  if (period === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === "week") {
    return new Date(now.getTime() - 7 * 86400_000);
  }
  if (period === "month") {
    return new Date(now.getTime() - 30 * 86400_000);
  }
  if (period === "all") {
    return null;
  }
  throw new Error(`Unsupported period: ${period}`);
}

// ---------------------------------------------------------------------------
// UsageTracker — aggregate usage data
// ---------------------------------------------------------------------------

export class UsageTracker {
  storage: UsageStorage;
  uploader: UsageUploadTarget | null;

  constructor(storage?: UsageStorage, uploader?: UsageUploadTarget | null) {
    this.storage = storage ?? new UsageStorage();
    this.uploader = uploader ?? null;
  }

  recordUsage(opts: {
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    latency_ms: number;
    fallback: boolean;
    cost?: number;
    billing_mode?: string;
    metadata?: Record<string, string>;
  }): UsageUploadRecord {
    const RESERVED = new Set(["ts", "provider", "model", "in", "out", "cost", "fallback", "latency_ms", "billing_mode", "cache_creation_in", "cache_read_in"]);
    const record: UsageUploadRecord = {
      ts: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      in: opts.input_tokens,
      out: opts.output_tokens,
      cost: round8(opts.cost ?? 0),
      fallback: opts.fallback,
      latency_ms: opts.latency_ms,
      billing_mode: opts.billing_mode,
    };
    if (opts.cache_creation_input_tokens) {
      record.cache_creation_in = opts.cache_creation_input_tokens;
    }
    if (opts.cache_read_input_tokens) {
      record.cache_read_in = opts.cache_read_input_tokens;
    }
    if (opts.metadata) {
      for (const [k, v] of Object.entries(opts.metadata)) {
        if (!RESERVED.has(k)) record[k] = v;
      }
    }
    this.storage.append(record);
    this.uploader?.upload(record);
    return record;
  }

  summary(period = "month"): Record<string, unknown> {
    const records = this.storage.read(period);
    const totalRequests = records.length;
    const totalInput = records.reduce((s, r) => s + asInt(r.in), 0);
    const totalOutput = records.reduce((s, r) => s + asInt(r.out), 0);
    const totalCost = round8(records.reduce((s, r) => s + asFloat(r.cost), 0));
    const avgLatency = totalRequests
      ? Math.round((records.reduce((s, r) => s + asInt(r.latency_ms), 0) / totalRequests) * 100) / 100
      : 0;
    const fallbackCount = records.filter(r => r.fallback).length;

    return {
      period,
      requests: totalRequests,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: totalCost,
      avg_latency_ms: avgLatency,
      fallback_requests: fallbackCount,
    };
  }

  byModel(period = "month"): Array<Record<string, unknown>> {
    return this._groupBy("model", period);
  }

  byProvider(period = "month"): Array<Record<string, unknown>> {
    return this._groupBy("provider", period);
  }

  private _groupBy(key: string, period: string): Array<Record<string, unknown>> {
    const buckets = new Map<string, {
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      fallback_requests: number;
      latency_sum: number;
    }>();

    for (const record of this.storage.read(period)) {
      const bucketKey = String(record[key] ?? "unknown");
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, fallback_requests: 0, latency_sum: 0 };
        buckets.set(bucketKey, bucket);
      }
      bucket.requests++;
      bucket.input_tokens += asInt(record.in);
      bucket.output_tokens += asInt(record.out);
      bucket.cost_usd = round8(bucket.cost_usd + asFloat(record.cost));
      if (record.fallback) bucket.fallback_requests++;
      bucket.latency_sum += asInt(record.latency_ms);
    }

    const rows: Array<Record<string, unknown>> = [];
    for (const [bucketKey, bucket] of buckets) {
      rows.push({
        [key]: bucketKey,
        requests: bucket.requests,
        input_tokens: bucket.input_tokens,
        output_tokens: bucket.output_tokens,
        cost_usd: bucket.cost_usd,
        avg_latency_ms: bucket.requests ? Math.round((bucket.latency_sum / bucket.requests) * 100) / 100 : 0,
        fallback_requests: bucket.fallback_requests,
      });
    }
    rows.sort((a, b) => (asFloat(b.cost_usd) - asFloat(a.cost_usd)) || String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
    return rows;
  }
}

function asInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function asFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round8(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}
