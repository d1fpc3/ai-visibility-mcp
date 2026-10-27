import { type EngineId, ProviderError } from './types.js';

export interface HttpOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Base delay for exponential backoff. Tests set this to 0. */
  baseDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before retry `attempt` (0-based): exponential with full jitter, or the server's Retry-After. */
export function backoffDelay(attempt: number, baseDelayMs: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  const cap = baseDelayMs * 2 ** attempt;
  return Math.round(Math.random() * cap);
}

/**
 * POST JSON with a per-attempt timeout and retries on rate limits, server errors and network failures.
 * Client errors (400, 401, 403, 404) fail fast because retrying them only burns money.
 */
export async function postJson<T>(
  engine: EngineId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: HttpOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (options.signal?.aborted) throw new ProviderError('Request was cancelled', engine);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let retryAfter: string | null = null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return (await res.json()) as T;

      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const retryable = RETRYABLE_STATUS.has(res.status);
      lastError = new ProviderError(
        `${engine} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        engine,
        res.status,
        retryable,
      );
      if (!retryable) throw lastError;
      retryAfter = res.headers.get('retry-after');
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      if (err instanceof ProviderError) {
        lastError = err;
      } else if (options.signal?.aborted) {
        throw new ProviderError('Request was cancelled', engine);
      } else {
        const timedOut = timeout.aborted;
        lastError = new ProviderError(
          timedOut
            ? `${engine} timed out after ${options.timeoutMs} ms`
            : `${engine} request failed: ${(err as Error).message}`,
          engine,
          undefined,
          true,
        );
      }
    }

    if (attempt < options.maxRetries) await sleep(backoffDelay(attempt, baseDelayMs, retryAfter));
  }

  throw lastError ?? new ProviderError(`${engine} request failed`, engine);
}
