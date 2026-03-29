一旦此文件夹有文件变化，请更新我

TypeScript SDK 源码目录，包含主 SDK 导出、gateway 配置/服务与共享 usage 逻辑。
`gateway/` 负责 HTTP proxy 与配置解析；`providers/` 提供各 LLM API 适配器；其余文件提供路由、状态与成本计算等基础能力。

| filename | role | function |
|---|---|---|
| `index.ts` | package entry | Register built-in providers and export the public SDK API surface/version |
| `models.ts` | type definitions | Core types: RouteResponse (with cache tokens), RouteOptions (with modelFallbacks/retry), StreamChunk (with error), ContentBlock (TextBlock/ImageUrlBlock/ImageBase64Block), ResponseFormat |
| `content.ts` | content helpers | extractTextFromContent and normalizeContent for converting between string and ContentBlock[] |
| `stream.ts` | stream utilities | streamToReadable: converts routeStream() AsyncGenerator to Web ReadableStream<string> |
| `middleware.ts` | hook definitions | Middleware interface with beforeRequest, afterResponse, onError hooks for request/response interception |
| `router.ts` | routing engine | Model/tier routing with health tracking, model fallback chains, 429 retry, streaming (routeStream), callback streaming (routeStreamCallbacks), and middleware hooks |
| `api.ts` | API client | StatusAPI client for aistatus.cc model/provider status checks |
| `errors.ts` | error classes | AllProvidersDown, ProviderCallFailed, and other typed errors |
| `http.ts` | HTTP utilities | fetchJson, readEnv, extractText, joinUrl helpers |
| `defaults.ts` | provider defaults | AUTO_PROVIDERS, MODEL_PREFIX_MAP, PROVIDER_ALIASES for auto-discovery and routing |
| `usage.ts` | shared library | Persist per-request usage records (with cache tokens) and compute aggregate summaries/groupings |
| `pricing.ts` | cost calculator | CostCalculator with calculateCost and calculateCostWithCache (fetches per-provider cache pricing from API, falls back to 1.25x/0.10x multipliers) |
| `providers/` | adapter layer | ProviderAdapter base class + Anthropic, OpenAI, Google, OpenRouter, Compatible adapters |
| `gateway/` | gateway module | Gateway config parsing, server runtime (with per-request mode routing), health tracking, and translation exports |
