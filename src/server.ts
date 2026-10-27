import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { analyzeVisibility, tallyCompetitors, type VisibilityReport } from './analysis.js';
import { type AppConfig, NO_ENGINES_MESSAGE } from './config.js';
import { ENGINE_IDS, ENGINE_LABELS, type EngineId, type EngineProvider } from './providers/types.js';
import { suggestQuestions } from './questions.js';
import { AnswerCache, runQuestions } from './run.js';

export const SERVER_NAME = 'ai-visibility-mcp';
export const SERVER_VERSION = '0.1.0';

const engineList = z.array(z.enum(ENGINE_IDS)).min(1).optional();
const question = z.string().trim().min(3).max(500);

const pct = (value: number) => `${Math.round(value * 100)}%`;

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function pickEngines(all: EngineProvider[], requested: EngineId[] | undefined) {
  if (!requested) return { engines: all, missing: [] as EngineId[] };
  const engines = all.filter((e) => requested.includes(e.id));
  const missing = requested.filter((id) => !all.some((e) => e.id === id));
  return { engines, missing };
}

function missingNote(missing: EngineId[]): string {
  return missing.length
    ? `\nSkipped (no API key set): ${missing.map((id) => ENGINE_LABELS[id]).join(', ')}.`
    : '';
}

function formatReport(report: VisibilityReport): string {
  const lines = [
    `${report.business} was named in ${report.overall.namedIn} of ${report.overall.answered} answers (${pct(report.overall.visibility)}).`,
    '',
    ...report.engines.map(
      (e) =>
        `${e.assistant}: named in ${e.namedIn}/${e.questions}${e.averagePosition ? `, average position ${e.averagePosition}` : ''}`,
    ),
    '',
    'Per answer:',
  ];
  for (const row of report.results) {
    const head = `- [${row.assistant}] "${row.question}"`;
    if (row.named) {
      const rank = row.position ? `#${row.position}` : 'mentioned';
      lines.push(`${head}: NAMED ${rank}${row.evidence ? `. "${row.evidence}"` : ''}`);
    } else {
      const instead = row.competitors.slice(0, 5).join(', ');
      lines.push(`${head}: not named.${instead ? ` Named instead: ${instead}.` : ''}`);
    }
  }
  if (report.errors.length) {
    lines.push('', 'Errors:');
    for (const e of report.errors) lines.push(`- [${ENGINE_LABELS[e.engine]}] "${e.question}": ${e.error}`);
  }
  return lines.join('\n');
}

const visibilityOutput = {
  business: z.string(),
  overall: z.object({ answered: z.number(), namedIn: z.number(), visibility: z.number() }),
  engines: z.array(
    z.object({
      engine: z.enum(ENGINE_IDS),
      assistant: z.string(),
      questions: z.number(),
      namedIn: z.number(),
      visibility: z.number(),
      averagePosition: z.number().nullable(),
    }),
  ),
  results: z.array(
    z.object({
      engine: z.enum(ENGINE_IDS),
      assistant: z.string(),
      question: z.string(),
      named: z.boolean(),
      position: z.number().nullable(),
      matchedAs: z.string().nullable(),
      evidence: z.string().nullable(),
      competitors: z.array(z.string()),
      citations: z.array(z.string()),
    }),
  ),
  errors: z.array(z.object({ engine: z.enum(ENGINE_IDS), question: z.string(), error: z.string() })),
  stats: z.object({
    engineCalls: z.number(),
    cacheHits: z.number(),
    failures: z.number(),
    elapsedMs: z.number(),
  }),
};

const competitorOutput = {
  answered: z.number(),
  competitors: z.array(
    z.object({
      name: z.string(),
      mentions: z.number(),
      assistants: z.array(z.string()),
      averagePosition: z.number(),
      isTarget: z.boolean(),
    }),
  ),
  stats: z.object({
    engineCalls: z.number(),
    cacheHits: z.number(),
    failures: z.number(),
    elapsedMs: z.number(),
  }),
};

export interface ServerOptions {
  /** Shared across tool calls, so check_visibility followed by compare_competitors costs one set of calls. */
  cache?: AnswerCache;
}

