/** Signing and trusted keys for the review commands (ADR 0013): PEM files, directories or variables. */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CheckSetError, assertValidCheckSet, type CheckSet } from '../index.ts';
import { pemBlocks, privateKeyOf, trustedKeySet, type TrustedKeySet } from '../verifier/sign.ts';
import { CliError, readJson, readText, type Io, type Values } from './io.ts';

/** The private key from `--key <file>`, else `$ASSAY_SIGNING_KEY` (PEM text); undefined for an unsigned lock. */
export function signingKey(values: Values, env: Io['env']): string | undefined {
  const file = values.key as string | undefined;
  const pem = file !== undefined ? readText(file, 'signing key') : env.ASSAY_SIGNING_KEY;
  if (pem === undefined || pem === '') return undefined;
  const where = file ?? '$ASSAY_SIGNING_KEY';
  try {
    privateKeyOf(pem);
  } catch (e) {
    throw new CliError(`${where}: ${(e as Error).message}`);
  }
  return pem;
}

const keyName = (file: string) => basename(file).replace(/(\.pub)?\.pem$/, '');

/**
 * Trusted public keys from `--trusted-key` (a PEM file, which may hold several keys, or a
 * directory of `.pem` files; repeatable) and `$ASSAY_TRUSTED_KEYS` (PEM text). A key is
 * reported by its file name. Undefined when there are none.
 */
export function trustedKeys(values: Values, env: Io['env']): TrustedKeySet | undefined {
  const keys: { name?: string; key: string }[] = [];
  for (const path of (values['trusted-key'] as string[] | undefined) ?? []) {
    if (!existsSync(path)) throw new CliError(`trusted key not found: ${path}`);
    const files = statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((f) => f.endsWith('.pem'))
          .toSorted()
          .map((f) => join(path, f))
      : [path];
    if (!files.length) throw new CliError(`no .pem files in ${path}`);
    for (const f of files) {
      const blocks = pemBlocks(readText(f, 'trusted key'));
      if (!blocks.length) throw new CliError(`${f} holds no PEM key`);
      for (const key of blocks) keys.push({ ...(blocks.length === 1 ? { name: keyName(f) } : {}), key });
    }
  }
  if (env.ASSAY_TRUSTED_KEYS) {
    const blocks = pemBlocks(env.ASSAY_TRUSTED_KEYS);
    if (!blocks.length) throw new CliError('$ASSAY_TRUSTED_KEYS holds no PEM key');
    keys.push(...blocks.map((key) => ({ key })));
  }
  if (!keys.length) return undefined;
  try {
    return trustedKeySet(keys);
  } catch (e) {
    throw new CliError(`trusted keys: ${(e as Error).message}`);
  }
}

/** Read and validate a check set; an invalid one is an error (exit 4). */
export function readCheckSet(file: string, what = 'check set'): CheckSet {
  try {
    return assertValidCheckSet(readJson(file, what));
  } catch (e) {
    if (e instanceof CheckSetError) throw new CliError(`${file}: ${e.message}`);
    throw e;
  }
}

/** Write a check set as the repository stores them: two-space JSON and a final newline. */
export function writeCheckSet(file: string, cs: CheckSet): void {
  writeFileSync(file, JSON.stringify(cs, null, 2) + '\n');
}
