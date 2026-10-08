// input: persistent upload config (replaceable via setConfig), per-request usage records, global fetch, and package VERSION metadata
// output: UsageUploader plus flushUsageUploads(); one process-wide batched queue per upload URL, flushed every 60 s, at 100 records, on beforeExit, or on demand
// pos: bridges local usage tracking to remote leaderboard ingestion without blocking SDK request flows
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import { randomUUID } from "node:crypto";

import type { AIStatusConfig } from "./config";
import { joinUrl } from "./http";
import { VERSION } from "./version";

const BASE_URL = "https://aistatus.cc";
const MAX_BATCH = 100;
const MAX_BUFFERED = 1000;
const FLUSH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
// Shared through globalThis so the ESM and CJS bundles of one version use the same queues.
const REGISTRY_KEY = Symbol.for(`aistatus.usage-upload-queues@${VERSION}`);

interface UsageRecord {
  ts: string;
  provider: string;
  model: string;
  in?: number;
  out?: number;
  cache_creation_in?: number;
  cache_read_in?: number;
  cost?: number;
  latency_ms?: number;
}

interface UsageUploadRecord {
  ts: string;
  name: string;
  organization: string | null;
  email: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

interface UsageUploadPayload {
  batch_id: string;
  sdk_version: string;
  records: UsageUploadRecord[];
}

interface UploadBatch {
  id: string;
  records: UsageUploadRecord[];
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class UploadQueue {
  enqueued = 0;
  exitMark = 0;
  private records: UsageUploadRecord[] = [];
  // Batch currently being sent, or kept after a retryable failure; retried verbatim.
  private head: UploadBatch | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly url: string) {
    const timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    timer.unref?.();
  }

  push(record: UsageUploadRecord): void {
    this.records.push(record);
    this.enqueued += 1;
    const excess = (this.head?.records.length ?? 0) + this.records.length - MAX_BUFFERED;
    if (excess > 0) {
      this.records.splice(0, excess);
    }
    if (this.records.length >= MAX_BATCH && !this.head) {
      void this.flush();
    }
  }

  hasWork(): boolean {
    return this.head !== null || this.records.length > 0;
  }

  flush(): Promise<void> {
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async flushAll(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
    }
    if (this.hasWork()) {
      await this.flush();
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (!this.head) {
        if (this.records.length === 0) {
          return;
        }
        this.head = { id: randomUUID(), records: this.records.splice(0, MAX_BATCH) };
      }
      if (!(await this.send(this.head))) {
        return;
      }
      this.head = null;
    }
  }

  /** Returns false when the batch should be kept and retried on the next flush. */
  private async send(batch: UploadBatch): Promise<boolean> {
    let body: string;
    try {
      const payload: UsageUploadPayload = { batch_id: batch.id, sdk_version: VERSION, records: batch.records };
      body = JSON.stringify(payload);
    } catch {
      return true;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("usage upload timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      const response = await Promise.race([
        fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        }),
        timeout,
      ]);
      await Promise.race([response.text(), timeout]).catch(() => {});
      return !(response.status === 429 || response.status >= 500);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function existingQueues(): Map<string, UploadQueue> | undefined {
  return (globalThis as unknown as Record<symbol, Map<string, UploadQueue> | undefined>)[REGISTRY_KEY];
}

function flushOnExit(queues: Map<string, UploadQueue>): void {
  // beforeExit re-fires after this async work; only retry while new records keep arriving.
  for (const queue of queues.values()) {
    if (queue.enqueued !== queue.exitMark && queue.hasWork()) {
      queue.exitMark = queue.enqueued;
      void queue.flush();
    }
  }
}

function queueFor(url: string): UploadQueue {
  let queues = existingQueues();
  if (!queues) {
    const created = new Map<string, UploadQueue>();
    (globalThis as unknown as Record<symbol, Map<string, UploadQueue>>)[REGISTRY_KEY] = created;
    if (typeof process !== "undefined" && typeof process.on === "function") {
      process.on("beforeExit", () => flushOnExit(created));
    }
    queues = created;
  }
  let queue = queues.get(url);
  if (!queue) {
    queue = new UploadQueue(url);
    queues.set(url, queue);
  }
  return queue;
}

/**
 * Send every buffered usage record now. Resolves once all queues are drained
 * (or a retryable failure leaves a batch for later), or after `timeoutMs`.
 */
export async function flushUsageUploads(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  const queues = existingQueues();
  if (!queues || queues.size === 0) {
    return;
  }
  await withTimeout(Promise.all([...queues.values()].map(queue => queue.flushAll())).then(() => {}), timeoutMs);
}

export class UsageUploader {
  private config: AIStatusConfig;
  private readonly url: string;

  constructor(config: AIStatusConfig, baseUrl = BASE_URL) {
    this.config = config;
    this.url = joinUrl(baseUrl, "/api/usage/upload");
  }

  /**
   * Replace the upload config used for subsequent records. Records already
   * queued keep the identity they were built with and are still sent.
   */
  setConfig(config: AIStatusConfig): void {
    this.config = config;
  }

  /** True when the config allows uploading: `uploadEnabled` with a name and an email. */
  get enabled(): boolean {
    return Boolean(this.config.uploadEnabled && this.config.name && this.config.email);
  }

  upload(record: UsageRecord): void {
    if (!this.enabled) {
      return;
    }
    try {
      queueFor(this.url).push(this.buildRecord(record));
    } catch {
      // Uploading is best-effort and must never break the caller.
    }
  }

  /** Flush this uploader's queue (shared with other uploaders for the same URL). */
  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const queue = existingQueues()?.get(this.url);
    if (queue) {
      await withTimeout(queue.flushAll(), timeoutMs);
    }
  }

  private buildRecord(record: UsageRecord): UsageUploadRecord {
    return {
      ts: record.ts,
      name: truncate(this.config.name!, 200),
      organization: this.config.org ? truncate(this.config.org, 200) : null,
      email: truncate(this.config.email!, 254),
      provider: record.provider,
      model: record.model,
      input_tokens: record.in ?? 0,
      output_tokens: record.out ?? 0,
      cache_creation_input_tokens: record.cache_creation_in ?? 0,
      cache_read_input_tokens: record.cache_read_in ?? 0,
      cost_usd: record.cost ?? 0,
      latency_ms: record.latency_ms ?? 0,
    };
  }
}
