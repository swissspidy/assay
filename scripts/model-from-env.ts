/**
 * Picks the model for scripts. An existing cassette is replayed, so results are
 * reproducible in CI without a key and a re-run does not pay twice. A missing
 * cassette is recorded live when ANTHROPIC_API_KEY is set.
 *
 * ASSAY_MODEL_MODE=replay never calls the model; ASSAY_MODEL_MODE=record
 * re-records every cassette (needs the key), e.g. after a prompt change.
 */
import { existsSync } from 'node:fs';
import { anthropicModel, recordingModel, replayModel, type ModelClient } from '../src/index.ts';

export interface EnvModel {
  model: ModelClient;
  mode: 'live' | 'replay';
  /** What to record as the model's provenance: the recorded model and time when replaying. */
  provenance: { model: string; at?: string };
  save(): void;
}

export async function modelFromEnv(cassette: string): Promise<EnvModel> {
  const mode = process.env.ASSAY_MODEL_MODE;
  if (mode !== undefined && mode !== '' && mode !== 'replay' && mode !== 'record') {
    throw new Error(`ASSAY_MODEL_MODE must be "replay" or "record", got ${JSON.stringify(mode)}`);
  }
  const record = mode === 'record' || (mode !== 'replay' && !existsSync(cassette));
  if (mode === 'record' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ASSAY_MODEL_MODE=record needs ANTHROPIC_API_KEY.');
  }
  if (record && process.env.ANTHROPIC_API_KEY) {
    const rec = recordingModel(await anthropicModel(), cassette);
    return { model: rec, mode: 'live', provenance: rec.recorded, save: () => rec.save() };
  }
  if (!existsSync(cassette)) {
    throw new Error(`No cassette at ${cassette} and no ANTHROPIC_API_KEY: set the key to compile live.`);
  }
  const model = replayModel(cassette);
  return { model, mode: 'replay', provenance: model.recorded, save: () => {} };
}
