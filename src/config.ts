// input: process env plus optional ~/.aistatus/config.yaml filesystem state and runtime configure() overrides
// output: public AIStatusConfig helpers for loading, saving, and resolving persistent SDK upload settings
// pos: SDK-level persistent configuration layer that merges in-memory overrides, env vars, YAML file values, and defaults
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";

export interface AIStatusConfig {
  name: string | null;
  org: string | null;
  email: string | null;
  uploadEnabled: boolean;
}

interface ConfigOptions {
  env?: Record<string, string | undefined>;
  filePath?: string;
  skipFile?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".aistatus");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const DEFAULT_CONFIG: AIStatusConfig = {
  name: null,
  org: null,
  email: null,
  uploadEnabled: false,
};

let configuredOverrides: Partial<AIStatusConfig> = {};

export function configure(config: Partial<AIStatusConfig> | null): AIStatusConfig {
  configuredOverrides = normalizePartial(config ?? {});
  return getConfig();
}

export function getConfig(options: ConfigOptions = {}): AIStatusConfig {
  const env = options.env ?? process.env;
  const fileConfig = options.skipFile ? {} : loadFromFile(options.filePath);
  const envConfig = loadFromEnv(env);
  return mergeConfig(configuredOverrides, envConfig, fileConfig, DEFAULT_CONFIG);
}

export function loadFromFile(filePath = CONFIG_FILE): Partial<AIStatusConfig> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    return {};
  }

  const parsed = yaml.parse(raw);
  if (!isRecord(parsed)) {
    return {};
  }

  return normalizePartial({
    name: readString(parsed.name),
    org: readString(parsed.org),
    email: readString(parsed.email),
    uploadEnabled: readBoolean(parsed.uploadEnabled ?? parsed.upload_enabled),
  });
}

export function saveToFile(config: Partial<AIStatusConfig>, filePath = CONFIG_FILE): void {
  const normalized = mergeConfig(normalizePartial(config), DEFAULT_CONFIG);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = yaml.stringify({
    name: normalized.name,
    org: normalized.org,
    email: normalized.email,
    uploadEnabled: normalized.uploadEnabled,
  });
  fs.writeFileSync(filePath, content, "utf-8");
}

function loadFromEnv(env: Record<string, string | undefined>): Partial<AIStatusConfig> {
  return normalizePartial({
    name: readString(env.AISTATUS_NAME),
    org: readString(env.AISTATUS_ORG),
    email: readString(env.AISTATUS_EMAIL),
    uploadEnabled: readBoolean(env.AISTATUS_UPLOAD_ENABLED),
  });
}

function mergeConfig(...parts: Partial<AIStatusConfig>[]): AIStatusConfig {
  return {
    name: coalesce(...parts.map(part => part.name)),
    org: coalesce(...parts.map(part => part.org)),
    email: coalesce(...parts.map(part => part.email)),
    uploadEnabled: coalesceBoolean(...parts.map(part => part.uploadEnabled)),
  };
}

function normalizePartial(config: Partial<AIStatusConfig>): Partial<AIStatusConfig> {
  return {
    name: readString(config.name),
    org: readString(config.org),
    email: readString(config.email),
    uploadEnabled: readBoolean(config.uploadEnabled),
  };
}

function readString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function coalesce(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

function coalesceBoolean(...values: Array<boolean | undefined>): boolean {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
