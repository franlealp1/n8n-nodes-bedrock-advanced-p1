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

/**
 * Rich fake stream: text deltas + tool_call_chunks (start + delta args)
 * + metadata + messageStop. Mirrors the catch-all branch of @langchain/aws
 * chat_models.cjs L735-743 where messageStop lands under response_metadata.
 */
async function* fakeSuperStreamRich() {
	yield { text: 'Hello', message: { content: 'Hello' } } as any;
	yield { text: ' world', message: { content: ' world' } } as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [
				{ name: 'searchEmail', id: 'tooluse_abc123', index: 0, type: 'tool_call_chunk' },
			],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ args: '{"query":"', index: 0, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ args: 'project plan"}', index: 0, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			response_metadata: {
				usage: { cacheReadInputTokens: 0, cacheWriteInputTokens: 100 },
			},
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			response_metadata: { messageStop: { stopReason: 'tool_use' } },
		},
	} as any;
}

/** Stream that ends with end_turn (final agent answer, no tool call). */
async function* fakeSuperStreamFinish() {
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
	yield {
		text: '',
		message: {
			content: '',
			response_metadata: { messageStop: { stopReason: 'end_turn' } },
		},
	} as any;
}

/** Stream with two parallel tool calls (rare but possible in Claude). */
async function* fakeSuperStreamMultiTool() {
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ name: 'getEmail', id: 'tu_0', index: 0, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ name: 'getCalendar', id: 'tu_1', index: 1, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ args: '{"q":"a"}', index: 0, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ args: '{"day":"mon"}', index: 1, type: 'tool_call_chunk' }],
		},
	} as any;
	yield {
		text: '',
		message: {
			content: '',
			response_metadata: { messageStop: { stopReason: 'tool_use' } },
		},
	} as any;
}

/** Legacy text-only stream (used by simple tests where chunks/stop don't matter). */
async function* fakeSuperStreamTextOnly() {
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

	// ── Case 1 — byte-identity with empty streamCallbackUrl (AC1 line) ──────

	it('Case 1 — yields the same ChatGenerationChunk sequence as PatchedChatBedrockConverse (empty URL, rich stream)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamRich as any,
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
		// Sanity: rich stream produced 7 chunks (2 text + 1 tool_start + 2 tool_delta + 1 metadata + 1 stop).
		expect(streamingOut).toHaveLength(7);
	});

	// ── Case 2 — no fetch when streamCallbackUrl is empty (rich stream) ─────

	it('Case 2 — does not emit any fetch call when streamCallbackUrl is empty (even with tool/stop chunks)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamRich as any,
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
			fakeSuperStreamTextOnly as any,
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

		const deltaCalls = calls.filter((c) => c.body.type === 'delta');
		const aggregated = deltaCalls.map((c) => c.body.delta).join('');
		expect(aggregated).toBe('Hello world');
		for (const c of deltaCalls) {
			expect(typeof c.body.delta).toBe('string');
		}
		expect(deltaCalls.length).toBeGreaterThan(0);
	});

	// ── Case 4 — done:true on generator completion ──────────────────────────

	it('Case 4 — emits exactly one final delta POST with done:true on completion', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamTextOnly as any,
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
	});

	// ── Case 5 — done:true even when consumer break()-s early ───────────────

	it('Case 5 — emits final POST with done:true when consumer break()-s early (try/finally fires)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamTextOnly as any,
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

	// ── Case 7 — tool-call-start emission ───────────────────────────────────

	it('Case 7 — with URL set and stopReason="tool_use", emits tool-call-start with tools[{name,id,args:parsed}] to /agent-event', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamRich as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's7',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.url).toBe('http://example.test/cb/agent-event');
		expect(toolCall!.body.tools).toEqual([
			{ name: 'searchEmail', id: 'tooluse_abc123', args: { query: 'project plan' } },
		]);
		expect(toolCall!.body.streamId).toBe('s7');
	});

	// ── Case 8 — agent-finish emission ──────────────────────────────────────

	it('Case 8 — with URL set and stopReason="end_turn", emits agent-finish with text="Hello world" and finishReason to /agent-event', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamFinish as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's8',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const finish = calls.find((c) => c.body.type === 'agent-finish');
		expect(finish).toBeDefined();
		expect(finish!.url).toBe('http://example.test/cb/agent-event');
		expect(finish!.body.text).toBe('Hello world');
		expect(finish!.body.finishReason).toBe('end_turn');
	});

	// ── Case 9 — path routing (deltas → /stream-token, events → /agent-event) ─

	it('Case 9 — path routing: deltas POST to /stream-token, events POST to /agent-event; trailing slash trimmed', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamFinish as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb/',  // trailing slash
			streamSessionId: 's9',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const deltas = calls.filter((c) => c.body.type === 'delta');
		const events = calls.filter((c) => c.body.type !== 'delta');
		expect(deltas.length).toBeGreaterThan(0);
		expect(events.length).toBeGreaterThan(0);
		for (const c of deltas) {
			expect(c.url).toBe('http://example.test/cb/stream-token');
		}
		for (const c of events) {
			expect(c.url).toBe('http://example.test/cb/agent-event');
		}
		// No double-slash anywhere:
		for (const c of calls) {
			expect(c.url.includes('//stream-token')).toBe(false);
			expect(c.url.includes('//agent-event')).toBe(false);
		}
	});

	// ── Case 10 — agentName + agentColor propagated ─────────────────────────

	it('Case 10 — streamAgentName and streamAgentColor appear in every POST body', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamFinish as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's10',
			streamAgentName: 'Copiloto',
			streamAgentColor: '#FF5733',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const c of calls) {
			expect(c.body.agentName).toBe('Copiloto');
			expect(c.body.color).toBe('#FF5733');
			expect(typeof c.body.timestamp).toBe('string');
		}
	});

	// ── Case 11 — seq monotonic across types ────────────────────────────────

	it('Case 11 — seq is monotonic across types (delta, tool-call-start, agent-finish share counter)', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamFinish as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's11',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const seqs = calls.map((c) => c.body.seq);
		// Strictly increasing.
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
		}
		// First seq is 0, last is calls.length - 1.
		expect(seqs[0]).toBe(0);
		expect(seqs[seqs.length - 1]).toBe(calls.length - 1);
		// Final is agent-finish (after the done:true delta).
		expect(calls[calls.length - 1].body.type).toBe('agent-finish');
	});

	// ── Case 12 — multi-tool parallel ───────────────────────────────────────

	it('Case 12 — multi-tool parallel (index=0 and index=1) accumulates separately and emits both in tools[]', async () => {
		vi.spyOn(ChatBedrockConverse.prototype, '_streamResponseChunks').mockImplementation(
			fakeSuperStreamMultiTool as any,
		);
		const { spy, calls } = makeFetchSpy();
		vi.stubGlobal('fetch', spy);

		const model = new ChatAwsBedrockAdvancedStreaming({
			client: stubClient(),
			model: 'test-model',
			region: 'us-west-2',
			patchOptions: {},
			streamCallbackUrl: 'http://example.test/cb',
			streamSessionId: 's12',
		});

		await collectChunks((model as any)._streamResponseChunks([], {}, undefined));
		await new Promise((r) => setImmediate(r));

		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.body.tools).toHaveLength(2);
		expect(toolCall!.body.tools[0]).toEqual({ name: 'getEmail', id: 'tu_0', args: { q: 'a' } });
		expect(toolCall!.body.tools[1]).toEqual({
			name: 'getCalendar',
			id: 'tu_1',
			args: { day: 'mon' },
		});
	});
});
