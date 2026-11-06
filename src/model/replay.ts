import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from '../snapshot/digest.ts';
import type { ModelClient, ModelMode, ModelRequest, ModelTurn } from './types.ts';
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

/**
 * Digest of a request for a given model id and mode (changing the model, its effort or how
 * it is driven invalidates replays). The `tools` key leaves the mode out, so it is the key
 * every cassette recorded before modes existed already uses (ADR 0017).
 */
export function requestKey(req: ModelRequest, model: string, mode: ModelMode = 'tools'): string {
  return sha256(canonicalJson(mode === 'tools' ? { model, request: req } : { model, mode, request: req }));
}

const MODES: readonly ModelMode[] = ['tools', 'json'];

/** The recorded turn for a request: under the given mode's key, or under any mode's. */
function lookup(
  c: Cassette,
  req: ModelRequest,
  mode: ModelMode | undefined,
): { key: string; turn: ModelTurn } | undefined {
  for (const m of mode ? [mode] : MODES) {
    const key = requestKey(req, c.model, m);
    const turn = c.turns[key];
    if (turn) return { key, turn };
  }
  return undefined;
}

export interface ReplayOptions {
  /** Only replay turns recorded in this mode (default: either). */
  mode?: ModelMode;
}

function load(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
}

/** A recording or replaying client also exposes what is recorded: the model and when. */
export interface ReplayModel extends ModelClient {
  readonly recorded: { model: string; at: string };
}

/** In every error about a request a cassette cannot answer: callers treat it as a stale cassette. */
export const NO_RECORDING = 'has no recording for this request';

/** Provenance time for cassettes recorded before `recordedAt` was kept: fixed, so replays stay identical. */
export const UNRECORDED_AT = '1970-01-01T00:00:00.000Z';

export function replayModel(path: string, opts: ReplayOptions = {}): ReplayModel {
  const cassette = load(path);
  if (!cassette) throw new ModelError(`No cassette at ${path}. Set ANTHROPIC_API_KEY to record one.`);
  return {
    id: `${cassette.model} (replay)`,
    recorded: { model: cassette.model, at: cassette.recordedAt ?? UNRECORDED_AT },
    async turn(req) {
      const hit = lookup(cassette, req, opts.mode)?.turn;
      if (!hit) {
        throw new ModelError(
          `Cassette ${path} ${NO_RECORDING}; the prompt, tools or inputs changed. Re-record with ANTHROPIC_API_KEY set.`,
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
    // Like a replay until a turn is recorded live, so reports read the same as a plain replay.
    get id() {
      return misses ? old.model : `${old.model} (replay)`;
    },
    recorded,
    get misses() {
      return misses;
    },
    async turn(req) {
      const found = lookup(old, req, undefined);
      if (found) {
        fresh.turns[found.key] = found.turn;
        return structuredClone(found.turn);
      }
      // Every failure to fill the gap reads as a stale cassette (NO_RECORDING), never as a model outcome.
      const stale = (why: string) =>
        new ModelError(`Cassette ${path} ${NO_RECORDING}, and it could not be recorded: ${why}`);
      try {
        inner ??= await live();
      } catch (e) {
        throw stale(e instanceof Error ? e.message : String(e));
      }
      if (inner.id !== old.model) throw stale(`it was recorded with ${old.model}, not ${inner.id}; re-record it`);
      let out: ModelTurn;
      try {
        out = await inner.turn(req);
      } catch (e) {
        throw stale(e instanceof Error ? e.message : String(e));
      }
      misses++;
      fresh.recordedAt ??= new Date().toISOString();
      fresh.turns[requestKey(req, old.model, out.mode)] = out;
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
      const out = await inner.turn(req);
      cassette.turns[requestKey(req, inner.id, out.mode)] = out;
      write(partial);
      return out;
    },
    save() {
      write(partial);
      renameSync(partial, path);
    },
  };
}
