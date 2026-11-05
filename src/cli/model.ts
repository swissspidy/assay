/**
 * Model selection for the CLI, consistent with the library's adapters and the
 * repository's scripts:
 *
 * - `--provider` / $ASSAY_PROVIDER: "anthropic" (default, `anthropicModel` from
 *   `/models`) or "ai-sdk" (`aiSdkModel` from `/ai-sdk`, with a model id string
 *   for the AI SDK's default provider).
 * - `--model` / $ASSAY_MODEL: the model id.
 * - `--cassette <file>`: replay an existing cassette, else record a live run to it.
 *   ASSAY_MODEL_MODE=replay never calls a model; ASSAY_MODEL_MODE=record re-records.
 */
import { existsSync } from 'node:fs';
import type { ModelClient } from '../model/types.ts';
import { CliError, UsageError, type Values } from './io.ts';

export interface SelectedModel {
  model: ModelClient;
  mode: 'live' | 'record' | 'replay';
  /** The recorded model and time for a cassette (what the compiler writes as provenance). */
  provenance?: { model: string; at: string };
  /** Move a recorded cassette into place (no-op when nothing was recorded, or when replaying). */
  save(): void;
}

export type Provider = 'anthropic' | 'ai-sdk';

export function providerOf(values: Values, env: Record<string, string | undefined>): Provider {
  const p = (values.provider as string | undefined) ?? (env.ASSAY_PROVIDER || 'anthropic');
  if (p !== 'anthropic' && p !== 'ai-sdk')
    throw new UsageError(`--provider must be "anthropic" or "ai-sdk", got ${JSON.stringify(p)}`);
  return p;
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND';

async function liveModel(provider: Provider, id: string | undefined, env: Record<string, string | undefined>) {
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      throw new CliError('no model key: set ANTHROPIC_API_KEY, or pass --cassette <file> to replay a recording.');
    }
    const { anthropicModel } = await import('../model/anthropic.ts');
    return anthropicModel(id ? { model: id } : {});
  }
  if (!id) throw new UsageError('--provider ai-sdk needs a model id: --model or ASSAY_MODEL');
  const { aiSdkModel } = await import('../model/ai-sdk.ts').catch((e: unknown) => {
    throw missing(e) ? new CliError('--provider ai-sdk requires the optional dependency `ai` (npm i ai).') : e;
  });
  return aiSdkModel(id);
}

export async function selectModel(values: Values, env: Record<string, string | undefined>): Promise<SelectedModel> {
  const provider = providerOf(values, env);
  const id = (values.model as string | undefined) ?? (env.ASSAY_MODEL || undefined);
  const cassette = values.cassette as string | undefined;
  const mode = env.ASSAY_MODEL_MODE || undefined;
  if (mode !== undefined && mode !== 'replay' && mode !== 'record') {
    throw new CliError(`ASSAY_MODEL_MODE must be "replay" or "record", got ${JSON.stringify(mode)}`);
  }
  const { recordingModel, replayModel } = await import('../model/replay.ts');
  if (!cassette) {
    if (mode) throw new UsageError(`ASSAY_MODEL_MODE=${mode} needs --cassette <file>`);
    return { model: await liveModel(provider, id, env), mode: 'live', save: () => {} };
  }
  const exists = existsSync(cassette);
  if (mode === 'replay' || (exists && mode !== 'record')) {
    if (!exists) throw new CliError(`no cassette at ${cassette} (ASSAY_MODEL_MODE=replay never calls a model)`);
    const model = replayModel(cassette);
    return { model, mode: 'replay', provenance: model.recorded, save: () => {} };
  }
  const rec = recordingModel(await liveModel(provider, id, env), cassette);
  // Saved only when a turn was recorded: an empty recording must not replace a cassette.
  let turns = 0;
  const model: ModelClient = {
    id: rec.id,
    async turn(req) {
      const out = await rec.turn(req);
      turns++;
      return out;
    },
  };
  return { model, mode: 'record', provenance: rec.recorded, save: () => turns > 0 && rec.save() };
}
