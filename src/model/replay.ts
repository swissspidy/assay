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
  readonly recorded: { model: string; at: string };
}

/** Provenance time for cassettes recorded before `recordedAt` was kept: fixed, so replays stay identical. */
export const UNRECORDED_AT = '1970-01-01T00:00:00.000Z';

export function replayModel(path: string): ReplayModel {
  const cassette = load(path);
  if (!cassette) throw new ModelError(`No cassette at ${path}. Set ANTHROPIC_API_KEY to record one.`);
  return {
    id: `${cassette.model} (replay)`,
    recorded: { model: cassette.model, at: cassette.recordedAt ?? UNRECORDED_AT },
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
 * Replays the turns an existing cassette has and records the ones it lacks with a
 * live model, created on the first miss only. A run whose every turn is recorded
 * leaves the cassette as it was (`save()` writes nothing), so a replay stays byte for
 * byte; after a miss, `save()` writes a fresh cassette with exactly the turns this
 * run used, stamped with the time of the first miss. Used by the scripts when a
 * prompt change invalidates only some steps (e.g. discovery, not the rubric).
 */
export function replayOrRecordModel(
  path: string,
  live: () => Promise<ModelClient>,
): ReplayModel & { save(): void; readonly misses: number } {
  const old = load(path);
  if (!old) throw new ModelError(`No cassette at ${path}.`);
  const fresh: Cassette = { schema: 'assay.cassette/v1', model: old.model, turns: {} };
  let inner: ModelClient | undefined;
  let misses = 0;
  const recorded = {
    model: old.model,
    get at() {
      return fresh.recordedAt ?? old.recordedAt ?? UNRECORDED_AT;
    },
  };
  return {
    id: old.model,
    recorded,
    get misses() {
      return misses;
    },
    async turn(req) {
      const key = requestKey(req, old.model);
      const hit = old.turns[key];
      if (hit) {
        fresh.turns[key] = hit;
        return structuredClone(hit);
      }
      inner ??= await live();
      if (inner.id !== old.model)
        throw new ModelError(`Cassette ${path} was recorded with ${old.model}, not ${inner.id}; re-record it.`);
      misses++;
      fresh.recordedAt ??= new Date().toISOString();
      const out = await inner.turn(req);
      fresh.turns[key] = out;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.partial`, JSON.stringify(fresh, null, 1) + '\n');
      return out;
    },
    save() {
      if (!misses) return;
      writeFileSync(`${path}.partial`, JSON.stringify(fresh, null, 1) + '\n');
      renameSync(`${path}.partial`, path);
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
