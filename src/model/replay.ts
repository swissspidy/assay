import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /** When the recording started (ISO 8601); absent on cassettes recorded before it was kept. */
  recordedAt?: string;
  turns: Record<string, ModelTurn>;
}

/** Digest of a request for a given model id (changing the model or its effort invalidates replays). */
export function requestKey(req: ModelRequest, model: string): string {
  return sha256(canonicalJson({ model, request: req }));
}

function load(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
}

/** A recording or replaying client also exposes what is recorded: the model and when. */
export interface ReplayModel extends ModelClient {
  readonly recorded: { model: string; at?: string };
}

export function replayModel(path: string): ReplayModel {
  const cassette = load(path);
  if (!cassette) throw new ModelError(`No cassette at ${path}. Set ANTHROPIC_API_KEY to record one.`);
  return {
    id: `${cassette.model} (replay)`,
    recorded: { model: cassette.model, ...(cassette.recordedAt ? { at: cassette.recordedAt } : {}) },
    async turn(req) {
      const hit = cassette.turns[requestKey(req, cassette.model)];
      if (!hit) {
        throw new ModelError(
          `Cassette ${path} has no recording for this request; the prompt, tools or inputs changed. Re-record with ANTHROPIC_API_KEY set.`,
        );
      }
      return structuredClone(hit);
    },
  };
}

/**
 * Wraps a live model and records every turn into a fresh cassette. While the run
 * is in progress, turns are written to `<path>.partial` after each turn (so a
 * crash keeps what was already paid for without replacing a complete cassette);
 * `save()` moves it into place.
 */
export function recordingModel(inner: ModelClient, path: string): ReplayModel & { save(): void } {
  const cassette: Cassette = {
    schema: 'assay.cassette/v1',
    model: inner.id,
    recordedAt: new Date().toISOString(),
    turns: {},
  };
  const partial = `${path}.partial`;
  const write = (file: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cassette, null, 1) + '\n');
  };
  return {
    id: inner.id,
    recorded: { model: cassette.model, at: cassette.recordedAt! },
    async turn(req) {
      const key = requestKey(req, inner.id);
      const out = await inner.turn(req);
      cassette.turns[key] = out;
      write(partial);
      return out;
    },
    save() {
      write(partial);
      renameSync(partial, path);
    },
  };
}
