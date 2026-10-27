import { describe, expect, it, vi } from 'vitest';
import { configFromEnv, enginesFromEnv, runSettingsFromEnv } from '../src/config.js';
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAIAdapter,
  PerplexityAdapter,
} from '../src/providers/adapters.js';
import { backoffDelay, postJson } from '../src/providers/http.js';
import { ProviderError } from '../src/providers/types.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fast = { timeoutMs: 1000, maxRetries: 2, baseDelayMs: 0 };

describe('postJson', () => {
  it('retries rate limits and server errors, then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(429, { error: 'slow down' }))
      .mockResolvedValueOnce(json(503, { error: 'busy' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(postJson('openai', 'https://x.test', {}, {}, { ...fast, fetchImpl })).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails fast on client errors like a bad key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(401, { error: 'bad key' }));
    const error = (await postJson('anthropic', 'https://x.test', {}, {}, { ...fast, fetchImpl }).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries with the last error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(500, {}));
    await expect(postJson('gemini', 'https://x.test', {}, {}, { ...fast, fetchImpl })).rejects.toThrow(
      'HTTP 500',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries network failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(postJson('perplexity', 'https://x.test', {}, {}, { ...fast, fetchImpl })).resolves.toEqual({
      ok: 1,
    });
  });

  it('times out a hung request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(
      postJson(
        'openai',
        'https://x.test',
        {},
        {},
        { timeoutMs: 20, maxRetries: 0, baseDelayMs: 0, fetchImpl },
      ),
    ).rejects.toThrow('timed out after 20 ms');
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      postJson('openai', 'https://x.test', {}, {}, { ...fast, fetchImpl, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors Retry-After and caps exponential backoff', () => {
    expect(backoffDelay(0, 500, '2')).toBe(2000);
    expect(backoffDelay(5, 500, '999')).toBe(30_000);
    for (let i = 0; i < 20; i++) expect(backoffDelay(3, 100)).toBeLessThanOrEqual(800);
  });
});

function captureFetch(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return json(200, body);
  });
  const headersOf = (index: number) => (calls[index]?.init.headers ?? {}) as Record<string, string>;
  return { calls, fetchImpl, headersOf };
}

const http = (fetchImpl: typeof fetch) => ({ timeoutMs: 1000, maxRetries: 0, fetchImpl });

describe('adapters', () => {
  it('Anthropic sends the messages API shape and joins text blocks', async () => {
    const { calls, fetchImpl, headersOf } = captureFetch({
      content: [{ type: 'text', text: 'Try Eco-Cool.' }],
    });
    const answer = await new AnthropicAdapter({
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      http: http(fetchImpl),
    }).ask('best hvac?');
    expect(answer).toMatchObject({ engine: 'anthropic', model: 'claude-haiku-5-5', text: 'Try Eco-Cool.' });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headersOf(0)['x-api-key']).toBe('k');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'best hvac?' }],
    });
  });

  it('OpenAI reads the first choice', async () => {
    const { calls, fetchImpl, headersOf } = captureFetch({
      choices: [{ message: { content: 'Harford Heating.' } }],
    });
    const answer = await new OpenAIAdapter({ apiKey: 'k', model: 'gpt-5-mini', http: http(fetchImpl) }).ask(
      'q?',
    );
    expect(answer.text).toBe('Harford Heating.');
    expect(headersOf(0).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0]?.init.body)).max_completion_tokens).toBe(4000);
  });

  it('Perplexity returns its citations, deduplicated', async () => {
    const { fetchImpl } = captureFetch({
      choices: [{ message: { content: 'See these.' } }],
      citations: ['https://a.test'],
      search_results: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
    });
    const answer = await new PerplexityAdapter({ apiKey: 'k', model: 'sonar', http: http(fetchImpl) }).ask(
      'q?',
    );
    expect(answer.citations).toEqual(['https://a.test', 'https://b.test']);
  });

  it('Gemini joins parts and reads grounding sources', async () => {
    const { calls, fetchImpl, headersOf } = captureFetch({
      candidates: [
        {
          content: { parts: [{ text: 'Part one. ' }, { text: 'Part two.' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://g.test' } }] },
        },
      ],
    });
    const answer = await new GeminiAdapter({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      http: http(fetchImpl),
    }).ask('q?');
    expect(answer.text).toBe('Part one. Part two.');
    expect(answer.citations).toEqual(['https://g.test']);
    expect(calls[0]?.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(headersOf(0)['x-goog-api-key']).toBe('k');
  });

  it('treats an empty answer as an error', async () => {
    const { fetchImpl } = captureFetch({ choices: [{ message: { content: '  ' } }] });
    await expect(
      new OpenAIAdapter({ apiKey: 'k', model: 'm', http: http(fetchImpl) }).ask('q?'),
    ).rejects.toThrow('empty answer');
  });
});

describe('config', () => {
  it('enables only engines with keys and honors model overrides', () => {
    const engines = enginesFromEnv({
      ANTHROPIC_API_KEY: 'a',
      GOOGLE_API_KEY: 'g',
      AIV_GEMINI_MODEL: 'gemini-x',
    });
    expect(engines.map((e) => [e.id, e.model])).toEqual([
      ['anthropic', 'claude-haiku-5-5'],
      ['gemini', 'gemini-x'],
    ]);
  });

  it('has no engines when no keys are set', () => {
    expect(configFromEnv({}).engines).toEqual([]);
  });

  it('parses limits and rejects bad values', () => {
    expect(runSettingsFromEnv({ AIV_CONCURRENCY: '2', AIV_CACHE_TTL_SECONDS: '0' })).toMatchObject({
      concurrency: 2,
      cacheTtlMs: 0,
      maxQuestions: 12,
    });
    expect(() => runSettingsFromEnv({ AIV_CONCURRENCY: 'lots' })).toThrow('AIV_CONCURRENCY');
    expect(() => runSettingsFromEnv({ AIV_MAX_QUESTIONS: '500' })).toThrow('1 to 50');
  });
});
