/**
 * flock#1575 — wiring that the spec cannot see from inside the model class:
 * the node's UI option, the production client stack (a finalizeRequest
 * middleware like the Bearer one runs after ours), the streaming class with a
 * real callback URL, mixed TTLs, the response/metrics path (#633) and
 * several calls on one instance.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { HttpResponse } from '@smithy/protocol-http';

import {
	CONVERSATIONS,
	MODEL_ID,
	PROD_OPTIONS,
	TOOLS,
	captureCall,
	captureClient,
	countWireCachePoints,
	expectSentinel,
	makeCaptureModel,
} from './__testing__/converseCapture';
import { LmChatAwsBedrockAdvanced } from './LmChatAwsBedrockAdvanced.node';
import { PatchedChatBedrockConverse, type PatchOptions } from './PatchedChatBedrockConverse';
import { buildTokensUsage } from './buildTokensUsage';
import { ChatAwsBedrockAdvancedStreaming } from '../LmChatAwsBedrockAdvancedStreaming/ChatAwsBedrockAdvancedStreaming';

const GOLDEN = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'converse-body-alpha9.json'), 'utf8'));
const ON = { ...PROD_OPTIONS, cacheToolResults: true } as PatchOptions;
const SIBLING = { cachePoint: { type: 'default' } };
const plusSibling = (key: string) => {
	const g = structuredClone(GOLDEN[key]);
	g.messages.at(-1).content.push(SIBLING);
	return g;
};

afterEach(() => vi.unstubAllGlobals());

describe('node UI', () => {
	it('exposes Cache Tool Results inside Options, off by default, only with prompt caching', () => {
		const options = new LmChatAwsBedrockAdvanced().description.properties.find((p: any) => p.name === 'options') as any;
		const opt = options.options.find((o: any) => o.name === 'cacheToolResults');
		expect(opt).toBeDefined();
		expect(opt.type).toBe('boolean');
		expect(opt.default).toBe(false);
		expect(opt.displayOptions).toEqual({ show: { enablePromptCaching: [true] } });
	});
});

describe('mixed TTL (cacheTtl 1h on tools — present in some PROD workflows)', () => {
	it.each(['nonStreaming', 'streaming'] as const)('%s: only change is the sibling, without ttl; 1h point stays before the 5m ones', async (route) => {
		const body = await captureCall(route, { ...ON, cacheTtl: '1h' }, CONVERSATIONS.oneToolResult());
		expect(body).toEqual(plusSibling(`prod1h/oneToolResult/${route}`));
		expect(body.toolConfig.tools.at(-1)).toEqual({ cachePoint: { type: 'default', ttl: '1h' } });
		expect(body.messages.at(-1).content.at(-1)).toEqual(SIBLING);
		// Bedrock prefix order is tools → system → messages: every point after the 1h one is 5m.
		const later = [...body.system, ...body.messages.flatMap((m: any) => m.content)].filter((b: any) => b.cachePoint);
		expect(later.every((b: any) => (b.cachePoint.ttl ?? '5m') === '5m')).toBe(true);
	});
});

describe('production client stack', () => {
	it('a finalizeRequest middleware (where the Bearer auth lives) already sees the sibling in the serialized body', async () => {
		const cap = captureClient();
		const seen: string[] = [];
		cap.client.middlewareStack.add(
			(next: any) => async (args: any) => {
				seen.push(String(args.request.body));
				return next(args);
			},
			{ step: 'finalizeRequest', priority: 'low', name: 'testFinalizeSpy' },
		);
		const model = makeCaptureModel('nonStreaming', ON, cap.client);
		await expectSentinel(model.bindTools(TOOLS as any).invoke(CONVERSATIONS.oneToolResult()));
		expect(seen).toHaveLength(1);
		expect(JSON.parse(seen[0]).messages.at(-1).content.at(-1)).toEqual(SIBLING);
	});

	it('a model built WITHOUT an injected client (LangChain creates one) registers too', () => {
		const model = new PatchedChatBedrockConverse({
			model: MODEL_ID,
			region: 'eu-central-1',
			credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
			patchOptions: ON,
		} as any);
		expect((model as any).client.middlewareStack.identify().some((s: string) => s.startsWith('flockToolResultCachePoint '))).toBe(true);
	});
});

describe('streaming class as production builds it (callback URL set)', () => {
	it('adds the sibling and still posts its events', async () => {
		const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
		const cap = captureClient();
		const model = new ChatAwsBedrockAdvancedStreaming({
			client: cap.client,
			model: MODEL_ID,
			region: 'eu-central-1',
			patchOptions: ON,
			streamCallbackUrl: 'http://callback.invalid/stream',
			streamSessionId: 's1',
		});
		await expectSentinel(model.bindTools(TOOLS as any).invoke(CONVERSATIONS.oneToolResult()));
		expect(cap.captured[0].path).toMatch(/\/converse-stream$/);
		expect(cap.captured[0].body).toEqual(plusSibling('prod/oneToolResult/streaming'));
	});
});

describe('several calls on one instance (one agent turn)', () => {
	it('first call quiet, then every tool-result call gets exactly one sibling at its end', async () => {
		const cap = captureClient();
		const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const model = makeCaptureModel('streaming', ON, cap.client, log).bindTools(TOOLS as any);
		for (const conv of ['firstCallNoTools', 'oneToolResult', 'twoRounds'] as const) {
			await expectSentinel(model.invoke(CONVERSATIONS[conv]()));
		}
		expect(cap.captured).toHaveLength(3);
		expect(cap.captured[0].body).toEqual(GOLDEN['prod/firstCallNoTools/streaming']);
		expect(cap.captured[1].body).toEqual(plusSibling('prod/oneToolResult/streaming'));
		expect(cap.captured[2].body).toEqual(plusSibling('prod/twoRounds/streaming'));
		expect(cap.captured.every((c) => countWireCachePoints(c.body) <= 4)).toBe(true);
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe('response path untouched (#633 metrics)', () => {
	function respondingClient() {
		const usage = { inputTokens: 1, outputTokens: 7, totalTokens: 11563, cacheReadInputTokens: 11048, cacheWriteInputTokens: 507 };
		const payload = JSON.stringify({
			output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
			stopReason: 'end_turn',
			usage,
			metrics: { latencyMs: 5 },
		});
		return new BedrockRuntimeClient({
			region: 'eu-central-1',
			credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
			maxAttempts: 1,
			requestHandler: {
				handle: async () => ({
					response: new HttpResponse({
						statusCode: 200,
						headers: { 'content-type': 'application/json' },
						body: Readable.from([Buffer.from(payload)]),
					}),
				}),
			} as any,
		});
	}

	async function runWith(opts: PatchOptions) {
		const model = new PatchedChatBedrockConverse({ client: respondingClient(), model: MODEL_ID, region: 'eu-central-1', patchOptions: opts });
		let llmOutput: any;
		const msg: any = await model.bindTools(TOOLS as any).invoke(CONVERSATIONS.oneToolResult(), {
			callbacks: [{ handleLLMEnd: (out: any) => { llmOutput = out.llmOutput; } }],
		});
		return { usage_metadata: msg.usage_metadata, promptCachingMetrics: msg.response_metadata.promptCachingMetrics, tokens: buildTokensUsage(llmOutput?.tokenUsage) };
	}

	it('cache figures reach usage_metadata / tokensUsage identically with the option ON and OFF', async () => {
		const off = await runWith(PROD_OPTIONS);
		const on = await runWith(ON);
		expect(on).toEqual(off);
		expect(on.tokens.cacheReadInputTokens).toBe(11048);
		expect(on.tokens.cacheWriteInputTokens).toBe(507);
		expect(on.usage_metadata.input_token_details).toEqual({ cache_read: 11048, cache_creation: 507 });
	});
});

describe('log attribution', () => {
	it('warnings from a real model name the model, so they can be traced in a worker log', async () => {
		const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const cap = captureClient();
		const model = makeCaptureModel('nonStreaming', { ...ON, systemPromptBlocks: '["' + 'a '.repeat(2100) + '","' + 'b '.repeat(2100) + '"]' }, cap.client, log);
		await expectSentinel(model.bindTools(TOOLS as any).invoke(CONVERSATIONS.oneToolResult()));
		const budget = log.warn.mock.calls.map(([m]) => String(m)).filter((m) => /toolResultCache/.test(m));
		expect(budget).toHaveLength(1);
		expect(budget[0]).toContain(`[${MODEL_ID}]`);
	});
});
