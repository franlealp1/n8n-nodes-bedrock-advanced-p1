/**
 * N8N node definition for AWS Bedrock Chat Model (Advanced P1).
 *
 * People1 fork: renamed type to coexist with original, cache metrics in
 * tokenUsage, custom tokensUsageParser for N8nLlmTracing.
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
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { PatchedChatBedrockConverse } from './PatchedChatBedrockConverse';


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
				displayOptions: { show: { authType: ['iam'] } },
			},
			{
				name: 'awsBedrockApiKeyP1',
				required: true,
				displayOptions: { show: { authType: ['apiKey'] } },
			},
		],
		requestDefaults: {
			ignoreHttpStatusErrors: true,
			baseURL: '=https://bedrock.{{$credentials?.region ?? "eu-central-1"}}.amazonaws.com',
		},
		properties: [
			{
				displayName: 'Authentication',
				name: 'authType',
				type: 'options',
				options: [
					{
						name: 'AWS IAM (existing)',
						value: 'iam',
						description: 'Access Key ID + Secret Access Key — existing configuration',
					},
					{
						name: 'Bedrock API Key',
						value: 'apiKey',
						description: 'Bearer token — simpler, Bedrock-only scope',
					},
				],
				default: 'iam',
				description: 'Authentication method for AWS Bedrock',
			},
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
			// ── API key auth: on-demand dropdown via loadOptionsMethod
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The model which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/foundation-models.html">Learn more</a>.',
				displayOptions: {
					show: { authType: ['apiKey'] },
					hide: { modelSource: ['inferenceProfile'] },
				},
				typeOptions: {
					loadOptionsDependsOn: ['authType', 'modelSource'],
					loadOptionsMethod: 'getModelsForApiKey',
				},
				default: '',
			},
			// ── API key auth: inference profiles dropdown via loadOptionsMethod
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The inference profile which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html">Learn more</a>.',
				displayOptions: {
					show: { authType: ['apiKey'], modelSource: ['inferenceProfile'] },
				},
				typeOptions: {
					loadOptionsDependsOn: ['authType', 'modelSource'],
					loadOptionsMethod: 'getInferenceProfilesForApiKey',
				},
				default: '',
			},
			// ── IAM auth: on-demand dropdown with loadOptions
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The model which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/foundation-models.html">Learn more</a>.',
				displayOptions: {
					show: { authType: ['iam'] },
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
			// ── IAM auth: inference profile dropdown with loadOptions
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				allowArbitraryValues: true,
				description:
					'The inference profile which will generate the completion. <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html">Learn more</a>.',
				displayOptions: {
					show: {
						authType: ['iam'],
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
						displayName: 'System Prompt Blocks (Multi-Cachepoint)',
						name: 'systemPromptBlocks',
						type: 'json',
						default: '',
						description:
							'Split the system prompt into multiple blocks with cache points between them. Expected: array of non-empty strings (or a JSON string that parses to one). When present and non-empty, REPLACES the AI Agent system message content. Each block should be ≥ ~1024 tokens to reach Bedrock\'s minimum cacheable size. Max 4 cache points per request (Bedrock hard limit); blocks beyond the 4th are merged into the 4th. Leave empty for legacy single-cachepoint behavior. Ignored if Cache System Prompt is disabled.',
						placeholder: '={{ $(\'Generate Prompt Blocks\').item.json.systemBlocks }}',
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

	methods = {
		loadOptions: {
			async getModelsForApiKey(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = await this.getCredentials<{ apiKey: string; region: string }>(
					'awsBedrockApiKeyP1',
				);
				const response = await this.helpers.httpRequest({
					method: 'GET',
					url: `https://bedrock.${creds.region}.amazonaws.com/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND`,
					headers: { Authorization: `Bearer ${creds.apiKey}` },
				});
				return ((response as any).modelSummaries as any[])
					.map(m => ({
						name: m.modelName as string,
						value: m.modelId as string,
						description: m.modelArn as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
			async getInferenceProfilesForApiKey(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = await this.getCredentials<{ apiKey: string; region: string }>(
					'awsBedrockApiKeyP1',
				);
				const response = await this.helpers.httpRequest({
					method: 'GET',
					url: `https://bedrock.${creds.region}.amazonaws.com/inference-profiles?maxResults=1000`,
					headers: { Authorization: `Bearer ${creds.apiKey}` },
				});
				return ((response as any).inferenceProfileSummaries as any[])
					.map(m => ({
						name: m.inferenceProfileName as string,
						value: m.inferenceProfileId as string,
						description: (m.description || m.inferenceProfileArn) as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const authType = this.getNodeParameter('authType', itemIndex, 'iam') as string;
		const modelName = this.getNodeParameter('model', itemIndex) as string;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			temperature?: number;
			maxTokensToSample?: number;
			enablePromptCaching?: boolean;
			cacheSystemPrompt?: boolean;
			cacheTools?: boolean;
			cacheConversationHistory?: boolean;
			cacheTtl?: string;
			systemPromptBlocks?: string | string[];
			enableDebugLogs?: boolean;
		};

		const proxyAgent = getNodeProxyAgent();
		let client: BedrockRuntimeClient;
		let region: string;

		if (authType === 'apiKey') {
			// ── Bearer token path ────────────────────────────────────────────────
			const apiKeyCreds = await this.getCredentials<{
				apiKey: string;
				region: string;
			}>('awsBedrockApiKeyP1');

			region = apiKeyCreds.region;

			const clientConfig: BedrockRuntimeClientConfig = {
				region,
				// Dummy IAM credentials — SDK requires them to initialize.
				// bedrockBearerTokenMiddleware replaces the auth header after SigV4.
				credentials: {
					accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
					secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				},
			};

			if (proxyAgent) {
				clientConfig.requestHandler = new NodeHttpHandler({
					httpAgent: proxyAgent,
					httpsAgent: proxyAgent,
				});
			}

			const bearerToken = apiKeyCreds.apiKey;
			client = new BedrockRuntimeClient(clientConfig);

			// Runs at 'finalizeRequest' with priority 'low' → AFTER httpSigningMiddleware.
			// Replaces the SigV4 Authorization header with Bearer token.
			client.middlewareStack.add(
				(next: any) => async (args: any) => {
					const req = args.request as any;
					req.headers['authorization'] = `Bearer ${bearerToken}`;
					// x-amz-security-token is for temporary session credentials only — not needed.
					delete req.headers['x-amz-security-token'];
					return next(args);
				},
				{
					step: 'finalizeRequest',
					priority: 'low',
					name: 'bedrockBearerTokenMiddleware',
				},
			);
		} else {
			// ── IAM path (existing behavior, zero changes) ───────────────────────
			const credentials = await this.getCredentials<{
				region: string;
				secretAccessKey: string;
				accessKeyId: string;
				sessionToken: string;
			}>('aws');

			region = credentials.region;

			const clientConfig: BedrockRuntimeClientConfig = {
				region,
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

			client = new BedrockRuntimeClient(clientConfig);
		}

		// Always use our patched subclass — it handles both the empty content fix
		// (always needed) and prompt caching (when enabled).
		const model = new PatchedChatBedrockConverse({
			client,
			model: modelName,
			region,
			temperature: options.temperature,
			maxTokens: options.maxTokensToSample,
			patchOptions: options,
			patchLogger: this.logger,
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
