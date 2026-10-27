import type { EngineAnswer, EngineId, EngineProvider } from '../src/providers/types.js';

/**
 * Synthetic answers written to look like what assistants return for local questions.
 * Businesses here are made up for tests.
 */
export const NUMBERED_BOLD = `Here are some of the best HVAC companies in Bel Air, MD:

1. **Eco-Cool HVAC LLC** - Family owned, known for fast AC repair and honest quotes.
   - **Phone:** (410) 555-0101
   - **Why they stand out:** 4.9 stars on Google
2. **Harford Heating & Air** - Full service installs and maintenance plans.
3. **Bel Air Comfort Pros** - Good for heat pump work.

**Tips:** Always ask for a written estimate and check that they are licensed.`;

export const PLAIN_LIST = `Top picks near Bel Air:
- Harford Heating and Air: great reviews for furnace repair
- Chesapeake Climate Control (serves all of Harford County)
- Bel Air Comfort Pros, known for heat pumps

Other well reviewed options include EcoCool Heating, which many locals mention for same-day service.`;

export const HEADINGS = `### 1. Chesapeake Climate Control
Large team and 24/7 emergency service.

### 2. Harford Heating & Air
Maintenance plans start around $15 a month.

## Bottom line
Call two or three companies and compare.`;

export const NOT_NAMED = `I can't verify current reviews, but these are commonly recommended:

1. Harford Heating & Air
2. Chesapeake Climate Control
3. Bel Air Comfort Pros

Check Google and Yelp reviews before you book.`;

export const PICK_LABELS = `- **Best Overall:** Eco Cool HVAC, strong reviews and fair prices
- **Best Budget:** Bel Air Comfort Pros
- **Best for Commercial:** Chesapeake Climate Control`;

export class MockEngine implements EngineProvider {
  calls: string[] = [];
  active = 0;
  peak = 0;

  constructor(
    readonly id: EngineId,
    private readonly reply: (question: string) => string | Error,
    readonly model = `${id}-mock`,
    private readonly delayMs = 0,
  ) {}

  async ask(question: string): Promise<EngineAnswer> {
    this.calls.push(question);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const result = this.reply(question);
      if (result instanceof Error) throw result;
      return {
        engine: this.id,
        model: this.model,
        question,
        text: result,
        citations: [],
        latencyMs: this.delayMs,
      };
    } finally {
      this.active--;
    }
  }
}
