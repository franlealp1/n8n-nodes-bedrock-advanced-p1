/**
 * ChatBedrockClaudeStreaming — subclass of ChatBedrockClaude that side-channels text deltas
 * to an HTTP callback during streaming generation.
 *
 * Design constraint: the original `ChatBedrockClaude.ts` must NOT be modified (diff=0 vs
 * main). This is achieved by overriding only `_streamResponseChunks` and delegating to
 * `super._streamResponseChunks(...)` — we never need access to `buildRequestBody` (private)
 * or any other internal of the base class.
 *
 * When `streamCallbackUrl` is empty, `createStreamCallback` returns a no-op session and the
 * yielded `ChatGenerationChunk` sequence is byte-identical to the base class's output for
 * the same input. Verified by a test in ChatBedrockClaudeStreaming.test.ts.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

import { ChatBedrockClaude, type ChatBedrockClaudeInput } from '../LmChatBedrockClaude/ChatBedrockClaude';
import { createStreamCallback, type StreamCallbackConfig } from './streamCallback';

export interface ChatBedrockClaudeStreamingInput extends ChatBedrockClaudeInput {
	streamCallbackUrl?: string;
	streamSessionId?: string;
	streamAuthHeaderValue?: string;
	streamBatchIntervalMs?: number;   // default 60
	streamMaxBatchChars?: number;     // default 120
}

export class ChatBedrockClaudeStreaming extends ChatBedrockClaude {
	private readonly streamCfg: StreamCallbackConfig;

	constructor(fields: ChatBedrockClaudeStreamingInput) {
		super(fields);
		this.streamCfg = {
			callbackUrl:      fields.streamCallbackUrl,
			sessionId:        fields.streamSessionId,
			authHeaderValue:  fields.streamAuthHeaderValue,
			batchIntervalMs:  fields.streamBatchIntervalMs ?? 60,
			maxBatchChars:    fields.streamMaxBatchChars   ?? 120,
			logger:           fields.logger ?? undefined,
		};
		// This subclass exists for streaming; force it on regardless of the caller's intent.
		// (See plan Notes → "Why force this.streaming = true in the subclass constructor".)
		this.streaming = true;
	}

	_llmType(): string {
		return 'bedrock-claude-streaming';
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		const session = createStreamCallback(this.streamCfg);
		try {
			for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
				session.appendIfText(chunk);
				yield chunk;
			}
		} finally {
			await session.flushFinal();
		}
	}
}
