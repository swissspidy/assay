/**
 * The review sheet (pipeline step 5, ADR 0013): what a reviewer reads before approving a
 * check set. Each requirement with its quote; each check's description next to what it
 * mechanically tests and the evidence it reads; warnings, stress findings, and, against
 * the approved version, what changed. Markdown for a terminal or PR comment, or HTML.
 */
import type { CheckSet } from '../types.ts';
import type { StressReport } from '../stress/stress.ts';
import { validateCheckSet } from '../dsl/validate.ts';
import { reviewState, stressDigest, describeChange, type LockCheckOptions } from './lock.ts';
import { checkItem, checkView, diffBlocks, diffCheckSets, type CheckSetDiff } from './diff.ts';
import { cat, render, type Block, type DocFormat, type ListItem } from './doc.ts';

export interface ReviewSheetOptions extends LockCheckOptions {
  /** "markdown" (default) or "html". */
  format?: DocFormat;
  /**
   * Markdown only: collapse unchanged requirements in `<details>` (for a GitHub comment).
   * Default false.
   */
  details?: boolean;
  /** The version last approved: show what changed, and list unchanged requirements without their checks. */
  previous?: CheckSet;
  /** A stress report for this set: its rates, and each check's findings next to the check. */
  stress?: StressReport;
  /** Validation warnings to show (default: `validateCheckSet`'s); `false` for none. */
  warnings?: string[] | false;
}

/** Warnings about one check or requirement go next to it, the rest at the top. */
function placeWarnings(warnings: string[]) {
  const byCheck = new Map<string, string[]>();
  const byRequirement = new Map<string, string[]>();
  const general: string[] = [];
  for (const w of warnings) {
    const m = /^(check|requirement) ([A-Za-z0-9_.-]+)[:. ]/.exec(w);
    if (!m) general.push(w);
    else {
      const map = m[1] === 'check' ? byCheck : byRequirement;
      map.set(m[2]!, [...(map.get(m[2]!) ?? []), w]);
    }
  }
  return { byCheck, byRequirement, general };
}

const show = (f: { reference: string; id: string; description: string }) => `${f.reference}/${f.id} (${f.description})`;

