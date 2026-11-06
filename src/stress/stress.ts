/**
 * Stress testing (milestone 3): run a check set against valid variants and
 * invalid mutants of its correct reference snapshots, and report acceptance and
 * rejection rates, over-constrained, fragile and weak checks.
 */
import type { CheckSet, EvidenceSnapshot, Outcome, Status } from '../types.ts';
import { compileChecks, PlanRun } from '../plan/plan.ts';
import { buildStore } from '../store/store.ts';
import { generateVariants } from './variants.ts';
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
  /** Accepted: no check is worse than on the reference itself. */
  accepted: boolean;
  /** Checks whose status got worse than on the reference. */
  rejectedBy: CheckFinding[];
}

export interface MutantResult {
  reference: string;
  id: string;
  check?: string;
  description: string;
  advisory: boolean;
  /** A copy of a rejected mutant with a success claim added to the page. */
  claim: boolean;
  verdict: Outcome['verdict'];
  /** Rejected: the overall verdict is not success, or the attacked requirement no longer passes. */
  rejected: boolean;
  rejectedBy?: 'fail' | 'abstain';
  /** Status of the check whose evidence was broken. */
  targetStatus?: Status;
}

export interface FindingRef {
  reference: string;
  id: string;
  description: string;
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
    claimMutantsRejected: number;
    claimMutantsTotal: number;
  };
  /** A check failed on a valid variant (or a correct reference): it imposes a condition the task did not state. */
  overConstrained: { check: string; variants: FindingRef[] }[];
  /** A check abstained on a valid variant: its anchors are brittle. */
  fragile: { check: string; variants: FindingRef[] }[];
  /** A check still passed when its own evidence was broken. */
  weak: { check: string; mutants: FindingRef[] }[];
  /** Definite mutants the check set did not reject. */
  missed: FindingRef[];
  /** Advisory mutants accepted (e.g. the check set relies on page content alone). */
  advisories: FindingRef[];
  /** Checks that have no targeted mutant (the generator could not break their evidence). */
  untested: string[];
}

const RANK: Record<Status, number> = { pass: 2, abstain: 1, fail: 0 };

function group(pairs: [string, FindingRef][]) {
  const m = new Map<string, FindingRef[]>();
  for (const [k, v] of pairs) m.set(k, [...(m.get(k) ?? []), v]);
  return [...m].map(([check, items]) => ({ check, items }));
}

const ref = (x: { reference: string; id: string; description: string }): FindingRef => ({
  reference: x.reference,
  id: x.id,
  description: x.description,
});

const finding = (c: Outcome['checks'][number]): CheckFinding => ({
  check: c.check,
  status: c.status,
  ...(c.reason ? { reason: c.reason } : {}),
  message: c.message,
});

