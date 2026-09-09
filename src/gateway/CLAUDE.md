一旦此文件夹有文件变化，请更新我

Gateway 子模块：解析配置、维护健康状态，并暴露 proxy/status/usage/quota/mode 接口。
该目录是 aistatus TypeScript SDK 的运行时网关实现入口。

| filename | role | function |
|---|---|---|
| `index.ts` | 入口 | 导出网关 API 并启动或热加载配置 |
| `auth.ts` | auth checker | Pure-function gateway API key authentication (Bearer/custom header, public path bypass) |
| `config.ts` | 配置 | 解析网关配置、请求限额与模式 |
| `server.ts` | HTTP runtime | Dispatch proxy requests and WebSocket upgrades, and coordinate Gateway modules |
| `server-types.ts` | types | Define internal backend and usage contracts |
| `server-helpers.ts` | 工具 | 转换请求头、请求体、模型与用量（含 Responses API 的 cached-input 归一化），并解析 proxy 路由 |
| `server-info.ts` | info API | Serve health, status, usage, quota, and model prechecks |
| `quota-snapshot.ts` | quota store | Parse and atomically persist latest provider quota |
| `stream-response.ts` | streaming | Forward complete SSE, abort interrupted streams, and parse Anthropic / chat-completions / Responses API usage |
| `websocket-proxy.ts` | websocket proxy | Replay the upgrade upstream, tunnel raw bytes, and account usage per completed response |
| `websocket-frames.ts` | frame reader | Reassemble server-to-client WebSocket messages for read-only usage sniffing |
| `usage-accounting.ts` | accounting | Price and persist JSON or SSE usage |
| `health.ts` | health tracker | Track backend/model health and cooldown state for failover |
| `translate.ts` | protocol adapter | Translate Anthropic requests/responses/SSE to OpenAI-compatible payloads |
