一旦此文件夹有文件变化，请更新我

Gateway 子模块：解析 gateway 配置、维护健康状态，并暴露 HTTP proxy/status/usage/mode 接口。
该目录是 aistatus TypeScript SDK 的运行时网关实现入口。

| filename | role | function |
|---|---|---|
| `index.ts` | public entry | Re-export gateway server/config helpers and bootstrap `startGateway()` |
| `auth.ts` | auth checker | Pure-function gateway API key authentication (Bearer/custom header, public path bypass) |
| `config.ts` | config parser | Load flat or mode-aware nested gateway configs, auth config, and auto-discover env-based defaults |
| `server.ts` | HTTP runtime | Serve proxy traffic plus `/health`, `/status`, `/usage`, and `/mode` endpoints; enforces gateway auth |
| `health.ts` | health tracker | Track backend/model health and cooldown state for failover |
| `translate.ts` | protocol adapter | Translate Anthropic requests/responses/SSE to OpenAI-compatible payloads |
