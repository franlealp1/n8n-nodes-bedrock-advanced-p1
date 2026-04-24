import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ChatBedrockConverse } from '@langchain/aws';

import { PatchedChatBedrockConverse } from '../LmChatAwsBedrockAdvanced/PatchedChatBedrockConverse';
import { ChatAwsBedrockAdvancedStreaming } from './ChatAwsBedrockAdvancedStreaming';

/**
 * Stub client that passes the ChatBedrockConverse constructor type check.
 * Streaming chunks are produced by vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks'),
 * so the stub's send() is never invoked by the tests below.
 */
function stubClient(): BedrockRuntimeClient {
	return {
		send: async () => ({ body: (async function* () {})() }),
	} as unknown as BedrockRuntimeClient;
}

/** Fixed stream emitted by the ChatBedrockConverse super override — shared across tests. */
async function* fakeSuperStream() {
	yield { text: 'Hello', message: { content: 'Hello' } } as any;
	yield { text: ' world', message: { content: ' world' } } as any;
	yield {
		text: '',
		message: {
			content: '',
			response_metadata: {
				usage: { cacheReadInputTokens: 0, cacheWriteInputTokens: 100 },
			},
		},
	} as any;
}

async function collectChunks<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const c of gen) out.push(c);
	return out;
}

type FetchCall = { url: string; body: any; headers: Record<string, string> };

function makeFetchSpy(): { spy: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const spy = (async (url: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
		let parsed: any = rawBody;
		try { parsed = JSON.parse(rawBody); } catch { /* leave raw */ }
		calls.push({ url: String(url), body: parsed, headers });
		return new Response('ok');
	}) as unknown as typeof fetch;
	return { spy, calls };
}

describe('ChatAwsBedrockAdvancedStreaming', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// ── Case 1 — byte-identity with empty streamCallbackUrl ──────────────────

	it('Case 1 — yields the same ChatGenerationChunk sequence as PatchedChatBedrockConverse (empty URL)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStream as any,
		);

		const baseModel = new PatchedChatBedrockConverse({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: { enablePromptCaching: false },
		});
		const streamingModel = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: { enablePromptCaching: false },
			// streamCallbackUrl: undefined — explicit no-op
		});

		const baseOut = await collectChunks(
			(baseModel as any)._streamResponseChunks([], {}, undefined),
		);
		const streamingOut = await collectChunks(
			(streamingModel as any)._streamResponseChunks([], {}, undefined),
		);

		expect(JSON.parse(JSON.stringify(streamingOut))).toEqual(
			JSON.parse(JSON.stringify(baseOut)),
		);
	});

	// ── Case 2 — no fetch when streamCallbackUrl is empty ────────────────────

	it('Case 2 — does not emit any fetch call when streamCallbackUrl is empty', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStream as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const streamingModel = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
		});
		await collectChunks((streamingModel as any)._streamResponseChunks([], {}, undefined));

		expect(calls).toHaveLength(0);
	});

	// ── Case 3 — aggregate POST deltas equal generated text ─────────────────

	it('Case 3 — with URL set, concatenated POST deltas equal the generated text', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStream as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's1',
			streamBatchIntervalMs: 60,
			streamMaxBatchChars: 120,
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const aggregated = calls.map((c) => c.body.delta).join('');
		expect(aggregated).toBe('Hello world');
		for (const c of calls) {
			expect(typeof c.body.delta).toBe('string');
		}
		expect(calls.length).toBeGreaterThan(0);
	});

	// ── Case 4 — done:true on generator completion ──────────────────────────

	it('Case 4 — emits exactly one final POST with done:true on completion; seq matches last call', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStream as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's2',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const done = calls.filter((c) => c.body.done === true);
		expect(done).toHaveLength(1);
		expect(done[0].body.seq).toBe(calls[calls.length - 1].body.seq);
	});

	// ── Case 5 — done:true even when consumer break()-s early ───────────────

	it('Case 5 — emits final POST with done:true when consumer break()-s early (try/finally fires)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStream as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's3',
		});

		const gen = (model as any)._streamResponseChunks([], {}, undefined);
		for await (const _c of gen) { break; }
		await new Promise((r) => setImmediate(r));

		const done = calls.filter((c) => c.body.done === true);
		expect(done).toHaveLength(1);
	});

	// ── Case 6 — streaming flag forced on ───────────────────────────────────

	it('Case 6 — this.streaming=true is forced even if caller sets streaming:false', () => {
		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streaming: false,
		});
		expect(model.streaming).toBe(true);
	});
});
