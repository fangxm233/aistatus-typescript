# Changelog

## 0.0.4 — 2026-04-04

Opt-in usage upload pipeline and cache-aware pricing for the leaderboard flow.

### New Modules

#### `config` — persistent upload configuration

Manages SDK-wide upload identity, backed by `~/.aistatus/config.yaml`.

- **`AIStatusConfig` interface** — four fields:
  - `name: string | null` — user or organization display name
  - `org: string | null` — organization identifier
  - `email: string | null` — contact email for the upload identity
  - `uploadEnabled: boolean` — master switch for usage uploads
- **`getConfig(options?: ConfigOptions) → AIStatusConfig`** — returns the
  merged config. Resolution order:
  1. Runtime overrides (set via `configure()`)
  2. Environment variables
  3. YAML file at `~/.aistatus/config.yaml`
  4. Defaults (all null/false)

  `ConfigOptions` allows injecting custom `env`, `filePath`, or
  `skipFile: true` for testing.
- **`configure(config: Partial<AIStatusConfig> | null) → AIStatusConfig`** —
  stores in-memory overrides and returns the resolved config. Pass `null`
  to clear overrides.
- **`loadFromFile(filePath?) → Partial<AIStatusConfig>`** — reads and parses
  the YAML file. Supports both camelCase (`uploadEnabled`) and snake_case
  (`upload_enabled`) keys.
- **`saveToFile(config, filePath?)`** — writes the config to YAML. Creates
  parent directories as needed.
- **Environment variables**:
  | Variable | Maps to | Type |
  |---|---|---|
  | `AISTATUS_UPLOAD_ENABLED` | `uploadEnabled` | bool |
  | `AISTATUS_NAME` | `name` | str |
  | `AISTATUS_ORG` | `org` | str |
  | `AISTATUS_EMAIL` | `email` | str |
- **Boolean normalization**: string values `"1"`, `"true"`, `"yes"`, `"on"`
  → `true`; `"0"`, `"false"`, `"no"`, `"off"` → `false`. Applies to both
  env vars and YAML values.
- Internal helpers: `mergeConfig()` uses `coalesce()` for strings (first
  non-`undefined` wins) and `coalesceBoolean()` for booleans.

#### `uploader` — fire-and-forget usage upload

Bridges local usage tracking to the remote leaderboard API.

- **`UsageUploader` class**:
  - Constructor takes `AIStatusConfig` and optional `baseUrl`
    (default `https://aistatus.cc`).
  - **`upload(record: UsageRecord)`** — the only public method:
    1. Guards: returns immediately if `uploadEnabled`, `name`, or `email`
       are falsy
    2. Builds a `UsageUploadPayload`:
       - Maps short keys to full names: `in` → `input_tokens`,
         `out` → `output_tokens`, `cache_creation_in` →
         `cache_creation_input_tokens`, `cache_read_in` →
         `cache_read_input_tokens`
       - Includes identity fields (`name`, `organization`, `email`),
         metric fields (`cost_usd`, `latency_ms`), and `sdk_version`
         (from `VERSION` constant)
    3. Fires `fetch()` POST to `{baseUrl}/api/usage/upload` with
       `Content-Type: application/json`. The returned promise is
       **voided** (`.catch(() => {})`) — never blocks, never throws.
- **Type definitions**:
  - `UsageRecord` — input shape: `{ ts, provider, model, in?, out?,
    cache_creation_in?, cache_read_in?, cost?, latency_ms? }`
  - `UsageUploadRecord` — wire format: full field names + identity fields
  - `UsageUploadPayload` — `{ records: [UsageUploadRecord], sdk_version }`
- **`UsageUploadTarget` interface** (in `usage.ts`) — `{ upload(record): void }`
  structural typing so `UsageTracker` doesn't depend directly on `UsageUploader`.

### Enhanced

#### Usage tracking pipeline

- **`UsageTracker` constructor** — new optional second parameter
  `uploader?: UsageUploadTarget | null`. When set, `recordUsage()` calls
  `this.uploader?.upload(record)` after appending to local JSONL storage.
- **`UsageTracker.recordUsage()`** — new optional fields in the options
  object:
  - `cache_creation_input_tokens?: number`
  - `cache_read_input_tokens?: number`
  - `billing_mode?: string`

  Cache token keys are included conditionally (only when non-zero).

#### Usage storage

- **`UsageStorage`** — project-scoped persistence:
  - Directory: `~/.aistatus/usage/projects/{cwdHash}/` where `cwdHash` is
    the first 12 chars of `SHA-256(process.cwd())`
  - Files: `YYYY-MM.jsonl` (one per calendar month)
  - `manifest.json` — records the original `cwd` path and creation
    timestamp, written once on first access
  - **`exportJson(payload, outputPath)`** — new method for generic JSON
    export alongside existing `exportCsv()`

#### Router & Gateway wiring

- **`Router` constructor** — now constructs:
  ```typescript
  this.usage = new UsageTracker(undefined, new UsageUploader(getConfig()));
  ```
  New private `recordUsage()` method invoked on **all four route paths**:
  1. `routeModel()` — main success path
  2. `routeModel()` — 429 retry path
  3. `routeStream()` — streaming (collects usage from stream chunks)
  4. `routeStream()` — non-streaming fallback after stream collection

  Each call captures `provider`, `model`, `inputTokens`, `outputTokens`,
  `cacheCreationInputTokens`, `cacheReadInputTokens`, `latencyMs`,
  `wasFallback`, and calculated cost.

