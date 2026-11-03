/**
 * Splits expected outcomes ("Then" clauses) into clauses, keeping each clause's
 * exact position in the source text so requirements can quote it.
 * Accepts Gherkin (Then/And/But), Markdown lists, or one outcome per line.
 */
export interface Clause {
  text: string;
  start: number;
  end: number;
}

const GHERKIN_OUTCOME = /^(?:then|and|but)\s+/i;
const GHERKIN_OTHER = /^(?:given|when|feature:|scenario:|scenario outline:|background:|examples:|#|@|\|)/i;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;

export function parseOutcomes(text: string | undefined): Clause[] {
  if (!text) return [];
  const clauses: Clause[] = [];
  const isGherkin = text.split('\n').some((l) => /^\s*then\s+/i.test(l));
  let offset = 0;
  let inThen = false;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const lead = line.length - line.trimStart().length;
    let body = line.trim();
    if (!body) continue;
    let skip = 0;
    if (isGherkin) {
      if (/^then\s+/i.test(body)) inThen = true;
      else if (/^(?:given|when)\s+/i.test(body)) inThen = false;
      const m = GHERKIN_OUTCOME.exec(body);
      if (!m || !inThen) continue;
      skip = m[0].length;
    } else {
      if (body.startsWith('#')) continue;
      const m = LIST_ITEM.exec(body);
      if (m) skip = m[0].length;
      const rest = body.slice(skip);
      const then = /^then\s+/i.exec(rest);
      if (then) skip += then[0].length;
    }
    if (GHERKIN_OTHER.test(body) && isGherkin && skip === 0) continue;
    body = body.slice(skip).replace(/[.;]\s*$/, '');
    if (!body) continue;
    const start = lineStart + lead + skip;
    clauses.push({ text: body, start, end: start + body.length });
  }
  return clauses;
}
