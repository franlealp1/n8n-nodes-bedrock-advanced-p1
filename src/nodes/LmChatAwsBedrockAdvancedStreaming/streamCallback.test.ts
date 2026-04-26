import { describe, expect, it, vi, afterEach } from 'vitest';

import { createStreamCallback, type StreamCallbackConfig, type StreamCallbackLogger } from './streamCallback';

type FetchCall = { url: string; body: any; headers: Record<string, string> };

function makeFakeFetch(overrideImpl?: () => Promise<Response>): {
	fetchImpl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const rawBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
		let parsed: any = rawBody;
		try { parsed = JSON.parse(rawBody); } catch { /* leave raw */ }
		calls.push({ url: String(url), body: parsed, headers });
		if (overrideImpl) return overrideImpl();
		return new Response('ok');
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function makeLogger(): {
	logger: StreamCallbackLogger;
	info: string[];
	warn: string[];
	error: string[];
} {
	const info: string[] = [];
	const warn: string[] = [];
	const error: string[] = [];
	return {
		logger: {
			info: (m: string) => info.push(m),
			warn: (m: string) => warn.push(m),
			error: (m: string) => error.push(m),
		},
		info, warn, error,
	};
}

function chunkWithText(text: string): any {
	return { text, message: { content: text } };
}

function chunkEmptyText(): any {
	return { text: '', message: { content: '' } };
}

function chunkToolStart(idx: number, name: string, id: string): any {
	return {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ name, id, index: idx, type: 'tool_call_chunk' }],
		},
	};
}

function chunkToolDelta(idx: number, args: string): any {
	return {
		text: '',
		message: {
			content: '',
			tool_call_chunks: [{ args, index: idx, type: 'tool_call_chunk' }],
		},
	};
}

function chunkMessageStop(stopReason: string): any {
	return {
		text: '',
		message: {
			content: '',
			response_metadata: { messageStop: { stopReason } },
		},
	};
}

function baseCfg(overrides: Partial<StreamCallbackConfig> = {}): StreamCallbackConfig {
	return {
		callbackUrl: 'http://example.test/cb',
		sessionId: 'sess-1',
		batchIntervalMs: 60,
		maxBatchChars: 120,
		...overrides,
	};
}

