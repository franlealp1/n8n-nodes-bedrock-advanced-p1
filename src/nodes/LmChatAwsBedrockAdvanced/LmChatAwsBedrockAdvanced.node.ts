/**
 * N8N node definition for AWS Bedrock Chat Model (Advanced P1).
 *
 * People1 fork: renamed type to coexist with original, cache metrics in
 * tokenUsage, custom tokensUsageParser for N8nLlmTracing.
 */

import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ChatBedrockConverse } from '@langchain/aws';
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


class LmChatAwsBedrockAdvancedP1 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AWS Bedrock Chat Model (Advanced P1)',

		name: 'lmChatAwsBedrockAdvancedP1',
		icon: 'file:bedrock.svg',
		group: ['transform'],
		version: [1],
		description: 'AWS Bedrock Language Model with prompt caching support — People1 fork with cache metrics in output',
		defaults: {
			name: 'AWS Bedrock Chat Model (Advanced P1)',
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
						url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
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
			baseURL: '=https://bedrock.{{$credentials?.region ?? "eu-central-1"}}.amazonaws.com',
		},
		properties: [
			{
				displayName: 'Model Source',
				name: 'modelSource',
				type: 'options',
				options: [
					{
						name: 'On-Demand Models',
						value: 'onDemand',
						description: 'Standard foundation models with on-demand pricing',
					},
					{
						name: 'Inference Profiles',
						value: 'inferenceProfile',
						description:
							'Cross-region inference profiles (required for models like Claude Sonnet 4 and others)',
					},
				],
				default: 'onDemand',
				description: 'Choose between on-demand foundation models or inference profiles',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The model which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/foundation-models.html">Learn more</a>.',
				displayOptions: {
					hide: {
						modelSource: ['inferenceProfile'],
					},
				},
				typeOptions: {
					loadOptionsDependsOn: ['modelSource'],
					loadOptions: {
						routing: {
							request: {
								method: 'GET',
								url: '/foundation-models?&byOutputModality=TEXT&byInferenceType=ON_DEMAND',
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: {
											property: 'modelSummaries',
										},
									},
									{
										type: 'setKeyValue',
										properties: {
											name: '={{$responseItem.modelName}}',
											description: '={{$responseItem.modelArn}}',
											value: '={{$responseItem.modelId}}',
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
				routing: {
					send: {
						type: 'body',
						property: 'model',
					},
				},
				default: '',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The inference profile which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html">Learn more</a>.',
				displayOptions: {
					show: {
						modelSource: ['inferenceProfile'],
					},
				},
				typeOptions: {
					loadOptionsDependsOn: ['modelSource'],
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
										type: 'setKeyValue',
										properties: {
											name: '={{$responseItem.inferenceProfileName}}',
											description:
												'={{$responseItem.description || $responseItem.inferenceProfileArn}}',
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
				routing: {
					send: {
						type: 'body',
						property: 'model',
					},
				},
				default: '',
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokensToSample',
						default: 2000,
						description: 'The maximum number of tokens to generate in the completion',
						type: 'number',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						default: 0.7,
						typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
						description:
							'Controls randomness: Lowering results in less random completions. As the temperature approaches zero, the model will become deterministic and repetitive.',
						type: 'number',
					},
					{
						displayName: 'Enable Prompt Caching',
						name: 'enablePromptCaching',
						default: false,
						description:
							'Whether to enable prompt caching to reduce cost by caching reused content. Supported on Anthropic Claude 3.5+ and Nova models.',
						type: 'boolean',
					},
					{
						displayName: 'Cache Duration (TTL)',
						name: 'cacheTtl',
						type: 'options',
						displayOptions: {
							show: {
								enablePromptCaching: [true],
							},
						},
						options: [
							{
								name: '5 Minutes (Default)',
								value: '5m',
								description: 'Standard ephemeral cache duration, supported on all models',
							},
							{
								name: '1 Hour',
								value: '1h',
								description:
									'Extended cache duration — only supported on Claude Haiku 4.5, Sonnet 4.5, Opus 4.5. Applies to tool definitions only; system and conversation caching always use 5m.',
							},
						],
						default: '5m',
						description:
							'How long cached content should be kept alive. When mixing TTLs, longer durations must be placed before shorter ones in the request.',
					},
					{
						displayName: 'Cache System Prompt',
						name: 'cacheSystemPrompt',
						type: 'boolean',
						default: true,
						description:
							'Whether to add a cache point after the system prompt. Recommended when the system prompt is long and consistent across turns.',
						displayOptions: {
							show: {
								enablePromptCaching: [true],
							},
						},
					},
					{
						displayName: 'Cache Tool Definitions',
						name: 'cacheTools',
						type: 'boolean',
						default: false,
						description:
							'Whether to add a cache point after all tool definitions. Useful when many or large tools are defined. Supported on Claude models only, not Amazon Nova.',
						displayOptions: {
							show: {
								enablePromptCaching: [true],
							},
						},
					},
					{
						displayName: 'Cache Conversation History',
						name: 'cacheConversationHistory',
						type: 'boolean',
						default: false,
						description:
							'Whether to add a cache point at the end of the most recent previous assistant turn. Reduces cost in multi-turn conversations by caching the growing history.',
						displayOptions: {
							show: {
								enablePromptCaching: [true],
							},
						},
					},
					{
						displayName: 'Enable Debug Logs',
						name: 'enableDebugLogs',
						default: false,
						description:
							'Whether to log detailed debug information (messages, responses, cache metrics) during execution',
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
			temperature?: number;
			maxTokensToSample?: number;
			enablePromptCaching?: boolean;
			cacheSystemPrompt?: boolean;
			cacheTools?: boolean;
			cacheConversationHistory?: boolean;
			cacheTtl?: string;
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

		class CachingChatBedrockConverse extends ChatBedrockConverse {

			invocationParams(invokeOptions?: any): any {
				const params = super.invocationParams(invokeOptions);
				if (options.cacheTools && params.toolConfig?.tools?.length) {
					const ttl = options.cacheTtl === '1h' ? '1h' : '5m';
					params.toolConfig = {
						...params.toolConfig,
						tools: [...params.toolConfig.tools, { cachePoint: { type: 'default', ttl } }],
					};
				}
				return params;
			}

			async _generateNonStreaming(messages: any[], invokeOptions: any, runManager?: any) {
				const modifiedMessages = this.injectCachePoints(messages);
				if (options.enableDebugLogs) {
					logger.info('[BedrockAdvanced] modifiedMessages: ' + JSON.stringify(modifiedMessages));
				}
				return super._generateNonStreaming(modifiedMessages, invokeOptions, runManager);
			}

			// P1 patch: cache metrics in tokenUsage for N8nLlmTracing visibility
			async _generate(messages: any[], generateOptions: any, runManager?: any) {
				const response = await super._generate(messages, generateOptions, runManager);

				if (options.enableDebugLogs) {
					logger.info('[BedrockAdvanced] response: ' + JSON.stringify(response));
				}

				const rawUsage = response.llmOutput?.usage
					|| response.generations[0]?.message?.response_metadata?.usage
					|| {};
				const cacheRead = rawUsage.cacheReadInputTokens || 0;
				const cacheWrite = rawUsage.cacheWriteInputTokens || 0;

				if (response.generations?.length > 0) {
					const msg = response.generations[0].message;
					if (!msg.response_metadata) msg.response_metadata = {};
					msg.response_metadata.promptCachingMetrics = this.formatCacheMetrics(cacheRead, cacheWrite);
					if (options.enableDebugLogs) {
						logger.info('[BedrockAdvanced] promptCachingMetrics: ' + JSON.stringify(msg.response_metadata.promptCachingMetrics));
					}
				}

				// P1 patch: tokenUsage with cache metrics
				const usageMeta = (response.generations?.[0]?.message as any)?.usage_metadata;
				if (usageMeta) {
					response.llmOutput = {
						...response.llmOutput,
						tokenUsage: {
							completionTokens: usageMeta.output_tokens ?? 0,
							promptTokens: usageMeta.input_tokens ?? 0,
							totalTokens: usageMeta.total_tokens ?? 0,
							cacheReadInputTokens: cacheRead,
							cacheWriteInputTokens: cacheWrite,
						},
					};
				}

				return response;
			}

			async *_streamResponseChunks(messages: any[], generateOptions: any, runManager?: any) {
				const modifiedMessages = this.injectCachePoints(messages);
				if (options.enableDebugLogs) {
					logger.info('[BedrockAdvanced] [stream] modifiedMessages: ' + JSON.stringify(modifiedMessages));
				}

				const stream = super._streamResponseChunks(modifiedMessages, generateOptions, runManager);

				for await (const chunk of stream) {
					if (chunk.message?.response_metadata?.usage) {
						const rawUsage = chunk.message.response_metadata.usage;
						const cacheRead = rawUsage.cacheReadInputTokens || 0;
						const cacheWrite = rawUsage.cacheWriteInputTokens || 0;
						chunk.message.response_metadata.promptCachingMetrics = this.formatCacheMetrics(cacheRead, cacheWrite);
						if (options.enableDebugLogs) {
							logger.info('[BedrockAdvanced] [stream] promptCachingMetrics: ' + JSON.stringify(chunk.message.response_metadata.promptCachingMetrics));
						}
					}
					yield chunk;
				}
			}

			private findHistoryCacheTarget(messages: any[]): number {
				for (let i = messages.length - 2; i >= 0; i--) {
					const msgType = messages[i]._getType?.() ?? messages[i].getType?.();
					if (msgType === 'system') break;
					if (msgType === 'tool') continue;
					if (msgType === 'ai' && messages[i].tool_calls?.length > 0) continue;
					return i;
				}
				return -1;
			}

			private injectCachePoints(messages: any[]) {
				const cachePointBlock = { cachePoint: { type: 'default' } };
				const shouldCacheSystem = options.cacheSystemPrompt !== false;
				const historyTargetIndex = options.cacheConversationHistory
					? this.findHistoryCacheTarget(messages)
					: -1;

				return messages.map((msg, index) => {
					const msgType = msg._getType?.() ?? msg.getType?.();

					const shouldInject =
						(msgType === 'system' && shouldCacheSystem) ||
						(index === historyTargetIndex);

					if (!shouldInject) return msg;

					const hasContent =
						(typeof msg.content === 'string' && msg.content.length > 0) ||
						(Array.isArray(msg.content) && msg.content.length > 0);
					if (!hasContent) return msg;

					const newMsg = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg);
					if (typeof msg.content === 'string') {
						newMsg.content = [{ type: 'text', text: msg.content }, cachePointBlock];
					} else if (Array.isArray(msg.content)) {
						const hasCachePoint = msg.content.some((block: any) => block.cachePoint);
						if (!hasCachePoint) {
							newMsg.content = [...msg.content, cachePointBlock];
						}
					}
					return newMsg;
				});
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

		const ModelClass = options.enablePromptCaching
			? CachingChatBedrockConverse
			: ChatBedrockConverse;

		const model = new ModelClass({
			client,
			model: modelName,
			region: credentials.region,
			temperature: options.temperature,
			maxTokens: options.maxTokensToSample,
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

// Export as LmChatAwsBedrockAdvanced for N8N loader compatibility
export { LmChatAwsBedrockAdvancedP1 as LmChatAwsBedrockAdvanced };
