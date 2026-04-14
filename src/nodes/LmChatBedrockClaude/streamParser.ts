/**
 * Parses Anthropic streaming responses from Bedrock InvokeModelWithResponseStream.
 *
 * Bedrock returns the response as a sequence of binary chunks, each containing
 * a JSON event from the Anthropic Messages API streaming format.
 *
 * Event types:
 *   message_start      → contains usage.input_tokens
 *   content_block_start → starts a new text/tool_use block
 *   content_block_delta → incremental text or tool input
 *   content_block_stop  → ends the current block
 *   message_delta       → stop_reason and output token count
 *   message_stop        → stream complete
 */

import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';

export interface StreamState {
	currentBlockType: string | null;
	currentBlockIndex: number;
	currentToolCallId: string;
	currentToolCallName: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	stopReason: string | null;
}

export function createStreamState(): StreamState {
	return {
		currentBlockType: null,
		currentBlockIndex: -1,
		currentToolCallId: '',
		currentToolCallName: '',
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		stopReason: null,
	};
}

/**
 * Parse a single streaming event and return a ChatGenerationChunk if applicable.
 */
export function parseStreamEvent(
	event: any,
	state: StreamState,
): ChatGenerationChunk | null {
	const eventType = event.type;

	switch (eventType) {
		case 'message_start': {
			const usage = event.message?.usage;
			if (usage) {
				state.inputTokens = usage.input_tokens || 0;
				state.cacheReadInputTokens = usage.cache_read_input_tokens || 0;
				state.cacheCreationInputTokens = usage.cache_creation_input_tokens || 0;
			}
			return null;
		}

		case 'content_block_start': {
			state.currentBlockIndex = event.index ?? state.currentBlockIndex + 1;
			const block = event.content_block;
			if (!block) return null;

			state.currentBlockType = block.type;

			if (block.type === 'compaction') {
				// Compaction block arrives as a single complete block in the stream
				return new ChatGenerationChunk({
					text: block.content || '',
					message: new AIMessageChunk({
						content: block.content || '',
					}),
				});
			}

			if (block.type === 'tool_use') {
				state.currentToolCallId = block.id || '';
				state.currentToolCallName = block.name || '';
				return new ChatGenerationChunk({
					text: '',
					message: new AIMessageChunk({
						content: '',
						tool_call_chunks: [{
							id: block.id,
							name: block.name,
							args: '',
							index: state.currentBlockIndex,
							type: 'tool_call_chunk',
						}],
					}),
				});
			}

			if (block.type === 'server_tool_use') {
				// Server-side tools (tool_search, web_search) are executed by Anthropic's
				// servers. Skip emitting them as tool_call_chunks to prevent the agent
				// framework from trying to execute them locally (which causes infinite loops).
				state.currentBlockType = 'server_tool_use';
				return null;
			}

			return null;
		}

		case 'content_block_delta': {
			const delta = event.delta;
			if (!delta) return null;

			if (delta.type === 'text_delta' && delta.text) {
				return new ChatGenerationChunk({
					text: delta.text,
					message: new AIMessageChunk({
						content: delta.text,
					}),
				});
			}

			if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
				// Skip deltas for server-side tool blocks
				if (state.currentBlockType === 'server_tool_use') {
					return null;
				}
				return new ChatGenerationChunk({
					text: '',
					message: new AIMessageChunk({
						content: '',
						tool_call_chunks: [{
							id: state.currentToolCallId,
							name: state.currentToolCallName,
							args: delta.partial_json,
							index: state.currentBlockIndex,
							type: 'tool_call_chunk',
						}],
					}),
				});
			}

			return null;
		}

		case 'content_block_stop': {
			state.currentBlockType = null;
			return null;
		}

		case 'message_delta': {
			const delta = event.delta;
			if (delta?.stop_reason) {
				state.stopReason = delta.stop_reason;
			}
			const usage = event.usage;
			if (usage?.output_tokens) {
				state.outputTokens = usage.output_tokens;
			}

			// Emit a final chunk with usage metadata
			return new ChatGenerationChunk({
				text: '',
				message: new AIMessageChunk({
					content: '',
					response_metadata: {
						stop_reason: state.stopReason,
						usage: {
							input_tokens: state.inputTokens,
							output_tokens: state.outputTokens,
							cache_read_input_tokens: state.cacheReadInputTokens,
							cache_creation_input_tokens: state.cacheCreationInputTokens,
						},
					},
					usage_metadata: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						total_tokens: state.inputTokens + state.outputTokens,
						input_token_details: {
							cache_read: state.cacheReadInputTokens,
							cache_creation: state.cacheCreationInputTokens,
						},
					},
				}),
				generationInfo: {
					stop_reason: state.stopReason,
				},
			});
		}

		case 'message_stop': {
			return null;
		}

		default:
			return null;
	}
}
