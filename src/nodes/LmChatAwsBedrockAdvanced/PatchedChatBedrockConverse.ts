/**
 * PatchedChatBedrockConverse — ChatBedrockConverse subclass with Bedrock-Converse
 * patches applied: empty-content sanitize, prompt-caching injection (legacy +
 * multi-cachepoint), cache metrics on response_metadata / usage_metadata /
 * llmOutput.tokenUsage, and stream-path cache metrics.
 *
 * Extracted from the inline class that lived inside
 * LmChatAwsBedrockAdvanced.node.ts supplyData() (L528-685 pre-PRP-1b). The
 * three closure captures of that inline class (options, logger, modelName)
 * are now explicit constructor-set fields:
 *
 *   - options   → this.patchOptions  (required; set from getNodeParameter)
 *   - logger    → this.patchLogger   (optional; NOOP_LOGGER fallback)
 *   - modelName → this.model         (already public on ChatBedrockConverse
 *                                     per @langchain/aws v0.1.4 d.ts L574)
 *
 * Behavior is byte-identical to the inline class (verified by
 * PatchedChatBedrockConverse.test.ts). Prepared for reuse by a streaming
 * sibling node (PRP-1b/C2 — LmChatAwsBedrockAdvancedStreaming).
 */

import { ChatBedrockConverse, type ChatBedrockConverseInput } from '@langchain/aws';

import { injectCachePoints } from './injectCachePoints';

export interface PatchOptions {
	temperature?: number;
	maxTokensToSample?: number;
	enablePromptCaching?: boolean;
	cacheSystemPrompt?: boolean;
	cacheTools?: boolean;
	cacheConversationHistory?: boolean;
	cacheTtl?: string;
	systemPromptBlocks?: string | string[];
	enableDebugLogs?: boolean;
}

export interface PatchLogger {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
}

export interface PatchedChatBedrockConverseInput extends ChatBedrockConverseInput {
	patchOptions: PatchOptions;
	patchLogger?: PatchLogger;
}

const NOOP_LOGGER: PatchLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

export class PatchedChatBedrockConverse extends ChatBedrockConverse {
	protected readonly patchOptions: PatchOptions;
	protected readonly patchLogger: PatchLogger;

	constructor(fields: PatchedChatBedrockConverseInput) {
		super(fields);
		this.patchOptions = fields.patchOptions;
		this.patchLogger = fields.patchLogger ?? NOOP_LOGGER;
	}

	invocationParams(invokeOptions?: any): any {
		const params = super.invocationParams(invokeOptions);
		if (this.patchOptions.cacheTools && params.toolConfig?.tools?.length) {
			const ttl = this.patchOptions.cacheTtl === '1h' ? '1h' : '5m';
			params.toolConfig = {
				...params.toolConfig,
				tools: [...params.toolConfig.tools, { cachePoint: { type: 'default', ttl } }],
			};
		}
		return params;
	}