function stressFindings(r: StressReport): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (check: string, text: string) => m.set(check, [...(m.get(check) ?? []), text]);
  for (const o of r.overConstrained) add(o.check, `over-constrained: rejects ${o.variants.map(show).join('; ')}`);
  for (const o of r.fragile) add(o.check, `fragile: abstains on ${o.variants.map(show).join('; ')}`);
  for (const o of r.weak) add(o.check, `weak: still passes ${o.mutants.map(show).join('; ')}`);
  for (const c of r.untested) add(c, 'no targeted mutant (the generator could not break its evidence)');
  return m;
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)}%`);

function stressBlocks(cs: CheckSet, r: StressReport, lockStress: string | undefined): Block[] {
  const items: ListItem[] = [
    {
      text: `valid variants accepted: ${r.rates.variantsAccepted}/${r.rates.variantsTotal} (${pct(r.rates.variantsAccepted, r.rates.variantsTotal)})`,
    },
    {
      text: `mutants rejected: ${r.rates.mutantsRejected}/${r.rates.mutantsTotal} (${pct(r.rates.mutantsRejected, r.rates.mutantsTotal)})`,
    },
    ...(r.missed.length
      ? [{ text: 'missed mutants (accepted as success):', items: r.missed.map((m) => ({ text: show(m) })) }]
      : []),
    ...(r.advisories.length ? [{ text: 'advisories:', items: r.advisories.map((m) => ({ text: show(m) })) }] : []),
  ];
  if (r.checkSet.id !== cs.id || r.checkSet.version !== cs.version)
    items.unshift({ text: `this report is for ${r.checkSet.id} v${r.checkSet.version}, not this set` });
  if (lockStress)
    items.push({
      text:
        lockStress === stressDigest(r)
          ? 'this is the report the approver saw'
          : 'this is not the report the approver saw (its digest differs from the lock)',
    });
  return [{ h: 2, text: `Stress test (${r.references.join(', ')})` }, { ul: items }];
}

function approvalBlocks(cs: CheckSet, opts: LockCheckOptions): Block[] {
  const { state, lock, rejected } = reviewState(cs, opts);
  const l = lock.lock;
  const lines: Block[] = [{ h: 2, text: 'Approval' }];
  if (state === 'proposal') {
    lines.push({
      p: rejected
        ? `Not locked: a proposal, revised since ${rejected.by} rejected it at ${rejected.at} ("${rejected.note}").`
        : 'Not locked: a proposal awaiting review.',
    });
  } else if (state === 'rejected') {
    lines.push({ p: [{ t: `Rejected by ${rejected!.by} at ${rejected!.at}:`, b: true }, ` ${rejected!.note}`] });
  } else {
    const sig = l!.signature;
    const signature =
      lock.signature === 'none'
        ? 'unsigned'
        : lock.signature === 'trusted'
          ? `signed with trusted key ${lock.signer}`
          : lock.signature === 'untrusted'
            ? `signed with key ${sig!.keyId}, which is NOT a trusted key`
            : lock.signature === 'invalid'
              ? `signature INVALID for key ${sig!.keyId}`
              : `signed with key ${sig!.keyId} (not checked: no trusted keys given)`;
    const status = state === 'approved' ? `valid, ${signature}` : `BROKEN: ${lock.problems.join('; ')}`;
    lines.push({ p: `Locked by ${l!.by} at ${l!.at} (${status}).` });
    if (l!.note) lines.push({ p: [{ t: 'Note:', b: true }, ` ${l!.note}`] });
  }
  return lines;
}

/** Markdown (or HTML) review sheet: everything a reviewer needs to approve or reject the set. */
export function reviewSheet(cs: CheckSet, opts: ReviewSheetOptions = {}): string {
  const blocks: Block[] = [
    { h: 1, text: `Review: ${cs.id} v${cs.version}` },
    { p: [{ t: 'Instruction:', b: true }, ` ${cs.task.instruction}`] },
  ];
  if (cs.task.outcomes)
    blocks.push({ p: { t: 'Expected outcomes:', b: true } }, { quote: cs.task.outcomes.split('\n') });
  if (cs.compiled)
    blocks.push({ p: `Compiled by ${cs.compiled.compiler} with ${cs.compiled.model} at ${cs.compiled.at}.` });

  const { state, lock } = reviewState(cs, opts);
  if (state === 'changed' && lock.changes.length && !opts.previous)
    blocks.push({
      p: [
        { t: 'Changed since approval:', b: true },
        ` ${lock.changes.map(describeChange).join(', ')}. Pass the approved version to see how.`,
      ],
    });

  const warnings = opts.warnings === false ? [] : (opts.warnings ?? validateCheckSet(cs).warnings);
  const placed = placeWarnings(warnings);
  if (placed.general.length) blocks.push({ h: 2, text: 'Warnings' }, { ul: placed.general.map((w) => ({ text: w })) });

  let diff: CheckSetDiff | undefined;
  if (opts.previous) {
    diff = diffCheckSets(opts.previous, cs);
    blocks.push({ h: 2, text: `Changes since ${diff.from.id} v${diff.from.version}` }, ...diffBlocks(diff, 2));
  }
  if (opts.stress) blocks.push(...stressBlocks(cs, opts.stress, lock.lock?.stress));
  const findings = opts.stress ? stressFindings(opts.stress) : new Map<string, string[]>();

  const review = diff ? new Set(diff.toReview) : undefined;
  const unchanged: Block[] = [];
  for (const r of cs.requirements) {
    const checks = cs.checks.filter((c) => c.requirement === r.id);
    if (review && !review.has(r.id)) {
      unchanged.push({
        ul: [
          {
            text: cat(
              { t: r.id, b: true },
              ` (${r.kind}): "${r.source.quote}": checks ${checks.map((c) => c.id).join(', ') || 'none'}`,
            ),
          },
        ],
      });
      continue;
    }
    const label = !diff
      ? ''
      : diff.requirements.added.some((x) => x.id === r.id)
        ? ' (new)'
        : diff.requirements.changed.some((x) => x.id === r.id)
          ? ' (changed)'
          : diff.set.some((x) => x.field === 'instruction' || x.field === 'expected outcomes')
            ? ' (task changed)'
            : ' (checks changed)';
    blocks.push({
      h: 2,
      text: `${r.id} (${r.kind}): "${r.source.quote}"${label}`,
    });
    const extra = placed.byRequirement.get(r.id);
    if (extra) blocks.push({ ul: extra.map((w) => ({ text: `warning: ${w}` })) });
    if (checks.length)
      blocks.push({
        ul: checks.map((c) =>
          checkItem(checkView(c), [
            ...(findings.get(c.id) ?? []).map((f) => ({ text: `stress: ${f}` })),
            ...(placed.byCheck.get(c.id) ?? []).map((w) => ({ text: `warning: ${w}` })),
          ]),
        ),
      });
  }
  if (unchanged.length)
    blocks.push({
      details: `Unchanged since ${diff!.from.id} v${diff!.from.version} (${unchanged.length} requirement${unchanged.length === 1 ? '' : 's'})`,
      blocks: [{ ul: unchanged.flatMap((b) => ('ul' in b ? b.ul : [])) }],
    });
  blocks.push(...approvalBlocks(cs, opts));
  return render(blocks, opts.format, { details: !!opts.details });
}
