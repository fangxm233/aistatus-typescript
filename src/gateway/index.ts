// input:  CLI options, gateway config, upload config, filesystem watchers
// output: Public gateway/quota exports, config file watchers, and startGateway() (returns the running server)
// pos:    Gateway package entry point
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export { GatewayServer } from "./server.js";
export {
  loadConfig,
  autoDiscover,
  generateConfig,
  fromDict,
  DEFAULT_BASE_URLS,
  DEFAULT_MAX_BODY_SIZE_MB,
  AUTH_STYLES,
  RESERVED_KEYS,
} from "./config.js";
export type { GatewayConfig, EndpointConfig, FallbackConfig } from "./config.js";
export { checkGatewayAuth } from "./auth.js";
export type { GatewayAuthConfig } from "./auth.js";
export { HealthTracker, isServerError } from "./health.js";
export { QuotaSnapshotStore } from "./quota-snapshot.js";
export type { ProviderQuotaSnapshot, QuotaWindowSnapshot } from "./quota-snapshot.js";
export {
  anthropicRequestToOpenai,
  openaiResponseToAnthropic,
  openaiSseToAnthropicSse,
} from "./translate.js";

import { type GatewayConfig, loadConfig, autoDiscover } from "./config.js";
import { GatewayServer } from "./server.js";
import { type AIStatusConfig, CONFIG_FILE, getConfig } from "../config.js";

export interface StartOptions {
  configPath?: string;
  host?: string;
  port?: number;
  auto?: boolean;
  pidFile?: string;
  /**
   * Set false to disable config hot reload. When enabled (default), the gateway config file
   * (if one is used) and the upload config `~/.aistatus/config.yaml` are both watched.
   */
  watchConfig?: boolean;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".aistatus", "gateway.yaml");

/**
 * Poll `filePath` and call `onReload(load())` after it changes (200 ms debounce).
 * fs.watchFile (polling) is robust to atomic-save editors and missing files.
 * A failing `load()` logs a warning and leaves the previous config in place.
 */
function pollFile<T>(
  filePath: string,
  load: () => T,
  onReload: (value: T) => void,
  options: { intervalMs?: number; reloadOnDelete?: boolean },
): () => void {
  const interval = options.intervalMs ?? 1000;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const handler = (curr: fs.Stats, prev: fs.Stats): void => {
    // mtime 0 means the file does not exist (yet/anymore).
    if (curr.mtimeMs === 0 && !options.reloadOnDelete) return;
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      try {
        onReload(load());
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

/** Watch a gateway config file and call `onReload` with the freshly parsed config when it changes. */
export function watchConfigFile(
  filePath: string,
  onReload: (config: GatewayConfig) => void,
  options: { intervalMs?: number } = {},
): () => void {
  return pollFile(filePath, () => loadConfig(filePath), onReload, options);
}

/**
 * Watch the upload config file (default `~/.aistatus/config.yaml`) and call `onReload`
 * with the merged config (configure() > env > file > defaults) when it is created,
 * edited or deleted. `env` overrides process.env for the merge.
 */
export function watchUploadConfigFile(
  onReload: (config: AIStatusConfig) => void,
  options: { filePath?: string; intervalMs?: number; env?: Record<string, string | undefined> } = {},
): () => void {
  const filePath = options.filePath ?? CONFIG_FILE;
  return pollFile(filePath, () => getConfig({ filePath, env: options.env }), onReload, {
    intervalMs: options.intervalMs,
    reloadOnDelete: true,
  });
}

export async function startGateway(options: StartOptions = {}): Promise<GatewayServer> {
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

  if (options.watchConfig !== false) {
    if (watchPath) {
      watchConfigFile(watchPath, next => server.reloadConfig(next));
    }
    watchUploadConfigFile(next => server.reloadUploadConfig(next));
  }

  await server.run();
  return server;
}
