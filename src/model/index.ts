/** `@swissspidy/assay/models`: the provider-neutral agent loop, cassettes and the Anthropic adapter. */
export * from './types.ts';
export { runAgent, type AgentTool, type AgentRun, type AgentOptions, type ToolOutcome } from './agent.ts';
export { replayModel, recordingModel, requestKey, UNRECORDED_AT, type Cassette, type ReplayModel } from './replay.ts';
export {
  anthropicModel,
  toAnthropicMessages,
  fromAnthropicMessage,
  type AnthropicOptions,
  type AnthropicLike,
} from './anthropic.ts';
