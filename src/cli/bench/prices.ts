/**
 * Model prices for `assay bench` (ADR 0026): the built-in list (`PRICING`), the config's
 * `bench.prices` and a `--prices` file, by precedence file > config > built-in. Each price says
 * where it came from; a model in none of them has no price, and its cost is unknown, never $0.
 */
import { readFileSync } from 'node:fs';
import { checkPrices, ConfigError, type BenchPrice } from '../../config/config.ts';
import { PRICING } from '../../eval/metrics.ts';

/** Where a price came from: the built-in list, `bench.prices`, or the `--prices` file. */
export type PriceSource = 'default' | 'config' | 'file';

export interface FoundPrice {
  /** The key it is listed under (`provider:model` or the bare model name). */
  key: string;
  source: PriceSource;
  price: BenchPrice;
}

export interface PriceBook {
  /** Whether any price came from the config or a file (the report then lists every price). */
  custom: boolean;
  /** The price of a model id as Assay writes it, or undefined when no table lists it. */
  find(modelId: string): FoundPrice | undefined;
}

/**
 * The keys a model id may be listed under, most specific first: `provider:model`, then the bare
 * model name. The replay marker (` (replay)`) and effort suffix (`@high`) are ignored, as in
 * `priceFor`.
 */
export function priceKeys(modelId: string): string[] {
  const id = modelId.replace(/ \(replay\)$/, '').replace(/@[^@]*$/, '');
  const bare = id.replace(/^[\w.-]+:/, '');
  return bare === id ? [id] : [id, bare];
}

/** Read and check a `--prices` file: JSON of the same shape as `bench.prices`. */
export function readPriceFile(file: string, shown = file): Record<string, BenchPrice> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`--prices ${shown}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  return checkPrices(raw, `--prices ${shown}`);
}

/** The prices, by precedence: the `--prices` file, then `bench.prices`, then the built-in list. */
export function priceBook(layers: {
  file?: Record<string, BenchPrice>;
  config?: Record<string, BenchPrice>;
}): PriceBook {
  const tables: [PriceSource, Record<string, BenchPrice>][] = [];
  if (layers.file) tables.push(['file', layers.file]);
  if (layers.config) tables.push(['config', layers.config]);
  tables.push(['default', PRICING]);
  return {
    custom: !!(layers.file || layers.config),
    find(modelId) {
      const keys = priceKeys(modelId);
      for (const [source, table] of tables) {
        for (const key of keys) if (Object.hasOwn(table, key)) return { key, source, price: table[key]! };
      }
      return undefined;
    },
  };
}

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/**
 * The cost of `usage` at `price` in USD, or why it is unknown: a job that read from or wrote to
 * the cache has no known cost when the price leaves that rate out (no rate is assumed).
 */
export function priceUsage(usage: Usage, found: FoundPrice): { usd: number } | { unknown: string } {
  const { price } = found;
  for (const [tokens, rate] of [
    [usage.cacheReadTokens, 'cacheRead'],
    [usage.cacheWriteTokens, 'cacheWrite'],
  ] as const) {
    if (tokens > 0 && price[rate] === undefined)
      return {
        unknown: `price unknown: ${found.key} (${found.source}) has no ${rate} price, and the job used ${tokens} ${rate} tokens`,
      };
  }
  const read = usage.cacheReadTokens;
  const write = usage.cacheWriteTokens;
  const fresh = Math.max(0, usage.inputTokens - read - write);
  return {
    usd:
      (fresh * price.input +
        read * (price.cacheRead ?? 0) +
        write * (price.cacheWrite ?? 0) +
        usage.outputTokens * price.output) /
      1e6,
  };
}
