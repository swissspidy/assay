/**
 * Stress testing (milestone 3): run a check set against valid variants and
 * invalid mutants of its correct reference snapshots, and report acceptance and
 * rejection rates, over-constrained checks, fragile checks and weak checks.
 */
import type { CheckSet, EvidenceSnapshot, Outcome, Status } from '../types.ts';
import { evaluate } from '../runtime/evaluate.ts';
import { generateVariants, type Variant } from './variants.ts';
import { generateMutants, withSuccessClaim, type Mutant } from './mutants.ts';

export interface StressReference {
  name: string;
  snapshot: EvidenceSnapshot;
}

export interface StressOptions {
  /** Generic variant ids that do not apply to this task (e.g. "extra-row" when the task fixes the item count). */
  skipVariants?: string[];
  /** Also re-run every rejected mutant with a success claim added to the page (default true). */
  successClaims?: boolean;
}

interface CheckFinding {
  check: string;
  status: Status;
  reason?: string;
  message: string;
}

export interface VariantResult {
  reference: string;
  id: string;
  description: string;
  verdict: Outcome['verdict'];
  rejectedBy: CheckFinding[];
}

export interface MutantResult {
  reference: string;
  id: string;
  check?: string;
  description: string;
  advisory: boolean;
  verdict: Outcome['verdict'];
  /** Status of the check whose evidence was broken. */
  targetStatus?: Status;
}

export interface StressReport {
  checkSet: { id: string; version: string };
  references: string[];
  variants: VariantResult[];
  mutants: MutantResult[];
  rates: {
    variantsAccepted: number;
    variantsTotal: number;
    mutantsRejected: number;
    mutantsRejectedByFail: number;
    mutantsRejectedByAbstain: number;
    mutantsTotal: number;
  };
  /** A check failed on a valid variant: it imposes a condition the task did not state. */
  overConstrained: { check: string; variants: string[] }[];
  /** A check abstained on a valid variant: its anchors are brittle. */
  fragile: { check: string; variants: string[] }[];
  /** A check still passed when its own evidence was broken. */
  weak: { check: string; mutants: string[] }[];
  /** Non-advisory mutants the check set accepted as success. */
  missed: string[];
  /** Advisory mutants accepted (e.g. the check set relies on page content alone). */
  advisories: string[];
  /** The checks that have no targeted mutant (the generator could not break their evidence). */
  untested: string[];
}

const group = (pairs: [string, string][]) => {
  const m = new Map<string, string[]>();
  for (const [k, v] of pairs) m.set(k, [...(m.get(k) ?? []), v]);
  return [...m].map(([check, items]) => ({ check, items }));
};

