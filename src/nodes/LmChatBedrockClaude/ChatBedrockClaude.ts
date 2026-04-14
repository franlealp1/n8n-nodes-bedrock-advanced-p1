/**
 * ChatBedrockClaude — a custom BaseChatModel that calls the Bedrock InvokeModel API
 * with the native Anthropic Messages API format.
 *
 * This gives full control over Anthropic-specific features:
 * - Prompt caching (cache_control on system, tools, and messages)
 * - Built-in tools (web_search, computer_use, bash, text_editor)
 * - Programmatic tool calling
 * - Extended thinking
 *
 * People1 patch: cache metrics (cacheReadInputTokens, cacheWriteInputTokens)
 * propagated to llmOutput.tokenUsage for N8N tracing visibility.
 */

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
	InvokeModelCommand,
	InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessageChunk } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

import {
	extractSystemMessages,
	convertMessagesToAnthropic,
	convertResponseToLangchain,
} from './messageConverter';
import type { AnthropicToolEntry } from './toolConverter';
import { convertTools, markToolsAsDeferred } from './toolConverter';
import { createStreamState, parseStreamEvent } from './streamParser';

export interface ChatBedrockClaudeInput extends BaseChatModelParams {
	client: BedrockRuntimeClient;
	model: string;
	region: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
	streaming?: boolean;
	enableCaching?: boolean;    // master toggle (backward compat)
	cacheSystemPrompt?: boolean; // default: true when enableCaching is on
	cacheTools?: boolean;        // default: enableCaching && !enableToolSearch
	cacheConversationHistory?: boolean; // default: false
	cacheTtl?: string;
	builtInTools?: AnthropicToolEntry[];
	enableCompaction?: boolean;
	compactionTriggerTokens?: number;
	enable1mContext?: boolean;
	enableToolSearch?: boolean;
	enableProgrammaticToolCalling?: boolean;
	debugLog?: boolean;
	logger?: any;
	anthropicVersion?: string;
}

export class ChatBedrockClaude extends BaseChatModel {
	client: BedrockRuntimeClient;
	model: string;
	region: string;
	maxTokens: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
	streaming: boolean;
	enableCaching: boolean;
	cacheSystemPrompt: boolean;
	cacheTools: boolean;
	cacheConversationHistory: boolean;
	cacheTtl: string;
	builtInTools: AnthropicToolEntry[];
	enableCompaction: boolean;
	compactionTriggerTokens: number;
	enable1mContext: boolean;
	enableToolSearch: boolean;
	enableProgrammaticToolCalling: boolean;
	debugLog: boolean;
	logger: any;
	anthropicVersion: string;

	constructor(fields: ChatBedrockClaudeInput) {
		super(fields);
		this.client = fields.client;
		this.model = fields.model;
		this.region = fields.region;
		this.maxTokens = fields.maxTokens ?? 4096;
		this.temperature = fields.temperature;
		this.topP = fields.topP;
		this.stopSequences = fields.stopSequences;
		this.streaming = fields.streaming ?? false;
		this.enableCaching = fields.enableCaching ?? false;
		this.cacheTtl = fields.cacheTtl ?? '5m';
		this.builtInTools = fields.builtInTools ?? [];
		this.enableCompaction = fields.enableCompaction ?? false;
		this.compactionTriggerTokens = fields.compactionTriggerTokens ?? 150000;
		this.enable1mContext = fields.enable1mContext ?? false;
		this.enableToolSearch = fields.enableToolSearch ?? false;
		this.enableProgrammaticToolCalling = fields.enableProgrammaticToolCalling ?? false;
		this.debugLog = fields.debugLog ?? false;
		this.logger = fields.logger ?? null;
		this.anthropicVersion = fields.anthropicVersion ?? 'bedrock-2023-05-31';

		// Granular cache targets — backward compat: if not set, inherit from enableCaching.
		// cacheTools is safe with tool search: deferred tools are stripped from the cache
		// prefix, so caching never conflicts with defer_loading.
		this.cacheSystemPrompt = fields.cacheSystemPrompt ?? this.enableCaching;
		this.cacheTools = fields.cacheTools ?? this.enableCaching;
		this.cacheConversationHistory = fields.cacheConversationHistory ?? false;
	}

	_llmType(): string {
		return 'bedrock-claude';
	}

	bindTools(tools: any[], kwargs?: any): any {
		return this.withConfig({
			tools,
			...kwargs,
		});
	}

