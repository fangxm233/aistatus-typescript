/**
 * Health tracking for gateway backends.
 *
 * Tracks per-backend error rates using a sliding window + cooldown mechanism.
 * When a backend returns 429 / 5xx, it is marked unhealthy for a cooldown period.
 *
 * Supports dual-layer tracking:
 * - Backend level: isHealthy("anthropic:key:0")
 * - Model level: isHealthy("anthropic:key:0", "claude-opus-4-6")
 */

/** Cooldown durations (seconds) by HTTP status.
 *
 * Only 5xx errors trigger cooldowns — these indicate genuine backend health issues
 * (server errors, overload). 4xx errors (notably 429 rate-limit) are NOT health
 * problems: the backend is reachable and functioning, the caller's quota is
 * exhausted. Treating 429 as unhealthy caused a cascade where a harmless quota-
 * check probe (max_tokens=1, content="quota") would blackhole the backend for 30s,
 * causing all subsequent real requests to 503 "All backends unavailable".
 */
const COOLDOWNS: Record<number, number> = {
  500: 15,
  502: 10,
  503: 10,
  529: 30, // Anthropic overloaded
};
const DEFAULT_COOLDOWN = 10;

/** Returns true if the status code represents a server-side health issue.
 *  4xx errors are caller-side (rate limits, auth, bad request) and must NOT
 *  affect backend health tracking. */
export function isServerError(status: number): boolean {
  return status >= 500;
}

/** Sliding window for error rate tracking */
const WINDOW_SIZE = 60; // seconds
const MAX_ERRORS_IN_WINDOW = 5;

interface BackendState {
  cooldownUntil: number;
  errors: number[]; // timestamps (monotonic ms)
  totalRequests: number;
  totalErrors: number;
}

function createState(): BackendState {
  return { cooldownUntil: 0, errors: [], totalRequests: 0, totalErrors: 0 };
}

function now(): number {
  // Use Date.now() for cross-platform monotonic-like behavior
  // (performance.now() is relative to process start, Date.now() is absolute but fine for our purposes)
  return Date.now() / 1000;
}

/** Max entries in _modelState before eviction */
const MAX_MODEL_STATE_ENTRIES = 500;

export class HealthTracker {
  private _state = new Map<string, BackendState>();
  private _modelState = new Map<string, BackendState>();

  private _getState(backendId: string, model?: string): BackendState {
    if (model != null) {
      const key = `${backendId}\0${model}`;
      let s = this._modelState.get(key);
      if (!s) {
        s = createState();
        this._modelState.set(key, s);
        // Evict stale entries when map grows too large
        if (this._modelState.size > MAX_MODEL_STATE_ENTRIES) {
          this._evictModelState();
        }
      }
      return s;
    }
    let s = this._state.get(backendId);
    if (!s) {
      s = createState();
      this._state.set(backendId, s);
    }
    return s;
  }

  private _evictModelState(): void {
    const cutoff = now() - WINDOW_SIZE * 2;
    for (const [key, s] of this._modelState) {
      // Remove entries with no recent activity
      const lastActivity = s.errors.length > 0 ? s.errors[s.errors.length - 1] : 0;
      if (lastActivity < cutoff && s.cooldownUntil < now()) {
        this._modelState.delete(key);
      }
    }
  }

  isHealthy(backendId: string, model?: string): boolean {
    const s = this._getState(backendId, model);
    const t = now();

    // Check cooldown
    if (t < s.cooldownUntil) return false;

    // Check error window
    const cutoff = t - WINDOW_SIZE;
    let recent = 0;
    for (const ts of s.errors) {
      if (ts > cutoff) recent++;
    }
    return recent < MAX_ERRORS_IN_WINDOW;
  }

  recordError(backendId: string, statusCode: number, model?: string): void {
    const s = this._getState(backendId, model);
    const t = now();
    s.totalRequests++;

    // 4xx errors (rate limits, auth failures, bad requests) are caller-side — the
    // backend is healthy and reachable. Only 5xx errors affect health/cooldown.
    if (!isServerError(statusCode)) return;

    s.errors.push(t);
    // Keep errors array bounded
    if (s.errors.length > 50) s.errors.splice(0, s.errors.length - 50);
    s.totalErrors++;

    const cooldown = COOLDOWNS[statusCode] ?? DEFAULT_COOLDOWN;
    s.cooldownUntil = Math.max(s.cooldownUntil, t + cooldown);
  }

  /** Return the backend whose cooldown expires soonest (seconds from now, 0 if healthy). */
  soonestCooldown(backendIds: string[]): { id: string; remaining: number } | null {
    let best: { id: string; remaining: number } | null = null;
    const t = now();
    for (const id of backendIds) {
      const s = this._state.get(id);
      const remaining = s ? Math.max(0, s.cooldownUntil - t) : 0;
      if (!best || remaining < best.remaining) {
        best = { id, remaining };
      }
    }
    return best;
  }

  recordSuccess(backendId: string, model?: string): void {
    const s = this._getState(backendId, model);
    s.totalRequests++;
    // Successful request clears cooldown (backend/model recovered)
    s.cooldownUntil = 0;
  }

  errorCount(backendId: string, model?: string): number {
    return this._getState(backendId, model).totalErrors;
  }

  summary(): Record<string, unknown> {
    const t = now();
    const out: Record<string, unknown> = {};

    // Backend-level summary
    for (const [bid, s] of this._state) {
      const cutoff = t - WINDOW_SIZE;
      let recentErrors = 0;
      for (const ts of s.errors) {
        if (ts > cutoff) recentErrors++;
      }
      out[bid] = {
        healthy: this.isHealthy(bid),
        recent_errors: recentErrors,
        total_errors: s.totalErrors,
        total_requests: s.totalRequests,
        cooldown_remaining: Math.max(0, Math.round((s.cooldownUntil - t) * 10) / 10),
      };
    }

    // Model-level summary
    if (this._modelState.size > 0) {
      const modelHealth: Record<string, unknown> = {};
      for (const [key, s] of this._modelState) {
        const [bid, model] = key.split("\0");
        const cutoff = t - WINDOW_SIZE;
        let recentErrors = 0;
        for (const ts of s.errors) {
          if (ts > cutoff) recentErrors++;
        }
        const displayKey = `${bid}/${model}`;
        modelHealth[displayKey] = {
          healthy: this.isHealthy(bid, model),
          recent_errors: recentErrors,
          total_errors: s.totalErrors,
          total_requests: s.totalRequests,
          cooldown_remaining: Math.max(0, Math.round((s.cooldownUntil - t) * 10) / 10),
        };
      }
      out.model_health = modelHealth;
    }

    return out;
  }
}
