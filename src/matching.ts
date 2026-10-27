/**
 * Entity matching: did an AI answer name this business, and who else did it name?
 *
 * AI answers write the same business many ways ("Eco-Cool HVAC LLC", "EcoCool", "Eco Cool Heating & Air"),
 * so everything here compares normalized token sets with small typo tolerance instead of raw strings.
 */

export interface BusinessTarget {
  name: string;
  domain?: string | undefined;
  aliases?: string[] | undefined;
}

export interface Mention {
  named: boolean;
  /** 1-based rank among the businesses the answer listed, or null if it was only mentioned in passing (or not at all). */
  position: number | null;
  /** The exact name the answer used for the business. */
  matchedAs: string | null;
  /** Short excerpt from the answer around the first mention. */
  quote: string | null;
}

const CORPORATE_SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'co',
  'corp',
  'corporation',
  'company',
  'ltd',
  'limited',
  'pllc',
  'pc',
  'lp',
  'llp',
]);

/** Words that describe a trade, not a business. A name made only of these can't identify anyone. */
const GENERIC_TOKENS = new Set([
  'and',
  'of',
  'the',
  'a',
  'heating',
  'cooling',
  'air',
  'conditioning',
  'hvac',
  'plumbing',
  'plumber',
  'plumbers',
  'electric',
  'electrical',
  'electrician',
  'roofing',
  'roofers',
  'landscaping',
  'lawn',
  'care',
  'auto',
  'detailing',
  'cleaning',
  'services',
  'service',
  'solutions',
  'group',
  'home',
  'homes',
  'pros',
  'pro',
  'experts',
  'repair',
  'repairs',
  'mechanical',
  'contractors',
  'contracting',
  'dental',
  'dentistry',
  'spa',
  'med',
  'medical',
  'clinic',
  'studio',
  'local',
  'best',
  'top',
]);

/** Leading words that mark a line as advice or a heading, not a business name. */
const NOT_A_NAME_PREFIX =
  /^(here|what|why|how|when|where|who|which|tips?|notes?|consider|look|check|ask|final|bottom line|summary|conclusion|key|factors?|pros|cons|cost|costs|pricing|prices?|reviews?|google rating|services|location|address|phone|website|contact|hours|best (?:for|overall|value|budget|rated|choice|pick)|specialt(?:y|ies)|rating|ratings|overall|also|other|honorable|more|things|questions?|steps?|options?|recommendations?|in summary|disclaimer|sources?|citations?|notable|highlights|certifications?|warranty|availability|service areas?|years|if you|you can|for|to|get|read|compare|choosing|choose|verify|request|licensed|insured)\b/i;

/** Words that turn a phrase into a heading ("Top HVAC Companies in Bel Air"), not a name. */
const HEADING_TOKENS = new Set([
  'companies',
  'businesses',
  'options',
  'picks',
  'choices',
  'providers',
  'recommendations',
  'overview',
  'considerations',
  'faq',
  'faqs',
]);

/** "Best Overall: Eco-Cool HVAC" style labels. The name is what follows the colon. */
const PICK_LABEL =
  /^(?:best [a-z ]{2,20}|top pick|our pick|runner[- ]up|budget pick|editors?'?s? choice)\s*:\s*(.+)$/i;

const SMALL_WORDS = new Set(['and', 'of', 'the', 'a', 'an', 'at', 'in', 'on', 'for', 'by', '&', 'to']);

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
}

/** Lowercase, unify "&"/"and", drop punctuation, a leading "the" and trailing legal suffixes. */
export function normalizeName(value: string): string {
  const tokens = stripDiacritics(value)
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  return tokens.join(' ');
}

export function nameTokens(value: string): string[] {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(' ') : [];
}

/** Classic edit distance, with an early exit once it passes `max`. */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/** Two tokens match if equal, singular/plural of each other, or one typo apart (for words of 5+ letters). */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (`${a}s` === b || `${b}s` === a) return true;
  if (a.length >= 5 && b.length >= 5) return levenshtein(a, b, 1) <= 1;
  return false;
}

function containsAll(haystack: string[], needles: string[]): boolean {
  return needles.every((n) => haystack.some((h) => tokensMatch(h, n)));
}

function isDistinctive(tokens: string[]): boolean {
  return tokens.some((t) => !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t));
}

