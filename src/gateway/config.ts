/**
 * Gateway configuration: loading, validation, auto-discovery.
 * Compatible with Python SDK gateway.yaml format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".aistatus");
const CONFIG_FILE = path.join(CONFIG_DIR, "gateway.yaml");

/** Default base URLs (without trailing /v1) */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
};

/** How each endpoint type sends authentication: [headerName, prefix] */
export const AUTH_STYLES: Record<string, [string, string]> = {
  anthropic: ["x-api-key", ""],
  openai: ["authorization", "Bearer "],
  bearer: ["authorization", "Bearer "],
  google: ["x-goog-api-key", ""],
};

/** Env var -> endpoint mapping for auto-discovery */
const AUTO_DISCOVER_MAP: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
};

/** Known OpenAI-compatible fallback providers */
const FALLBACK_PRESETS: Record<string, { base_url: string; env: string }> = {
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
  },
  deepseek: {
    base_url: "https://api.deepseek.com",
    env: "DEEPSEEK_API_KEY",
  },
  together: {
    base_url: "https://api.together.xyz/v1",
    env: "TOGETHER_API_KEY",
  },
  groq: {
    base_url: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
  },
};

export interface FallbackConfig {
  name: string;
  base_url: string;
  api_key: string;
  auth_style: string;
  model_prefix: string;
  model_map: Record<string, string>;
  translate: string | null;
}

export interface EndpointConfig {
  name: string;
  base_url: string;
  auth_style: string;
  keys: string[];
  passthrough: boolean;
  fallbacks: FallbackConfig[];
  model_fallbacks: Record<string, string[]>;
}

export interface GatewayConfig {
  host: string;
  port: number;
  status_check: boolean;
  endpoints: Record<string, EndpointConfig>;
}

function resolveSingle(val: string): string {
  if (typeof val === "string" && val.startsWith("$")) {
    return process.env[val.slice(1)] ?? "";
  }
  return val;
}

function resolveKeys(rawKeys: unknown[]): string[] {
  const out: string[] = [];
  for (const k of rawKeys) {
    const v = resolveSingle(String(k));
    if (v) out.push(v);
  }
  return out;
}

function parseModelFallbacks(raw: unknown): Record<string, string[]> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("model_fallbacks must be a mapping");
  }
  const parsed: Record<string, string[]> = {};
  for (const [model, candidates] of Object.entries(raw as Record<string, unknown>)) {
    const source = String(model).trim();
    if (!source) throw new Error("source model must be a non-empty string");
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`model_fallbacks[${JSON.stringify(source)}] fallback list must be a non-empty list`);
    }
    const parsedCandidates: string[] = [];
    for (const candidate of candidates) {
      const target = String(candidate).trim();
      if (!target) {
        throw new Error(`model_fallbacks[${JSON.stringify(source)}] fallback target must be a non-empty string`);
      }
      parsedCandidates.push(target);
    }
    parsed[source] = parsedCandidates;
  }
  return parsed;
}

function fromDict(raw: Record<string, unknown>): GatewayConfig {
  const host = (raw.host as string) ?? "127.0.0.1";
  const port = (raw.port as number) ?? 9880;
  const status_check = raw.status_check !== false;

  const endpoints: Record<string, EndpointConfig> = {};
  for (const epName of ["anthropic", "openai", "google"]) {
    const epRaw = raw[epName] as Record<string, unknown> | undefined;
    if (!epRaw) continue;

    const keys = resolveKeys((epRaw.keys as unknown[]) ?? []);
    const auth_style = (epRaw.auth_style as string) ?? (epName in AUTH_STYLES ? epName : "bearer");
    const base_url = (epRaw.base_url as string) ?? DEFAULT_BASE_URLS[epName] ?? "";

    const fallbacks: FallbackConfig[] = [];
    for (const fb of (epRaw.fallbacks as Record<string, unknown>[]) ?? []) {
      const fbKey = resolveSingle((fb.key as string) ?? (fb.api_key as string) ?? "");
      fallbacks.push({
        name: (fb.name as string) ?? "fallback",
        base_url: fb.base_url as string,
        api_key: fbKey,
        auth_style: (fb.auth_style as string) ?? "bearer",
        model_prefix: (fb.model_prefix as string) ?? "",
        model_map: (fb.model_map as Record<string, string>) ?? {},
        translate: (fb.translate as string) ?? null,
      });
    }

    const passthrough = epRaw.passthrough !== false;
    const model_fallbacks = parseModelFallbacks(epRaw.model_fallbacks);

    endpoints[epName] = {
      name: epName,
      base_url,
      auth_style,
      keys,
      passthrough,
      fallbacks,
      model_fallbacks,
    };
  }

  return { host, port, status_check, endpoints };
}

