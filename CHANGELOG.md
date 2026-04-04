# Changelog

## 0.0.4 — 2026-04-04

### Added

- Persistent usage-upload configuration helpers backed by `~/.aistatus/config.yaml`
  with `configure() > env vars > config file > defaults` precedence
- Fire-and-forget `UsageUploader` that POSTs usage records to
  `https://aistatus.cc/api/usage/upload` and swallows network failures
- Leaderboard support in the SDK usage pipeline: routers and gateway usage
  tracking now forward uploaded records with user identity metadata

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
