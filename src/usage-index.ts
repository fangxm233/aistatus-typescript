// input:  JSONL usage files, period and grouping key
// output: exact incremental aggregate reports and prewarm
// pos:    Compact index for low-latency usage summaries
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as fs from "node:fs";
import * as path from "node:path";

export type UsageGroupKey = "model" | "provider";

interface UsageColumns {
  timestamps: number[];
  providerIds: number[];
  modelIds: number[];
  inputs: number[];
  outputs: number[];
  costs: number[];
  fallbacks: number[];
  latencies: number[];
}

interface IndexedUsageFile {
  columns: UsageColumns;
  readOffset: number;
  guard: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface UsageBucket {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  fallback_requests: number;
  latency_sum: number;
}

interface ScanResult {
  readOffset: number;
  stat: fs.Stats;
}

const READ_CHUNK_BYTES = 256 * 1024;
const GUARD_BYTES = 64;
const MONTH_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;

export class UsageAggregateIndex {
  private readonly files = new Map<string, IndexedUsageFile>();
  private readonly providerIds = new Map<string, number>();
  private readonly providers: string[] = [];
  private readonly modelIds = new Map<string, number>();
  private readonly models: string[] = [];
  private readonly resolveProvider = (value: string) => this.providerId(value);
  private readonly resolveModel = (value: string) => this.modelId(value);

  constructor(private readonly projectDir: string) {}

  prewarm(period = "month"): void {
    this.syncFiles(period);
  }

  report(period = "month", groupBy?: UsageGroupKey): Record<string, unknown> {
    const sinceMs = periodSinceMs(period);
    const paths = this.syncFiles(period);
    const summary = emptyBucket();
    const groups = new Map<number, UsageBucket>();
    for (const filePath of paths) {
      const indexed = this.files.get(filePath);
      if (indexed) aggregateColumns(indexed.columns, sinceMs, groupBy, summary, groups);
    }
    return buildReport(period, groupBy, summary, groups, this.groupNames(groupBy));
  }

  private syncFiles(period: string): string[] {
    const paths = relevantFiles(this.projectDir, periodSinceMs(period));
    for (const filePath of paths) this.syncFile(filePath);
    return paths;
  }

  private syncFile(filePath: string): void {
    const stat = fs.statSync(filePath);
    const indexed = this.files.get(filePath);
    if (!indexed || needsRebuild(filePath, indexed, stat)) {
      this.files.set(filePath, this.loadFile(filePath));
      return;
    }
    if (stat.size > indexed.readOffset) this.extendFile(filePath, indexed);
  }

  private loadFile(filePath: string): IndexedUsageFile {
    const columns = emptyColumns();
    const scan = scanCompleteLines(filePath, 0, (record) => {
      appendRecord(columns, record, this.resolveProvider, this.resolveModel);
    });
    return {
      columns,
      readOffset: scan.readOffset,
      guard: readGuard(filePath, scan.readOffset),
      dev: scan.stat.dev,
      ino: scan.stat.ino,
      mtimeMs: scan.stat.mtimeMs,
      ctimeMs: scan.stat.ctimeMs,
    };
  }

  private extendFile(filePath: string, indexed: IndexedUsageFile): void {
    const scan = scanCompleteLines(filePath, indexed.readOffset, (record) => {
      appendRecord(indexed.columns, record, this.resolveProvider, this.resolveModel);
    });
    indexed.readOffset = scan.readOffset;
    indexed.guard = readGuard(filePath, scan.readOffset);
    indexed.dev = scan.stat.dev;
    indexed.ino = scan.stat.ino;
    indexed.mtimeMs = scan.stat.mtimeMs;
    indexed.ctimeMs = scan.stat.ctimeMs;
  }

  private providerId(value: string): number {
    return internString(value, this.providerIds, this.providers);
  }

  private modelId(value: string): number {
    return internString(value, this.modelIds, this.models);
  }

