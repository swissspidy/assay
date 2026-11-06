/** `@swissspidy/assay/models`: the provider-neutral agent loop, cassettes, JSON mode, model resolution and the Anthropic adapter. */
export * from './types.ts';
export { runAgent, type AgentTool, type AgentRun, type AgentOptions, type ToolOutcome } from './agent.ts';
export {
  replayModel,
  recordingModel,
  requestKey,
  UNRECORDED_AT,
  type Cassette,
  type ReplayModel,
  type ReplayOptions,
} from './replay.ts';
export { jsonModeModel, isJsonModeModel, parseJsonReply, type ParsedReply } from './json-mode.ts';
export { resolveModel, PROVIDERS, type ModelInput, type ModelOptions, type LanguageModelLike } from './resolve.ts';
export {
  anthropicModel,
  toAnthropicMessages,
  fromAnthropicMessage,
  type AnthropicOptions,
  type AnthropicLike,
} from './anthropic.ts';
