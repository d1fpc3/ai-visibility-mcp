export const ENGINE_IDS = ['anthropic', 'openai', 'perplexity', 'gemini'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** Human-friendly names for the assistants each engine powers. */
export const ENGINE_LABELS: Record<EngineId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
};

export interface EngineAnswer {
  engine: EngineId;
  model: string;
  question: string;
  text: string;
  /** Source URLs the engine cited, when it returns them (Perplexity does). */
  citations: string[];
  latencyMs: number;
}

export interface AskOptions {
  signal?: AbortSignal;
}

/** One AI engine. Every adapter turns a plain question into the answer a user would read. */
export interface EngineProvider {
  readonly id: EngineId;
  readonly model: string;
  ask(question: string, options?: AskOptions): Promise<EngineAnswer>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly engine: EngineId,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