	// FIX: Bedrock Converse API rejects messages with empty content.
	// This can happen with AI messages from chat history that had no text
	// and whose tool_calls were not preserved during serialization.
	private sanitizeMessages(messages: any[]): any[] {
		return messages.map(msg => {
			const msgType = msg._getType?.() ?? msg.getType?.();
			if (msgType !== 'ai') return msg;
			if (msg.tool_calls?.length > 0) return msg;
			const hasContent =
				(typeof msg.content === 'string' && msg.content.length > 0) ||
				(Array.isArray(msg.content) && msg.content.length > 0);
			if (hasContent) return msg;
			const newMsg = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg);
			newMsg.content = '.';
			return newMsg;
		});
	}

	async _generateNonStreaming(messages: any[], invokeOptions: any, runManager?: any) {
		const sanitized = this.sanitizeMessages(messages);
		const modifiedMessages = this.patchOptions.enablePromptCaching
			? injectCachePoints(sanitized, this.patchOptions, this.patchLogger)
			: sanitized;
		if (this.patchOptions.enableDebugLogs) {
			this.patchLogger.info('[BedrockAdvanced] modifiedMessages: ' + JSON.stringify(modifiedMessages));
		}
		return super._generateNonStreaming(modifiedMessages, invokeOptions, runManager);
	}

	// P1 patch: cache metrics in tokenUsage for N8nLlmTracing visibility
	// + populate response_metadata & usage_metadata so intermediateSteps carries token data
	async _generate(messages: any[], generateOptions: any, runManager?: any) {
		const response = await super._generate(messages, generateOptions, runManager);

		if (this.patchOptions.enableDebugLogs) {
			this.patchLogger.info('[BedrockAdvanced] response: ' + JSON.stringify(response));
		}

		const rawUsage = response.llmOutput?.usage
			|| response.generations[0]?.message?.response_metadata?.usage
			|| {};
		const cacheRead = rawUsage.cacheReadInputTokens || 0;
		const cacheWrite = rawUsage.cacheWriteInputTokens || 0;

		const usageMeta = (response.generations?.[0]?.message as any)?.usage_metadata;
		const inputTokens = usageMeta?.input_tokens ?? 0;
		const outputTokens = usageMeta?.output_tokens ?? 0;

		if (response.generations?.length > 0) {
			const msg = response.generations[0].message as any;
			if (!msg.response_metadata) msg.response_metadata = {};

			// P1 patch: custom metrics (kept for backward compat)
			msg.response_metadata.promptCachingMetrics = this.formatCacheMetrics(cacheRead, cacheWrite);

			// P1 patch: standard fields so intermediateSteps carries token data
			// The Metrics Analyzer reads these from step.action.messageLog[].kwargs
			msg.response_metadata.usage = {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: cacheWrite,
			};
			msg.response_metadata.tokenUsage = {
				cacheReadInputTokens: cacheRead,
				cacheWriteInputTokens: cacheWrite,
			};
			msg.response_metadata.model_name = this.model;

			// Set on additional_kwargs — survives LangChain serialization to intermediateSteps
			if (!msg.additional_kwargs) msg.additional_kwargs = {};
			msg.additional_kwargs.model = this.model;

			// P1 patch: ensure usage_metadata exists with standard fields
			msg.usage_metadata = {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				total_tokens: inputTokens + outputTokens,
				input_token_details: {
					cache_read: cacheRead,
					cache_creation: cacheWrite,
				},
			};

			if (this.patchOptions.enableDebugLogs) {
				this.patchLogger.info('[BedrockAdvanced] response_metadata.usage: ' + JSON.stringify(msg.response_metadata.usage));
				this.patchLogger.info('[BedrockAdvanced] usage_metadata: ' + JSON.stringify(msg.usage_metadata));
			}
		}

		// P1 patch: tokenUsage with cache metrics for N8nLlmTracing
		if (usageMeta) {
			response.llmOutput = {
				...response.llmOutput,
				tokenUsage: {
					completionTokens: outputTokens,
					promptTokens: inputTokens,
					totalTokens: inputTokens + outputTokens,
					cacheReadInputTokens: cacheRead,
					cacheWriteInputTokens: cacheWrite,
				},
			};
		}

		return response;
	}

	async *_streamResponseChunks(messages: any[], generateOptions: any, runManager?: any) {
		const sanitized = this.sanitizeMessages(messages);
		const modifiedMessages = this.patchOptions.enablePromptCaching
			? injectCachePoints(sanitized, this.patchOptions, this.patchLogger)
			: sanitized;
		if (this.patchOptions.enableDebugLogs) {
			this.patchLogger.info('[BedrockAdvanced] [stream] modifiedMessages: ' + JSON.stringify(modifiedMessages));
		}

		const stream = super._streamResponseChunks(modifiedMessages, generateOptions, runManager);

		for await (const chunk of stream) {
			if (chunk.message?.response_metadata?.usage) {
				const rawUsage = chunk.message.response_metadata.usage;
				const cacheRead = rawUsage.cacheReadInputTokens || 0;
				const cacheWrite = rawUsage.cacheWriteInputTokens || 0;
				chunk.message.response_metadata.promptCachingMetrics = this.formatCacheMetrics(cacheRead, cacheWrite);
				if (this.patchOptions.enableDebugLogs) {
					this.patchLogger.info('[BedrockAdvanced] [stream] promptCachingMetrics: ' + JSON.stringify(chunk.message.response_metadata.promptCachingMetrics));
				}
			}
			yield chunk;
		}
	}

	private formatCacheMetrics(readTokens: number, writeTokens: number) {
		let status = 'NO CACHE';
		if (readTokens > 0) status = 'CACHE HIT';
		else if (writeTokens > 0) status = 'CACHE WRITTEN';

		return {
			status,
			tokensReadFromCache: readTokens,
			tokensWrittenToCache: writeTokens,
		};
	}
}