/** Token-level Dice coefficient with typo-tolerant token equality. */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const used = new Set<number>();
  let shared = 0;
  for (const token of a) {
    const index = b.findIndex((other, i) => !used.has(i) && tokensMatch(token, other));
    if (index >= 0) {
      used.add(index);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Does `candidate` (a name pulled from an answer) refer to the same business as `name`? */
export function namesMatch(candidate: string, name: string): boolean {
  const c = nameTokens(candidate);
  const t = nameTokens(name);
  if (c.length === 0 || t.length === 0) return false;

  const cJoined = c.join('');
  const tJoined = t.join('');
  if (cJoined === tJoined) return true;
  if (cJoined.length >= 6 && tJoined.length >= 6 && levenshtein(cJoined, tJoined, 1) <= 1) return true;

  // "Eco-Cool" vs "Eco Cool Heating & Air": every word of the shorter name appears in the longer one.
  // The shorter name must carry a distinctive word, or "Heating and Cooling" would match everyone.
  const [shorter, longer] = c.length <= t.length ? [c, t] : [t, c];
  if (isDistinctive(shorter) && containsAll(longer, shorter) && longer.length - shorter.length <= 3)
    return true;

  // "EcoCool" vs "Eco Cool HVAC": compare the squashed spelling against each prefix of the longer name.
  for (let i = 1; i <= longer.length; i++) {
    const prefix = longer.slice(0, i).join('');
    if (prefix.length >= 5 && prefix === shorter.join('') && isDistinctive(longer.slice(0, i))) return true;
  }

  // "EcoCool Heating" vs "Eco-Cool HVAC": same brand words, trade words that mean the same trade.
  const cCore = c.filter((x) => !GENERIC_TOKENS.has(x)).join('');
  const tCore = t.filter((x) => !GENERIC_TOKENS.has(x)).join('');
  if (cCore.length >= 4 && cCore === tCore && tradesCompatible(c, t)) return true;

  return isDistinctive(c) && isDistinctive(t) && tokenSimilarity(c, t) >= 0.8;
}

/** Trade words grouped by trade, so "heating" and "HVAC" agree but "plumbing" and "HVAC" do not. */
const TRADE_GROUPS: Record<string, string> = {
  heating: 'hvac',
  cooling: 'hvac',
  air: 'hvac',
  conditioning: 'hvac',
  hvac: 'hvac',
  mechanical: 'hvac',
  plumbing: 'plumbing',
  plumber: 'plumbing',
  plumbers: 'plumbing',
  electric: 'electric',
  electrical: 'electric',
  electrician: 'electric',
  roofing: 'roofing',
  roofers: 'roofing',
  landscaping: 'lawn',
  lawn: 'lawn',
  auto: 'auto',
  detailing: 'auto',
  cleaning: 'cleaning',
  dental: 'dental',
  dentistry: 'dental',
  spa: 'med',
  med: 'med',
  medical: 'med',
};

function tradesCompatible(a: string[], b: string[]): boolean {
  const groups = (tokens: string[]) => new Set(tokens.map((t) => TRADE_GROUPS[t]).filter(Boolean));
  const ga = groups(a);
  const gb = groups(b);
  if (ga.size === 0 || gb.size === 0) return true;
  return [...ga].some((g) => gb.has(g));
}

export function targetNames(target: BusinessTarget): string[] {
  return [target.name, ...(target.aliases ?? [])].filter((n) => n.trim().length > 0);
}

export function matchesTarget(candidate: string, target: BusinessTarget): boolean {
  if (targetNames(target).some((name) => namesMatch(candidate, name))) return true;
  const host = normalizeDomain(target.domain);
  return !!host && candidate.toLowerCase().includes(host);
}

export function normalizeDomain(domain: string | undefined): string | null {
  if (!domain) return null;
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return host?.includes('.') ? host : null;
}

/** Remove markdown links, emphasis, code ticks and citation markers like [1]. */
export function stripMarkdown(value: string): string {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*])\*(?!\s)([^*]+)\*/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*\u2022\u25AA]|#{1,6})\s+(.+)$/;
const BOLD = /\*\*([^*\n]{2,90})\*\*|__([^_\n]{2,90})__/g;
/** Where a business name ends inside a list line: a dash, colon, pipe, bracket, comma or a verb clause. */
const NAME_END =
  /\s[-\u2013\u2014|]\s|:|\s\(|,|\.\s|\s(?:is|are|has|offers|provides|specializes|stands|was|known|serves|serving)\s/i;

/** The name at the start of a list line, cut at the first dash, colon, bracket or verb. */
function firstName(line: string): string {
  const end = NAME_END.exec(line);
  return end ? line.slice(0, end.index) : line;
}

function cleanCandidate(raw: string): string {
  return stripMarkdown(raw)
    .replace(/^[\s"'\u201C\u2018]+|[\s"'\u201D\u2019.:;,!]+$/g, '')
    .replace(/\s*\((?:[^)]*)\)\s*$/, '')
    .trim();
}

function looksLikeBusinessName(name: string): boolean {
  if (name.length < 2 || name.length > 80 || /[?]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 8) return false;
  if (NOT_A_NAME_PREFIX.test(name)) return false;
  if (nameTokens(name).some((t) => HEADING_TOKENS.has(t))) return false;
  if (!/^[A-Z0-9\u00C0-\u024F]/.test(name)) return false;
  const significant = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  if (significant.length === 0) return false;
  const capitalized = significant.filter((w) => /^[A-Z0-9\u00C0-\u024F]/.test(w));
  if (capitalized.length / significant.length < 0.6) return false;
  return nameTokens(name).length > 0;
}

/**
 * Pull the businesses an answer recommends, in the order it lists them.
 * Reads numbered and bulleted list items, headings and bold names, then drops advice lines and duplicates.
 */
export function extractBusinesses(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const name = cleanCandidate(raw);
    if (!looksLikeBusinessName(name)) return;
    if (found.some((existing) => namesMatch(existing, name))) return;
    found.push(name);
  };

  for (const line of text.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    if (item?.[1]) {
      const indented = /^\s{2,}/.test(line);
      // "### 1. Eco-Cool HVAC" is a heading with its own number inside it.
      const content = item[1].trim().replace(/^\d{1,2}[.)]\s+/, '');
      const leadingBold = /^(?:\*\*|__)(.+?)(?:\*\*|__)(\s*:)?/.exec(content);
      if (leadingBold?.[1]) {
        const isLabel = leadingBold[1].trim().endsWith(':') || !!leadingBold[2];
        // Indented "**Phone:** ..." lines describe the business above them. They are not new businesses.
        if (isLabel && indented) continue;
        const label = PICK_LABEL.exec(stripMarkdown(content));
        add(label?.[1] ? firstName(label[1]) : leadingBold[1]);
        continue;
      }
      if (indented) continue;
      const plain = stripMarkdown(content);
      const label = PICK_LABEL.exec(plain);
      add(firstName(label?.[1] ?? plain));
      continue;
    }
    for (const match of line.matchAll(BOLD)) add(match[1] ?? match[2] ?? '');
  }
  return found;
}

