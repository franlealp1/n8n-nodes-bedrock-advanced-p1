import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatBedrockConverse } from '@langchain/aws';

import {
	PatchedChatBedrockConverse,
	type PatchOptions,
} from './PatchedChatBedrockConverse';

/**
 * Minimal stub client that passes the ChatBedrockConverse constructor type check.
 * The overrides we exercise never actually call .send() — they go through
 * spied-upon super methods — so a no-op send is sufficient.
 */
function stubClient(): BedrockRuntimeClient {
	return {
		send: async () => ({ body: (async function* () {})() }),
	} as unknown as BedrockRuntimeClient;
}

function makeModel(patchOptions: PatchOptions, loggerSink?: { info: any; warn: any; error: any }) {
	return new PatchedChatBedrockConverse({
		client: stubClient(),
		model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
		region: 'us-west-2',
		patchOptions,
		patchLogger: loggerSink
			? { info: loggerSink.info, warn: loggerSink.warn, error: loggerSink.error }
			: undefined,
	});
}

async function collectChunks<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const c of gen) out.push(c);
	return out;
}

describe('PatchedChatBedrockConverse', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── invocationParams ────────────────────────────────────────────────────

	describe('invocationParams', () => {
		it('Case 1 — cacheTools=true + tools present: cachePoint appended to tools array with 5m default ttl', () => {
			vi.spyOn(ChatBedrockConverse.prototype, 'invocationParams').mockReturnValue({
				toolConfig: { tools: [{ toolSpec: { name: 't1' } }, { toolSpec: { name: 't2' } }] },
			} as any);
			const model = makeModel({ cacheTools: true });

			const params = model.invocationParams();

			expect(params.toolConfig.tools).toHaveLength(3);
			expect(params.toolConfig.tools[2]).toEqual({ cachePoint: { type: 'default', ttl: '5m' } });
		});

		it('Case 1b — cacheTools=true + cacheTtl=1h: cachePoint uses 1h ttl', () => {
			vi.spyOn(ChatBedrockConverse.prototype, 'invocationParams').mockReturnValue({
				toolConfig: { tools: [{ toolSpec: { name: 't1' } }] },
			} as any);
			const model = makeModel({ cacheTools: true, cacheTtl: '1h' });

			const params = model.invocationParams();

			expect(params.toolConfig.tools[1]).toEqual({ cachePoint: { type: 'default', ttl: '1h' } });
		});

		it('Case 2 — cacheTools=false: tools array unchanged', () => {
			const baseTools = [{ toolSpec: { name: 't1' } }];
			vi.spyOn(ChatBedrockConverse.prototype, 'invocationParams').mockReturnValue({
				toolConfig: { tools: baseTools },
			} as any);
			const model = makeModel({ cacheTools: false });

			const params = model.invocationParams();

			expect(params.toolConfig.tools).toEqual(baseTools);
			expect(params.toolConfig.tools).toHaveLength(1);
		});

		it('Case 3 — cacheTools=true but no tools: params unchanged', () => {
			vi.spyOn(ChatBedrockConverse.prototype, 'invocationParams').mockReturnValue({
				inferenceConfig: { temperature: 0.5 },
			} as any);
			const model = makeModel({ cacheTools: true });

			const params = model.invocationParams();

			expect(params.toolConfig).toBeUndefined();
			expect(params.inferenceConfig).toEqual({ temperature: 0.5 });
		});
	});

	// ── sanitizeMessages ────────────────────────────────────────────────────

	describe('sanitizeMessages', () => {
		it('Case 4 — AI message with empty string content gets content mutated to "."', () => {
			const model = makeModel({});
			const input = [new AIMessage({ content: '' })];

			const out = (model as any).sanitizeMessages(input);

			expect(out).toHaveLength(1);
			expect(out[0].content).toBe('.');
			expect(input[0].content).toBe('');
		});

		it('Case 4b — AI message with empty array content gets content mutated to "."', () => {
			const model = makeModel({});
			const input = [new AIMessage({ content: [] as any })];

			const out = (model as any).sanitizeMessages(input);

			expect(out[0].content).toBe('.');
		});

		it('Case 5 — AI message with tool_calls stays untouched even with empty content', () => {
			const model = makeModel({});
			const aiWithToolCalls = new AIMessage({
				content: '',
				tool_calls: [{ id: 'tc1', name: 'search', args: {} }],
			});
			const input = [aiWithToolCalls];

			const out = (model as any).sanitizeMessages(input);

			expect(out[0]).toBe(aiWithToolCalls);
			expect(out[0].content).toBe('');
		});

		it('Case 6 — Non-AI messages (Human / System) are untouched', () => {
			const model = makeModel({});
			const sys = new SystemMessage({ content: 'you are helpful' });
			const user = new HumanMessage({ content: 'hi' });
			const input = [sys, user];

			const out = (model as any).sanitizeMessages(input);

			expect(out[0]).toBe(sys);
			expect(out[1]).toBe(user);
		});

		it('Case 6b — AI message with non-empty content is untouched (identity)', () => {
			const model = makeModel({});
			const ai = new AIMessage({ content: 'hello' });
			const input = [ai];

			const out = (model as any).sanitizeMessages(input);

			expect(out[0]).toBe(ai);
		});
	});

	// ── _generateNonStreaming ───────────────────────────────────────────────

	describe('_generateNonStreaming', () => {
		it('Case 7 — enablePromptCaching=true invokes injectCachePoints (system message acquires cachePoint block)', async () => {
			const superSpy = vi
				.spyOn(ChatBedrockConverse.prototype, '_generateNonStreaming')
				.mockResolvedValue({ generations: [], llmOutput: {} } as any);

			const model = makeModel({
				enablePromptCaching: true,
				cacheSystemPrompt: true,
			});
			const input = [
				new SystemMessage({ content: 'system-prompt' }),
				new HumanMessage({ content: 'hi' }),
			];

			await (model as any)._generateNonStreaming(input, {}, undefined);

			const passed = superSpy.mock.calls[0][0] as any[];
			// The system message content should now be an array containing a cachePoint marker.
			const sysOut = passed[0];
			expect(Array.isArray(sysOut.content)).toBe(true);
			const hasCachePoint = (sysOut.content as any[]).some((b) => b.cachePoint);
			expect(hasCachePoint).toBe(true);
			// Human message reference preserved (injectCachePoints returns originals for non-cache targets).
			expect(passed[1]).toBe(input[1]);
		});

		it('Case 7b — enablePromptCaching=false does NOT invoke injectCachePoints (messages pass through sanitize only)', async () => {
			const superSpy = vi
				.spyOn(ChatBedrockConverse.prototype, '_generateNonStreaming')
				.mockResolvedValue({ generations: [], llmOutput: {} } as any);

			const model = makeModel({ enablePromptCaching: false });
			const input = [new HumanMessage({ content: 'hi' })];

			await (model as any)._generateNonStreaming(input, {}, undefined);

			const passed = superSpy.mock.calls[0][0] as any[];
			// With caching disabled, the non-AI human message is passed through the sanitize
			// map — which returns the same reference for non-AI messages.
			expect(passed[0]).toBe(input[0]);
		});
	});

	// ── _generate ───────────────────────────────────────────────────────────

	describe('_generate', () => {
		it('Case 8 — response_metadata.usage / usage_metadata / llmOutput.tokenUsage populated with cacheRead/cacheWrite', async () => {
			const canned = {
				generations: [{
					text: 'hello',
					message: Object.assign(new AIMessage({ content: 'hello' }), {
						response_metadata: {
							usage: { cacheReadInputTokens: 123, cacheWriteInputTokens: 45 },
						},
						usage_metadata: { input_tokens: 500, output_tokens: 10 },
					}),
				}],
				llmOutput: {
					usage: { cacheReadInputTokens: 123, cacheWriteInputTokens: 45 },
				},
			};
			vi.spyOn(ChatBedrockConverse.prototype, '_generate').mockResolvedValue(canned as any);

			const model = makeModel({});
			const response = await (model as any)._generate([], {}, undefined);

			const msg = response.generations[0].message;
			expect(msg.response_metadata.promptCachingMetrics).toEqual({
				status: 'CACHE HIT',
				tokensReadFromCache: 123,
				tokensWrittenToCache: 45,
			});
			expect(msg.response_metadata.usage).toEqual({
				input_tokens: 500,
				output_tokens: 10,
				cache_read_input_tokens: 123,
				cache_creation_input_tokens: 45,
			});
			expect(msg.response_metadata.tokenUsage).toEqual({
				cacheReadInputTokens: 123,
				cacheWriteInputTokens: 45,
			});
			expect(msg.response_metadata.model_name).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
			expect(msg.additional_kwargs.model).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
			expect(msg.usage_metadata).toEqual({
				input_tokens: 500,
				output_tokens: 10,
				total_tokens: 510,
				input_token_details: { cache_read: 123, cache_creation: 45 },
			});
			expect(response.llmOutput.tokenUsage).toEqual({
				completionTokens: 10,
				promptTokens: 500,
				totalTokens: 510,
				cacheReadInputTokens: 123,
				cacheWriteInputTokens: 45,
			});
		});
	});

	// ── _streamResponseChunks ───────────────────────────────────────────────

	describe('_streamResponseChunks', () => {
		it('Case 9a — chunks without usage pass through unchanged', async () => {
			async function* fakeStream() {
				yield { text: 'a', message: { content: 'a' } } as any;
				yield { text: 'b', message: { content: 'b' } } as any;
			}
			vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
				fakeStream as any,
			);

			const model = makeModel({});
			const chunks = await collectChunks((model as any)._streamResponseChunks([], {}, undefined));

			expect(chunks).toHaveLength(2);
			expect(chunks[0].message.response_metadata).toBeUndefined();
			expect(chunks[1].message.response_metadata).toBeUndefined();
		});

		it('Case 9b — chunk with usage gets promptCachingMetrics injected', async () => {
			async function* fakeStream() {
				yield {
					text: '',
					message: {
						content: '',
						response_metadata: {
							usage: { cacheReadInputTokens: 10, cacheWriteInputTokens: 0 },
						},
						usage_metadata: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
					},
				} as any;
			}
			vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
				fakeStream as any,
			);

			const model = makeModel({});
			const chunks = await collectChunks((model as any)._streamResponseChunks([], {}, undefined));

			expect(chunks[0].message.response_metadata.promptCachingMetrics).toEqual({
				status: 'CACHE HIT',
				tokensReadFromCache: 10,
				tokensWrittenToCache: 0,
			});
		});

		it('Case 9c — streaming enrichment matches _generate metadata shape (parity)', async () => {
			async function* fakeStream() {
				yield {
					text: '',
					message: {
						content: '',
						response_metadata: {
							usage: { cacheReadInputTokens: 123, cacheWriteInputTokens: 45 },
						},
						usage_metadata: { input_tokens: 500, output_tokens: 10, total_tokens: 510 },
					},
				} as any;
			}
			vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
				fakeStream as any,
			);

			const model = makeModel({});
			const chunks = await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
			const msg = chunks[0].message;

			// Mirrors _generate's Case 8 assertions — same fields on streaming path.
			expect(msg.response_metadata.usage).toEqual({
				input_tokens: 500,
				output_tokens: 10,
				cache_read_input_tokens: 123,
				cache_creation_input_tokens: 45,
			});
			expect(msg.response_metadata.tokenUsage).toEqual({
				cacheReadInputTokens: 123,
				cacheWriteInputTokens: 45,
			});
			expect(msg.response_metadata.model_name).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
			expect(msg.additional_kwargs.model).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
			expect(msg.usage_metadata).toEqual({
				input_tokens: 500,
				output_tokens: 10,
				total_tokens: 510,
				input_token_details: { cache_read: 123, cache_creation: 45 },
			});
		});

		it('Case 9d — when super omits usage_metadata, falls back to raw Bedrock keys (inputTokens/outputTokens)', async () => {
			async function* fakeStream() {
				yield {
					text: '',
					message: {
						content: '',
						response_metadata: {
							usage: {
								inputTokens: 200,
								outputTokens: 20,
								cacheReadInputTokens: 50,
								cacheWriteInputTokens: 10,
							},
						},
						// no usage_metadata
					},
				} as any;
			}
			vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
				fakeStream as any,
			);

			const model = makeModel({});
			const chunks = await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
			const msg = chunks[0].message;

			expect(msg.response_metadata.usage.input_tokens).toBe(200);
			expect(msg.response_metadata.usage.output_tokens).toBe(20);
			expect(msg.usage_metadata.total_tokens).toBe(220);
		});
	});

	// ── formatCacheMetrics ──────────────────────────────────────────────────

	describe('formatCacheMetrics', () => {
		it('Case 10 — NO CACHE / CACHE HIT / CACHE WRITTEN status transitions', () => {
			const model = makeModel({});
			const fmt = (r: number, w: number) => (model as any).formatCacheMetrics(r, w);

			expect(fmt(0, 0)).toEqual({
				status: 'NO CACHE',
				tokensReadFromCache: 0,
				tokensWrittenToCache: 0,
			});
			expect(fmt(100, 0)).toEqual({
				status: 'CACHE HIT',
				tokensReadFromCache: 100,
				tokensWrittenToCache: 0,
			});
			expect(fmt(0, 50)).toEqual({
				status: 'CACHE WRITTEN',
				tokensReadFromCache: 0,
				tokensWrittenToCache: 50,
			});
			// HIT precedence when both are present
			expect(fmt(100, 50)).toEqual({
				status: 'CACHE HIT',
				tokensReadFromCache: 100,
				tokensWrittenToCache: 50,
			});
		});
	});

	// ── Logger fallback ─────────────────────────────────────────────────────

	describe('patchLogger fallback', () => {
		it('NOOP_LOGGER is used when patchLogger is undefined — enableDebugLogs does not crash', async () => {
			vi.spyOn(ChatBedrockConverse.prototype, '_generateNonStreaming').mockResolvedValue({
				generations: [],
				llmOutput: {},
			} as any);
			const model = makeModel({ enableDebugLogs: true }); // no loggerSink → NOOP
			await expect(
				(model as any)._generateNonStreaming([new HumanMessage({ content: 'hi' })], {}, undefined),
			).resolves.toBeDefined();
		});
	});
});