export function createServer(config: AppConfig, options: ServerOptions = {}): McpServer {
  const cache = options.cache ?? new AnswerCache(config.run.cacheTtlMs);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Checks whether AI assistants (Claude, ChatGPT, Perplexity, Gemini) recommend a business. ' +
        'Typical flow: suggest_questions, then check_visibility with those questions, then compare_competitors. ' +
        'Each question costs one API call per enabled engine, so keep question lists short.',
    },
  );

  const tooManyQuestions = (count: number) =>
    count > config.run.maxQuestions
      ? fail(
          `That is ${count} questions. The limit is ${config.run.maxQuestions} per call (set AIV_MAX_QUESTIONS to change it). Split the list or trim it.`,
        )
      : null;

  server.registerTool(
    'ask_engines',
    {
      title: 'Ask AI engines',
      description:
        'Ask one customer-style question (for example "best HVAC company in Bel Air MD") to every configured AI engine ' +
        'and return each raw answer plus any cited sources. Use this to read exactly what an assistant tells customers.',
      inputSchema: { question, engines: engineList },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question: q, engines: requested }, extra) => {
      if (config.engines.length === 0) return fail(NO_ENGINES_MESSAGE);
      const { engines, missing } = pickEngines(config.engines, requested);
      if (engines.length === 0)
        return fail(`None of the requested engines are configured.${missingNote(missing)}`);
      const { outcomes } = await runQuestions(engines, [q], {
        concurrency: config.run.concurrency,
        cache,
        signal: extra.signal,
      });
      const text = outcomes
        .map((o) =>
          o.ok
            ? `## ${ENGINE_LABELS[o.answer.engine]} (${o.answer.model})${o.cached ? ' [cached]' : ''}\n\n${o.answer.text}${
                o.answer.citations.length
                  ? `\n\nSources:\n${o.answer.citations.map((c) => `- ${c}`).join('\n')}`
                  : ''
              }`
            : `## ${ENGINE_LABELS[o.engine]}\n\nError: ${o.error}`,
        )
        .join('\n\n');
      return { content: [{ type: 'text', text: text + missingNote(missing) }] };
    },
  );

  server.registerTool(
    'check_visibility',
    {
      title: 'Check AI visibility',
      description:
        'Run customer questions across the configured AI engines and report, per engine and per question, whether the ' +
        'business was named, its position in the list, a short evidence quote and which competitors were named instead. ' +
        'Handles name variants (LLC/Inc, "&" vs "and", spacing, small typos). Pass aliases for nicknames or old names.',
      inputSchema: {
        business: z.string().trim().min(1).max(120).describe('Business name, for example "Eco-Cool HVAC"'),
        domain: z.string().trim().max(200).optional().describe('Website, used as an extra match signal'),
        aliases: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
        questions: z.array(question).min(1).max(50),
        engines: engineList,
      },
      outputSchema: visibilityOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ business, domain, aliases, questions, engines: requested }, extra) => {
      if (config.engines.length === 0) return fail(NO_ENGINES_MESSAGE);
      const limitError = tooManyQuestions(questions.length);
      if (limitError) return limitError;
      const { engines, missing } = pickEngines(config.engines, requested);
      if (engines.length === 0)
        return fail(`None of the requested engines are configured.${missingNote(missing)}`);

      const run = await runQuestions(engines, questions, {
        concurrency: config.run.concurrency,
        cache,
        signal: extra.signal,
      });
      const report = analyzeVisibility({ name: business, domain, aliases }, run.outcomes);
      return {
        content: [{ type: 'text', text: formatReport(report) + missingNote(missing) }],
        structuredContent: { ...report, stats: run.stats },
      };
    },
  );

  server.registerTool(
    'suggest_questions',
    {
      title: 'Suggest customer questions',
      description:
        'Generate 8 to 12 realistic questions a customer might ask an AI assistant when looking for this kind of ' +
        'business in this city. Uses the first configured engine to write them, or a built-in template set if none is set up.',
      inputSchema: {
        businessType: z.string().trim().min(2).max(80).describe('For example "HVAC company" or "med spa"'),
        city: z.string().trim().min(2).max(80).describe('For example "Bel Air, MD"'),
        service: z
          .string()
          .trim()
          .max(80)
          .optional()
          .describe('A service to emphasize, for example "AC repair"'),
        count: z.number().int().min(8).max(12).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const result = await suggestQuestions(input, config.engines[0]);
      const by = result.source === 'model' ? `written by ${result.model}` : 'from built-in templates';
      return {
        content: [
          {
            type: 'text',
            text: `${result.questions.length} questions (${by}):\n${result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
          },
        ],
        structuredContent: { questions: result.questions, source: result.source },
      };
    },
  );

  server.registerTool(
    'compare_competitors',
    {
      title: 'Compare competitors',
      description:
        'Run customer questions across the configured AI engines and rank which businesses get named most, with how ' +
        'often, by which assistants and at what average position. Pass the business name to flag it in the ranking.',
      inputSchema: {
        questions: z.array(question).min(1).max(50),
        business: z.string().trim().min(1).max(120).optional(),
        aliases: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
        engines: engineList,
        top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many businesses to return (default 15)'),
      },
      outputSchema: competitorOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ questions, business, aliases, engines: requested, top }, extra) => {
      if (config.engines.length === 0) return fail(NO_ENGINES_MESSAGE);
      const limitError = tooManyQuestions(questions.length);
      if (limitError) return limitError;
      const { engines, missing } = pickEngines(config.engines, requested);
      if (engines.length === 0)
        return fail(`None of the requested engines are configured.${missingNote(missing)}`);

      const run = await runQuestions(engines, questions, {
        concurrency: config.run.concurrency,
        cache,
        signal: extra.signal,
      });
      const target = business ? { name: business, aliases } : undefined;
      const competitors = tallyCompetitors(run.outcomes, target).slice(0, top ?? 15);
      const answered = run.outcomes.filter((o) => o.ok).length;
      const lines = [
        `Most-named businesses across ${answered} answers:`,
        ...competitors.map(
          (c, i) =>
            `${i + 1}. ${c.name}${c.isTarget ? ' (you)' : ''}: ${c.mentions} mentions, avg position ${c.averagePosition}, by ${c.assistants.join(', ')}`,
        ),
      ];
      if (competitors.length === 0) lines.push('No business names could be found in the answers.');
      if (run.stats.failures)
        lines.push('', `${run.stats.failures} engine call(s) failed and were left out.`);
      return {
        content: [{ type: 'text', text: lines.join('\n') + missingNote(missing) }],
        structuredContent: { answered, competitors, stats: run.stats },
      };
    },
  );

  server.registerPrompt(
    'visibility_report',
    {
      title: 'AI visibility report',
      description: 'Walk through a full AI visibility audit for one business and write it up.',
      argsSchema: {
        business: z.string().describe('Business name'),
        businessType: z.string().describe('For example "HVAC company"'),
        city: z.string().describe('For example "Bel Air, MD"'),
        domain: z.string().optional().describe('Website, optional'),
      },
    },
    ({ business, businessType, city, domain }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Audit how AI assistants talk about ${business}, a ${businessType} in ${city}${domain ? ` (${domain})` : ''}.`,
              '1. Call suggest_questions for this business type and city.',
              '2. Call check_visibility with those questions.',
              '3. Call compare_competitors with the same questions and the business name.',
              'Then write a short report: overall visibility, how each assistant differs, the 3 competitors named most,',
              'quotes that show why they win, and 5 concrete fixes (pages, reviews, listings, content) ranked by impact.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerResource(
    'engines',
    'ai-visibility://engines',
    {
      title: 'Configured engines',
      description:
        'Which AI engines this server can query, the model each uses, and the run limits. Never includes keys.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              engines: config.engines.map((e) => ({
                id: e.id,
                assistant: ENGINE_LABELS[e.id],
                model: e.model,
              })),
              notConfigured: ENGINE_IDS.filter((id) => !config.engines.some((e) => e.id === id)),
              limits: config.run,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
