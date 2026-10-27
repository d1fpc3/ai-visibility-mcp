import {
  type BusinessTarget,
  competitorsIn,
  extractBusinesses,
  findMention,
  matchesTarget,
  namesMatch,
  normalizeName,
} from './matching.js';
import { ENGINE_LABELS, type EngineId } from './providers/types.js';
import type { EngineOutcome } from './run.js';

export interface VisibilityRow {
  engine: EngineId;
  assistant: string;
  question: string;
  named: boolean;
  position: number | null;
  matchedAs: string | null;
  evidence: string | null;
  competitors: string[];
  citations: string[];
}

export interface EngineSummary {
  engine: EngineId;
  assistant: string;
  questions: number;
  namedIn: number;
  /** Share of answered questions where the business was named, 0 to 1. */
  visibility: number;
  averagePosition: number | null;
}

export interface VisibilityReport {
  business: string;
  overall: { answered: number; namedIn: number; visibility: number };
  engines: EngineSummary[];
  results: VisibilityRow[];
  errors: Array<{ engine: EngineId; question: string; error: string }>;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

export function analyzeVisibility(target: BusinessTarget, outcomes: EngineOutcome[]): VisibilityReport {
  const results: VisibilityRow[] = [];
  const errors: VisibilityReport['errors'] = [];

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      errors.push({ engine: outcome.engine, question: outcome.question, error: outcome.error });
      continue;
    }
    const { answer } = outcome;
    const businesses = extractBusinesses(answer.text);
    const mention = findMention(answer.text, target, businesses);
    results.push({
      engine: answer.engine,
      assistant: ENGINE_LABELS[answer.engine],
      question: answer.question,
      named: mention.named,
      position: mention.position,
      matchedAs: mention.matchedAs,
      evidence: mention.quote,
      competitors: competitorsIn(businesses, target).slice(0, 10),
      citations: answer.citations.slice(0, 10),
    });
  }

  const engineIds = [...new Set(results.map((r) => r.engine))];
  const engines = engineIds.map((engine): EngineSummary => {
    const rows = results.filter((r) => r.engine === engine);
    const named = rows.filter((r) => r.named);
    const positions = named.map((r) => r.position).filter((p): p is number => p !== null);
    return {
      engine,
      assistant: ENGINE_LABELS[engine],
      questions: rows.length,
      namedIn: named.length,
      visibility: rows.length ? round(named.length / rows.length) : 0,
      averagePosition: positions.length
        ? round(positions.reduce((a, b) => a + b, 0) / positions.length, 1)
        : null,
    };
  });

  const namedIn = results.filter((r) => r.named).length;
  return {
    business: target.name,
    overall: {
      answered: results.length,
      namedIn,
      visibility: results.length ? round(namedIn / results.length) : 0,
    },
    engines,
    results,
    errors,
  };
}

export interface CompetitorTally {
  name: string;
  mentions: number;
  /** Which assistants named it at least once. */
  assistants: string[];
  averagePosition: number;
  isTarget: boolean;
}

/**
 * Count which businesses the engines name most across a set of answers.
 * Different spellings of one business ("Eco-Cool HVAC", "EcoCool") are merged under the first spelling seen.
 */
export function tallyCompetitors(outcomes: EngineOutcome[], target?: BusinessTarget): CompetitorTally[] {
  const tallies = new Map<
    string,
    { name: string; mentions: number; assistants: Set<string>; positions: number[] }
  >();
  const keys: Array<{ key: string; name: string }> = [];

  const keyFor = (name: string): string => {
    const existing = keys.find((k) => k.key === normalizeName(name) || namesMatch(k.name, name));
    if (existing) return existing.key;
    const key = normalizeName(name);
    keys.push({ key, name });
    return key;
  };

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const businesses = extractBusinesses(outcome.answer.text);
    businesses.forEach((name, index) => {
      const key = keyFor(name);
      const tally = tallies.get(key) ?? { name, mentions: 0, assistants: new Set<string>(), positions: [] };
      tally.mentions++;
      tally.assistants.add(ENGINE_LABELS[outcome.answer.engine]);
      tally.positions.push(index + 1);
      tallies.set(key, tally);
    });
  }

  return [...tallies.values()]
    .map((t) => ({
      name: t.name,
      mentions: t.mentions,
      assistants: [...t.assistants].sort(),
      averagePosition: round(t.positions.reduce((a, b) => a + b, 0) / t.positions.length, 1),
      isTarget: target ? matchesTarget(t.name, target) : false,
    }))
    .sort(
      (a, b) =>
        b.mentions - a.mentions || a.averagePosition - b.averagePosition || a.name.localeCompare(b.name),
    );
}