function splitSentences(text: string): string[] {
  return text
    .split(/\r?\n+|(?<=[.!?])\s+(?=[A-Z0-9*"\u201C])/)
    .map((s) => stripMarkdown(s))
    .filter((s) => s.length > 0);
}

function trimQuote(sentence: string, maxLength = 220): string {
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Does any run of words in `sentence` match the target? Catches passing mentions outside a list. */
function sentenceMentions(sentence: string, target: BusinessTarget): string | null {
  const host = normalizeDomain(target.domain);
  if (host && sentence.toLowerCase().includes(host)) return host;
  const words = sentence.split(/\s+/).filter(Boolean);
  for (const name of targetNames(target)) {
    const size = Math.max(1, name.split(/\s+/).length);
    for (const width of [size, size + 1, size - 1, size + 2]) {
      if (width < 1) continue;
      for (let i = 0; i + width <= words.length; i++) {
        const window = words.slice(i, i + width).join(' ');
        if (namesMatch(window, name)) return cleanCandidate(window);
      }
    }
  }
  return null;
}

export function findMention(
  text: string,
  target: BusinessTarget,
  businesses = extractBusinesses(text),
): Mention {
  const index = businesses.findIndex((b) => matchesTarget(b, target));
  for (const sentence of splitSentences(text)) {
    const matched =
      index >= 0 && namesMatchSentence(sentence, businesses[index] ?? '') ? businesses[index] : null;
    const passing = matched ?? sentenceMentions(sentence, target);
    if (passing) {
      return {
        named: true,
        position: index >= 0 ? index + 1 : null,
        matchedAs: index >= 0 ? (businesses[index] ?? passing) : passing,
        quote: trimQuote(sentence),
      };
    }
  }
  if (index >= 0) {
    return { named: true, position: index + 1, matchedAs: businesses[index] ?? null, quote: null };
  }
  return { named: false, position: null, matchedAs: null, quote: null };
}

function namesMatchSentence(sentence: string, name: string): boolean {
  return (
    name.length > 0 && stripDiacritics(sentence).toLowerCase().includes(stripDiacritics(name).toLowerCase())
  );
}

/** The businesses an answer named that are not the target, in listed order. */
export function competitorsIn(businesses: string[], target: BusinessTarget): string[] {
  return businesses.filter((b) => !matchesTarget(b, target));
}