export function stressTest(cs: CheckSet, refs: StressReference[], opts: StressOptions = {}): StressReport {
  const skip = new Set(opts.skipVariants ?? []);
  const variants: VariantResult[] = [];
  const mutants: MutantResult[] = [];

  for (const ref of refs) {
    const base = evaluate(cs, ref.snapshot);
    if (base.verdict !== 'success') {
      // A correct run the checks reject is the strongest over-constraint evidence;
      // record it as a variant result and do not derive variants/mutants from it.
      variants.push({
        reference: ref.name,
        id: 'reference',
        description: 'the correct reference run itself',
        verdict: base.verdict,
        rejectedBy: base.checks
          .filter((c) => c.status !== 'pass')
          .map((c) => ({
            check: c.check,
            status: c.status,
            ...(c.reason ? { reason: c.reason } : {}),
            message: c.message,
          })),
      });
      continue;
    }
    for (const v of generateVariants(cs, ref.snapshot).filter((x: Variant) => !skip.has(x.id.split(':')[0]!))) {
      const o = evaluate(cs, v.snapshot);
      variants.push({
        reference: ref.name,
        id: v.id,
        description: v.description,
        verdict: o.verdict,
        rejectedBy: o.checks
          .filter((c) => c.status !== 'pass')
          .map((c) => ({
            check: c.check,
            status: c.status,
            ...(c.reason ? { reason: c.reason } : {}),
            message: c.message,
          })),
      });
    }
    const generated = generateMutants(cs, ref.snapshot);
    const all: Mutant[] = [...generated];
    if (opts.successClaims !== false) {
      for (const m of generated)
        if (!m.advisory && evaluate(cs, m.snapshot).verdict !== 'success') all.push(withSuccessClaim(m));
    }
    for (const m of all) {
      const o = evaluate(cs, m.snapshot);
      const targetCheck = m.check ? o.checks.find((c) => c.check === m.check) : undefined;
      const target = targetCheck?.status;
      // A targeted mutant is rejected when the requirement it attacks no longer passes
      // (for soft requirements the overall verdict legitimately stays success).
      const reqStatus = targetCheck
        ? o.requirements.find((r) => r.requirement === targetCheck.requirement)?.status
        : undefined;
      const verdict =
        reqStatus === undefined || reqStatus === 'pass' ? o.verdict : reqStatus === 'fail' ? 'fail' : 'abstain';
      mutants.push({
        reference: ref.name,
        id: m.id,
        ...(m.check ? { check: m.check } : {}),
        description: m.description,
        advisory: !!m.advisory,
        verdict: reqStatus === 'pass' ? 'success' : verdict,
        ...(target ? { targetStatus: target } : {}),
      });
    }
  }

  const definite = mutants.filter((m) => !m.advisory);
  const overConstrained = group(
    variants.flatMap((v) =>
      v.rejectedBy.filter((c) => c.status === 'fail').map((c): [string, string] => [c.check, `${v.reference}/${v.id}`]),
    ),
  );
  const fragile = group(
    variants.flatMap((v) =>
      v.rejectedBy
        .filter((c) => c.status === 'abstain')
        .map((c): [string, string] => [c.check, `${v.reference}/${v.id}`]),
    ),
  );
  const weak = group(
    definite
      .filter((m) => m.check && m.targetStatus === 'pass' && !m.id.endsWith('+claim'))
      .map((m): [string, string] => [m.check!, `${m.reference}/${m.id}`]),
  );
  const targeted = new Set(definite.map((m) => m.check).filter(Boolean));

  return {
    checkSet: { id: cs.id, version: cs.version },
    references: refs.map((r) => r.name),
    variants,
    mutants,
    rates: {
      variantsAccepted: variants.filter((v) => v.verdict === 'success').length,
      variantsTotal: variants.length,
      mutantsRejected: definite.filter((m) => m.verdict !== 'success').length,
      mutantsRejectedByFail: definite.filter((m) => m.verdict === 'fail').length,
      mutantsRejectedByAbstain: definite.filter((m) => m.verdict === 'abstain').length,
      mutantsTotal: definite.length,
    },
    overConstrained: overConstrained.map((g) => ({ check: g.check, variants: g.items })),
    fragile: fragile.map((g) => ({ check: g.check, variants: g.items })),
    weak: weak.map((g) => ({ check: g.check, mutants: g.items })),
    missed: definite.filter((m) => m.verdict === 'success').map((m) => `${m.reference}/${m.id}`),
    advisories: mutants
      .filter((m) => m.advisory && m.verdict === 'success')
      .map((m) => `${m.reference}/${m.id}: ${m.description}`),
    untested: cs.checks.map((c) => c.id).filter((id) => !targeted.has(id)),
  };
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)}%`);

export function formatStressReport(r: StressReport): string {
  const lines = [
    `## ${r.checkSet.id} v${r.checkSet.version}`,
    '',
    `- Valid variants accepted: **${r.rates.variantsAccepted}/${r.rates.variantsTotal}** (${pct(r.rates.variantsAccepted, r.rates.variantsTotal)})`,
    `- Mutants rejected: **${r.rates.mutantsRejected}/${r.rates.mutantsTotal}** (${pct(r.rates.mutantsRejected, r.rates.mutantsTotal)}; ${r.rates.mutantsRejectedByFail} by fail, ${r.rates.mutantsRejectedByAbstain} by abstain)`,
  ];
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push('', `**${title}**`, ...items.map((i) => `- ${i}`));
  };
  list(
    'Over-constrained checks (reject a valid variant)',
    r.overConstrained.map((o) => `${o.check}: ${o.variants.join(', ')}`),
  );
  list(
    'Fragile checks (abstain on a valid variant)',
    r.fragile.map((o) => `${o.check}: ${o.variants.join(', ')}`),
  );
  list(
    'Weak checks (pass although their own evidence was broken)',
    r.weak.map((o) => `${o.check}: ${o.mutants.join(', ')}`),
  );
  list('Missed mutants (accepted as success)', r.missed);
  list('Advisories', r.advisories);
  list('Checks without a targeted mutant', r.untested);
  return lines.join('\n');
}
