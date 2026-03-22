一旦此文件夹有文件变化，请更新我

TypeScript SDK 源码目录，包含主 SDK 导出、gateway 配置/服务与共享 usage 逻辑。
`gateway/` 负责 HTTP proxy 与配置解析；其余文件提供路由、状态与成本计算等基础能力。

| filename | role | function |
|---|---|---|
| `index.ts` | package entry | Register built-in providers and export the public SDK API surface/version |
| `usage.ts` | shared library | Persist per-request usage records and compute aggregate summaries/groupings |
| `gateway/` | gateway module | Gateway config parsing, server runtime, health tracking, and translation exports |
