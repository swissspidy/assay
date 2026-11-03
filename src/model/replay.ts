import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from '../snapshot/digest.ts';
import type { ModelClient, ModelRequest, ModelTurn } from './types.ts';
import { ModelError } from './types.ts';

/**
 * Cassettes make model-driven steps reproducible: a live run records every
 * turn keyed by a digest of the full request; CI replays them without a key.
 * Because tools are deterministic (snapshots are fixed, evaluation is pure), a
 * replayed run issues exactly the recorded requests.
 */
export interface Cassette {
  schema: 'assay.cassette/v1';
  model: string;
  turns: Record<string, ModelTurn>;
}

export function requestKey(req: ModelRequest): string {
  return sha256(canonicalJson(req));
}

function load(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
}

export function replayModel(path: string): ModelClient {
  const cassette = load(path);
  if (!cassette) throw new ModelError(`No cassette at ${path}. Set ANTHROPIC_API_KEY to record one.`);
  return {
    id: `${cassette.model} (replay)`,
    async turn(req) {
      const hit = cassette.turns[requestKey(req)];
      if (!hit) {
        throw new ModelError(
          `Cassette ${path} has no recording for this request; the prompt, tools or inputs changed. Re-record with ANTHROPIC_API_KEY set.`,
        );
      }
      return structuredClone(hit);
    },
  };
}

/** Wraps a live model and writes every turn to the cassette (replacing it). */
export function recordingModel(inner: ModelClient, path: string): ModelClient & { save(): void } {
  const cassette: Cassette = { schema: 'assay.cassette/v1', model: inner.id, turns: {} };
  return {
    id: inner.id,
    async turn(req) {
      const out = await inner.turn(req);
      cassette.turns[requestKey(req)] = out;
      return out;
    },
    save() {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cassette, null, 1) + '\n');
    },
  };
}
