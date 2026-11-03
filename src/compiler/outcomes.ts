/**
 * Splits expected outcomes ("Then" clauses) into clauses, keeping each clause's
 * exact span in the source text so requirements can quote it.
 *
 * Accepts Gherkin (Then/And/But/* steps after a Then), Markdown lists, or one
 * outcome per line. Lines that are not outcomes are returned as `ignored` so
 * callers can surface them instead of dropping them silently.
 */
import { canonical } from '../text.ts';

export interface Clause {
  /** Canonical text of the clause (continuation lines joined with a space). */
  text: string;
  /** Span in the source; `source.slice(start, end)` canonicalizes to `text`. */
  start: number;
  end: number;
}

export interface ParsedOutcomes {
  clauses: Clause[];
  /** Non-empty lines that were not taken as outcomes (headings, Given/When steps, …). */
  ignored: string[];
}

const STEP = /^(given|when|then|and|but|\*)(?=\s)\s*/i;
const SECTION = /^(feature|scenario|scenario outline|scenario template|background|examples|rule):/i;
const LIST_ITEM = /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
const THEN_PREFIX = /^(?:\*\*then\*\*|then:?)\s+/i;

interface Line {
  text: string;
  start: number;
  lead: number;
}

function lines(src: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  for (const raw of src.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), start: offset + lead, lead });
    offset += raw.length + 1;
  }
  return out;
}

function isGherkin(ls: Line[]): boolean {
  const content = ls.filter((l) => l.text);
  if (content.some((l) => /^(given|when)\s/i.test(l.text) || SECTION.test(l.text))) return true;
  // All lines are steps and one of them is a Then step ("* a\n* b" alone is a bullet list).
  return content.length > 0 && content.every((l) => STEP.test(l.text)) && content.some((l) => /^then\s/i.test(l.text));
}

const trimEnd = (t: string) => t.replace(/[.;]\s*$/, '');

/** Extend a clause with a continuation line. The text stays verbatim (inner punctuation included) so it can be quoted. */
function extend(src: string, clause: Clause, l: Line): void {
  const body = trimEnd(l.text);
  clause.end = l.start + body.length;
  clause.text = canonical(src.slice(clause.start, clause.end));
}

export function parseOutcomesDetailed(text: string | undefined): ParsedOutcomes {
  const clauses: Clause[] = [];
  const ignored: string[] = [];
  if (!text) return { clauses, ignored };
  const ls = lines(text);
  const gherkin = isGherkin(ls);
  let inThen = false;
  let last: { clause: Clause; lead: number } | undefined;

  const push = (l: Line, skip: number) => {
    const body = trimEnd(l.text.slice(skip));
    if (!canonical(body)) return;
    const start = l.start + skip;
    const clause = { text: canonical(body), start, end: start + body.length };
    clauses.push(clause);
    last = { clause, lead: l.lead };
  };

  for (const l of ls) {
    if (!l.text) {
      last = undefined;
      continue;
    }
    if (gherkin) {
      if (SECTION.test(l.text)) {
        inThen = false;
        last = undefined;
        ignored.push(l.text);
        continue;
      }
      const m = STEP.exec(l.text);
      if (!m) {
        // Indented continuation of the previous Then step.
        if (last && l.lead > last.lead) extend(text, last.clause, l);
        else ignored.push(l.text);
        continue;
      }
      const kw = m[1]!.toLowerCase();
      if (kw === 'then') inThen = true;
      else if (kw === 'given' || kw === 'when') inThen = false;
      if (!inThen) {
        last = undefined;
        ignored.push(l.text);
        continue;
      }
      push(l, m[0].length);
      continue;
    }
    // Markdown or plain lines.
    let skip = LIST_ITEM.exec(l.text)?.[0].length ?? 0;
    const then = THEN_PREFIX.exec(l.text.slice(skip));
    if (then) skip += then[0].length;
    const isItem = skip > 0;
    // An indented line under a list item continues it.
    if (!isItem && last && l.lead > last.lead) {
      extend(text, last.clause, l);
      continue;
    }
    // Headings and header-like lines ("Expected outcomes:") are not outcomes; items ending in ":" still are.
    if (l.text.startsWith('#') || (!isItem && /:\s*$/.test(l.text))) {
      ignored.push(l.text);
      last = undefined;
      continue;
    }
    push(l, skip);
  }
  return { clauses, ignored };
}

export function parseOutcomes(text: string | undefined): Clause[] {
  return parseOutcomesDetailed(text).clauses;
}
