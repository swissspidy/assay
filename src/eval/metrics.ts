/** Binary verification metrics (milestone 5). "Positive" = the run really succeeded. */
export interface Prediction {
  expected: 'success' | 'fail';
  verdict: 'success' | 'fail' | 'abstain';
  costUsd: number;
  ms: number;
}

export interface Metrics {
  n: number;
  positives: number;
  negatives: number;
  /** Runs that succeeded and were judged success. */
  tpr: number;
  /** Runs that failed and were judged not success (fail or abstain). */
  tnr: number;
  balancedAccuracy: number;
  /** Share of runs with an abstain verdict (they count as "not success" above). */
  abstainRate: number;
  /** TPR/TNR counting only decided runs (abstains excluded). */
  decidedTpr: number;
  decidedTnr: number;
  costUsdPerRun: number;
  msPerRunMedian: number;
  msPerRunP95: number;
  /** Runs with a measured latency (replayed model runs have none). */
  msMeasured: number;
}

const rate = (a: number, b: number) => (b === 0 ? NaN : a / b);
/** Quantile over the finite values only (unmeasured latencies are NaN). */
const quantile = (all: number[], q: number) => {
  const xs = all.filter(Number.isFinite);
  if (!xs.length) return NaN;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function metrics(preds: Prediction[]): Metrics {
  const pos = preds.filter((p) => p.expected === 'success');
  const neg = preds.filter((p) => p.expected === 'fail');
  const tpr = rate(pos.filter((p) => p.verdict === 'success').length, pos.length);
  const tnr = rate(neg.filter((p) => p.verdict !== 'success').length, neg.length);
  const posD = pos.filter((p) => p.verdict !== 'abstain');
  const negD = neg.filter((p) => p.verdict !== 'abstain');
  return {
    n: preds.length,
    positives: pos.length,
    negatives: neg.length,
    tpr,
    tnr,
    balancedAccuracy: (tpr + tnr) / 2,
    abstainRate: rate(preds.filter((p) => p.verdict === 'abstain').length, preds.length),
    decidedTpr: rate(posD.filter((p) => p.verdict === 'success').length, posD.length),
    decidedTnr: rate(negD.filter((p) => p.verdict === 'fail').length, negD.length),
    costUsdPerRun: preds.reduce((a, p) => a + p.costUsd, 0) / Math.max(1, preds.length),
    msPerRunMedian: quantile(
      preds.map((p) => p.ms),
      0.5,
    ),
    msPerRunP95: quantile(
      preds.map((p) => p.ms),
      0.95,
    ),
    msMeasured: preds.filter((p) => Number.isFinite(p.ms)).length,
  };
}

/** Per-million-token prices in USD. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Anthropic first-party list prices (per million tokens) for models used here. */
export const PRICING: Record<string, Pricing> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function costUsd(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  price: Pricing | undefined,
): number {
  if (!price) return NaN;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - read - write);
  return (
    (fresh * price.input + read * price.cacheRead + write * price.cacheWrite + usage.outputTokens * price.output) / 1e6
  );
}
