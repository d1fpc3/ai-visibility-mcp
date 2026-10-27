import { ADAPTERS } from './providers/adapters.js';
import { ENGINE_IDS, type EngineId, type EngineProvider } from './providers/types.js';

export interface EngineSettings {
  keyEnv: readonly string[];
  modelEnv: string;
  defaultModel: string;
}

/** Each engine turns on only when its API key is present. Models are small and fast by default to keep cost low. */
export const ENGINE_SETTINGS: Record<EngineId, EngineSettings> = {
  anthropic: {
    keyEnv: ['ANTHROPIC_API_KEY'],
    modelEnv: 'AIV_ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-5-5',
  },
  openai: { keyEnv: ['OPENAI_API_KEY'], modelEnv: 'AIV_OPENAI_MODEL', defaultModel: 'gpt-5-mini' },
  perplexity: { keyEnv: ['PERPLEXITY_API_KEY'], modelEnv: 'AIV_PERPLEXITY_MODEL', defaultModel: 'sonar' },
  gemini: {
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'AIV_GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
  },
};

export interface RunSettings {
  /** Max engine calls in flight at once, across all questions. */
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  /** How long an identical question to the same engine is served from cache. */
  cacheTtlMs: number;
  /** Hard cap on questions per tool call, so one request can't run up a big bill. */
  maxQuestions: number;
}

export interface AppConfig {
  engines: EngineProvider[];
  run: RunSettings;
}

type Env = Record<string, string | undefined>;

function intFromEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

export function runSettingsFromEnv(env: Env = process.env): RunSettings {
  return {
    concurrency: intFromEnv(env, 'AIV_CONCURRENCY', 4, 1, 32),
    timeoutMs: intFromEnv(env, 'AIV_TIMEOUT_MS', 45_000, 1_000, 300_000),
    maxRetries: intFromEnv(env, 'AIV_MAX_RETRIES', 2, 0, 6),
    cacheTtlMs: intFromEnv(env, 'AIV_CACHE_TTL_SECONDS', 600, 0, 86_400) * 1000,
    maxQuestions: intFromEnv(env, 'AIV_MAX_QUESTIONS', 12, 1, 50),
  };
}

export function enginesFromEnv(
  env: Env = process.env,
  run: RunSettings = runSettingsFromEnv(env),
): EngineProvider[] {
  const engines: EngineProvider[] = [];
  for (const id of ENGINE_IDS) {
    const settings = ENGINE_SETTINGS[id];
    const apiKey = settings.keyEnv.map((name) => env[name]?.trim()).find((v) => v);
    if (!apiKey) continue;
    const model = env[settings.modelEnv]?.trim() || settings.defaultModel;
    engines.push(
      new ADAPTERS[id]({ apiKey, model, http: { timeoutMs: run.timeoutMs, maxRetries: run.maxRetries } }),
    );
  }
  return engines;
}

export function configFromEnv(env: Env = process.env): AppConfig {
  const run = runSettingsFromEnv(env);
  return { engines: enginesFromEnv(env, run), run };
}

export const NO_ENGINES_MESSAGE =
  'No AI engines are configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
  'PERPLEXITY_API_KEY or GEMINI_API_KEY in the MCP server environment, then restart it.';