	// Walk backwards through LangChain messages to find the safest index at which
	// to inject a conversation-history cache point. Rules:
	//   STOP  on 'system' — nothing useful further back
	//   SKIP  on 'tool'   — ToolMessages are merged by the converter; tracking
	//                       the resulting Anthropic index becomes ambiguous
	//   SAFE  on 'human' or 'ai' (with or without tool_calls — we control the
	//                       Anthropic conversion so tool_use blocks get cache_control too)
	private findHistoryCacheTarget(messages: BaseMessage[]): number {
		for (let i = messages.length - 2; i >= 0; i--) {
			const type = messages[i].getType();
			if (type === 'system') break;
			if (type === 'tool') continue;
			return i; // 'human' or 'ai'
		}
		return -1;
	}

	/**
	 * Build the Anthropic Messages API request body.
	 */
	private buildRequestBody(messages: BaseMessage[], options?: any): Record<string, any> {
		const system = extractSystemMessages(messages, this.cacheSystemPrompt, this.cacheTtl);

		// Find conversation-history cache target before converting messages
		const historyTargetIndex = this.cacheConversationHistory
			? this.findHistoryCacheTarget(messages)
			: -1;

		const cacheControl = historyTargetIndex >= 0
			? { type: 'ephemeral' as const, ...(this.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) }
			: undefined;

		const anthropicMessages = convertMessagesToAnthropic(messages, historyTargetIndex, cacheControl);

		// Merge bound tools (from agent) + built-in tools (from node config).
		const agentTools = options?.tools || [];
		const convertedAgentTools = convertTools(agentTools, false);

		// When programmatic tool calling is enabled, add allowed_callers to agent tools
		if (this.enableProgrammaticToolCalling && convertedAgentTools.length > 0) {
			for (const tool of convertedAgentTools) {
				if ('input_schema' in tool && !('allowed_callers' in tool)) {
					(tool as any).allowed_callers = ['direct', 'code_execution_20250825'];
				}
			}
		}

		// When tool search is enabled, mark agent tools as deferred
		const finalAgentTools = this.enableToolSearch
			? markToolsAsDeferred(convertedAgentTools)
			: convertedAgentTools;

		const nonDeferredTools: any[] = [...this.builtInTools];
		if (this.enableProgrammaticToolCalling) {
			nonDeferredTools.push({ type: 'code_execution_20250825', name: 'code_execution' });
		}
		const allTools: any[] = [...nonDeferredTools, ...finalAgentTools];

		// Inject cache_control on the last non-deferred tool
		if (this.cacheTools && allTools.length > 0) {
			const ttl = this.cacheTtl === '1h' ? '1h' : '5m';
			const cacheControlForTools: { type: 'ephemeral'; ttl?: string } = { type: 'ephemeral' };
			if (ttl === '1h') cacheControlForTools.ttl = '1h';

			const targetIndex = nonDeferredTools.length > 0
				? nonDeferredTools.length - 1
				: allTools.length - 1;

			const target = allTools[targetIndex];
			if (target && ('input_schema' in target || 'type' in target)) {
				target.cache_control = cacheControlForTools;
			}
		}

		const body: Record<string, any> = {
			anthropic_version: this.anthropicVersion,
			max_tokens: this.maxTokens,
			messages: anthropicMessages,
		};

		// Add beta headers for features that require them
		const betas: string[] = [];
		if (this.enableProgrammaticToolCalling) {
			betas.push('advanced-tool-use-2025-11-20');
		}
		if (this.enableToolSearch) {
			betas.push('tool-search-tool-2025-10-19');
		}
		if (this.enable1mContext) {
			betas.push('context-1m-2025-08-07');
		}
		if (this.enableCompaction) {
			betas.push('compact-2026-01-12');
			body.context_management = {
				edits: [{
					type: 'compact_20260112',
					trigger: {
						type: 'input_tokens',
						value: this.compactionTriggerTokens,
					},
				}],
			};
		}
		if (betas.length > 0) {
			body.anthropic_beta = betas;
		}

		if (system.length > 0) {
			body.system = system;
		}

		if (allTools.length > 0) {
			body.tools = allTools;
		}

		if (this.temperature !== undefined) {
			body.temperature = this.temperature;
		}

		if (this.topP !== undefined) {
			body.top_p = this.topP;
		}

		if (this.stopSequences?.length) {
			body.stop_sequences = this.stopSequences;
		}

		if (options?.tool_choice) {
			body.tool_choice = this.convertToolChoice(options.tool_choice);
		}

		return body;
	}

