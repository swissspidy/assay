/**
 * Picks the model for scripts: with ANTHROPIC_API_KEY set (and ASSAY_MODEL_MODE
 * not "replay"), runs live and records a cassette; otherwise replays the
 * cassette so results are reproducible in CI without a key.
 */
import { existsSync } from 'node:fs';
import { anthropicModel, recordingModel, replayModel, type ModelClient } from '../src/index.ts';

export interface EnvModel {
  model: ModelClient;
  mode: 'live' | 'replay';
  save(): void;
}

export async function modelFromEnv(cassette: string): Promise<EnvModel> {
  const mode = process.env.ASSAY_MODEL_MODE;
  if (process.env.ANTHROPIC_API_KEY && mode !== 'replay') {
    const rec = recordingModel(await anthropicModel(), cassette);
    return { model: rec, mode: 'live', save: () => rec.save() };
  }
  if (!existsSync(cassette)) {
    throw new Error(`No cassette at ${cassette} and no ANTHROPIC_API_KEY: set the key to compile live.`);
  }
  return { model: replayModel(cassette), mode: 'replay', save: () => {} };
}
