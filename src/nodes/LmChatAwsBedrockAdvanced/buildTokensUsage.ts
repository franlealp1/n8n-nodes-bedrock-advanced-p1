/**
 * Pure builder for the token-usage record N8N records per LLM call.
 *
 * Extracted from the inline `tokensUsageParser` in the node so the merge rules
 * can be unit-tested without standing up N8N's supply context — same reasoning
 * as `injectCachePoints`.
 *
 * The problem it solves (issue #633): the two execution paths report cache
 * usage differently.
 *
 *  - Non-streaming: `llmOutput.tokenUsage` carries real `cacheReadInputTokens` /
 *    `cacheWriteInputTokens`. Authoritative.
 *  - Streaming: LangChain rebuilds `llmOutput.tokenUsage` from the aggregated
 *    chunks with only completion/prompt/total, and both cache fields surface as
 *    literal `0` rather than `undefined`. `generations` arrives empty too, so
 *    nothing downstream can recover them — a `??` chain silently accepts the 0.
 *    Measured on noprod: Bedrock reported cacheRead=6889 / cacheWrite=5006 while
 *    the node recorded 0/0, which is why every `_Stream` engine showed a 0% hit
 *    rate in `posthoc_agent_metrics` despite caching normally.
 *
 * The streaming path therefore captures what Bedrock actually sent and passes it
 * in as `sunk`. Because a genuine 0 and a lost 0 are indistinguishable once they
 * reach here, the rule is "first positive wins", never "first defined wins".
 */

export interface RawTokenUsage {
	completionTokens?: unknown;
	promptTokens?: unknown;
	cacheReadInputTokens?: unknown;
	cacheWriteInputTokens?: unknown;
}

export interface SunkCacheUsage {
	cacheReadInputTokens?: unknown;
	cacheWriteInputTokens?: unknown;
}

export interface TokensUsage {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
	cacheReadInputTokens: number;
	cacheWriteInputTokens: number;
}

/** First finite, strictly positive number in `values`; 0 when there is none. */
export function firstPositive(...values: unknown[]): number {
	for (const v of values) {
		if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
	}
	return 0;
}

/** Non-negative finite number, or 0. Guards against null/undefined/NaN/strings. */
function nonNegative(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildTokensUsage(tu?: RawTokenUsage | null, sunk?: SunkCacheUsage | null): TokensUsage {
	const completionTokens = nonNegative(tu?.completionTokens);
	const promptTokens = nonNegative(tu?.promptTokens);

	return {
		completionTokens,
		promptTokens,
		// Deliberately prompt+completion, excluding cache tokens. That is what the
		// non-streaming path has always reported and what the metrics pipeline is
		// calibrated against; widening it here would silently reprice history.
		totalTokens: completionTokens + promptTokens,
		cacheReadInputTokens: firstPositive(tu?.cacheReadInputTokens, sunk?.cacheReadInputTokens),
		cacheWriteInputTokens: firstPositive(tu?.cacheWriteInputTokens, sunk?.cacheWriteInputTokens),
	};
}
