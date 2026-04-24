/**
 * ChatAwsBedrockAdvancedStreaming — subclass of PatchedChatBedrockConverse that
 * side-channels text deltas to an HTTP callback during streaming generation.
 *
 * Design constraint mirrored from PRP-1 (wrong-parent, removed in C3): the
 * Patched base class must NOT be modified (diff=0 for its .ts after this
 * commit). This is achieved by overriding only `_streamResponseChunks` and
 * delegating to `super._streamResponseChunks(...)` — the super call hits the
 * Patched class's version, which in turn hits ChatBedrockConverse's version,
 * preserving sanitize + cache-inject + stream-metrics behavior unchanged.
 *
 * When `streamCallbackUrl` is empty, `createStreamCallback` returns a no-op
 * session and the yielded `ChatGenerationChunk` sequence is byte-identical to
 * PatchedChatBedrockConverse's own `_streamResponseChunks` output for the same
 * input. Verified in ChatAwsBedrockAdvancedStreaming.test.ts.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

import {
	PatchedChatBedrockConverse,
	type PatchedChatBedrockConverseInput,
} from '../LmChatAwsBedrockAdvanced/PatchedChatBedrockConverse';
import { createStreamCallback, type StreamCallbackConfig } from './streamCallback';

export interface ChatAwsBedrockAdvancedStreamingInput extends PatchedChatBedrockConverseInput {
	streamCallbackUrl?: string;
	streamSessionId?: string;
	streamAuthHeaderValue?: string;
	streamBatchIntervalMs?: number;   // default 60
	streamMaxBatchChars?: number;     // default 120
}

export class ChatAwsBedrockAdvancedStreaming extends PatchedChatBedrockConverse {
	private readonly streamCfg: StreamCallbackConfig;

	constructor(fields: ChatAwsBedrockAdvancedStreamingInput) {
		super(fields);
		this.streamCfg = {
			callbackUrl:      fields.streamCallbackUrl,
			sessionId:        fields.streamSessionId,
			authHeaderValue:  fields.streamAuthHeaderValue,
			batchIntervalMs:  fields.streamBatchIntervalMs ?? 60,
			maxBatchChars:    fields.streamMaxBatchChars   ?? 120,
			logger:           fields.patchLogger,
		};
		// This subclass exists for streaming; force it on regardless of the caller's intent.
		this.streaming = true;
	}

	_llmType(): string {
		return 'bedrock-advanced-streaming';
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
