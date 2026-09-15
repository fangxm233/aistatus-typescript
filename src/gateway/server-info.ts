// input:  Gateway config, health, usage/quota storage, info requests
// output: health/status/usage/quota responses and health prechecks
// pos:    Gateway operational endpoint handlers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as http from "node:http";

import { USAGE_GROUP_KEYS, type UsageGroupKey } from "../usage-index.js";
import type { UsageTracker } from "../usage.js";
import type { EndpointConfig, GatewayConfig } from "./config.js";
import type { HealthTracker } from "./health.js";
import type { QuotaSnapshotStore } from "./quota-snapshot.js";
import { asInt, jsonResponse } from "./server-helpers.js";

export function handleHealth(config: GatewayConfig, res: http.ServerResponse): void {
  jsonResponse(res, 200, {
    status: "ok",
    mode: config.mode,
    endpoints: Object.keys(config.endpoints),
  });
}

export function handleStatus(
  config: GatewayConfig,
  health: HealthTracker,
  res: http.ServerResponse,
): void {
  const endpoints = Object.fromEntries(
    Object.entries(config.endpoints).map(([name, endpoint]) => [name, endpointStatus(name, endpoint, health)]),
  );
  const healthSummary = health.summary();
  const modelHealth = healthSummary.model_health;
  delete healthSummary.model_health;
  jsonResponse(res, 200, {
    mode: config.mode,
    available_modes: Object.keys(config.endpoint_modes),
    endpoints,
    health_detail: healthSummary,
    model_health: modelHealth ?? {},
  });
}

function endpointStatus(name: string, endpoint: EndpointConfig, health: HealthTracker): Record<string, unknown> {
  const backends: Array<Record<string, unknown>> = [];
  for (let index = 0; index < endpoint.keys.length; index++) {
    const id = `${name}:key:${index}`;
    backends.push({ id, type: "primary", healthy: health.isHealthy(id) });
  }
  if (endpoint.keys.length === 0 || endpoint.passthrough) {
    const id = `${name}:passthrough`;
    backends.push({ id, type: "passthrough", healthy: health.isHealthy(id) });
  }
  for (const fallback of endpoint.fallbacks) {
    const id = `${name}:fb:${fallback.name}`;
    backends.push({ id, type: "fallback", name: fallback.name, healthy: health.isHealthy(id) });
  }
  const mode = endpoint.keys.length === 0 ? "passthrough" : endpoint.passthrough ? "hybrid" : "managed";
  return { backends, mode };
}

export function handleUsage(
  tracker: UsageTracker,
  query: Record<string, string>,
  res: http.ServerResponse,
): void {
  if (query.format === "records") {
    handleUsageRecords(tracker, query, res);
    return;
  }
  handleUsageSummary(tracker, query, res);
}

export function handleQuota(
  store: QuotaSnapshotStore,
  query: Record<string, string>,
  res: http.ServerResponse,
): void {
  const provider = typeof query.provider === "string" ? query.provider : undefined;
  jsonResponse(res, 200, { providers: store.list(provider) });
}

function handleUsageRecords(
  tracker: UsageTracker,
  query: Record<string, string>,
  res: http.ServerResponse,
): void {
  const records = filterUsageSince(tracker.storage.read("all"), query.since);
  const limit = Math.max(0, asInt(query.limit ?? 1000));
  const offset = Math.max(0, asInt(query.offset ?? 0));
  const paged = limit > 0 ? records.slice(offset, offset + limit) : records.slice(offset);
  jsonResponse(res, 200, { records: paged });
}

function filterUsageSince(records: Array<Record<string, unknown>>, since?: string): Array<Record<string, unknown>> {
  if (!since) return records;
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) return records;
  return records.filter(record => {
    const timestamp = new Date(record.ts as string);
    return !isNaN(timestamp.getTime()) && timestamp > sinceDate;
  });
}