  private groupNames(groupBy?: UsageGroupKey): string[] {
    return groupBy === "model" ? this.models : this.providers;
  }
}

export function periodSinceMs(period: string, now = new Date()): number | null {
  if (period === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === "week") return now.getTime() - 7 * 86400_000;
  if (period === "month") return now.getTime() - 30 * 86400_000;
  if (period === "all") return null;
  throw new Error(`Unsupported period: ${period}`);
}

function relevantFiles(projectDir: string, sinceMs: number | null): string[] {
  if (!fs.existsSync(projectDir)) return [];
  const cutoffMonth = sinceMs === null ? null : utcMonthKey(new Date(sinceMs));
  return fs.readdirSync(projectDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(projectDir, name))
    .filter((filePath) => isRelevantUsageFile(filePath, cutoffMonth, sinceMs))
    .sort();
}

function isRelevantUsageFile(filePath: string, cutoffMonth: string | null, sinceMs: number | null): boolean {
  if (cutoffMonth === null || sinceMs === null) return true;
  const match = path.basename(filePath).match(MONTH_FILE_RE);
  if (match === null || match[1] >= cutoffMonth) return true;
  return fs.statSync(filePath).mtimeMs >= sinceMs;
}

function utcMonthKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
}

function needsRebuild(filePath: string, indexed: IndexedUsageFile, stat: fs.Stats): boolean {
  if (stat.dev !== indexed.dev || stat.ino !== indexed.ino) return true;
  if (stat.size < indexed.readOffset) return true;
  if (stat.size === indexed.readOffset && metadataChanged(indexed, stat)) return true;
  return !readGuard(filePath, indexed.readOffset).equals(indexed.guard);
}

function metadataChanged(indexed: IndexedUsageFile, stat: fs.Stats): boolean {
  return stat.mtimeMs !== indexed.mtimeMs || stat.ctimeMs !== indexed.ctimeMs;
}

