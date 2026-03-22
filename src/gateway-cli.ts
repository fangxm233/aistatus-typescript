#!/usr/bin/env node
/**
 * CLI entry point: aistatus-gateway start|init
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  let command = "";
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "start" || arg === "init") {
      command = arg;
    } else if (arg === "--auto") {
      flags.auto = true;
    } else if (arg === "-c" || arg === "--config") {
      flags.config = args[++i] ?? "";
    } else if (arg === "--host") {
      flags.host = args[++i] ?? "127.0.0.1";
    } else if (arg === "-p" || arg === "--port") {
      flags.port = args[++i] ?? "9880";
    } else if (arg === "--pid-file") {
      flags.pidFile = args[++i] ?? "";
    } else if (arg === "-o" || arg === "--output") {
      flags.output = args[++i] ?? "";
    } else if (arg === "-h" || arg === "--help") {
      flags.help = true;
    }
  }

  return { command: command || "start", flags };
}

function printHelp(): void {
  console.log(`
  aistatus-gateway — Local transparent proxy for automatic AI API failover

  Usage:
    aistatus-gateway start [options]   Start the gateway server
    aistatus-gateway init [options]    Generate example config file

  Start options:
    -c, --config <path>   Config file path (default: ~/.aistatus/gateway.yaml)
    --host <host>         Listen host (default: 127.0.0.1)
    -p, --port <port>     Listen port (default: 9880)
    --auto                Auto-discover providers from env vars
    --pid-file <path>     Write PID to this file

  Init options:
    -o, --output <path>   Output path (default: ~/.aistatus/gateway.yaml)
`);
}

async function doStart(flags: Record<string, string | boolean>): Promise<void> {
  const { startGateway } = await import("./gateway/index.js");
  await startGateway({
    configPath: typeof flags.config === "string" ? flags.config : undefined,
    host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
    port: typeof flags.port === "string" ? parseInt(flags.port, 10) : 9880,
    auto: flags.auto === true,
    pidFile: typeof flags.pidFile === "string" ? flags.pidFile : undefined,
  });
}

async function doInit(flags: Record<string, string | boolean>): Promise<void> {
  const { generateConfig } = await import("./gateway/config.js");

  const configDir = path.join(os.homedir(), ".aistatus");
  const outputPath = typeof flags.output === "string"
    ? flags.output
    : path.join(configDir, "gateway.yaml");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = generateConfig();
  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`Config written to: ${outputPath}`);
  console.log();
  console.log("Edit the file to configure your API keys, then run:");
  console.log("  npx aistatus-gateway start");
  console.log();
  console.log("Or use auto-discovery (reads existing env vars):");
  console.log("  npx aistatus-gateway start --auto");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (flags.help) {
    printHelp();
    return;
  }

  if (command === "init") {
    await doInit(flags);
  } else {
    await doStart(flags);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
