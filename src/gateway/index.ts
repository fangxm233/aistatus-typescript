/**
 * Gateway entry point.
 *
 * Usage:
 *   import { startGateway } from "aistatus/gateway";
 *   startGateway({ port: 9880 });
 */

// input: CLI/startup options and gateway config loading helpers
// output: gateway server exports plus startGateway() bootstrap helper for consumers
// pos: public gateway module surface that re-exports config/server types and starts the HTTP gateway
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

export { GatewayServer } from "./server.js";
export { loadConfig, autoDiscover, generateConfig, fromDict } from "./config.js";
export type { GatewayConfig, EndpointConfig, FallbackConfig } from "./config.js";
export { checkGatewayAuth } from "./auth.js";
export type { GatewayAuthConfig } from "./auth.js";
export { HealthTracker } from "./health.js";
export {
  anthropicRequestToOpenai,
  openaiResponseToAnthropic,
  openaiSseToAnthropicSse,
} from "./translate.js";

import { type GatewayConfig, loadConfig, autoDiscover } from "./config.js";
import { GatewayServer } from "./server.js";

export interface StartOptions {
  configPath?: string;
  host?: string;
  port?: number;
  auto?: boolean;
  pidFile?: string;
}

export async function startGateway(options: StartOptions = {}): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 9880;

  let config: GatewayConfig;
  if (options.auto) {
    config = autoDiscover(host, port);
  } else if (options.configPath) {
    config = loadConfig(options.configPath);
  } else {
    config = loadConfig();
  }

  config.host = host;
  config.port = port;

  const server = new GatewayServer(config, options.pidFile);
  await server.run();
}