	private convertToolChoice(toolChoice: any): any {
		if (typeof toolChoice === 'string') {
			switch (toolChoice) {
				case 'auto': return { type: 'auto' };
				case 'any': return { type: 'any' };
				case 'none': return { type: 'none' };
				default: return { type: 'tool', name: toolChoice };
			}
		}
		return toolChoice;
	}

	/**
	 * Non-streaming generation.
	 * P1 patch: cache metrics in tokenUsage.
	 */
	async _generate(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		if (this.streaming) {
			return this._generateStreaming(messages, options, _runManager);
		}

		const body = this.buildRequestBody(messages, options);

		if (this.debugLog && this.logger) {
			this.logger.info('[BedrockClaude] Request body: ' + JSON.stringify(body));
		}

		const command = new InvokeModelCommand({
			modelId: this.model,
			contentType: 'application/json',
			accept: 'application/json',
			body: JSON.stringify(body),
		});

		const response = await this.client.send(command);
		const responseBody = JSON.parse(new TextDecoder().decode(response.body));

		if (this.debugLog && this.logger) {
			this.logCacheMetrics(responseBody.usage);
		}

		const aiMessage = convertResponseToLangchain(responseBody);
		const usage = responseBody.usage ?? {};

		return {
			generations: [{
				text: typeof aiMessage.content === 'string' ? aiMessage.content : '',
				message: aiMessage,
			}],
			llmOutput: {
				tokenUsage: {
					completionTokens: usage.output_tokens ?? 0,
					promptTokens: usage.input_tokens ?? 0,
					totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
					cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
					cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
				},
			},
		};
	}

	/**
	 * Streaming generation — collects chunks and returns a single ChatResult.
	 * P1 patch: cache metrics in tokenUsage from response_metadata.usage.
	 */
	private async _generateStreaming(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const stream = this._streamResponseChunks(messages, options, runManager);
		let finalChunk: ChatGenerationChunk | undefined;

		for await (const chunk of stream) {
			if (!finalChunk) {
				finalChunk = chunk;
			} else {
				finalChunk = finalChunk.concat(chunk);
			}
		}

		if (!finalChunk) {
			throw new Error('No response received from Bedrock Claude streaming');
		}

		if (this.debugLog && this.logger) {
			const streamUsage = (finalChunk.message as any)?.response_metadata?.usage;
			if (streamUsage) {
				this.logCacheMetrics(streamUsage);
			}
		}

		const usageMeta = (finalChunk.message as any)?.usage_metadata;
		const streamUsage = (finalChunk.message as any)?.response_metadata?.usage ?? {};

		return {
			generations: [finalChunk],
			llmOutput: {
				...finalChunk.generationInfo,
				...(usageMeta ? {
					tokenUsage: {
						completionTokens: usageMeta.output_tokens ?? 0,
						promptTokens: usageMeta.input_tokens ?? 0,
						totalTokens: usageMeta.total_tokens ?? 0,
						cacheReadInputTokens: streamUsage.cache_read_input_tokens ?? 0,
						cacheWriteInputTokens: streamUsage.cache_creation_input_tokens ?? 0,
					},
				} : {}),
			},
		};
	}

	/**
	 * Streaming response chunks via InvokeModelWithResponseStream.
	 */
	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		const body = this.buildRequestBody(messages, options);

		if (this.debugLog) {
			console.error('[BedrockClaude] [stream] Request body:', JSON.stringify(body, null, 2));
		}

		const command = new InvokeModelWithResponseStreamCommand({
			modelId: this.model,
			contentType: 'application/json',
			accept: 'application/json',
			body: JSON.stringify(body),
		});

		const response = await this.client.send(command);
		const state = createStreamState();

		if (response.body) {
			for await (const event of response.body) {
				if (event.chunk?.bytes) {
					const eventData = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
					const chunk = parseStreamEvent(eventData, state);
					if (chunk) {
						await _runManager?.handleLLMNewToken(chunk.text || '');
						yield chunk;
					}
				}
			}
		}
	}

	private logCacheMetrics(usage: any) {
		if (!usage) return;

		const cacheRead = usage.cache_read_input_tokens ?? 0;
		const cacheWrite = usage.cache_creation_input_tokens ?? 0;
		const inputTokens = usage.input_tokens ?? 0;
		const outputTokens = usage.output_tokens ?? 0;

		let status = 'NO CACHE';
		if (cacheRead > 0) status = 'CACHE HIT';
		else if (cacheWrite > 0) status = 'CACHE WRITTEN';

		this.logger.info(`[BedrockClaude] ${status} | input: ${inputTokens}, output: ${outputTokens}, cache_read: ${cacheRead}, cache_write: ${cacheWrite}`);
	}
}
