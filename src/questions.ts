import type { EngineProvider } from './providers/types.js';

export interface QuestionInput {
  businessType: string;
  city: string;
  /** Optional service the business wants to be known for, like "AC repair". */
  service?: string | undefined;
  count?: number | undefined;
}

/** The shapes real customers use when they ask an assistant for a local recommendation. */
type Template = (parts: { type: string; city: string; service: string }) => string;

const TEMPLATES: Template[] = [
  ({ type, city }) => `Who is the best ${type} in ${city}?`,
  ({ type, city }) => `What are the top rated ${type} companies in ${city}?`,
  ({ type, city }) => `Can you recommend a reliable ${type} near ${city}?`,
  ({ type, city }) => `Which ${type} in ${city} has the best reviews?`,
  ({ city, service }) => `Who should I call for ${service} in ${city}?`,
  ({ type, city }) => `I just moved to ${city}. Which ${type} do locals trust?`,
  ({ type, city }) => `What is the most affordable ${type} in ${city} that still does good work?`,
  ({ type, city, service }) => `Is there a ${type} in ${city} that offers same-day ${service}?`,
  ({ type, city }) => `Which ${type} near ${city} is family owned?`,
  ({ type, city }) => `List 5 ${type} businesses in ${city} and what each one is known for.`,
  ({ city, service }) => `Who does the best ${service} in ${city}?`,
  ({ type, city }) => `What ${type} in ${city} would you recommend for a first-time customer?`,
];

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampCount(count: number | undefined): number {
  return Math.min(12, Math.max(8, count ?? 10));
}

/** Deterministic question set, used when no engine is configured or the model's list can't be parsed. */
export function templateQuestions(input: QuestionInput): string[] {
  const type = clean(input.businessType).toLowerCase();
  const city = clean(input.city);
  const service = clean(input.service ?? type).toLowerCase();
  const count = clampCount(input.count);
  return TEMPLATES.slice(0, count).map((build) => build({ type, city, service }));
}

/** Pull one question per line out of a model reply, dropping numbering, bullets and quotes. */
export function parseQuestionList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const question = line
      .replace(/^\s*(?:\d{1,2}[.)]|[-*\u2022])\s*/, '')
      .replace(/^["'\u201C]|["'\u201D]$/g, '')
      .trim();
    if (question.length < 12 || question.length > 200 || !question.endsWith('?')) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(question);
  }
  return out;
}

export function questionPrompt(input: QuestionInput, count: number): string {
  const service = input.service
    ? ` The business especially wants to be found for "${clean(input.service)}".`
    : '';
  return [
    `Write ${count} different questions a real customer might type into ChatGPT or Claude when looking for a`,
    `${clean(input.businessType)} in ${clean(input.city)}.${service}`,
    'Mix "best" questions, price, urgency, trust and specific-service questions.',
    'Write them the way people actually type, not like an SEO keyword.',
    'Do not name any business. Return only the questions, one per line, each ending with a question mark.',
  ].join(' ');
}

export async function suggestQuestions(
  input: QuestionInput,
  writer: EngineProvider | undefined,
): Promise<{ questions: string[]; source: 'model' | 'templates'; model?: string }> {
  const count = clampCount(input.count);
  if (writer) {
    try {
      const answer = await writer.ask(questionPrompt(input, count));
      const questions = parseQuestionList(answer.text).slice(0, count);
      if (questions.length >= Math.min(8, count)) return { questions, source: 'model', model: writer.model };
    } catch {
      // Fall through to templates. A question list is never worth failing the tool call over.
    }
  }
  return { questions: templateQuestions(input), source: 'templates' };
}
