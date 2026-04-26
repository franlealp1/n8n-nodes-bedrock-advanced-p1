/**
 * Streaming callback helper — batches LLM text deltas and fires fire-and-forget POSTs to a
 * configured HTTP endpoint while the generation is in flight, plus emits semantic events
 * (tool-call-start, agent-finish) when the stream signals tool invocation or final closure.
 *
 * No-op fast path: if `callbackUrl` is empty, processChunk and flushFinal allocate nothing,
 * schedule no timers, and make no network calls. This guarantees byte-identity of the parent
 * generator's output when the node is instantiated without a callback URL (AC1 line).
 *
 * Routing: the configured Callback URL is treated as a BASE. Deltas POST to {base}/stream-token
 * (high-frequency, non-persistent). Semantic events (tool-call-start, agent-finish, error) POST
 * to {base}/agent-event (low-frequency, persistent). Trailing slash on the base URL is trimmed.
 *
 * Failure semantics: network/HTTP errors from the callback are logged and swallowed. The
 * generator continues. This is intentional — if the callback is unreachable the user's final
 * message still arrives through the normal /webhook/sendMessage path; streaming UX degrades
 * gracefully.
 */

import type { ChatGenerationChunk } from '@langchain/core/outputs';

export interface StreamCallbackLogger {
	info?: (m: string) => void;
	warn?: (m: string) => void;
	error?: (m: string) => void;
}

/**
 * Discriminated union emitted by the helper. Backend backwards-compat: a body without
 * `type` is interpreted as `delta` (the v0.9.0 shape). The helper always emits `type`
 * explicitly to reduce ambiguity in logs/debug.
 */
export type CallbackEvent =
	| {
			type: 'delta';
			streamId?: string;
			seq: number;
			delta: string;
			done: boolean;
			agentName?: string;
			color?: string;
			timestamp: string;
	  }
	| {
			type: 'tool-call-start';
			streamId?: string;
			seq: number;
			tools: Array<{ name: string; args: unknown; id: string }>;
			agentName?: string;
			color?: string;
			timestamp: string;
	  }
	| {
			type: 'agent-finish';
			streamId?: string;
			seq: number;
			text: string;
			finishReason: 'end_turn' | 'stop_sequence' | 'max_tokens';
			agentName?: string;
			color?: string;
			timestamp: string;
	  }
	| {
			type: 'error';
			streamId?: string;
			seq: number;
			error: { code: string; message: string; retryable: boolean };
			agentName?: string;
			color?: string;
			timestamp: string;
	  };

export interface StreamCallbackConfig {
	callbackUrl?: string;
	sessionId?: string;
	authHeaderValue?: string;
	agentName?: string;
	agentColor?: string;
	batchIntervalMs: number;
	maxBatchChars: number;
	logger?: StreamCallbackLogger;
	fetchImpl?: typeof fetch;
}

export interface StreamCallbackSession {
	processChunk(chunk: ChatGenerationChunk): void;
	flushFinal(): Promise<void>;
}

type ToolAccumEntry = { name?: string; id?: string; argsBuffer: string };

const FINISH_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

function tryParseJson(s: string): unknown {
	if (!s) return {};
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}

