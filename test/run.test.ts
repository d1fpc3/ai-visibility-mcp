import { describe, expect, it } from 'vitest';
import { analyzeVisibility, tallyCompetitors } from '../src/analysis.js';
import { parseQuestionList, suggestQuestions, templateQuestions } from '../src/questions.js';
import { AnswerCache, cacheKey, createLimiter, runQuestions } from '../src/run.js';
import { HEADINGS, MockEngine, NOT_NAMED, NUMBERED_BOLD, PLAIN_LIST } from './fixtures.js';

describe('createLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 8 }, () => limit(task)));
    expect(peak).toBe(2);
  });
});

describe('runQuestions', () => {
  it('asks every question on every engine within the concurrency limit', async () => {
    const a = new MockEngine('anthropic', () => NUMBERED_BOLD, 'm', 5);
    const b = new MockEngine('openai', () => NOT_NAMED, 'm', 5);
    const { outcomes, stats } = await runQuestions([a, b], ['q1?', 'q2?', 'q3?'], { concurrency: 2 });
    expect(outcomes).toHaveLength(6);
    expect(stats).toMatchObject({ engineCalls: 6, cacheHits: 0, failures: 0 });
    expect(a.peak + b.peak).toBeLessThanOrEqual(3);
  });

  it('asks a repeated question only once, even with different spacing or case', async () => {
    const engine = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const { outcomes } = await runQuestions([engine], ['Best HVAC?', 'best  hvac?'], { concurrency: 4 });
    expect(engine.calls).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
  });

  it('serves a second run from the shared cache', async () => {
    const engine = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const cache = new AnswerCache(60_000);
    await runQuestions([engine], ['q?'], { concurrency: 1, cache });
    const second = await runQuestions([engine], ['q?'], { concurrency: 1, cache });
    expect(engine.calls).toHaveLength(1);
    expect(second.stats).toMatchObject({ engineCalls: 0, cacheHits: 1 });
    expect(second.outcomes[0]).toMatchObject({ ok: true, cached: true });
  });

  it('keeps going when one engine fails, and does not cache the failure', async () => {
    let fail = true;
    const flaky = new MockEngine('gemini', () => (fail ? new Error('gemini returned HTTP 500') : HEADINGS));
    const good = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const cache = new AnswerCache(60_000);
    const first = await runQuestions([flaky, good], ['q?'], { concurrency: 2, cache });
    expect(first.stats.failures).toBe(1);
    expect(first.outcomes.find((o) => !o.ok)).toMatchObject({
      engine: 'gemini',
      error: 'gemini returned HTTP 500',
    });
    fail = false;
    const second = await runQuestions([flaky], ['q?'], { concurrency: 1, cache });
    expect(second.outcomes[0]?.ok).toBe(true);
  });

  it('expires cache entries after the TTL', async () => {
    let now = 0;
    const cache = new AnswerCache(1000, () => now);
    const engine = new MockEngine('anthropic', () => NUMBERED_BOLD);
    await runQuestions([engine], ['q?'], { concurrency: 1, cache });
    now = 1001;
    await runQuestions([engine], ['q?'], { concurrency: 1, cache });
    expect(engine.calls).toHaveLength(2);
  });

  it('builds cache keys from engine, model and normalized question', () => {
    expect(cacheKey('openai', 'm', '  Best   HVAC? ')).toBe('openai|m|best hvac?');
  });
});

describe('analyzeVisibility', () => {
  it('summarizes per engine and per answer', async () => {
    const claude = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const chatgpt = new MockEngine('openai', () => NOT_NAMED);
    const { outcomes } = await runQuestions([claude, chatgpt], ['q1?', 'q2?'], { concurrency: 4 });
    const report = analyzeVisibility({ name: 'Eco-Cool HVAC' }, outcomes);

    expect(report.overall).toEqual({ answered: 4, namedIn: 2, visibility: 0.5 });
    expect(report.engines).toEqual([
      {
        engine: 'anthropic',
        assistant: 'Claude',
        questions: 2,
        namedIn: 2,
        visibility: 1,
        averagePosition: 1,
      },
      {
        engine: 'openai',
        assistant: 'ChatGPT',
        questions: 2,
        namedIn: 0,
        visibility: 0,
        averagePosition: null,
      },
    ]);
    const miss = report.results.find((r) => r.engine === 'openai');
    expect(miss?.competitors).toEqual([
      'Harford Heating & Air',
      'Chesapeake Climate Control',
      'Bel Air Comfort Pros',
    ]);
  });

  it('lists failed engine calls separately', () => {
    const report = analyzeVisibility({ name: 'X' }, [
      { ok: false, engine: 'gemini', question: 'q?', error: 'boom' },
    ]);
    expect(report.errors).toEqual([{ engine: 'gemini', question: 'q?', error: 'boom' }]);
    expect(report.overall.visibility).toBe(0);
  });
});

describe('tallyCompetitors', () => {
  it('merges spellings and ranks by mentions, then position', async () => {
    const a = new MockEngine('anthropic', () => NUMBERED_BOLD);
    const b = new MockEngine('perplexity', () => PLAIN_LIST);
    const c = new MockEngine('openai', () => HEADINGS);
    const { outcomes } = await runQuestions([a, b, c], ['q?'], { concurrency: 3 });
    const tally = tallyCompetitors(outcomes, { name: 'Eco-Cool HVAC' });

    expect(tally[0]).toMatchObject({ name: 'Harford Heating & Air', mentions: 3, isTarget: false });
    expect(tally[0]?.assistants).toEqual(['ChatGPT', 'Claude', 'Perplexity']);
    expect(tally.find((t) => t.isTarget)).toMatchObject({ name: 'Eco-Cool HVAC LLC', mentions: 1 });
    expect(tally.map((t) => t.name)).not.toContain('Harford Heating and Air');
  });
});

describe('questions', () => {
  it('builds 8 to 12 template questions', () => {
    expect(templateQuestions({ businessType: 'HVAC company', city: 'Bel Air, MD' })).toHaveLength(10);
    expect(templateQuestions({ businessType: 'x', city: 'y', count: 3 })).toHaveLength(8);
    expect(templateQuestions({ businessType: 'x', city: 'y', count: 40 })).toHaveLength(12);
    expect(templateQuestions({ businessType: 'Med Spa', city: 'Boca Raton', service: 'Botox' })[4]).toBe(
      'Who should I call for botox in Boca Raton?',
    );
  });

  it('parses a numbered model reply and drops junk lines', () => {
    const text =
      'Sure! Here you go:\n1. "Who is the best plumber in Towson?"\n2) Who fixes leaks fast in Towson?\n- not a question\n- Who is the best plumber in Towson?';
    expect(parseQuestionList(text)).toEqual([
      'Who is the best plumber in Towson?',
      'Who fixes leaks fast in Towson?',
    ]);
  });

  it('uses the model when it returns enough questions, else falls back to templates', async () => {
    const list = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}. Who is good option number ${i} near me?`,
    ).join('\n');
    const writer = new MockEngine('anthropic', () => list);
    await expect(suggestQuestions({ businessType: 'x', city: 'y' }, writer)).resolves.toMatchObject({
      source: 'model',
      model: 'anthropic-mock',
    });

    const broken = new MockEngine('anthropic', () => new Error('down'));
    const fallback = await suggestQuestions({ businessType: 'HVAC company', city: 'Bel Air' }, broken);
    expect(fallback.source).toBe('templates');
    expect(fallback.questions).toHaveLength(10);
  });
});
