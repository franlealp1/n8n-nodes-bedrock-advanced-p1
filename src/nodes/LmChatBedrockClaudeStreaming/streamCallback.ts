/**
 * Streaming callback helper — batches LLM text deltas and fires fire-and-forget POSTs to a
 * configured HTTP endpoint while the generation is in flight.
 *
 * No-op fast path: if `callbackUrl` is empty, appendIfText and flushFinal allocate nothing,
 * schedule no timers, and make no network calls. This guarantees byte-identity of the parent
 * generator's output when the node is instantiated without a callback URL.
 *
 * Failure semantics: network/HTTP errors from the callback are logged and swallowed. The
 * generator continues. This is intentional — if the callback is unreachable the user's final
 * message still arrives through the normal /webhook/sendMessage path; streaming UX degrades
 * gracefully to "no intermediate tokens", not to "request fails".
 */

import type { ChatGenerationChunk } from '@langchain/core/outputs';

export interface StreamCallbackLogger {
	info?: (m: string) => void;
	warn?: (m: string) => void;
	error?: (m: string) => void;
}

export interface StreamCallbackConfig {
	callbackUrl?: string;
	sessionId?: string;
	authHeaderValue?: string;
	batchIntervalMs: number;
	maxBatchChars: number;
	logger?: StreamCallbackLogger;
	fetchImpl?: typeof fetch;
}

export interface StreamCallbackSession {
	appendIfText(chunk: ChatGenerationChunk): void;
	flushFinal(): Promise<void>;
}

export function createStreamCallback(config: StreamCallbackConfig): StreamCallbackSession {
	// No-op fast path: empty URL → zero allocation, zero network, zero timers.
	if (!config.callbackUrl) {
		return {
			appendIfText() { /* no-op */ },
			async flushFinal() { /* no-op */ },
		};
	}

	const url = config.callbackUrl;
	const sessionId = config.sessionId;
	const authHeaderValue = config.authHeaderValue;
	const batchIntervalMs = Math.max(0, config.batchIntervalMs);
	const maxBatchChars = Math.max(1, config.maxBatchChars);
	const fetchImpl = config.fetchImpl ?? fetch;
	const logger = config.logger;

	let buffer = '';
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	function post(delta: string, done: boolean): void {
		const currentSeq = seq++;
		const body = JSON.stringify({
			streamId: sessionId,
			seq: currentSeq,
			delta,
			done,
		});
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (authHeaderValue) headers['x-webhook-auth'] = authHeaderValue;

		// Fire-and-forget. Do NOT await — we must not block the generator on network I/O.
		fetchImpl(url, { method: 'POST', headers, body })
			.catch((err: unknown) => {
				logger?.error?.(`[streamCallback] POST failed: streamId=${sessionId} seq=${currentSeq} err=${String(err)}`);
			});
	}

	function flushBuffered(): void {
		if (timer !== null) { clearTimeout(timer); timer = null; }
		if (buffer.length === 0) return;
		const payload = buffer;
		buffer = '';
		post(payload, false);
	}

	function scheduleTimer(): void {
		if (timer !== null || batchIntervalMs <= 0) return;
		timer = setTimeout(() => { timer = null; flushBuffered(); }, batchIntervalMs);
	}

	return {
		appendIfText(chunk: ChatGenerationChunk): void {
			if (closed) return;
			const text = chunk.text;
			// streamParser emits text:'' for tool_use / message_delta / server_tool_use chunks.
			// Only real text deltas have non-empty .text.
			if (typeof text !== 'string' || text.length === 0) return;

			buffer += text;

			if (buffer.length >= maxBatchChars) {
				flushBuffered();
				return;
			}
			scheduleTimer();
		},

		async flushFinal(): Promise<void> {
			if (closed) return;
			closed = true;
			if (timer !== null) { clearTimeout(timer); timer = null; }
			const remaining = buffer;
			buffer = '';
			// Always emit a final done-marker POST, even when remaining is empty.
			// The consumer relies on `done:true` to clear its partial-message state.
			post(remaining, true);
		},
	};
}
