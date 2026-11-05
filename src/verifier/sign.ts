/**
 * Ed25519 keys and signatures for check set locks (ADR 0013), with `node:crypto` only.
 * A lock's signature covers its digest, which covers the check set and every lock field.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

/** A PEM string (public or private key; a private key stands for its public half) or a key object. */
export type KeyInput = string | KeyObject;

/** A key a lock's signature is trusted from, optionally with a name to report it by. */
export type TrustedKey = KeyInput | { name?: string; key: KeyInput };

export interface SigningKeyPair {
  /** PKCS#8 PEM. Keep it secret. */
  privateKey: string;
  /** SPKI PEM. Distribute it to whoever verifies locks. */
  publicKey: string;
  keyId: string;
}

/** What the signature is over: a fixed context string and the lock digest. */
const message = (digest: string) => Buffer.from(`assay.lock/v1\n${digest}`, 'utf8');

const PEM_BLOCK = /-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g;

/** The PEM blocks in a text (a file or variable may hold several trusted keys). */
export function pemBlocks(text: string): string[] {
  return [...text.matchAll(PEM_BLOCK)].map((m) => m[0]);
}

function asEd25519(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error(`${what} is a ${key.asymmetricKeyType ?? key.type} key; locks are signed with Ed25519`);
  return key;
}

/** The private key to sign with. */
export function privateKeyOf(input: KeyInput): KeyObject {
  if (typeof input !== 'string') {
    if (input.type !== 'private') throw new Error('signing needs a private key');
    return asEd25519(input, 'the signing key');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(input);
  } catch (e) {
    throw new Error(`not a PEM private key: ${(e as Error).message}`, { cause: e });
  }
  return asEd25519(key, 'the signing key');
}

/** The public key of a public or private key. */
export function publicKeyOf(input: KeyInput): KeyObject {
  let key: KeyObject;
  try {
    key = typeof input === 'string' ? createPublicKey(input) : input.type === 'public' ? input : createPublicKey(input);
  } catch (e) {
    throw new Error(`not a PEM key: ${(e as Error).message}`, { cause: e });
  }
  return asEd25519(key, 'the key');
}

/**
 * A short, stable name for a key: "ed25519:" and the first 16 hex digits of the SHA-256
 * of its public key (SPKI DER). It only tells which trusted key to check a signature
 * with; trust comes from the key itself, never from the id.
 */
export function keyId(input: KeyInput): string {
  const der = publicKeyOf(input).export({ type: 'spki', format: 'der' });
  return `ed25519:${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

/** A new Ed25519 key pair as PEM. */
export function generateSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    keyId: keyId(publicKey),
  };
}

/** Sign a lock digest; returns the signature as base64. */
export function signDigest(digest: string, key: KeyInput): string {
  return sign(null, message(digest), privateKeyOf(key)).toString('base64');
}

/** Whether `signature` (base64) is a valid signature of the lock digest by `key`. */
export function verifyDigest(digest: string, signature: string, key: KeyInput): boolean {
  try {
    return verify(null, message(digest), publicKeyOf(key), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export interface TrustedKeySet {
  /** By key id. */
  keys: Map<string, { name: string; key: KeyObject }>;
}

/**
 * Index trusted keys by key id. A string may hold several PEM blocks. Throws when a key
 * cannot be read or is not Ed25519.
 */
export function trustedKeySet(keys: readonly TrustedKey[]): TrustedKeySet {
  const out = new Map<string, { name: string; key: KeyObject }>();
  const add = (input: KeyInput, name?: string) => {
    const key = publicKeyOf(input);
    const id = keyId(key);
    out.set(id, { name: name ?? id, key });
  };
  for (const k of keys) {
    if (typeof k === 'string') {
      const blocks = pemBlocks(k);
      if (!blocks.length) throw new Error('a trusted key holds no PEM block');
      for (const b of blocks) add(b);
    } else if (k instanceof KeyObject) add(k);
    else add(k.key, k.name);
  }
  return { keys: out };
}
