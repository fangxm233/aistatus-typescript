// input:  Anthropic response headers and filesystem snapshot path
// output: normalized provider quota snapshots and atomic persistence
// pos:    Gateway latest-value store for provider quota headers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface QuotaWindowSnapshot {
  type: "five_hour" | "seven_day";
  utilization: number;
  resets_at: number;
}

export interface ProviderQuotaSnapshot {
  provider: string;
  mode: string;
  windows: QuotaWindowSnapshot[];
  observed_at: number;
}

interface QuotaSnapshotFile {
  version: 1;
  providers: ProviderQuotaSnapshot[];
}

export interface QuotaObservation {
  provider: string;
  mode: string;
  status: number;
}

const DEFAULT_PATH = path.join(os.homedir(), ".aistatus", "quota.json");
const WINDOW_HEADERS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
] as const;

function finiteHeader(headers: Headers, name: string, min: number, max = Infinity): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function explicitWindow(
  headers: Headers,
  type: QuotaWindowSnapshot["type"],
  wireName: string,
): QuotaWindowSnapshot | null {
  const prefix = `anthropic-ratelimit-unified-${wireName}`;
  const utilization = finiteHeader(headers, `${prefix}-utilization`, 0, 1);
  const resetsAt = finiteHeader(headers, `${prefix}-reset`, 0);
  if (utilization === null || resetsAt === null) return null;
  return { type, utilization, resets_at: resetsAt };
}

function claimedType(value: string | null): QuotaWindowSnapshot["type"] | null {
  if (value === "5h" || value === "five_hour") return "five_hour";
  if (value === "7d" || value === "seven_day") return "seven_day";
  return null;
}

function rejectedWindow(headers: Headers): QuotaWindowSnapshot | null {
  if (headers.get("anthropic-ratelimit-unified-status") !== "rejected") return null;
  const type = claimedType(headers.get("anthropic-ratelimit-unified-representative-claim"));
  const resetsAt = finiteHeader(headers, "anthropic-ratelimit-unified-reset", 0);
  return type && resetsAt !== null ? { type, utilization: 1, resets_at: resetsAt } : null;
}

function parseWindows(headers: Headers): QuotaWindowSnapshot[] {
  const explicit = WINDOW_HEADERS.flatMap(([type, wireName]) => {
    const window = explicitWindow(headers, type, wireName);
    return window ? [window] : [];
  });
  if (explicit.length > 0) return explicit;
  const rejected = rejectedWindow(headers);
  return rejected ? [rejected] : [];
}

function validWindow(value: unknown): value is QuotaWindowSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Partial<QuotaWindowSnapshot>;
  return (window.type === "five_hour" || window.type === "seven_day")
    && typeof window.utilization === "number" && Number.isFinite(window.utilization)
    && window.utilization >= 0 && window.utilization <= 1
    && typeof window.resets_at === "number" && Number.isFinite(window.resets_at)
    && window.resets_at >= 0;
}

function validSnapshot(value: unknown): value is ProviderQuotaSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<ProviderQuotaSnapshot>;
  return typeof snapshot.provider === "string" && snapshot.provider.length > 0
    && typeof snapshot.mode === "string" && snapshot.mode.length > 0
    && typeof snapshot.observed_at === "number" && Number.isFinite(snapshot.observed_at)
    && Array.isArray(snapshot.windows) && snapshot.windows.length > 0
    && snapshot.windows.every(validWindow);
}

function readSnapshots(filePath: string): ProviderQuotaSnapshot[] {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<QuotaSnapshotFile>;
    return payload.version === 1 && Array.isArray(payload.providers)
      ? payload.providers.filter(validSnapshot)
      : [];
  } catch {
    return [];
  }
}

export class QuotaSnapshotStore {
  private readonly snapshots = new Map<string, ProviderQuotaSnapshot>();

  constructor(private readonly filePath = DEFAULT_PATH) {
    for (const snapshot of readSnapshots(filePath)) this.snapshots.set(snapshot.provider, snapshot);
  }

  list(provider?: string): ProviderQuotaSnapshot[] {
    const values = [...this.snapshots.values()]
      .filter(snapshot => !provider || snapshot.provider === provider)
      .sort((a, b) => a.provider.localeCompare(b.provider));
    return structuredClone(values);
  }

  observe(headers: Headers, observation: QuotaObservation, nowMs = Date.now()): boolean {
    if (observation.status !== 429 && (observation.status < 200 || observation.status >= 300)) return false;
    const windows = parseWindows(headers);
    if (windows.length === 0) return false;
    this.snapshots.set(observation.provider, {
      provider: observation.provider,
      mode: observation.mode,
      windows,
      observed_at: Math.floor(nowMs / 1000),
    });
    this.persistBestEffort();
    return true;
  }

  private persistBestEffort(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const staging = `${this.filePath}.${process.pid}.tmp`;
      const payload: QuotaSnapshotFile = { version: 1, providers: this.list() };
      fs.writeFileSync(staging, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(staging, this.filePath);
    } catch (error) {
      console.warn(`[gateway] Failed to persist quota snapshot: ${(error as Error).message}`);
    }
  }
}