export function autoDiscover(host = "127.0.0.1", port = 9880): GatewayConfig {
  const endpoints: Record<string, EndpointConfig> = {};

  for (const [envVar, epName] of Object.entries(AUTO_DISCOVER_MAP)) {
    const key = process.env[envVar];
    if (!key) continue;
    const auth = epName in AUTH_STYLES ? epName : "bearer";
    const base = DEFAULT_BASE_URLS[epName] ?? "";
    endpoints[epName] = {
      name: epName,
      base_url: base,
      auth_style: auth,
      keys: [key],
      passthrough: true,
      fallbacks: [],
      model_fallbacks: {},
    };
  }

  // Auto-add OpenRouter as fallback if its key exists
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const orBase = FALLBACK_PRESETS.openrouter.base_url;
    for (const [epName, ep] of Object.entries(endpoints)) {
      const prefix = epName !== "openai" ? `${epName}/` : "openai/";
      const translate = epName === "anthropic" ? "anthropic-to-openai" : null;
      ep.fallbacks.push({
        name: "openrouter",
        base_url: orBase,
        api_key: orKey,
        model_prefix: prefix,
        model_map: {},
        auth_style: "bearer",
        translate,
      });
    }
  }

  return { host, port, status_check: true, endpoints };
}

export function loadConfig(configPath?: string): GatewayConfig {
  const filePath = configPath ?? CONFIG_FILE;
  if (!fs.existsSync(filePath)) {
    return autoDiscover();
  }

  // Dynamic import of yaml — it's an optional dependency
  let yaml: { parse: (s: string) => unknown };
  try {
    yaml = require("yaml");
  } catch {
    throw new Error(
      "Gateway config requires the 'yaml' package.\nInstall with: npm install yaml"
    );
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const raw = (yaml.parse(content) as Record<string, unknown>) ?? {};
  return fromDict(raw);
}

export function generateConfig(): string {
  return `\
# aistatus gateway configuration
# Docs: https://aistatus.cc/docs
#
# After editing, start with:
#   npx aistatus-gateway start
#
# Or skip this file entirely with auto-discovery:
#   npx aistatus-gateway start --auto

port: 9880

# ── Anthropic (for Claude Code) ─────────────────────────────────
anthropic:
  # Multiple keys → automatic rotation on rate-limit / 5xx
  keys:
    - $ANTHROPIC_API_KEY
    # - sk-ant-your-second-key

  # Hybrid mode: when true (default), the caller's own API key is
  # tried after managed keys, before fallbacks.
  # Set to false to use only managed keys.
  # Automatic model-level degradation order.
  # When a model is unhealthy, later tasks can switch to the first healthy fallback.
  # model_fallbacks:
  #   claude-opus-4-6:
  #     - claude-sonnet-4-6
  #     - claude-haiku-4-5

  fallbacks:
    # OpenRouter serves Claude models via OpenAI-compatible API
    - name: openrouter
      base_url: https://openrouter.ai/api/v1
      key: $OPENROUTER_API_KEY
      model_prefix: "anthropic/"
      translate: anthropic-to-openai

# ── OpenAI (for Codex) ──────────────────────────────────────────
openai:
  keys:
    - $OPENAI_API_KEY

  fallbacks:
    - name: openrouter
      base_url: https://openrouter.ai/api/v1
      key: $OPENROUTER_API_KEY
      model_prefix: "openai/"

    # DeepSeek as budget fallback (different models)
    # - name: deepseek
    #   base_url: https://api.deepseek.com
    #   key: $DEEPSEEK_API_KEY
    #   model_map:
    #     gpt-4o: deepseek-chat
    #     gpt-4o-mini: deepseek-chat

# ── Google (for Gemini CLI) ─────────────────────────────────────
# google:
#   keys:
#     - $GEMINI_API_KEY
`;
}
