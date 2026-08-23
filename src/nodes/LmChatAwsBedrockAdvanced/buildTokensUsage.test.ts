import { describe, expect, it } from 'vitest';

import { buildTokensUsage, firstPositive } from './buildTokensUsage';

/**
 * Contract tests for issue #633.
 *
 * The regression these lock down: every `_Stream` engine reported a 0% cache hit
 * rate while Bedrock was in fact caching normally. The cause was reading the cache
 * figures only from `llmOutput.tokenUsage`, where the streaming path delivers them
 * as literal 0 — so `??` accepted the 0 and the real numbers were dropped.
 *
 * The load-bearing rule is "first POSITIVE wins", not "first defined wins".
 */
describe('buildTokensUsage', () => {
	describe('non-streaming path (llmOutput is authoritative)', () => {
		it('takes cache figures from llmOutput when it has them', () => {
			const out = buildTokensUsage(
				{ completionTokens: 37, promptTokens: 402, cacheReadInputTokens: 0, cacheWriteInputTokens: 2294 },
				null,
			);
			expect(out.cacheWriteInputTokens).toBe(2294);
			expect(out.cacheReadInputTokens).toBe(0);
		});

		it('keeps working when no sink was ever populated', () => {
			const out = buildTokensUsage(
				{ completionTokens: 7, promptTokens: 4726, cacheReadInputTokens: 2294, cacheWriteInputTokens: 399 },
				undefined,
			);
			expect(out).toEqual({
				completionTokens: 7,
				promptTokens: 4726,
				totalTokens: 4733,
				cacheReadInputTokens: 2294,
				cacheWriteInputTokens: 399,
			});
		});
	});

	describe('streaming path (llmOutput zeroes the cache fields)', () => {
		// The exact shapes measured on noprod worker-2, execution 1161358.
		const streamingLlmOutput = {
			completionTokens: 94,
			promptTokens: 185,
			cacheReadInputTokens: 0,
			cacheWriteInputTokens: 0,
		};

		it('recovers the real figures from the sink — the #633 regression', () => {
			const out = buildTokensUsage(streamingLlmOutput, {
				cacheReadInputTokens: 6889,
				cacheWriteInputTokens: 5006,
			});
			expect(out.cacheReadInputTokens).toBe(6889);
			expect(out.cacheWriteInputTokens).toBe(5006);
		});

		it('reports 0 — not the sink — when nothing was cached at all', () => {
			const out = buildTokensUsage(streamingLlmOutput, {
				cacheReadInputTokens: 0,
				cacheWriteInputTokens: 0,
			});
			expect(out.cacheReadInputTokens).toBe(0);
			expect(out.cacheWriteInputTokens).toBe(0);
		});

		it('recovers each field independently (cache written but not yet read)', () => {
			const out = buildTokensUsage(streamingLlmOutput, {
				cacheReadInputTokens: 0,
				cacheWriteInputTokens: 5006,
			});
			expect(out.cacheReadInputTokens).toBe(0);
			expect(out.cacheWriteInputTokens).toBe(5006);
		});

		it('never lets the sink override a real llmOutput figure', () => {
			const out = buildTokensUsage(
				{ ...streamingLlmOutput, cacheReadInputTokens: 1000 },
				{ cacheReadInputTokens: 9999, cacheWriteInputTokens: 0 },
			);
			expect(out.cacheReadInputTokens).toBe(1000);
		});
	});

	describe('totalTokens stays prompt+completion', () => {
		it('excludes cache tokens, matching what the non-streaming path always reported', () => {
			const out = buildTokensUsage(
				{ completionTokens: 94, promptTokens: 185 },
				{ cacheReadInputTokens: 6889, cacheWriteInputTokens: 5006 },
			);
			// 12174 would be Bedrock's own total; widening it here would reprice history.
			expect(out.totalTokens).toBe(279);
		});
	});

	describe('hostile input never throws or leaks NaN', () => {
		it.each([
			['both null', null, null],
			['both undefined', undefined, undefined],
			['empty objects', {}, {}],
		])('%s → all zeros', (_label, tu, sunk) => {
			expect(buildTokensUsage(tu as any, sunk as any)).toEqual({
				completionTokens: 0,
				promptTokens: 0,
				totalTokens: 0,
				cacheReadInputTokens: 0,
				cacheWriteInputTokens: 0,
			});
		});

		it('coerces non-numeric and negative values to 0 rather than propagating them', () => {
			const out = buildTokensUsage(
				{
					completionTokens: '94' as any,
					promptTokens: NaN,
					cacheReadInputTokens: null as any,
					cacheWriteInputTokens: -5,
				},
				{ cacheReadInputTokens: undefined, cacheWriteInputTokens: 'x' as any },
			);
			expect(out).toEqual({
				completionTokens: 0,
				promptTokens: 0,
				totalTokens: 0,
				cacheReadInputTokens: 0,
				cacheWriteInputTokens: 0,
			});
			expect(Number.isNaN(out.totalTokens)).toBe(false);
		});
	});

	describe('firstPositive', () => {
		it('skips zero and picks the first strictly positive value', () => {
			expect(firstPositive(0, 0, 42)).toBe(42);
		});
		it('skips null, undefined, NaN, Infinity and non-numbers', () => {
			expect(firstPositive(null, undefined, NaN, Infinity, '7', 13)).toBe(13);
		});
		it('returns 0 when nothing qualifies', () => {
			expect(firstPositive(0, null, undefined, -1)).toBe(0);
		});
	});
});