function handleUsageSummary(
  tracker: UsageTracker,
  query: Record<string, string>,
  res: http.ServerResponse,
): void {
  const period = query.period ?? "today";
  const raw = query.group_by ?? "";
  const groupBy = parseUsageGroupKeys(raw);
  if (!validateUsageQuery(period, groupBy, raw, res)) return;

  jsonResponse(res, 200, tracker.report(period, groupBy ?? []));
}

/** Parse `group_by` into grouping keys; null marks an unknown or repeated key. */
function parseUsageGroupKeys(raw: string): UsageGroupKey[] | null {
  if (raw.trim() === "") return [];
  const keys = raw.split(",").map(key => key.trim());
  const known = keys.every(key => (USAGE_GROUP_KEYS as readonly string[]).includes(key));
  const distinct = new Set(keys).size === keys.length;
  return known && distinct ? (keys as UsageGroupKey[]) : null;
}

function validateUsageQuery(
  period: string,
  groupBy: UsageGroupKey[] | null,
  raw: string,
  res: http.ServerResponse,
): boolean {
  const validPeriods = ["today", "week", "month", "all"];
  if (!validPeriods.includes(period)) {
    jsonResponse(res, 400, {
      error: { message: `Invalid period: ${period}. Must be one of ${validPeriods.join(",")}`, type: "gateway_error" },
    });
    return false;
  }
  if (groupBy !== null) return true;
  jsonResponse(res, 400, {
    error: {
      message: `Invalid group_by: ${raw}. Must be distinct keys from ${USAGE_GROUP_KEYS.join(",")}`,
      type: "gateway_error",
    },
  });
  return false;
}

export async function applyGlobalModelHealthPrecheck(
  config: GatewayConfig,
  health: HealthTracker,
): Promise<void> {
  if (!config.status_check) return;
  const targets = collectModelTargets(config);
  if (targets.size === 0) return;
  const degradedModels = await fetchDegradedModels([...targets].sort());
  if (degradedModels.size === 0) return;
  for (const endpoint of Object.values(config.endpoints)) {
    markEndpointModels(endpoint, degradedModels, health);
  }
}

function collectModelTargets(config: GatewayConfig): Set<string> {
  const targets = new Set<string>();
  for (const endpoint of Object.values(config.endpoints)) {
    for (const [model, fallbacks] of Object.entries(endpoint.model_fallbacks)) {
      targets.add(model);
      for (const fallback of fallbacks) targets.add(fallback);
    }
  }
  return targets;
}

async function fetchDegradedModels(models: string[]): Promise<Set<string>> {
  const { StatusAPI } = await import("../api.js");
  const { Status } = await import("../models.js");
  const client = new StatusAPI();
  const results = await Promise.allSettled(models.map(model => client.checkModel(model)));
  const degraded = new Set<string>();
  for (let index = 0; index < models.length; index++) {
    const result = results[index];
    if (result.status !== "fulfilled") continue;
    if (result.value.status === Status.DEGRADED || result.value.status === Status.DOWN) {
      degraded.add(models[index]);
    }
  }
  return degraded;
}

function markEndpointModels(
  endpoint: EndpointConfig,
  degradedModels: Set<string>,
  health: HealthTracker,
): void {
  const endpointModels = new Set(Object.keys(endpoint.model_fallbacks));
  for (const fallbacks of Object.values(endpoint.model_fallbacks)) {
    for (const fallback of fallbacks) endpointModels.add(fallback);
  }
  const unhealthy = [...endpointModels].filter(model => degradedModels.has(model));
  if (unhealthy.length === 0) return;
  for (const backendId of endpointBackendIds(endpoint)) {
    for (const model of unhealthy) {
      health.recordError(backendId, 529, model);
      console.log(`[gateway] Pre-marked ${backendId} model unhealthy from global status: ${model}`);
    }
  }
}

function endpointBackendIds(endpoint: EndpointConfig): string[] {
  const ids = endpoint.keys.map((_, index) => `${endpoint.name}:key:${index}`);
  if (endpoint.keys.length === 0 || endpoint.passthrough) ids.push(`${endpoint.name}:passthrough`);
  for (const fallback of endpoint.fallbacks) ids.push(`${endpoint.name}:fb:${fallback.name}`);
  return ids;
}