function readGuard(filePath: string, offset: number): Buffer {
  const length = Math.min(offset, GUARD_BYTES);
  if (length === 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, "r");
  try {
    const guard = Buffer.allocUnsafe(length);
    const count = fs.readSync(fd, guard, 0, length, offset - length);
    return guard.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

function scanCompleteLines(filePath: string, start: number, onRecord: (record: Record<string, unknown>) => void): ScanResult {
  const fd = fs.openSync(filePath, "r");
  try {
    const readOffset = scanDescriptor(fd, start, onRecord);
    return { readOffset, stat: fs.fstatSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

function scanDescriptor(fd: number, start: number, onRecord: (record: Record<string, unknown>) => void): number {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let position = start;
  while (true) {
    const count = fs.readSync(fd, chunk, 0, chunk.length, position);
    if (count === 0) break;
    position += count;
    pending = consumeLines(Buffer.concat([pending, chunk.subarray(0, count)]), onRecord);
  }
  return position - pending.length;
}

function consumeLines(data: Buffer, onRecord: (record: Record<string, unknown>) => void): Buffer {
  let start = 0;
  while (true) {
    const newline = data.indexOf(10, start);
    if (newline < 0) return Buffer.from(data.subarray(start));
    parseLine(data.subarray(start, newline), onRecord);
    start = newline + 1;
  }
}

function parseLine(line: Buffer, onRecord: (record: Record<string, unknown>) => void): void {
  if (line.length === 0) return;
  try {
    onRecord(JSON.parse(line.toString("utf8")) as Record<string, unknown>);
  } catch {}
}

function emptyColumns(): UsageColumns {
  return {
    timestamps: [], providerIds: [], modelIds: [], inputs: [], outputs: [],
    costs: [], fallbacks: [], latencies: [],
  };
}

function appendRecord(
  columns: UsageColumns,
  record: Record<string, unknown>,
  providerId: (value: string) => number,
  modelId: (value: string) => number,
): void {
  columns.timestamps.push(timestampValue(record.ts));
  columns.providerIds.push(providerId(String(record.provider ?? "unknown")));
  columns.modelIds.push(modelId(String(record.model ?? "unknown")));
  columns.inputs.push(asInt(record.in));
  columns.outputs.push(asInt(record.out));
  columns.costs.push(asFloat(record.cost));
  columns.fallbacks.push(record.fallback ? 1 : 0);
  columns.latencies.push(asInt(record.latency_ms));
}

function timestampValue(value: unknown): number {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function aggregateColumns(
  columns: UsageColumns,
  sinceMs: number | null,
  groupBy: UsageGroupKey | undefined,
  summary: UsageBucket,
  groups: Map<number, UsageBucket>,
): void {
  const ids = groupBy ? groupIds(columns, groupBy) : null;
  for (let i = 0; i < columns.timestamps.length; i++) {
    if (sinceMs !== null && columns.timestamps[i] < sinceMs) continue;
    addIndexedValue(summary, columns, i, false);
    if (ids) addGroupedValue(groups, ids[i], columns, i);
  }
}

function groupIds(columns: UsageColumns, groupBy: UsageGroupKey): number[] {
  return groupBy === "model" ? columns.modelIds : columns.providerIds;
}

function addGroupedValue(groups: Map<number, UsageBucket>, id: number, columns: UsageColumns, index: number): void {
  const bucket = groups.get(id) ?? emptyBucket();
  addIndexedValue(bucket, columns, index, true);
  groups.set(id, bucket);
}

function addIndexedValue(bucket: UsageBucket, columns: UsageColumns, index: number, roundCost: boolean): void {
  bucket.requests++;
  bucket.input_tokens += columns.inputs[index];
  bucket.output_tokens += columns.outputs[index];
  const cost = bucket.cost_usd + columns.costs[index];
  bucket.cost_usd = roundCost ? round8(cost) : cost;
  bucket.fallback_requests += columns.fallbacks[index];
  bucket.latency_sum += columns.latencies[index];
}

function buildReport(
  period: string,
  groupBy: UsageGroupKey | undefined,
  summary: UsageBucket,
  groups: Map<number, UsageBucket>,
  names: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { summary: bucketSummary(summary, period) };
  if (groupBy) result[`${groupBy}s`] = groupedRows(groupBy, groups, names);
  return result;
}

function groupedRows(key: UsageGroupKey, groups: Map<number, UsageBucket>, names: string[]): Array<Record<string, unknown>> {
  const rows = [...groups].map(([id, bucket]) => bucketRow(key, names[id] ?? "unknown", bucket));
  rows.sort((a, b) => asFloat(b.cost_usd) - asFloat(a.cost_usd)
    || String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
  return rows;
}

function bucketSummary(bucket: UsageBucket, period: string): Record<string, unknown> {
  return {
    period,
    requests: bucket.requests,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cost_usd: round8(bucket.cost_usd),
    avg_latency_ms: averageLatency(bucket),
    fallback_requests: bucket.fallback_requests,
  };
}

function bucketRow(key: UsageGroupKey, name: string, bucket: UsageBucket): Record<string, unknown> {
  return {
    [key]: name,
    requests: bucket.requests,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cost_usd: bucket.cost_usd,
    avg_latency_ms: averageLatency(bucket),
    fallback_requests: bucket.fallback_requests,
  };
}

function emptyBucket(): UsageBucket {
  return {
    requests: 0, input_tokens: 0, output_tokens: 0,
    cost_usd: 0, fallback_requests: 0, latency_sum: 0,
  };
}

function averageLatency(bucket: UsageBucket): number {
  if (bucket.requests === 0) return 0;
  return Math.round((bucket.latency_sum / bucket.requests) * 100) / 100;
}

function internString(value: string, ids: Map<string, number>, values: string[]): number {
  const existing = ids.get(value);
  if (existing !== undefined) return existing;
  const id = values.length;
  ids.set(value, id);
  values.push(value);
  return id;
}

function asInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : 0;
}

function asFloat(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