- **`GatewayServer` constructor** — same pattern:
  ```typescript
  this.usage = new UsageTracker(undefined, new UsageUploader(getConfig()));
  ```
  Gateway usage recording now forwards cache token fields through to the
  uploader.

#### Cache-aware pricing

- **`CostCalculator.calculateCostWithCache()`** — new method:
  ```typescript
  calculateCostWithCache(
    provider, model,
    inputTokens, outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  ): number
  ```
  Cost formula:
  - Base input: `inputTokens × input_per_million`
  - Cache creation: `cacheCreationInputTokens × writePrice`
    (fetched from API; fallback **1.25×** input price)
  - Cache read: `cacheReadInputTokens × readPrice`
    (fetched from API; fallback **0.10×** input price)
  - Output: `outputTokens × output_per_million`

- **`PricingInfo` interface** — now includes `input_cache_read_per_million`
  and `input_cache_write_per_million` (nullable). Populated from the
  `input_cache_read` and `input_cache_write` fields in the aistatus.cc API
  response.

- **`_refreshPricing()`** — async refresh with deduplication via
  `_pendingRefreshes` Map: concurrent calls for the same model coalesce
  into a single fetch.

### Public API

New top-level exports in `aistatus`:

```typescript
export { UsageUploader } from "./uploader";
export { configure, getConfig, loadFromFile, saveToFile } from "./config";
export type { AIStatusConfig } from "./config";
```

### Dependencies

- Added `yaml ^2.8.3` for YAML config file parsing/writing

### User Flow

```typescript
import { configure, route } from "aistatus";

// One-time setup (persisted to ~/.aistatus/config.yaml)
configure({ name: "Alice", email: "alice@example.com", uploadEnabled: true });

// Every route() call now uploads usage in the background
const resp = await route("Hello", { model: "claude-sonnet-4-6" });
// → usage record POSTed to aistatus.cc/api/usage/upload (async, silent)
```

## 0.0.3 — 2026-03-23

Initial public release of the TypeScript SDK.

### Router

- **Auto-discovery** — scans environment variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) and registers provider adapters
  automatically
- **Model routing** — zero-config `route("Hello", { model: "claude-sonnet-4-6" })`
  resolves provider via `aistatus.cc`, no manual registration needed
- **Tier routing** — define ordered model groups (`fast`, `standard`, `premium`)
  and let the router try them in sequence
- **Automatic fallback** — when the primary provider is unavailable or returns
  an error, tries compatible healthy providers
- **`prefer` parameter** — bias fallback ordering toward preferred providers
- **`system` parameter** — convenient system prompt without manual message
  wrapping
- **String message shortcut** — pass a plain string instead of a full messages
  array
- **Unified `RouteResponse`** — `content`, `modelUsed`, `providerUsed`,
  `wasFallback`, `fallbackReason`, `inputTokens`, `outputTokens`, `costUsd`,
  `raw`
- **Manual provider registration** — register custom or self-hosted
  OpenAI-compatible endpoints
- **Slug alias system** — register multiple slugs for the same provider

### Provider Adapters

- **Anthropic** — Messages API with streaming, system prompts, multimodal
  content, and tool use
- **OpenAI** — Chat Completions with streaming and structured output
- **Google Gemini** — GenerateContent with streaming
- **OpenRouter** — multi-provider gateway with model prefix handling
- **OpenAI-compatible** — reusable adapter for DeepSeek, Mistral, xAI, Groq,
  Together, Moonshot, and Qwen/DashScope

### Gateway

A complete local HTTP proxy for AI API failover, running on `localhost:9880`.

- **Multi-key rotation** — configure multiple API keys per endpoint, rotated
  round-robin with automatic advance on error
- **Hybrid backend selection** — managed keys tried first, then the caller's
  own API key (passthrough), then fallback providers
- **Fallback chains** — route to secondary providers (e.g. OpenRouter) when
  the primary is down
- **Model-level fallback** — configure degradation chains per model
  (e.g. opus → sonnet → haiku); response includes
  `x-gateway-model-fallback` header
- **Protocol translation** — automatic Anthropic ↔ OpenAI format conversion
  for cross-provider fallback, including streaming SSE events
- **Health tracking** — per-backend and per-model health with sliding 60-second
  error window and status-code-specific cooldowns
- **Pre-flight status check** — queries `aistatus.cc` at startup to pre-mark
  globally degraded models
- **Configuration modes** — maintain multiple YAML configs (production/dev)
  and switch at runtime via `POST /mode` or per-request via `/m/{mode}/...`
- **Gateway authentication** — protect the proxy with separate API keys
- **Usage tracking** — per-provider/model cost breakdown via `/usage` endpoint
  with period and `group_by` filters
- **Management endpoints** — `/health`, `/status`, `/usage`, `/mode`
- **CLI** — `npx aistatus-gateway start [--auto|--config PATH]` and
  `npx aistatus-gateway init` to generate example config

### API Client

- `StatusAPI` — query `aistatus.cc` for provider status, model search,
  availability checks, trending models, benchmarks, market pricing, and
  recommendations
- Pricing lookup for cost calculation

### Other

- **Async-first** — all APIs return `Promise<RouteResponse>`;
  `aroute()` alias for naming symmetry with the Python SDK
- **Dual format** — ships ESM and CJS builds with TypeScript declarations
- **Error hierarchy** — `AllProvidersDown`, `ProviderNotConfigured`,
  `ProviderCallFailed`
- **Middleware hooks** — request/response interception points
- **Content utilities** — content block helpers
- **Stream utilities** — streaming response helpers
- Node.js `>=18` required (built-in `fetch`)
