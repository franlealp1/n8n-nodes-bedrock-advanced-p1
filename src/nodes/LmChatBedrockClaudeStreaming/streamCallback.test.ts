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

	it('no-op when callbackUrl is empty', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback({
			callbackUrl: '',
			batchIntervalMs: 60,
			maxBatchChars: 120,
			fetchImpl,
		});
		for (let i = 0; i < 10; i++) session.appendIfText(chunkWithText('x'));
		expect(vi.getTimerCount()).toBe(0);
		await session.flushFinal();
		expect(calls).toHaveLength(0);
	});

	it('batches by interval', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		for (let i = 0; i < 10; i++) session.appendIfText(chunkWithText('0123456789'));
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
		session.appendIfText(chunkWithText('A'.repeat(500)));
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

		session.appendIfText(chunkWithText('a'));
		await vi.advanceTimersByTimeAsync(60);
		session.appendIfText(chunkWithText('b'));
		await vi.advanceTimersByTimeAsync(60);
		session.appendIfText(chunkWithText('c'));
		await vi.advanceTimersByTimeAsync(60);

		expect(calls).toHaveLength(3);
		expect(calls.map((c) => c.body.seq)).toEqual([0, 1, 2]);
	});

	it('fetch rejection does not throw out of appendIfText', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch(() => Promise.reject(new Error('boom')));
		const { logger, error } = makeLogger();
		const session = createStreamCallback(baseCfg({ fetchImpl, logger }));

		expect(() => session.appendIfText(chunkWithText('hi'))).not.toThrow();
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(1);
		expect(error.some((m) => m.includes('POST failed'))).toBe(true);

		// subsequent append still works
		expect(() => session.appendIfText(chunkWithText('bye'))).not.toThrow();
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(2);
	});

	it('flushFinal emits done:true with remaining buffer', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.appendIfText(chunkWithText('A'.repeat(30)));
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
		for (let i = 0; i < 5; i++) session.appendIfText(chunkEmptyText());
		await vi.advanceTimersByTimeAsync(60);
		expect(calls).toHaveLength(0);
	});

	it('chunk with text==="" interleaved with real text only emits the real text', async () => {
		vi.useFakeTimers();
		const { fetchImpl, calls } = makeFakeFetch();
		const session = createStreamCallback(baseCfg({ fetchImpl }));
		session.appendIfText(chunkEmptyText());
		session.appendIfText(chunkWithText('hello'));
		session.appendIfText(chunkEmptyText());
		session.appendIfText(chunkWithText(' world'));
		session.appendIfText(chunkEmptyText());
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
		withAuth.appendIfText(chunkWithText('a'));
		await vi.advanceTimersByTimeAsync(60);
		expect(first.calls[0].headers['x-webhook-auth']).toBe('secret-xyz');
		expect(first.calls[0].headers['Content-Type']).toBe('application/json');

		const second = makeFakeFetch();
		const noAuth = createStreamCallback(baseCfg({
			fetchImpl: second.fetchImpl,
			authHeaderValue: undefined,
		}));
		noAuth.appendIfText(chunkWithText('b'));
		await vi.advanceTimersByTimeAsync(60);
		expect(second.calls[0].headers['x-webhook-auth']).toBeUndefined();
	});
});
