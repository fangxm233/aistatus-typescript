import { ProviderNotConfigured } from "./errors";

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

export class HTTPStatusError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "HTTPStatusError";
    this.status = status;
    this.body = body;
  }
}

export function readEnv(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }

  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }

  return process.env[name];
}

export function requireApiKey(
  provider: string,
  apiKey: string | undefined,
  envName?: string,
): string {
  if (!apiKey) {
    throw new ProviderNotConfigured(provider, envName);
  }

  return apiKey;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("\n");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }

    if ("content" in value) {
      return extractText(value.content);
    }
  }

  return "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchJson<T>(
  url: string,
  init: Omit<RequestInit, "body"> & { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? 3_000;
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const externalSignal = init.signal;
  const abortFromExternal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, {
        once: true,
      });
    }
  }

  try {
    const headers = new Headers(init.headers ?? {});
    let body: unknown = init.body;

    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer)
    ) {
      body = JSON.stringify(body);
    }

    if (typeof body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(url, {
      ...init,
      headers,
      body: body as BodyInit | null | undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? tryParseJson(text) : null;

    if (!response.ok) {
      throw new HTTPStatusError(response.status, payload);
    }

    return payload as T;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
