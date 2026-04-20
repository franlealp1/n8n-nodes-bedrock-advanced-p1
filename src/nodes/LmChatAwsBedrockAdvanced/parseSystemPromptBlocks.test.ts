import { describe, expect, it } from 'vitest';

import {
	MAX_CACHEPOINTS,
	MIN_BLOCK_CHARS,
	parseSystemPromptBlocks,
} from './parseSystemPromptBlocks';

function makeLogger() {
	const warn: string[] = [];
	const error: string[] = [];
	return {
		logger: {
			warn: (m: string) => warn.push(m),
			error: (m: string) => error.push(m),
		},
		warn,
		error,
	};
}

// Blocks long enough to clear the ~1024 token heuristic (avoid noisy warn logs
// when the test is not specifically about block size).
const LARGE_BLOCK_A = 'A'.repeat(MIN_BLOCK_CHARS);
const LARGE_BLOCK_B = 'B'.repeat(MIN_BLOCK_CHARS);
const LARGE_BLOCK_C = 'C'.repeat(MIN_BLOCK_CHARS);
const LARGE_BLOCK_D = 'D'.repeat(MIN_BLOCK_CHARS);
const LARGE_BLOCK_E = 'E'.repeat(MIN_BLOCK_CHARS);

describe('parseSystemPromptBlocks', () => {
	describe('fast paths (no log, no work)', () => {
		it('undefined → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks(undefined, logger)).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('null → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks(null, logger)).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('empty string → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks('', logger)).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('whitespace-only string → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks('   \n\t ', logger)).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('literal empty array → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks([], logger)).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('array full of empty/whitespace/non-string items → []', () => {
			const { logger, warn, error } = makeLogger();
			expect(
				parseSystemPromptBlocks(['', '  ', '\n', null, 0, {}, []], logger),
			).toEqual([]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});
	});

	describe('invalid inputs (warn + fall back to legacy)', () => {
		it('malformed JSON string → [] + 1 warn', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks('not valid json', logger)).toEqual([]);
			expect(warn).toHaveLength(1);
			expect(warn[0]).toMatch(/could not parse JSON string/);
			expect(error).toEqual([]);
		});

		it('JSON parses to non-array (object) → [] + 1 warn', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks('{"foo":"bar"}', logger)).toEqual([]);
			expect(warn).toHaveLength(1);
			expect(warn[0]).toMatch(/expected an array/);
			expect(error).toEqual([]);
		});

		it('raw non-array, non-string value → [] + 1 warn', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks({ foo: 'bar' }, logger)).toEqual([]);
			expect(warn).toHaveLength(1);
			expect(warn[0]).toMatch(/expected an array/);
			expect(error).toEqual([]);
		});
	});

	describe('valid inputs', () => {
		it('single large block → [block] with no warn/error', () => {
			const { logger, warn, error } = makeLogger();
			expect(parseSystemPromptBlocks([LARGE_BLOCK_A], logger)).toEqual([
				LARGE_BLOCK_A,
			]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('four valid blocks → 4 blocks, no error, no size warn', () => {
			const { logger, warn, error } = makeLogger();
			const input = [LARGE_BLOCK_A, LARGE_BLOCK_B, LARGE_BLOCK_C, LARGE_BLOCK_D];
			const out = parseSystemPromptBlocks(input, logger);
			expect(out).toHaveLength(MAX_CACHEPOINTS);
			expect(out).toEqual(input);
			expect(error).toEqual([]);
			expect(warn).toEqual([]);
		});

		it('JSON string array → parsed correctly', () => {
			const { logger, warn, error } = makeLogger();
			const input = JSON.stringify([LARGE_BLOCK_A, LARGE_BLOCK_B]);
			const out = parseSystemPromptBlocks(input, logger);
			expect(out).toEqual([LARGE_BLOCK_A, LARGE_BLOCK_B]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('blocks with empty interleaved entries are filtered silently', () => {
			const { logger, warn, error } = makeLogger();
			const out = parseSystemPromptBlocks(
				[LARGE_BLOCK_A, '', '   ', LARGE_BLOCK_B, null as any],
				logger,
			);
			expect(out).toEqual([LARGE_BLOCK_A, LARGE_BLOCK_B]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});
	});

	describe('overflow (> MAX_CACHEPOINTS blocks)', () => {
		it('five valid blocks → first 3 preserved, 4+5 merged into block 4, error log', () => {
			const { logger, warn, error } = makeLogger();
			const input = [
				LARGE_BLOCK_A,
				LARGE_BLOCK_B,
				LARGE_BLOCK_C,
				LARGE_BLOCK_D,
				LARGE_BLOCK_E,
			];
			const out = parseSystemPromptBlocks(input, logger);

			expect(out).toHaveLength(MAX_CACHEPOINTS);
			expect(out[0]).toBe(LARGE_BLOCK_A);
			expect(out[1]).toBe(LARGE_BLOCK_B);
			expect(out[2]).toBe(LARGE_BLOCK_C);
			expect(out[3]).toBe(`${LARGE_BLOCK_D}\n\n${LARGE_BLOCK_E}`);

			expect(error).toHaveLength(1);
			expect(error[0]).toMatch(/received 5 blocks/);
			expect(error[0]).toMatch(/max 4 cachepoints/);
			expect(warn).toEqual([]);
		});
	});

	describe('block size heuristic', () => {
		it('block shorter than MIN_BLOCK_CHARS → warn log for that block only', () => {
			const { logger, warn, error } = makeLogger();
			const short = 'short block'; // << MIN_BLOCK_CHARS
			const out = parseSystemPromptBlocks([short, LARGE_BLOCK_A], logger);
			expect(out).toEqual([short, LARGE_BLOCK_A]);
			expect(warn).toHaveLength(1);
			expect(warn[0]).toMatch(/block 1/);
			expect(warn[0]).toMatch(/minimum cacheable size/);
			expect(error).toEqual([]);
		});
	});

	describe('works without a logger', () => {
		it('does not throw when logger omitted on any branch', () => {
			expect(() => parseSystemPromptBlocks(undefined)).not.toThrow();
			expect(() => parseSystemPromptBlocks('not json')).not.toThrow();
			expect(() => parseSystemPromptBlocks(['a', 'b', 'c', 'd', 'e'])).not.toThrow();
			expect(() => parseSystemPromptBlocks(['short'])).not.toThrow();
		});
	});
});
