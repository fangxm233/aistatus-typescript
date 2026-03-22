/**
 * Gateway entry point.
 *
 * Usage:
 *   import { startGateway } from "aistatus/gateway";
 *   startGateway({ port: 9880 });
 */

export { GatewayServer } from "./server.js";
export { loadConfig, autoDiscover, generateConfig } from "./config.js";
export type { GatewayConfig, EndpointConfig, FallbackConfig } from "./config.js";
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
