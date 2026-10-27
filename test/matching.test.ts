import { describe, expect, it } from 'vitest';
import {
  competitorsIn,
  extractBusinesses,
  findMention,
  levenshtein,
  namesMatch,
  normalizeDomain,
  normalizeName,
  stripMarkdown,
} from '../src/matching.js';
import { HEADINGS, NOT_NAMED, NUMBERED_BOLD, PICK_LABELS, PLAIN_LIST } from './fixtures.js';

describe('normalizeName', () => {
  it('lowercases, unifies & and drops punctuation and legal suffixes', () => {
    expect(normalizeName('Eco-Cool HVAC, LLC')).toBe('eco cool hvac');
    expect(normalizeName('Harford Heating & Air Inc.')).toBe('harford heating and air');
    expect(normalizeName("The Joe's Plumbing Co")).toBe('joes plumbing');
    expect(normalizeName('Caf\u00E9 Lumi\u00E8re')).toBe('cafe lumiere');
  });

  it('keeps a lone suffix-like word instead of returning an empty name', () => {
    expect(normalizeName('Co')).toBe('co');
  });
});

describe('namesMatch', () => {
  it.each([
    ['Eco-Cool HVAC LLC', 'Eco-Cool HVAC'],
    ['EcoCool', 'Eco Cool'],
    ['Eco Cool Heating & Air', 'Eco-Cool'],
    ['EcoCool Heating', 'Eco-Cool HVAC'],
    ['Harford Heating and Air', 'Harford Heating & Air'],
    ['Chesapeak Climate Control', 'Chesapeake Climate Control'],
    ['HARFORD HEATING & AIR, INC.', 'Harford Heating & Air'],
  ])('matches "%s" to "%s"', (a, b) => {
    expect(namesMatch(a, b)).toBe(true);
  });

  it.each([
    ['Heating and Cooling', 'Bel Air Heating and Cooling'],
    ['Harford Plumbing', 'Harford Heating & Air'],
    ['Bel Air Comfort Pros', 'Eco-Cool HVAC'],
    ['HVAC', 'Eco-Cool HVAC'],
    ['Chesapeake Climate Control', 'Chesapeake Plumbing'],
  ])('does not match "%s" to "%s"', (a, b) => {
    expect(namesMatch(a, b)).toBe(false);
  });
});

describe('levenshtein', () => {
  it('counts edits and exits early past the max', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abcdef', 'uvwxyz', 1)).toBe(2);
  });
});

describe('extractBusinesses', () => {
  it('reads bold numbered lists and skips indented detail lines and tips', () => {
    expect(extractBusinesses(NUMBERED_BOLD)).toEqual([
      'Eco-Cool HVAC LLC',
      'Harford Heating & Air',
      'Bel Air Comfort Pros',
    ]);
  });

  it('cuts plain list lines at the first colon, bracket or comma', () => {
    expect(extractBusinesses(PLAIN_LIST)).toEqual([
      'Harford Heating and Air',
      'Chesapeake Climate Control',
      'Bel Air Comfort Pros',
    ]);
  });

  it('reads numbered headings and ignores "Bottom line"', () => {
    expect(extractBusinesses(HEADINGS)).toEqual(['Chesapeake Climate Control', 'Harford Heating & Air']);
  });

  it('takes the name after "Best Overall:" style labels', () => {
    expect(extractBusinesses(PICK_LABELS)).toEqual([
      'Eco Cool HVAC',
      'Bel Air Comfort Pros',
      'Chesapeake Climate Control',
    ]);
  });

  it('drops headings that describe a category', () => {
    expect(extractBusinesses('## Top HVAC Companies in Bel Air\n1. Eco-Cool HVAC')).toEqual([
      'Eco-Cool HVAC',
    ]);
  });

  it('returns nothing for prose with no names', () => {
    expect(extractBusinesses('You should get at least three quotes and check licensing.')).toEqual([]);
  });
});

describe('findMention', () => {
  const target = { name: 'Eco-Cool HVAC', domain: 'https://www.ecocoolhvac.com/' };

  it('finds the rank and a quote when the business is listed', () => {
    const mention = findMention(NUMBERED_BOLD, target);
    expect(mention).toMatchObject({ named: true, position: 1, matchedAs: 'Eco-Cool HVAC LLC' });
    expect(mention.quote).toContain('Eco-Cool HVAC LLC');
  });

  it('catches a passing mention outside the list, with no position', () => {
    const mention = findMention(PLAIN_LIST, target);
    expect(mention.named).toBe(true);
    expect(mention.position).toBeNull();
    expect(mention.quote).toContain('EcoCool Heating');
  });

  it('counts the website as a mention', () => {
    const mention = findMention('You could also try ecocoolhvac.com for quotes.', target);
    expect(mention.named).toBe(true);
    expect(mention.matchedAs).toBe('ecocoolhvac.com');
  });

  it('matches aliases', () => {
    const mention = findMention(HEADINGS, { name: 'Eco-Cool HVAC', aliases: ['Chesapeake Climate Control'] });
    expect(mention).toMatchObject({ named: true, position: 1 });
  });

  it('reports not named', () => {
    expect(findMention(NOT_NAMED, target)).toEqual({
      named: false,
      position: null,
      matchedAs: null,
      quote: null,
    });
  });
});

describe('helpers', () => {
  it('lists competitors without the target', () => {
    expect(competitorsIn(extractBusinesses(NUMBERED_BOLD), { name: 'EcoCool' })).toEqual([
      'Harford Heating & Air',
      'Bel Air Comfort Pros',
    ]);
  });

  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  it('strips markdown and citation markers', () => {
    expect(stripMarkdown('**Bold** and [a link](https://x.y) [1][2] `code`')).toBe('Bold and a link code');
  });
});
