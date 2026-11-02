import type { Outcome } from './types.js';

const ICON = { pass: '✔', fail: '✘', abstain: '?' } as const;

/** Plain-text report of an outcome, grouped by requirement. */
export function formatOutcome(o: Outcome): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${o.verdict.toUpperCase()}  (${o.checkSet.id} v${o.checkSet.version}, snapshot ${o.snapshot.digest.slice(0, 19)}…)`);
  for (const r of o.requirements) {
    lines.push(`${ICON[r.status]} [${r.kind}] ${r.requirement}: ${r.text}${r.reason ? `  (${r.reason})` : ''}`);
    for (const id of r.checks) {
      const c = o.checks.find((x) => x.check === id)!;
      lines.push(`    ${ICON[c.status]} ${c.check}: ${c.description}`);
      lines.push(`        ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${c.message}`);
      for (const e of c.evidence) {
        const v = e.value === undefined ? '' : ` = ${truncate(JSON.stringify(e.value), 160)}`;
        lines.push(`        evidence [${e.origin}, ${e.channel}/${e.trust}] ${e.locator ?? ''}${v}`);
      }
    }
  }
  if (o.drift.length) {
    lines.push('Drift (anchors that no longer match; check still decided):');
    for (const d of o.drift) lines.push(`    ${d.check}: ${d.locator}`);
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
