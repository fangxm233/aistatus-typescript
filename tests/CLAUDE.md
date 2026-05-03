一旦此文件夹有文件变化，请更新我

SDK 回归测试目录，覆盖 config、gateway server、usage、router、health 与协议转换行为。
所有新增功能应先在这里加入失败测试，再实现源码修改。

| filename | role | function |
|---|---|---|
| `config.test.mjs` | regression test | Verify auto-discovery plus flat/mode-aware gateway config parsing |
| `server.test.mjs` | integration test | Exercise gateway HTTP endpoints including mode switching and raw usage records |
| `usage.test.mjs` | regression test | Verify usage persistence, aggregation, and billing_mode recording |
| `health.test.mjs` | regression test | Verify backend/model health tracking and recovery |
| `router.test.mjs` | regression test | Verify routing fallback behavior and provider alias handling |
| `status-api.test.mjs` | regression test | Verify StatusAPI response parsing and provider normalization |
| `translate.test.mjs` | regression test | Verify Anthropic↔OpenAI payload and SSE translation |
| `pricing.test.mjs` | regression test | Verify token pricing cost calculation behavior including cache-aware costs |
| `router-advanced.test.mjs` | regression test | Verify router health tracking, model fallback chains, 429 retry, cache tokens, and streaming |
| `uploader.test.mjs` | regression test | Verify upload payload construction, config gating, and silent fire-and-forget fetch behavior |
| `gateway-mode.test.mjs` | integration test | Verify per-request mode routing via /m/{mode}/{ep}/{path} URL pattern |
| `middleware.test.mjs` | regression test | Verify middleware hooks (beforeRequest, afterResponse, onError), execution order, dynamic use(), abort, tier routing, and fallback integration |
| `gateway-auth.test.mjs` | regression test | Verify gateway API key authentication: Bearer/custom header, public paths, env var resolution, backward compatibility |
| `multimodal-structured-stream.test.mjs` | regression test | Verify multimodal ContentBlock[] messages, ResponseFormat options, StreamChunk error type, routeStreamCallbacks, streamToReadable, and AbortSignal cancellation |
| `gateway-reload.test.mjs` | regression test | Verify `GatewayServer.reloadConfig()` in-place hot reload (host/port pinning, active-mode fallback) and `watchConfigFile()` mtime-polling change detection |
