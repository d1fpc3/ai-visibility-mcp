import type { EngineAnswer, EngineId, EngineProvider } from './providers/types.js';

/** Runs async tasks with at most `limit` in flight. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/** Same question, same engine, same model: reuse the answer instead of paying for it twice. */
export function cacheKey(engine: EngineId, model: string, question: string): string {
  return `${engine}|${model}|${question.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export class AnswerCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<EngineAnswer> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the cached promise, or runs `load` once and shares it with every caller. Failures are not cached. */
  getOrLoad(key: string, load: () => Promise<EngineAnswer>): { value: Promise<EngineAnswer>; hit: boolean } {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) return { value: entry.value, hit: true };
    const value = load();
    this.entries.set(key, { expires: this.now() + this.ttlMs, value });
    value.catch(() => this.entries.delete(key));
    return { value, hit: false };
  }

  get size(): number {
    return this.entries.size;
  }
}

export type EngineOutcome =
  | { ok: true; answer: EngineAnswer; cached: boolean }
  | { ok: false; engine: EngineId; question: string; error: string };

export interface RunStats {
  engineCalls: number;
  cacheHits: number;
  failures: number;
  elapsedMs: number;
}

export interface RunResult {
  outcomes: EngineOutcome[];
  stats: RunStats;
}

export interface RunOptions {
  concurrency: number;
  cache?: AnswerCache;
  signal?: AbortSignal;
}

/**
 * Ask every question on every engine, at most `concurrency` calls at a time.
 * One engine failing never sinks the run: its error is returned next to the answers that worked.
 */
export async function runQuestions(
  engines: EngineProvider[],
  questions: string[],
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const limit = createLimiter(options.concurrency);
  const cache = options.cache ?? new AnswerCache(0);
  const seen = new Set<string>();
  let engineCalls = 0;
  let cacheHits = 0;

  const jobs: Array<Promise<EngineOutcome>> = [];
  for (const question of questions) {
    for (const engine of engines) {
      const key = cacheKey(engine.id, engine.model, question);
      if (seen.has(key)) continue; // duplicate question inside this run
      seen.add(key);
      const { value, hit } = cache.getOrLoad(key, () => {
        engineCalls++;
        return limit(() => engine.ask(question, options.signal ? { signal: options.signal } : {}));
      });
      if (hit) cacheHits++;
      jobs.push(
        value.then(
          (answer): EngineOutcome => ({ ok: true, answer: { ...answer, question }, cached: hit }),
          (err: unknown): EngineOutcome => ({
            ok: false,
            engine: engine.id,
            question,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    }
  }

  const outcomes = await Promise.all(jobs);
  return {
    outcomes,
    stats: {
      engineCalls,
      cacheHits,
      failures: outcomes.filter((o) => !o.ok).length,
      elapsedMs: Date.now() - started,
    },
  };
}