export function stressTest(cs: CheckSet, refs: StressReference[], options: StressOptions = {}): StressReport {
  const skip = new Set(options.skipVariants ?? []);
  const variants: VariantResult[] = [];
  const mutants: MutantResult[] = [];
  const plan = compileChecks(cs);
  const opts = { digests: false };
  // Checks of hard requirements: one of them failing makes the verdict fail.
  const hard = new Set(cs.requirements.filter((r) => r.kind === 'hard').map((r) => r.id));
  // A check the read-sets cannot describe runs on every mutant, as it always did (it may throw).
  const describable = plan.checks.every((c) => c.reads !== null);
  /** Whether a check of a hard requirement fails, trying the mutant's target check `t` first. */
  const failsHard = (run: PlanRun, t: number): boolean => {
    const fails = (i: number) => run.check(i).status === 'fail' && hard.has(plan.checks[i]!.check.requirement);
    if (t >= 0 && fails(t)) return true;
    for (let i = 0; i < plan.checks.length; i++) if (i !== t && fails(i)) return true;
    return false;
  };

  for (const reference of refs) {
    // Variants and mutants are overlays on their reference: they replace a few parts of its
    // snapshot and share the rest, so only the checks that read a replaced part run again
    // (ADR 0016). A success claim is an overlay on its mutant.
    const refRun = new PlanRun(plan, buildStore(reference.snapshot));
    const base = refRun.outcome(opts);
    const baseStatus = new Map(base.checks.map((c) => [c.check, c.status] as const));
    if (base.verdict !== 'success') {
      // A correct run the checks reject is the strongest over-constraint evidence;
      // record it, and do not derive variants or mutants from it.
      variants.push({
        reference: reference.name,
        id: 'reference',
        description: 'the correct reference run itself',
        verdict: base.verdict,
        accepted: false,
        rejectedBy: base.checks.filter((c) => c.status !== 'pass').map(finding),
      });
      continue;
    }
    for (const v of generateVariants(cs, reference.snapshot)) {
      if (skip.has(v.id.split(':')[0]!)) continue;
      const o = new PlanRun(plan, buildStore(v.snapshot), refRun).outcome(opts);
      const worse = o.checks.filter((c) => RANK[c.status] < RANK[baseStatus.get(c.check) ?? 'pass']);
      variants.push({
        reference: reference.name,
        id: v.id,
        description: v.description,
        verdict: o.verdict,
        accepted: worse.length === 0,
        rejectedBy: worse.map(finding),
      });
    }

    const judge = (m: Mutant, claim: boolean, over: PlanRun): { result: MutantResult; run: PlanRun } => {
      const run = new PlanRun(plan, buildStore(m.snapshot), over);
      const t = m.check ? plan.checks.findIndex((c) => c.check.id === m.check) : -1;
      let verdict: Outcome['verdict'];
      let target: Outcome['checks'][number] | undefined;
      let rejected: boolean;
      let by: 'fail' | 'abstain' | undefined;
      if (describable && failsHard(run, t)) {
        // A failing check of a hard requirement decides: the verdict is fail whatever the
        // other checks say, so they need not run (the full outcome would say the same).
        verdict = 'fail';
        target = t >= 0 ? run.check(t) : undefined;
        rejected = true;
        by = 'fail';
      } else {
        const o = run.outcome(opts);
        verdict = o.verdict;
        const found = m.check ? o.checks.find((c) => c.check === m.check) : undefined;
        target = found;
        const reqStatus = found ? o.requirements.find((r) => r.requirement === found.requirement)?.status : undefined;
        rejected = o.verdict !== 'success' || (reqStatus !== undefined && reqStatus !== 'pass');
        by = !rejected ? undefined : o.verdict === 'fail' || reqStatus === 'fail' ? 'fail' : 'abstain';
      }
      const result: MutantResult = {
        reference: reference.name,
        id: m.id,
        ...(m.check ? { check: m.check } : {}),
        description: m.description,
        advisory: !!m.advisory,
        claim,
        verdict,
        rejected,
        ...(by ? { rejectedBy: by } : {}),
        ...(target ? { targetStatus: target.status } : {}),
      };
      return { result, run };
    };
    for (const m of generateMutants(cs, reference.snapshot)) {
      const { result: r, run } = judge(m, false, refRun);
      mutants.push(r);
      if (options.successClaims !== false && !m.advisory && r.rejected)
        mutants.push(judge(withSuccessClaim(m), true, run).result);
    }
  }

  const definite = mutants.filter((m) => !m.advisory && !m.claim);
  const claims = mutants.filter((m) => m.claim);
  const overConstrained = group(
    variants.flatMap((v) =>
      v.rejectedBy.filter((c) => c.status === 'fail').map((c): [string, FindingRef] => [c.check, ref(v)]),
    ),
  );
  const fragile = group(
    variants.flatMap((v) =>
      v.rejectedBy.filter((c) => c.status === 'abstain').map((c): [string, FindingRef] => [c.check, ref(v)]),
    ),
  );
  const weak = group(
    definite.filter((m) => m.check && m.targetStatus === 'pass').map((m): [string, FindingRef] => [m.check!, ref(m)]),
  );
  const targeted = new Set(definite.map((m) => m.check).filter(Boolean));

  return {
    checkSet: { id: cs.id, version: cs.version },
    references: refs.map((r) => r.name),
    variants,
    mutants,
    rates: {
      variantsAccepted: variants.filter((v) => v.accepted).length,
      variantsTotal: variants.length,
      mutantsRejected: definite.filter((m) => m.rejected).length,
      mutantsRejectedByFail: definite.filter((m) => m.rejectedBy === 'fail').length,
      mutantsRejectedByAbstain: definite.filter((m) => m.rejectedBy === 'abstain').length,
      mutantsTotal: definite.length,
      claimMutantsRejected: claims.filter((m) => m.rejected).length,
      claimMutantsTotal: claims.length,
    },
    overConstrained: overConstrained.map((g) => ({ check: g.check, variants: g.items })),
    fragile: fragile.map((g) => ({ check: g.check, variants: g.items })),
    weak: weak.map((g) => ({ check: g.check, mutants: g.items })),
    missed: [...definite, ...claims].filter((m) => !m.rejected).map(ref),
    advisories: mutants.filter((m) => m.advisory && !m.rejected).map(ref),
    untested: cs.checks.map((c) => c.id).filter((id) => !targeted.has(id)),
  };
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)}%`);
const show = (f: FindingRef) => `${f.reference}/${f.id} (${f.description})`;

export function formatStressReport(r: StressReport): string {
  const lines = [
    `## ${r.checkSet.id} v${r.checkSet.version}`,
    '',
    `- Valid variants accepted: **${r.rates.variantsAccepted}/${r.rates.variantsTotal}** (${pct(r.rates.variantsAccepted, r.rates.variantsTotal)})`,
    `- Mutants rejected: **${r.rates.mutantsRejected}/${r.rates.mutantsTotal}** (${pct(r.rates.mutantsRejected, r.rates.mutantsTotal)}; ${r.rates.mutantsRejectedByFail} by fail, ${r.rates.mutantsRejectedByAbstain} by abstain)`,
    `- Mutants with a success claim added still rejected: ${r.rates.claimMutantsRejected}/${r.rates.claimMutantsTotal}`,
  ];
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push('', `**${title}**`, ...items.map((i) => `- ${i}`));
  };
  list(
    'Over-constrained checks (reject a valid variant)',
    r.overConstrained.map((o) => `${o.check}: ${o.variants.map(show).join('; ')}`),
  );
  list(
    'Fragile checks (abstain on a valid variant)',
    r.fragile.map((o) => `${o.check}: ${o.variants.map(show).join('; ')}`),
  );
  list(
    'Weak checks (pass although their own evidence was broken)',
    r.weak.map((o) => `${o.check}: ${o.mutants.map(show).join('; ')}`),
  );
  list('Missed mutants (accepted as success)', r.missed.map(show));
  list('Advisories', r.advisories.map(show));
  list('Checks without a targeted mutant', r.untested);
  return lines.join('\n');
}