export function createStreamCallback(config: StreamCallbackConfig): StreamCallbackSession {
	// No-op fast path: empty URL → zero allocation, zero network, zero timers.
	// AC1 line: yielded chunk sequence must remain byte-identical to the super generator.
	if (!config.callbackUrl) {
		return {
			processChunk() { /* no-op */ },
			async flushFinal() { /* no-op */ },
		};
	}

	const baseUrl = config.callbackUrl.replace(/\/$/, '');
	const deltaUrl = `${baseUrl}/stream-token`;
	const agentEventUrl = `${baseUrl}/agent-event`;
	const sessionId = config.sessionId;
	const authHeaderValue = config.authHeaderValue;
	const agentName = config.agentName;
	const agentColor = config.agentColor;
	const batchIntervalMs = Math.max(0, config.batchIntervalMs);
	const maxBatchChars = Math.max(1, config.maxBatchChars);
	const fetchImpl = config.fetchImpl ?? fetch;
	const logger = config.logger;

	let buffer = '';
	let aggregatedText = '';
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	const toolAccum: Map<number, ToolAccumEntry> = new Map();
	let pendingStopReason: string | null = null;

	function buildEnvelope<T extends Record<string, unknown>>(extra: T): T & {
		streamId?: string;
		seq: number;
		agentName?: string;
		color?: string;
		timestamp: string;
	} {
		// agentName/color omitted (not null) when undefined — preserves explicit-absence semantics.
		const env: any = {
			streamId: sessionId,
			seq: seq++,
			...extra,
			timestamp: new Date().toISOString(),
		};
		if (agentName !== undefined) env.agentName = agentName;
		if (agentColor !== undefined) env.color = agentColor;
		return env;
	}

	function sendPost(url: string, body: CallbackEvent): void {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (authHeaderValue) headers['x-webhook-auth'] = authHeaderValue;

		// Fire-and-forget. Do NOT await — we must not block the generator on network I/O.
		fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
			.catch((err: unknown) => {
				logger?.error?.(
					`[streamCallback] POST failed: streamId=${sessionId} seq=${body.seq} type=${body.type} err=${String(err)}`,
				);
			});
	}

	function postDelta(delta: string, done: boolean): void {
		const body = buildEnvelope({ type: 'delta' as const, delta, done }) as CallbackEvent;
		sendPost(deltaUrl, body);
	}

	function postToolCallStart(tools: Array<{ name: string; args: unknown; id: string }>): void {
		const body = buildEnvelope({ type: 'tool-call-start' as const, tools }) as CallbackEvent;
		sendPost(agentEventUrl, body);
	}

	function postAgentFinish(text: string, finishReason: 'end_turn' | 'stop_sequence' | 'max_tokens'): void {
		const body = buildEnvelope({
			type: 'agent-finish' as const,
			text,
			finishReason,
		}) as CallbackEvent;
		sendPost(agentEventUrl, body);
	}

	function flushBuffered(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (buffer.length === 0) return;
		const payload = buffer;
		buffer = '';
		postDelta(payload, false);
	}

	function scheduleTimer(): void {
		if (timer !== null || batchIntervalMs <= 0) return;
		timer = setTimeout(() => {
			timer = null;
			flushBuffered();
		}, batchIntervalMs);
	}

	function recordToolChunk(tcc: any): void {
		const idx = tcc.index;
		if (typeof idx !== 'number') return;
		let entry = toolAccum.get(idx);
		if (!entry) {
			entry = { argsBuffer: '' };
			toolAccum.set(idx, entry);
		}
		if (typeof tcc.name === 'string') entry.name = tcc.name;
		if (typeof tcc.id === 'string') entry.id = tcc.id;
		if (typeof tcc.args === 'string') entry.argsBuffer += tcc.args;
	}

	return {
		processChunk(chunk: ChatGenerationChunk): void {
			if (closed) return;

			// 1. tool_call_chunks (start carries name+id, deltas carry args fragments).
			//    These chunks contribute neither to delta text nor to aggregatedText.
			const tcc = (chunk as any)?.message?.tool_call_chunks?.[0];
			if (tcc) {
				recordToolChunk(tcc);
				return;
			}

			// 2. messageStop event (catch-all branch in chat_models.cjs L735-743 puts the
			//    whole messageStop under response_metadata). Capture stopReason for flushFinal.
			const stopReason = (chunk as any)?.message?.response_metadata?.messageStop?.stopReason;
			if (typeof stopReason === 'string') {
				pendingStopReason = stopReason;
				return;
			}

			// 3. Real text delta (path identical to v0.9.0 except aggregation for agent-finish).
			const text = chunk.text;
			// streamParser emits text:'' for tool_use / message_delta / server_tool_use chunks.
			if (typeof text !== 'string' || text.length === 0) return;

			aggregatedText += text;
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
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}

			// Always emit a final delta done-marker POST, even when remaining is empty.
			// The consumer relies on `done:true` to clear its partial-message state.
			const remaining = buffer;
			buffer = '';
			postDelta(remaining, true);

			// Emit semantic event based on stopReason.
			if (pendingStopReason === 'tool_use' && toolAccum.size > 0) {
				const tools = [...toolAccum.entries()]
					.sort(([a], [b]) => a - b)
					.map(([, e]) => ({
						name: e.name ?? '',
						id: e.id ?? '',
						args: tryParseJson(e.argsBuffer),
					}))
					.filter((t) => t.name);
				if (tools.length > 0) postToolCallStart(tools);
			} else if (pendingStopReason !== null && FINISH_REASONS.has(pendingStopReason)) {
				postAgentFinish(
					aggregatedText,
					pendingStopReason as 'end_turn' | 'stop_sequence' | 'max_tokens',
				);
			}
			// Other stopReasons (guardrail_intervened, content_filtered) → no-op in v1.
		},
	};
}
