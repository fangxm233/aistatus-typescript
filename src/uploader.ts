// input: persistent upload config, per-request usage records, global fetch, and package VERSION metadata
// output: fire-and-forget POSTs of usage payloads to the aistatus upload API with silent failure semantics
// pos: bridges local usage tracking to remote leaderboard ingestion without blocking SDK request flows
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import type { AIStatusConfig } from "./config";
import { VERSION } from "./index";
import { joinUrl } from "./http";

const BASE_URL = "https://aistatus.cc";

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
  records: [UsageUploadRecord];
  sdk_version: string;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

export class UsageUploader {
  private readonly config: AIStatusConfig;
  private readonly baseUrl: string;

  constructor(config: AIStatusConfig, baseUrl = BASE_URL) {
    this.config = config;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  upload(record: UsageRecord): void {
    if (!this.shouldUpload()) {
      return;
    }

    void fetch(joinUrl(this.baseUrl, "/api/usage/upload"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildPayload(record)),
    }).catch(() => {});
  }

  private shouldUpload(): boolean {
    return Boolean(this.config.uploadEnabled && this.config.name && this.config.email);
  }

  private buildPayload(record: UsageRecord): UsageUploadPayload {
    return {
      records: [
        {
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
        },
      ],
      sdk_version: VERSION,
    };
  }
}
