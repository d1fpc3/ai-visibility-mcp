import { type HttpOptions, postJson } from './http.js';
import {
  type AskOptions,
  type EngineAnswer,
  type EngineId,
  type EngineProvider,
  ProviderError,
} from './types.js';

export interface AdapterConfig {
  apiKey: string;
  model: string;
  http: Omit<HttpOptions, 'signal'>;
  maxOutputTokens?: number;
}

/** Ask the question the way a customer would. No system prompt, so the answer matches what users see. */
abstract class BaseAdapter implements EngineProvider {
  abstract readonly id: EngineId;

  constructor(protected readonly config: AdapterConfig) {}

  get model(): string {
    return this.config.model;
  }

  protected abstract request(
    question: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; citations: string[] }>;

  async ask(question: string, options: AskOptions = {}): Promise<EngineAnswer> {
    const started = Date.now();
    const { text, citations } = await this.request(question, options.signal);
    if (!text.trim()) throw new ProviderError(`${this.id} returned an empty answer`, this.id);
    return { engine: this.id, model: this.model, question, text, citations, latencyMs: Date.now() - started };
  }

  protected http(signal?: AbortSignal): HttpOptions {
    return signal ? { ...this.config.http, signal } : this.config.http;
  }

  protected get maxTokens(): number {
    return this.config.maxOutputTokens ?? 1200;
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class AnthropicAdapter extends BaseAdapter {
  readonly id = 'anthropic' as const;

  protected async request(question: string, signal?: AbortSignal) {
    const data = await postJson<AnthropicResponse>(
      this.id,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.model, max_tokens: this.maxTokens, messages: [{ role: 'user', content: question }] },
      this.http(signal),
    );
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return { text, citations: [] };
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  citations?: string[];
  search_results?: Array<{ url?: string }>;
}

export class OpenAIAdapter extends BaseAdapter {
  readonly id = 'openai' as const;

  /** GPT-5 family models spend part of the budget on reasoning, so give them more room by default. */
  protected override get maxTokens(): number {
    return this.config.maxOutputTokens ?? 4000;
  }

  protected async request(question: string, signal?: AbortSignal) {
    const data = await postJson<ChatCompletionResponse>(
      this.id,
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.model,
        max_completion_tokens: this.maxTokens,
        messages: [{ role: 'user', content: question }],
      },
      this.http(signal),
    );
    return { text: data.choices?.[0]?.message?.content ?? '', citations: [] };
  }
}

export class PerplexityAdapter extends BaseAdapter {
  readonly id = 'perplexity' as const;

  protected async request(question: string, signal?: AbortSignal) {
    const data = await postJson<ChatCompletionResponse>(
      this.id,
      'https://api.perplexity.ai/chat/completions',
      { authorization: `Bearer ${this.config.apiKey}` },
      { model: this.model, max_tokens: this.maxTokens, messages: [{ role: 'user', content: question }] },
      this.http(signal),
    );
    const fromResults = (data.search_results ?? []).map((r) => r.url).filter((u): u is string => !!u);
    const citations = [...new Set([...(data.citations ?? []), ...fromResults])];
    return { text: data.choices?.[0]?.message?.content ?? '', citations };
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
  }>;
}

export class GeminiAdapter extends BaseAdapter {
  readonly id = 'gemini' as const;

  protected async request(question: string, signal?: AbortSignal) {
    const data = await postJson<GeminiResponse>(
      this.id,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { 'x-goog-api-key': this.config.apiKey },
      {
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: this.maxTokens },
      },
      this.http(signal),
    );
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const citations = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web?.uri)
      .filter((u): u is string => !!u);
    return { text, citations };
  }
}

export const ADAPTERS: Record<EngineId, new (config: AdapterConfig) => EngineProvider> = {
  anthropic: AnthropicAdapter,
  openai: OpenAIAdapter,
  perplexity: PerplexityAdapter,
  gemini: GeminiAdapter,
};
