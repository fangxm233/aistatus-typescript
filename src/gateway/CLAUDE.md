一旦此文件夹有文件变化，请更新我

Gateway 子模块：解析 gateway 配置、维护健康状态，并暴露 HTTP proxy/status/usage/mode 接口。
该目录是 aistatus TypeScript SDK 的运行时网关实现入口。

| filename | role | function |
|---|---|---|
| `index.ts` | 入口 | 导出网关 API 并启动或热加载配置 |
| `auth.ts` | auth checker | Pure-function gateway API key authentication (Bearer/custom header, public path bypass) |
| `config.ts` | 配置 | 解析网关配置、请求限额与模式 |
| `server.ts` | HTTP runtime | Dispatch proxy requests and coordinate Gateway modules |
| `server-types.ts` | types | Define internal backend and usage contracts |
| `server-helpers.ts` | 工具 | 转换请求头、请求体、模型与用量 |
| `server-info.ts` | info API | Serve health, status, usage, and model prechecks |
| `stream-response.ts` | streaming | Forward SSE and persist stream usage |
| `usage-accounting.ts` | accounting | Price and persist JSON or SSE usage |
| `health.ts` | health tracker | Track backend/model health and cooldown state for failover |
| `translate.ts` | protocol adapter | Translate Anthropic requests/responses/SSE to OpenAI-compatible payloads |
