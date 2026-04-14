/**
 * N8N node definition for Bedrock Claude (P1).
 *
 * People1 fork: renamed type to coexist with original, custom tokensUsageParser
 * to propagate cache metrics through N8nLlmTracing.
 */

import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
	getNodeProxyAgent,
	makeN8nLlmFailedAttemptHandler,
	N8nLlmTracing,
} from '@n8n/ai-utilities';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { ChatBedrockClaude } from './ChatBedrockClaude';
import type { AnthropicToolEntry } from './toolConverter';
import {
	createWebSearchTool,
	createComputerUseTool,
	createBashTool,
	createTextEditorTool,
	createToolSearchTool,
} from './toolConverter';

// Class name uses P1 suffix internally; exported as LmChatBedrockClaude
// for N8N loader compatibility (file name must match export name).
class LmChatBedrockClaudeP1 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Bedrock Claude (P1)',
		name: 'lmChatBedrockClaudeP1',
		icon: 'file:bedrock-claude.svg',
		group: ['transform'],
		version: [1],
		description: 'Claude on AWS Bedrock via InvokeModel API — People1 fork with cache metrics in output',
		defaults: {
			name: 'Bedrock Claude (P1)',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html',
					},
				],
			},
		},

		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'aws',
				required: true,
			},
		],
		requestDefaults: {
			ignoreHttpStatusErrors: true,
			baseURL: '=https://bedrock.{{$credentials?.region ?? "us-west-2"}}.amazonaws.com',
		},
		properties: [
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description: 'The Claude model or inference profile to use',
				typeOptions: {
					loadOptions: {
						routing: {
							request: {
								method: 'GET',
								url: '/inference-profiles?maxResults=1000',
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: {
											property: 'inferenceProfileSummaries',
										},
									},
									{
										type: 'filter',
										properties: {
											pass: '={{$responseItem.inferenceProfileName.toLowerCase().includes("claude")}}',
										},
									},
									{
										type: 'setKeyValue',
										properties: {
											name: '={{$responseItem.inferenceProfileName}}',
											description: '={{$responseItem.description || $responseItem.inferenceProfileArn}}',
											value: '={{$responseItem.inferenceProfileId}}',
										},
									},
									{
										type: 'sort',
										properties: {
											key: 'name',
										},
									},
								],
							},
						},
					},
				},
				default: '',
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						default: 4096,
						description: 'The maximum number of tokens to generate',
						type: 'number',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						default: 0.7,
						typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
						description: 'Controls randomness in the response',
						type: 'number',
					},
					{
						displayName: 'Enable Prompt Caching',
						name: 'enableCaching',
						default: false,
						description: 'Whether to enable prompt caching to reduce cost by caching reused content',
						type: 'boolean',
					},
					{
						displayName: 'Cache TTL',
						name: 'cacheTtl',
						type: 'options',
						displayOptions: {
							show: {
								enableCaching: [true],
							},
						},
						options: [
							{
								name: '5 Minutes (Default)',
								value: '5m',
								description: 'Standard ephemeral cache duration — supported by all cacheable models',
							},
							{
								name: '1 Hour',
								value: '1h',
								description: 'Extended cache duration — supported by Claude Opus 4.5/4.6, Sonnet 4.5/4.6, Haiku 4.5',
							},
						],
						default: '5m',
						description: 'How long cached content should be kept alive. Applies to all cache targets.',
					},
					{
						displayName: 'Cache System Prompt',
						name: 'cacheSystemPrompt',
						type: 'boolean',
						default: true,
						description: 'Whether to add cache_control to the system prompt. Recommended when the system prompt is long and consistent across turns.',
						displayOptions: {
							show: {
								enableCaching: [true],
							},
						},
					},
					{
						displayName: 'Cache Tool Definitions',
						name: 'cacheTools',
						type: 'boolean',
						default: false,
						description: 'Whether to add cache_control to the last non-deferred tool definition. Compatible with Tool Search — cache_control is placed on built-in tools only; deferred agent tools are excluded from the cache prefix automatically.',
						displayOptions: {
							show: {
								enableCaching: [true],
							},
						},
					},
					{
						displayName: 'Cache Conversation History',
						name: 'cacheConversationHistory',
						type: 'boolean',
						default: false,
						description: 'Whether to add cache_control at the end of the most recent previous turn. Reduces cost in multi-turn conversations by caching the growing history.',
						displayOptions: {
							show: {
								enableCaching: [true],
							},
						},
					},
					{
						displayName: 'Enable Tool Search',
						name: 'enableToolSearch',
						default: false,
						description: 'Whether to enable Claude\'s built-in tool search tool, which lets Claude dynamically discover and load tools on-demand from large tool sets. Agent tools will be deferred and only loaded when Claude finds them relevant.',
						type: 'boolean',
					},
					{
						displayName: 'Tool Search Variant',
						name: 'toolSearchVariant',
						type: 'options',
						displayOptions: {
							show: {
								enableToolSearch: [true],
							},
						},
						options: [
							{
								name: 'Regex',
								value: 'regex',
								description: 'Claude constructs regex patterns to search for tools',
							},
							{
								name: 'BM25',
								value: 'bm25',
								description: 'Claude uses natural language queries to search for tools',
							},
						],
						default: 'regex',
						description: 'The search algorithm used to find relevant tools',
					},
					{
						displayName: 'Enable Web Search',
						name: 'enableWebSearch',
						default: false,
						description: 'Whether to enable Claude\'s built-in web search tool',
						type: 'boolean',
					},
					{
						displayName: 'Enable Computer Use',
						name: 'enableComputerUse',
						default: false,
						description: 'Whether to enable Claude\'s built-in computer use tool',
						type: 'boolean',
					},
					{
						displayName: 'Computer Display Width',
						name: 'computerDisplayWidth',
						default: 1024,
						description: 'Screen width in pixels for computer use',
						type: 'number',
						displayOptions: {
							show: {
								enableComputerUse: [true],
							},
						},
					},
					{
						displayName: 'Computer Display Height',
						name: 'computerDisplayHeight',
						default: 768,
						description: 'Screen height in pixels for computer use',
						type: 'number',
						displayOptions: {
							show: {
								enableComputerUse: [true],
							},
						},
					},
					{
						displayName: 'Enable Bash Tool',
						name: 'enableBash',
						default: false,
						description: 'Whether to enable Claude\'s built-in bash execution tool',
						type: 'boolean',
					},
					{
						displayName: 'Enable Text Editor Tool',
						name: 'enableTextEditor',
						default: false,
						description: 'Whether to enable Claude\'s built-in text editor tool',
						type: 'boolean',
					},
					{
						displayName: 'Enable Compaction',
						name: 'enableCompaction',
						default: false,
						description: 'Whether to automatically summarize older context when approaching the context window limit, extending effective conversation length beyond 200K tokens',
						type: 'boolean',
					},
					{
						displayName: 'Compaction Trigger (Tokens)',
						name: 'compactionTriggerTokens',
						default: 150000,
						description: 'Number of input tokens that triggers compaction (minimum 50,000)',
						type: 'number',
						typeOptions: { minValue: 50000 },
						displayOptions: {
							show: {
								enableCompaction: [true],
							},
						},
					},
					{
						displayName: 'Enable 1M Context',
						name: 'enable1mContext',
						default: false,
						description: 'Whether to enable the extended 1M token context window (default is 200K). Supported on Claude Opus 4.6 and Sonnet 4.6.',
						type: 'boolean',
					},
					{
						displayName: 'Enable Programmatic Tool Calling',
						name: 'enableProgrammaticToolCalling',
						default: false,
						description: 'Whether to allow Claude to call tools programmatically from within code execution, reducing latency and token usage in multi-tool workflows',
						type: 'boolean',
					},
					{
						displayName: 'Enable Debug Logs',
						name: 'enableDebugLogs',
						default: false,
						description: 'Whether to log detailed debug information during execution',
						type: 'boolean',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<{
			region: string;
			secretAccessKey: string;
			accessKeyId: string;
			sessionToken: string;
		}>('aws');

		const modelName = this.getNodeParameter('model', itemIndex) as string;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			maxTokens?: number;
			temperature?: number;
			enableCaching?: boolean;
			cacheSystemPrompt?: boolean;
			cacheTools?: boolean;
			cacheConversationHistory?: boolean;
			cacheTtl?: string;
			enableToolSearch?: boolean;
			toolSearchVariant?: 'regex' | 'bm25';
			enableWebSearch?: boolean;
			enableComputerUse?: boolean;
			computerDisplayWidth?: number;
			computerDisplayHeight?: number;
			enableBash?: boolean;
			enableTextEditor?: boolean;
			enableCompaction?: boolean;
			compactionTriggerTokens?: number;
			enable1mContext?: boolean;
			enableProgrammaticToolCalling?: boolean;
			enableDebugLogs?: boolean;
		};

		const proxyAgent = getNodeProxyAgent();
		const clientConfig: BedrockRuntimeClientConfig = {
			region: credentials.region,
			credentials: {
				secretAccessKey: credentials.secretAccessKey,
				accessKeyId: credentials.accessKeyId,
				...(credentials.sessionToken && { sessionToken: credentials.sessionToken }),
			},
		};

		if (proxyAgent) {
			clientConfig.requestHandler = new NodeHttpHandler({
				httpAgent: proxyAgent,
				httpsAgent: proxyAgent,
			});
		}

		const client = new BedrockRuntimeClient(clientConfig);
		const logger = this.logger;

		// Collect built-in tools from options
		const builtInTools: AnthropicToolEntry[] = [];
		if (options.enableWebSearch) {
			builtInTools.push(createWebSearchTool());
		}
		if (options.enableComputerUse) {
			builtInTools.push(createComputerUseTool(
				options.computerDisplayWidth ?? 1024,
				options.computerDisplayHeight ?? 768,
			));
		}
		if (options.enableBash) {
			builtInTools.push(createBashTool());
		}
		if (options.enableTextEditor) {
			builtInTools.push(createTextEditorTool());
		}
		if (options.enableToolSearch) {
			builtInTools.push(createToolSearchTool(options.toolSearchVariant ?? 'regex'));
		}

		if (options.enableDebugLogs) {
			logger.info(`[BedrockClaude] Model: ${modelName}`);
			logger.info(`[BedrockClaude] Caching: ${options.enableCaching ?? false}`);
			logger.info(`[BedrockClaude] Built-in tools: ${builtInTools.map(t => ('type' in t ? t.type : t.name)).join(', ') || 'none'}`);
		}

		const model = new ChatBedrockClaude({
			client,
			model: modelName,
			region: credentials.region,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			enableCaching: options.enableCaching ?? false,
			cacheSystemPrompt: options.cacheSystemPrompt,
			cacheTools: options.cacheTools,
			cacheConversationHistory: options.cacheConversationHistory ?? false,
			cacheTtl: options.cacheTtl ?? '5m',
			enableCompaction: options.enableCompaction ?? false,
			compactionTriggerTokens: options.compactionTriggerTokens ?? 150000,
			enable1mContext: options.enable1mContext ?? false,
			enableToolSearch: options.enableToolSearch ?? false,
			enableProgrammaticToolCalling: options.enableProgrammaticToolCalling ?? false,
			debugLog: options.enableDebugLogs ?? false,
			logger,
			builtInTools,
			// P1 patch: custom tokensUsageParser to preserve cache metrics
			callbacks: [new N8nLlmTracing(this, {
				tokensUsageParser: (result: any) => {
					const tu = result?.llmOutput?.tokenUsage ?? {};
					return {
						completionTokens: tu.completionTokens ?? 0,
						promptTokens: tu.promptTokens ?? 0,
						totalTokens: (tu.completionTokens ?? 0) + (tu.promptTokens ?? 0),
						cacheReadInputTokens: tu.cacheReadInputTokens ?? 0,
						cacheWriteInputTokens: tu.cacheWriteInputTokens ?? 0,
					};
				},
			}) as any],
			onFailedAttempt: makeN8nLlmFailedAttemptHandler(this),
		});

		return {
			response: model,
		};
	}
}

// Export as LmChatBedrockClaude for N8N loader compatibility
// (N8N expects export name to match file name)
export { LmChatBedrockClaudeP1 as LmChatBedrockClaude };
