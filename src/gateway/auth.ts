/**
 * Gateway authentication: pure functions for API key validation.
 */

import { timingSafeEqual } from "node:crypto";

// input: GatewayAuthConfig, request pathname, and request headers
// output: boolean indicating whether the request is authenticated
// pos: stateless auth check extracted from server for testability
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

export interface GatewayAuthConfig {
  /** If true, all proxy requests require authentication. Default: false */
  enabled: boolean;
  /** Accepted API keys (plain strings or resolved from $ENV_VAR references) */
  keys: string[];
  /** Header to check for the API key. Default: "authorization" (Bearer scheme) */
  header?: string;
  /** Paths that bypass authentication (e.g., ["/health"]). Default: ["/health"] */
  public_paths?: string[];
}

/**
 * Check whether a request is authorized against the gateway auth config.
 * Returns true if the request should be allowed through.
 */
export function checkGatewayAuth(
  authConfig: GatewayAuthConfig | undefined,
  pathname: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!authConfig || !authConfig.enabled) return true;

  // Check public paths
  const publicPaths = authConfig.public_paths ?? ["/health"];
  if (publicPaths.some(p => pathname === p || pathname.startsWith(p + "/"))) {
    return true;
  }

  // Extract key from request
  const headerName = (authConfig.header ?? "authorization").toLowerCase();
  const rawValue = headers[headerName];
  const headerValue = Array.isArray(rawValue) ? rawValue[0] ?? "" : rawValue ?? "";

  let providedKey: string;
  if (headerName === "authorization") {
    // Bearer scheme
    providedKey = headerValue.toLowerCase().startsWith("bearer ")
      ? headerValue.slice(7).trim()
      : headerValue.trim();
  } else {
    providedKey = headerValue.trim();
  }

  if (!providedKey) return false;

  // Constant-time comparison against configured keys
  return authConfig.keys.some(key => {
    const a = Buffer.from(key, "utf-8");
    const b = Buffer.from(providedKey, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  });
}