describe('createStreamCallback', () => {
	afterEach(() => vi.useRealTimers());

	// ── Existing tests, processChunk-renamed ─────────────────────────────────

	it('no-op when callbackUrl is empty', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback({
			callbackUrl: '',
			batchIntervalMs: 60,
			maxBatchChars: 120,
			fetchImpl,
		});
		for (let i = 0; i < 10; i++) session.processChunk(chunkWithText('x'));
		expect(vi.getTimerCount()).toBe(0);
		await session.flushFinal();
		expect(calls).toHaveLength(0);
	});

	it('batches by interval', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		for (let i = 0; i < 10; i++) session.processChunk(chunkWithText('0123456789'));
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.delta).toBe('0123456789'.repeat(10));
		expect(calls[0].body.done).toBe(false);
		expect(calls[0].body.seq).toBe(0);
	});

	it('batches by chars', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl, maxBatchChars: 120 }));
		session.processChunk(chunkWithText('A'.repeat(500)));
		// Timer advance not needed — flush is synchronous on threshold.
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.delta).toHaveLength(500);
		expect(calls[0].body.done).toBe(false);
	});

	it('multiple flushes keep seq monotonic', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));

		session.processChunk(chunkWithText('a'));
		await vi.advanceTimersByTimeAsync(60);
		session.processChunk(chunkWithText('b'));
		await vi.advanceTimersByTimeAsync(60);
		session.processChunk(chunkWithText('c'));
		await vi.advanceTimersByTimeAsync(60);

		expect(calls).toHaveLength(3);
		expect(calls.map((c) => c.body.seq)).toEqual([0, 1, 2]);
	});

	it('fetch rejection does not throw out of processChunk', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch(() => Promise.reject(new Error('boom')));
		const { logger, error } = makeLogger();
		const session = createStreamCallback(baseCfg({ fetchImpl, logger }));

		expect(() => session.processChunk(chunkWithText('hi'))).not.toThrow();
		await vi.advanceTimersByTimeAsync(60);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(error.some((m) => m.includes('POST failed'))).toBe(true);

		// subsequent append still works
		expect(() => session.processChunk(chunkWithText('bye'))).not.toThrow();
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(2);
	});

	it('flushFinal emits done:true with remaining buffer', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('A'.repeat(30)));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.done).toBe(true);
		expect(calls[0].body.delta).toBe('A'.repeat(30));
	});

	it('flushFinal emits done:true with empty delta when buffer empty', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.done).toBe(true);
		expect(calls[0].body.delta).toBe('');
	});

	it('chunk with text==="" is filtered (tool_use / message_delta semantics)', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		for (let i = 0; i < 5; i++) session.processChunk(chunkEmptyText());
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(0);
	});

	it('chunk with text==="" interleaved with real text only emits the real text', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkEmptyText());
		session.processChunk(chunkWithText('hello'));
		session.processChunk(chunkEmptyText());
		session.processChunk(chunkWithText(' world'));
		session.processChunk(chunkEmptyText());
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.delta).toBe('hello world');
	});

	it('auth header present when authHeaderValue is set; absent when not', async () => {
		vi.useFakeTimers();

		const first = makeFakeFetch();
		const withAuth = createStreamCallback(baseCfg({
			fetchImpl: first.fetchImpl,
			authHeaderValue: 'secret-xyz',
		}));
		withAuth.processChunk(chunkWithText('a'));
		await vi.advanceTimersByTimeAsync(60);
		expect(first.calls[0].headers['x-webhook-auth']).toBe('secret-xyz');
		expect(first.calls[0].headers['Content-Type']).toBe('application/json');

		const second = makeFakeFetch();
		const noAuth = createStreamCallback(baseCfg({
			fetchImpl: second.fetchImpl,
			authHeaderValue: undefined,
		}));
		noAuth.processChunk(chunkWithText('b'));
		await vi.advanceTimersByTimeAsync(60);
		expect(second.calls[0].headers['x-webhook-auth']).toBeUndefined();
	});

	// ── New tests: tool_call_chunks accumulation + semantic events ──────────

	it('processChunk with tool_call_chunks (start) accumulates name+id by index without firing fetch', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkToolStart(0, 'searchEmail', 'tooluse_abc'));
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(0);
	});

	it('processChunk with tool_call_chunks (delta args) concatenates argsBuffer by index', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkToolStart(0, 'searchEmail', 'tooluse_abc'));
		session.processChunk(chunkToolDelta(0, '{"q":"'));
		session.processChunk(chunkToolDelta(0, 'plan"}'));
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		// After flushFinal: 1 done-delta (empty buffer) + 1 tool-call-start.
		expect(calls).toHaveLength(2);
		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.body.tools).toEqual([
			{ name: 'searchEmail', id: 'tooluse_abc', args: { q: 'plan' } },
		]);
	});

	it('flushFinal with stopReason="tool_use" emits POST to {url}/agent-event', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkToolStart(0, 'doX', 'tu_1'));
		session.processChunk(chunkToolDelta(0, '{}'));
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.url).toBe('http://example.test/cb/agent-event');
	});

	it('flushFinal with stopReason="end_turn" emits agent-finish with text aggregated and finishReason', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('Hello'));
		session.processChunk(chunkWithText(' world'));
		session.processChunk(chunkMessageStop('end_turn'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const finish = calls.find((c) => c.body.type === 'agent-finish');
		expect(finish).toBeDefined();
		expect(finish!.url).toBe('http://example.test/cb/agent-event');
		expect(finish!.body.text).toBe('Hello world');
		expect(finish!.body.finishReason).toBe('end_turn');
	});

	it('flushFinal with stopReason="max_tokens" emits agent-finish with finishReason="max_tokens"', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('partial'));
		session.processChunk(chunkMessageStop('max_tokens'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const finish = calls.find((c) => c.body.type === 'agent-finish');
		expect(finish).toBeDefined();
		expect(finish!.body.finishReason).toBe('max_tokens');
	});

	it('flushFinal with stopReason="stop_sequence" emits agent-finish with finishReason="stop_sequence"', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('done'));
		session.processChunk(chunkMessageStop('stop_sequence'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const finish = calls.find((c) => c.body.type === 'agent-finish');
		expect(finish).toBeDefined();
		expect(finish!.body.finishReason).toBe('stop_sequence');
	});

	it('flushFinal with stopReason undefined emits only delta done:true (no tool-call-start, no agent-finish)', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('hi'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].body.type).toBe('delta');
		expect(calls[0].body.done).toBe(true);
	});

	it('flushFinal with unknown stopReason (guardrail_intervened) emits only delta done:true', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('blocked'));
		session.processChunk(chunkMessageStop('guardrail_intervened'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.filter((c) => c.body.type === 'agent-finish')).toHaveLength(0);
		expect(calls.filter((c) => c.body.type === 'tool-call-start')).toHaveLength(0);
	});

	it('argsBuffer truncated/invalid JSON falls back to {_raw:"..."} without throwing', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkToolStart(0, 'doIt', 'tu_x'));
		session.processChunk(chunkToolDelta(0, '{"q":"plan'));   // truncated, missing closing
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.body.tools[0].args).toEqual({ _raw: '{"q":"plan' });
	});

	it('Callback URL with trailing slash is trimmed: http://x/cb/ → POSTs to /stream-token and /agent-event', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl, callbackUrl: 'http://x/cb/' }));
		session.processChunk(chunkWithText('hi'));
		session.processChunk(chunkMessageStop('end_turn'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const urls = calls.map((c) => c.url);
		expect(urls).toContain('http://x/cb/stream-token');
		expect(urls).toContain('http://x/cb/agent-event');
		// No double-slash:
		expect(urls.some((u) => u.includes('//stream-token') || u.includes('//agent-event'))).toBe(false);
	});

	it('agentName and agentColor present in body of every POST when configured', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({
			fetchImpl,
			agentName: 'Copiloto',
			agentColor: '#FF5733',
		}));
		session.processChunk(chunkWithText('hi'));
		session.processChunk(chunkMessageStop('end_turn'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const c of calls) {
			expect(c.body.agentName).toBe('Copiloto');
			expect(c.body.color).toBe('#FF5733');
			expect(typeof c.body.timestamp).toBe('string');
			// ISO 8601 sanity
			expect(c.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		}
	});

	it('agentName and agentColor absent (not null) when not configured', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('hi'));
		session.processChunk(chunkMessageStop('end_turn'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		for (const c of calls) {
			expect('agentName' in c.body).toBe(false);
			expect('color' in c.body).toBe(false);
		}
	});

	it('seq monotonic across types: deltas + agent-finish share counter incrementally', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		// Two flushed deltas + done + agent-finish → 4 POSTs.
		session.processChunk(chunkWithText('a'));
		await vi.advanceTimersByTimeAsync(60);
		session.processChunk(chunkWithText('b'));
		await vi.advanceTimersByTimeAsync(60);
		session.processChunk(chunkMessageStop('end_turn'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const seqs = calls.map((c) => c.body.seq);
		expect(seqs).toEqual([0, 1, 2, 3]);
		// Last call must be agent-finish.
		expect(calls[calls.length - 1].body.type).toBe('agent-finish');
	});

	it('body always has explicit type:"delta" for delta POSTs (no implicit absence)', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkWithText('hi'));
		await vi.advanceTimersByTimeAsync(60);
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		for (const c of calls) {
			expect(c.body.type).toBeDefined();
			expect(['delta', 'tool-call-start', 'agent-finish']).toContain(c.body.type);
		}
	});

	it('multi-tool parallel (index=0 and index=1) accumulates independently and emits both in tools[]', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.processChunk(chunkToolStart(0, 'getEmail', 'tu_0'));
		session.processChunk(chunkToolStart(1, 'getCalendar', 'tu_1'));
		session.processChunk(chunkToolDelta(0, '{"q":"a"}'));
		session.processChunk(chunkToolDelta(1, '{"day":"mon"}'));
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		const toolCall = calls.find((c) => c.body.type === 'tool-call-start');
		expect(toolCall).toBeDefined();
		expect(toolCall!.body.tools).toHaveLength(2);
		expect(toolCall!.body.tools[0]).toEqual({ name: 'getEmail', id: 'tu_0', args: { q: 'a' } });
		expect(toolCall!.body.tools[1]).toEqual({ name: 'getCalendar', id: 'tu_1', args: { day: 'mon' } });
	});

	it('no-op fast path (callbackUrl empty) does NOT emit tool-call-start or agent-finish either', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback({
			callbackUrl: '',
			batchIntervalMs: 60,
			maxBatchChars: 120,
			fetchImpl,
		});
		session.processChunk(chunkWithText('hi'));
		session.processChunk(chunkToolStart(0, 'doX', 'tu_x'));
		session.processChunk(chunkToolDelta(0, '{}'));
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(0);
	});

	it('tool_use stopReason without any tool_call_chunks does NOT emit tool-call-start', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		// Edge case: stopReason=tool_use but accumulator is empty → silently drop.
		session.processChunk(chunkMessageStop('tool_use'));
		await session.flushFinal();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.filter((c) => c.body.type === 'tool-call-start')).toHaveLength(0);
	});
});
