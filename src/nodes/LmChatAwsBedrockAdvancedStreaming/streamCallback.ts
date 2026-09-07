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
 *
 * TWO CHANNELS, TWO GUARANTEES (flock#1060). `delta` POSTs are best-effort: high frequency,
 * unordered, fire-and-forget, no retry — they exist to paint the live bubble, where losing a
 * fragment is a cosmetic blip. The semantic events are the durable ones: each carries the
 * round's FULL text (`agent-finish.text` for the last round, `tool-call-start.text` for every
 * earlier one), so a consumer can always rebuild the turn without depending on every single
 * delta having arrived. A consumer that reconstructs persisted text by concatenating deltas is
 * using the wrong channel — that is precisely the bug flock#1060 fixed downstream.
 */

import type { ChatGenerationChunk } from '@langchain/core/outputs';

export interface StreamCallbackLogger {
	info?: (m: string) => void;
	warn?: (m: string) => void;
	error?: (m: string) => void;
}

/**
 * Token usage data captured from the metadata chunk emitted by Bedrock Converse.
 * Shape mirrors the enrichment done in PatchedChatBedrockConverse.ts:218-223:
 * {input,output,cache_read,cache_creation}_input_tokens. Sent on `agent-finish`
 * events to enable real-time cost capture downstream (Plan #69 D1' / D3).
 */
export interface UsageData {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
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
			/**
			 * Canonical text of the round that is closing — the same `aggregatedText`
			 * that `agent-finish` sends for the LAST round (flock#1060).
			 *
			 * WHY IT IS HERE. One session = one round, and a turn with tools has as many
			 * rounds as tool calls plus one. Until now only the last round had a canonical
			 * text: every earlier round survived solely as the sum of its `delta` POSTs,
			 * which are fire-and-forget and unordered. One lost POST and the consumer's
			 * reconstruction silently lost that fragment forever — measured in noprod on
			 * 2026-09-07, a message persisted as "Buscando planes existentes que enc".
			 *
			 * Always a string (empty when the round produced no text before calling the
			 * tool), so a consumer can tell "this fork does not send it" (undefined) from
			 * "this round said nothing" ('').
			 */
			text: string;
			usage?: UsageData;
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
			usage?: UsageData;
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
	let pendingUsage: UsageData | null = null;

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
			.then((res) => {
				// `fetch` only REJECTS on network failure: a 401, 500 or 502 resolves like a
				// success, so until now a POST the backend refused was indistinguishable from
				// one it accepted — nothing logged, on either side.
				//
				// That blind spot got expensive with flock#1060: a semantic event now carries
				// the whole text of its round, so losing ONE of them silently drops a whole
				// paragraph from the persisted message (a lost `delta` only chips a fragment).
				// We still do not retry — that would need de-duplication downstream — but a
				// refused POST must at least be visible in the worker log.
				if (res && res.ok === false) {
					logger?.error?.(
						`[streamCallback] POST rejected: streamId=${sessionId} seq=${body.seq} type=${body.type} status=${res.status}`,
					);
				}
			})
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

	function postToolCallStart(
		tools: Array<{ name: string; args: unknown; id: string }>,
		usage?: UsageData,
	): void {
		// `text` viaja SIEMPRE (aunque sea ''), por simetría con agent-finish: es el texto
		// canónico de esta ronda, y el único inmune a que se pierda un POST de delta.
		const extra: Record<string, unknown> = {
			type: 'tool-call-start' as const,
			tools,
			text: aggregatedText,
		};
		if (usage) extra.usage = usage;
		const body = buildEnvelope(extra) as CallbackEvent;
		sendPost(agentEventUrl, body);
	}

	function postAgentFinish(
		text: string,
		finishReason: 'end_turn' | 'stop_sequence' | 'max_tokens',
		usage?: UsageData,
	): void {
		const extra: Record<string, unknown> = {
			type: 'agent-finish' as const,
			text,
			finishReason,
		};
		if (usage) extra.usage = usage;
		const body = buildEnvelope(extra) as CallbackEvent;
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

			// 0. Capture token usage emitted by PatchedChatBedrockConverse on the
			//    metadata chunk (see PatchedChatBedrockConverse.ts:218-223). Does NOT
			//    early-return — this chunk may also carry messageStop or text. Idempotent:
			//    last write wins, but in practice the metadata chunk fires once per stream.
			const u = (chunk as any)?.message?.response_metadata?.usage;
			if (u && typeof u === 'object' && typeof u.input_tokens === 'number') {
				pendingUsage = {
					input_tokens: u.input_tokens,
					output_tokens: u.output_tokens ?? 0,
					cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
					cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
				};
			}

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
				if (tools.length > 0) postToolCallStart(tools, pendingUsage ?? undefined);
			} else if (pendingStopReason !== null && FINISH_REASONS.has(pendingStopReason)) {
				postAgentFinish(
					aggregatedText,
					pendingStopReason as 'end_turn' | 'stop_sequence' | 'max_tokens',
					pendingUsage ?? undefined,
				);
			}
			// Other stopReasons (guardrail_intervened, content_filtered) → no-op in v1.
		},
	};
}
