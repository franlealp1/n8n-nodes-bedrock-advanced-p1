import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

import { ChatBedrockClaude } from '../LmChatBedrockClaude/ChatBedrockClaude';
import { ChatBedrockClaudeStreaming } from './ChatBedrockClaudeStreaming';

/**
 * Build a minimal mock BedrockRuntimeClient that yields a canned list of Anthropic events
 * as if received from InvokeModelWithResponseStreamCommand.
 *
 * The parent's _streamResponseChunks only calls `.send(command)` and iterates `.body` — so
 * the mock only needs to satisfy that narrow surface. The cast via `unknown` bypasses the
 * vast SDK surface we don't exercise.
 */
function makeMockClient(events: Array<Record<string, any>>): BedrockRuntimeClient {
	async function* eventStream() {
		for (const event of events) {
			const bytes = new TextEncoder().encode(JSON.stringify(event));
			yield { chunk: { bytes } };
		}
	}
	return {
		send: async (_command: unknown) => ({ body: eventStream() }),
	} as unknown as BedrockRuntimeClient;
}

/** Canonical two-delta completion — "Hello world" split across two text_deltas. */
const FIXED_TEXT_EVENTS: Array<Record<string, any>> = [
	{ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
	{ type: 'content_block_stop',  index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
	{ type: 'message_stop' },
];

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

describe('ChatBedrockClaudeStreaming', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	describe('byte-identity with empty streamCallbackUrl', () => {
		it('yields the same ChatGenerationChunk sequence as ChatBedrockClaude', async () => {
			const baseModel = new ChatBedrockClaude({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
			});
			const streamingModel = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
				// streamCallbackUrl: undefined — explicit no-op
			});

			const baseOut = await collectChunks(
				baseModel._streamResponseChunks([], {} as any, undefined),
			);
			const streamingOut = await collectChunks(
				streamingModel._streamResponseChunks([], {} as any, undefined),
			);

			expect(JSON.parse(JSON.stringify(streamingOut))).toEqual(
				JSON.parse(JSON.stringify(baseOut)),
			);
		});

		it('does not emit any fetch call when streamCallbackUrl is empty', async () => {
			const { spy, calls } = makeFetchSpy();
			vi.stubGlobal('fetch', spy);

			const streamingModel = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
			});
			await collectChunks(streamingModel._streamResponseChunks([], {} as any, undefined));

			expect(calls).toHaveLength(0);
		});
	});

	describe('generator with streamCallbackUrl set', () => {
		it('emits POSTs containing only text deltas (aggregate equals generated text)', async () => {
			const { spy, calls } = makeFetchSpy();
			vi.stubGlobal('fetch', spy);

			const model = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
				streamCallbackUrl: 'http://example.test/cb',
				streamSessionId: 's1',
				streamBatchIntervalMs: 60,
				streamMaxBatchChars: 120,
			});

			await collectChunks(model._streamResponseChunks([], {} as any, undefined));
			// Allow any pending microtasks to settle.
			await new Promise((r) => setImmediate(r));

			// Aggregate across intermediate + final POSTs — batching timing is not asserted here,
			// only that the concatenated delta equals the full generated text and that no
			// tool_use / message_delta chunk (text:'') leaked into any POST body.
			const aggregated = calls.map((c) => c.body.delta).join('');
			expect(aggregated).toBe('Hello world');

			for (const c of calls) {
				expect(typeof c.body.delta).toBe('string');
			}
			expect(calls.length).toBeGreaterThan(0);
		});

		it('emits final POST with done:true on generator completion', async () => {
			const { spy, calls } = makeFetchSpy();
			vi.stubGlobal('fetch', spy);

			const model = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
				streamCallbackUrl: 'http://example.test/cb',
				streamSessionId: 's2',
			});

			await collectChunks(model._streamResponseChunks([], {} as any, undefined));
			await new Promise((r) => setImmediate(r));

			const done = calls.filter((c) => c.body.done === true);
			expect(done).toHaveLength(1);
			expect(done[0].body.seq).toBe(calls[calls.length - 1].body.seq);
		});

		it('emits final POST with done:true when consumer break()-s early', async () => {
			const { spy, calls } = makeFetchSpy();
			vi.stubGlobal('fetch', spy);

			const model = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
				streamCallbackUrl: 'http://example.test/cb',
				streamSessionId: 's3',
			});

			const gen = model._streamResponseChunks([], {} as any, undefined);
			for await (const _c of gen) { break; }
			await new Promise((r) => setImmediate(r));

			const done = calls.filter((c) => c.body.done === true);
			expect(done).toHaveLength(1);
		});

		it('ChatBedrockClaude.streaming flag is honored even if caller sets streaming:false', () => {
			const model = new ChatBedrockClaudeStreaming({
				client: makeMockClient(FIXED_TEXT_EVENTS),
				model: 'test-model',
				region: 'us-west-2',
				streaming: false,
			});
			expect(model.streaming).toBe(true);
		});
	});
});
