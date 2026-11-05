/** `assay keygen`: a new Ed25519 key pair for signing check set approvals (ADR 0013). */
import { existsSync, linkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { generateSigningKey } from '../../verifier/sign.ts';
import { CliError, EXIT, type Invocation, type Io } from '../io.ts';
import { tempFileFor } from '../keys.ts';

/**
 * Install files staged next to their destinations, all or none. Each staged file is new
 * (so the private key's mode 600 applies) and linked into place, which fails if the
 * destination exists; with `force`, an existing file is first moved aside and restored
 * if anything fails.
 */
export function installFiles(files: { staged: string; dest: string }[], force: boolean): void {
  const moved: { aside: string; dest: string }[] = [];
  const installed: string[] = [];
  try {
    for (const { dest } of files)
      if (existsSync(dest)) {
        if (!force) throw new CliError(`${dest} exists (use --force to replace it)`);
        const aside = tempFileFor(dest);
        renameSync(dest, aside);
        moved.push({ aside, dest });
      }
    for (const { staged, dest } of files) {
      linkSync(staged, dest);
      installed.push(dest);
    }
  } catch (e) {
    for (const dest of installed) rmSync(dest, { force: true });
    for (const { aside, dest } of moved) renameSync(aside, dest);
    throw e;
  } finally {
    for (const { staged } of files) rmSync(staged, { force: true });
  }
  for (const { aside } of moved) rmSync(aside, { force: true });
}

/** The public key's file next to the private key's: `alice.pem` → `alice.pub.pem`. */
export const publicKeyFile = (file: string) => file.replace(/(\.pem)?$/, '.pub.pem');

export async function run({ values }: Invocation, io: Io): Promise<number> {
  const pair = generateSigningKey();
  const out = values.out as string | undefined;
  if (out === undefined) {
    if (values.json) io.out(JSON.stringify(pair, null, 2));
    else {
      io.out(pair.privateKey.trimEnd());
      io.out(pair.publicKey.trimEnd());
      io.err(`Key id: ${pair.keyId}`);
    }
    return EXIT.ok;
  }
  const pub = publicKeyFile(out);
  if (!values.force)
    for (const f of [out, pub]) if (existsSync(f)) throw new CliError(`${f} exists (use --force to replace it)`);
  const files = [
    { staged: tempFileFor(out), dest: out, data: pair.privateKey, mode: 0o600 },
    { staged: tempFileFor(pub), dest: pub, data: pair.publicKey, mode: 0o644 },
  ];
  try {
    for (const f of files) writeFileSync(f.staged, f.data, { flag: 'wx', mode: f.mode });
  } catch (e) {
    for (const f of files) rmSync(f.staged, { force: true });
    throw e;
  }
  installFiles(files, !!values.force);
  if (values.json)
    io.out(
      JSON.stringify({ keyId: pair.keyId, privateKey: out, publicKey: pub, publicKeyPem: pair.publicKey }, null, 2),
    );
  else
    io.out(
      `Key id: ${pair.keyId}\nPrivate key: ${out} (keep it secret)\nPublic key: ${pub} (give it to whoever verifies, e.g. --trusted-key)`,
    );
  return EXIT.ok;
}
