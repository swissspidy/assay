/** `assay init`: write assay.config.ts with sensible defaults and the three model forms (ADR 0017). */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILES, findConfig } from '../../config/config.ts';
import { CliError, EXIT, type Invocation, type Io } from '../io.ts';

export const CONFIG_TEMPLATE = `import { defineConfig } from '@swissspidy/assay';

export default defineConfig({
  // The model that compiles checks (assay compile) and decides what the checks abstain on
  // (escalation). Verifying, stress-testing and validating never need one. Three forms:
  //
  // 1. A "provider:model" string, resolved through the provider's AI SDK package:
  //      npm i -D ai @ai-sdk/anthropic      (and set ANTHROPIC_API_KEY)
  model: 'anthropic:claude-opus-5-5',
  //    Others: 'openai:gpt-5', 'google:gemini-2.5-pro', 'ollama:llama3.1' (ollama-ai-provider-v2), ...
  //
  // 2. Any Vercel AI SDK language model:
  //      import { openai } from '@ai-sdk/openai';
  //      model: openai('gpt-5'),
  //
  // 3. Your own adapter, no AI SDK needed. It gets Assay's request (system, messages, tools)
  //    and returns one turn (stop, text, toolCalls, raw, usage, model):
  //      model: { id: 'my-llm', async turn(request) { ... } },
  //    Add \`capabilities: { tools: false }\` if it cannot call tools: Assay then sends no tools
  //    and drives it with JSON prompts, validating every reply.
  //
  // Models without tool calling fall back to JSON mode by themselves; to force a mode:
  // modelOptions: { mode: 'json' },

  // Where check sets live (assay validate with no files checks them all).
  checks: 'checks',
  // Where assay capture writes snapshots.
  snapshots: 'snapshots',
  // Write an outcome record for every verify.
  // recordDir: 'assay-records',

  // Escalate what the checks abstain on to the agentic verifier, with \`model\`.
  // escalate: true,

  // Refuse check sets nobody approved; 'signed' also needs a trusted key's signature.
  // requireLocked: 'signed',
  // trustedKeys: ['keys/'],

  // Stress test defaults: variants that do not apply to your tasks.
  // stress: { skipVariants: [] },

  // Models to compare with \`assay bench\` (default: \`model\`); tasks' runs in references/<task>/.
  // bench: { models: ['anthropic:claude-opus-5-5', 'openai:gpt-5', './my-adapter.ts'] },
});
`;

export async function run({ values }: Invocation, io: Io): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const file = join(cwd, CONFIG_FILES[0]);
  const existing = findConfig(cwd);
  if (existing && !(values.force && existing === file)) {
    throw new CliError(
      `${existing} already exists${existing === file ? ' (--force replaces it)' : '; remove it to create assay.config.ts'}`,
    );
  }
  writeFileSync(file, CONFIG_TEMPLATE);
  if (values.json) {
    io.out(JSON.stringify({ file }));
    return EXIT.ok;
  }
  io.out(`Created ${file}`);
  io.out(
    existsSync(join(cwd, 'node_modules', '@ai-sdk', 'anthropic'))
      ? 'Next: set ANTHROPIC_API_KEY, or change `model` to the model you use.'
      : 'Next: npm i -D ai @ai-sdk/anthropic and set ANTHROPIC_API_KEY, or change `model` to the model you use.',
  );
  return EXIT.ok;
}
