/** `assay keygen`: a new Ed25519 key pair for signing check set approvals (ADR 0013). */
import { existsSync, writeFileSync } from 'node:fs';
import { generateSigningKey } from '../../verifier/sign.ts';
import { CliError, EXIT, type Invocation, type Io } from '../io.ts';

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
  writeFileSync(out, pair.privateKey, { mode: 0o600 });
  writeFileSync(pub, pair.publicKey);
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
