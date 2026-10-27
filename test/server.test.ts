import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { runSettingsFromEnv } from '../src/config.js';
import type { EngineProvider } from '../src/providers/types.js';
import { createServer } from '../src/server.js';
import { MockEngine, NOT_NAMED, NUMBERED_BOLD, PLAIN_LIST } from './fixtures.js';

async function connect(engines: EngineProvider[], env: Record<string, string> = {}) {
  const server = createServer({ engines, run: runSettingsFromEnv(env) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const textOf = (result: unknown) =>
  ((result as { content?: Array<{ type: string; text: string }> }).content ?? [])
    .map((c) => c.text)
    .join('\n');

const firstText = (messages: Array<{ content: unknown }>) =>
  (messages[0]?.content as { text?: string } | undefined)?.text ?? '';

describe('MCP server', () => {
  it('lists the four tools with input schemas and read-only hints', async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_engines',
      'check_visibility',
      'compare_competitors',
      'suggest_questions',
    ]);
    const check = tools.find((t) => t.name === 'check_visibility');
    expect(check?.inputSchema.required).toEqual(expect.arrayContaining(['business', 'questions']));
    expect(check?.outputSchema).toBeDefined();
    expect(check?.annotations?.readOnlyHint).toBe(true);
  });

  it('check_visibility reports per engine with structured output', async () => {
    const claude = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const chatgpt = new MockEngine('openai', () => NOT_NAMED);
    const { client } = await connect([claude, chatgpt]);

    const result = await client.callTool({
      name: 'check_visibility',
      arguments: {
        business: 'Eco Cool HVAC',
        domain: 'ecocoolhvac.com',
        questions: ['Who is the best HVAC company in Bel Air, MD?', 'Best AC repair in Bel Air?'],
      },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('Eco Cool HVAC was named in 2 of 4 answers (50%).');
    expect(text).toContain('Claude: named in 2/2, average position 1');
    expect(text).toContain('Named instead: Harford Heating & Air');
    const data = result.structuredContent as {
      overall: { visibility: number };
      results: Array<{ engine: string; named: boolean; position: number | null }>;
      stats: { engineCalls: number };
    };
    expect(data.overall.visibility).toBe(0.5);
    expect(
      data.results.filter((r) => r.engine === 'anthropic').every((r) => r.named && r.position === 1),
    ).toBe(true);
    expect(data.stats.engineCalls).toBe(4);
  });

  it('reuses answers across tool calls through the shared cache', async () => {
    const claude = new MockEngine('anthropic', () => PLAIN_LIST);
    const { client } = await connect([claude]);
    const questions = ['Who is the best HVAC company in Bel Air?'];
    await client.callTool({ name: 'check_visibility', arguments: { business: 'Eco-Cool', questions } });
    const result = await client.callTool({
      name: 'compare_competitors',
      arguments: { questions, business: 'Harford Heating & Air' },
    });
    expect(claude.calls).toHaveLength(1);
    expect(textOf(result)).toContain('1. Harford Heating and Air (you): 1 mentions');
    expect((result.structuredContent as { stats: { cacheHits: number } }).stats.cacheHits).toBe(1);
  });

  it('only queries the engines asked for, and says which were skipped', async () => {
    const claude = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const chatgpt = new MockEngine('openai', () => NOT_NAMED);
    const { client } = await connect([claude, chatgpt]);
    const result = await client.callTool({
      name: 'ask_engines',
      arguments: { question: 'Best HVAC in Bel Air?', engines: ['openai', 'gemini'] },
    });
    expect(claude.calls).toHaveLength(0);
    expect(chatgpt.calls).toHaveLength(1);
    expect(textOf(result)).toContain('## ChatGPT (openai-mock)');
    expect(textOf(result)).toContain('Skipped (no API key set): Gemini.');
  });

  it('returns a clear error when no engines are configured', async () => {
    const { client } = await connect([]);
    const result = await client.callTool({
      name: 'check_visibility',
      arguments: { business: 'X', questions: ['Who is best?'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No AI engines are configured');
  });

  it('enforces the per-call question limit', async () => {
    const { client } = await connect([new MockEngine('anthropic', () => NUMBERED_BOLD)], {
      AIV_MAX_QUESTIONS: '2',
    });
    const result = await client.callTool({
      name: 'compare_competitors',
      arguments: { questions: ['a b c?', 'd e f?', 'g h i?'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The limit is 2 per call');
  });

  it('rejects bad input through the schema', async () => {
    const { client } = await connect([new MockEngine('anthropic', () => NUMBERED_BOLD)]);
    const result = await client.callTool({
      name: 'check_visibility',
      arguments: { business: 'X', questions: [] },
    });
    expect(result.isError).toBe(true);
  });

  it('suggest_questions works with no engines, from templates', async () => {
    const { client } = await connect([]);
    const result = await client.callTool({
      name: 'suggest_questions',
      arguments: { businessType: 'HVAC company', city: 'Bel Air, MD' },
    });
    expect(textOf(result)).toContain('10 questions (from built-in templates)');
    expect(textOf(result)).toContain('1. Who is the best hvac company in Bel Air, MD?');
  });

  it('serves the visibility_report prompt and the engines resource', async () => {
    const { client } = await connect([new MockEngine('anthropic', () => NUMBERED_BOLD, 'claude-haiku-5-5')]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['visibility_report']);
    const prompt = await client.getPrompt({
      name: 'visibility_report',
      arguments: { business: 'Eco-Cool HVAC', businessType: 'HVAC company', city: 'Bel Air, MD' },
    });
    expect(firstText(prompt.messages)).toContain('Call suggest_questions');

    const resource = await client.readResource({ uri: 'ai-visibility://engines' });
    const body = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(body.engines).toEqual([{ id: 'anthropic', assistant: 'Claude', model: 'claude-haiku-5-5' }]);
    expect(body.notConfigured).toEqual(['openai', 'perplexity', 'gemini']);
    expect(JSON.stringify(body)).not.toMatch(/key/i);
  });
});
