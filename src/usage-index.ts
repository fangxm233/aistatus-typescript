// input:  JSONL usage files, period and zero or more grouping keys
// output: exact incremental aggregate reports and prewarm
// pos:    Compact index for low-latency usage summaries
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as fs from "node:fs";
import * as path from "node:path";

export const USAGE_GROUP_KEYS = ["model", "provider", "billing_mode"] as const;

export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

/** Accept a single key or a list of keys, and always hand the aggregator a list. */
export function normalizeGroupKeys(groupBy?: UsageGroupKey | UsageGroupKey[]): UsageGroupKey[] {
  if (groupBy === undefined) return [];
  return Array.isArray(groupBy) ? [...groupBy] : [groupBy];
}

interface UsageInterners {
  provider(value: string): number;
  model(value: string): number;
  billingMode(value: string): number;
}

interface UsageColumns {
  timestamps: number[];
  providerIds: number[];
  modelIds: number[];
  billingModeIds: number[];
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
  private readonly billingModeIds = new Map<string, number>();
  private readonly billingModes: string[] = [];
  private readonly interners: UsageInterners = {
    provider: (value) => internString(value, this.providerIds, this.providers),
    model: (value) => internString(value, this.modelIds, this.models),
    billingMode: (value) => internString(value, this.billingModeIds, this.billingModes),
  };

  constructor(private readonly projectDir: string) {}

  prewarm(period = "month"): void {
    this.syncFiles(period);
  }

  report(period = "month", groupBy?: UsageGroupKey | UsageGroupKey[]): Record<string, unknown> {
    const keys = normalizeGroupKeys(groupBy);
    const sinceMs = periodSinceMs(period);
    const paths = this.syncFiles(period);
    // Read the dictionaries after syncing, so every interned name is already known.
    const names = keys.map((key) => this.groupNames(key));
    const radix = names.map((list) => Math.max(list.length, 1));
    const summary = emptyBucket();
    const groups = new Map<number, UsageBucket>();
    for (const filePath of paths) {
      const indexed = this.files.get(filePath);
      if (indexed) aggregateColumns(indexed.columns, sinceMs, keys, radix, summary, groups);
    }
    return buildReport(period, keys, radix, summary, groups, names);
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
      appendRecord(columns, record, this.interners);
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
      appendRecord(indexed.columns, record, this.interners);
    });
    indexed.readOffset = scan.readOffset;
    indexed.guard = readGuard(filePath, scan.readOffset);
    indexed.dev = scan.stat.dev;
    indexed.ino = scan.stat.ino;
    indexed.mtimeMs = scan.stat.mtimeMs;
    indexed.ctimeMs = scan.stat.ctimeMs;
  }

  private groupNames(groupBy: UsageGroupKey): string[] {
    if (groupBy === "model") return this.models;
    if (groupBy === "billing_mode") return this.billingModes;
    return this.providers;
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
    timestamps: [], providerIds: [], modelIds: [], billingModeIds: [],
    inputs: [], outputs: [], costs: [], fallbacks: [], latencies: [],
  };
}

function appendRecord(
  columns: UsageColumns,
  record: Record<string, unknown>,
  interners: UsageInterners,
): void {
  columns.timestamps.push(timestampValue(record.ts));
  columns.providerIds.push(interners.provider(String(record.provider ?? "unknown")));
  columns.modelIds.push(interners.model(String(record.model ?? "unknown")));
  columns.billingModeIds.push(interners.billingMode(String(record.billing_mode ?? "unknown")));
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
  groupBy: UsageGroupKey[],
  radix: number[],
  summary: UsageBucket,
  groups: Map<number, UsageBucket>,
): void {
  const idColumns = groupBy.map((key) => groupIds(columns, key));
  for (let i = 0; i < columns.timestamps.length; i++) {
    if (sinceMs !== null && columns.timestamps[i] < sinceMs) continue;
    addIndexedValue(summary, columns, i, false);
    if (idColumns.length > 0) addGroupedValue(groups, compositeId(idColumns, radix, i), columns, i);
  }
}

/** Pack one id per grouping key into a single bucket key, mixed-radix style. */
function compositeId(idColumns: number[][], radix: number[], index: number): number {
  let id = 0;
  for (let d = 0; d < idColumns.length; d++) id = id * radix[d] + idColumns[d][index];
  return id;
}

function decomposeId(id: number, radix: number[]): number[] {
  const ids = new Array<number>(radix.length);
  let remaining = id;
  for (let d = radix.length - 1; d >= 0; d--) {
    ids[d] = remaining % radix[d];
    remaining = Math.floor(remaining / radix[d]);
  }
  return ids;
}

function groupIds(columns: UsageColumns, groupBy: UsageGroupKey): number[] {
  if (groupBy === "model") return columns.modelIds;
  if (groupBy === "billing_mode") return columns.billingModeIds;
  return columns.providerIds;
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
  groupBy: UsageGroupKey[],
  radix: number[],
  summary: UsageBucket,
  groups: Map<number, UsageBucket>,
  names: string[][],
): Record<string, unknown> {
  const result: Record<string, unknown> = { summary: bucketSummary(summary, period) };
  if (groupBy.length === 0) return result;
  const envelope = groupBy.length === 1 ? `${groupBy[0]}s` : "rows";
  result[envelope] = groupedRows(groupBy, radix, groups, names);
  return result;
}

function groupedRows(
  keys: UsageGroupKey[],
  radix: number[],
  groups: Map<number, UsageBucket>,
  names: string[][],
): Array<Record<string, unknown>> {
  const rows = [...groups].map(([id, bucket]) => {
    const ids = decomposeId(id, radix);
    return bucketRow(keys.map((key, d) => [key, names[d][ids[d]] ?? "unknown"] as const), bucket);
  });
  rows.sort((a, b) => asFloat(b.cost_usd) - asFloat(a.cost_usd) || compareGroupNames(keys, a, b));
  return rows;
}

function compareGroupNames(
  keys: UsageGroupKey[],
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  for (const key of keys) {
    const order = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
    if (order !== 0) return order;
  }
  return 0;
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

function bucketRow(
  group: ReadonlyArray<readonly [UsageGroupKey, string]>,
  bucket: UsageBucket,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(group),
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
