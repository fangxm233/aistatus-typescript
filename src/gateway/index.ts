/**
 * Gateway entry point.
 *
 * Usage:
 *   import { startGateway } from "aistatus/gateway";
 *   startGateway({ port: 9880 });
 */

// input: CLI/startup options and gateway config loading helpers
// output: gateway server exports plus startGateway() bootstrap helper for consumers
// pos: public gateway module surface that re-exports config/server types, starts the HTTP gateway, and watches the config file for hot reload
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  /** Disable automatic config-file hot reload (default: enabled when a config file is used). */
  watchConfig?: boolean;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".aistatus", "gateway.yaml");

/**
 * Watch a config file and call `onReload` with the freshly parsed config when it changes.
 * Uses fs.watchFile (polling) so it is robust to atomic-save editors and missing files.
 */
export function watchConfigFile(
  filePath: string,
  onReload: (config: GatewayConfig) => void,
  options: { intervalMs?: number } = {},
): () => void {
  const interval = options.intervalMs ?? 1000;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const handler = (curr: fs.Stats, prev: fs.Stats): void => {
    // mtime 0 means the file does not exist (yet/anymore). Skip.
    if (curr.mtimeMs === 0) return;
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      try {
        const next = loadConfig(filePath);
        onReload(next);
      } catch (err) {
        console.warn(`[gateway] Config reload failed for ${filePath}:`, err);
      }
    }, 200);
  };

  fs.watchFile(filePath, { interval, persistent: false }, handler);
  console.log(`[gateway] Watching config file for changes: ${filePath}`);

  return () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    fs.unwatchFile(filePath, handler);
  };
}

export async function startGateway(options: StartOptions = {}): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 9880;

  let config: GatewayConfig;
  let watchPath: string | null = null;
  if (options.auto) {
    config = autoDiscover(host, port);
  } else if (options.configPath) {
    config = loadConfig(options.configPath);
    watchPath = options.configPath;
  } else {
    config = loadConfig();
    watchPath = DEFAULT_CONFIG_PATH;
  }

  config.host = host;
  config.port = port;

  const server = new GatewayServer(config, options.pidFile);

  const watchEnabled = options.watchConfig !== false;
  if (watchEnabled && watchPath) {
    watchConfigFile(watchPath, next => server.reloadConfig(next));
  }

  await server.run();
}
