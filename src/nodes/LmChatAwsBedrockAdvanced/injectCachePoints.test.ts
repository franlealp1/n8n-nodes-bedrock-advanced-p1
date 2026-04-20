import { describe, expect, it } from 'vitest';

import { MIN_BLOCK_CHARS } from './parseSystemPromptBlocks';
import {
	findHistoryCacheTarget,
	injectCachePoints,
	type InjectCachePointsLogger,
} from './injectCachePoints';

function makeLogger(): {
	logger: InjectCachePointsLogger;
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
		info,
		warn,
		error,
	};
}

function systemMsg(content: any): any {
	return { _getType: () => 'system', content };
}
function userMsg(content: any): any {
	return { _getType: () => 'human', content };
}
function aiMsg(content: any, toolCalls?: any[]): any {
	return { _getType: () => 'ai', content, tool_calls: toolCalls };
}
function toolMsg(content: any): any {
	return { _getType: () => 'tool', content };
}

const CACHEPOINT = { cachePoint: { type: 'default' } };

// Blocks long enough to clear the ~1024 token heuristic (avoid noisy size warns
// on tests not specifically about the heuristic).
const B1 = 'A'.repeat(MIN_BLOCK_CHARS);
const B2 = 'B'.repeat(MIN_BLOCK_CHARS);
const B3 = 'C'.repeat(MIN_BLOCK_CHARS);
const B4 = 'D'.repeat(MIN_BLOCK_CHARS);

describe('injectCachePoints', () => {
	describe('legacy single-cachepoint path', () => {
		it('wraps system string content with one cachepoint when cacheSystemPrompt defaults to true', () => {
			const { logger, warn, error } = makeLogger();
			const msgs = [systemMsg('hello prompt'), userMsg('hi')];
			const out = injectCachePoints(msgs, {}, logger);

			expect(out[0].content).toEqual([
				{ type: 'text', text: 'hello prompt' },
				CACHEPOINT,
			]);
			expect(out[1]).toBe(msgs[1]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('does not modify system message when cacheSystemPrompt is false', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg('hello'), userMsg('hi')];
			const out = injectCachePoints(msgs, { cacheSystemPrompt: false }, logger);

			expect(out[0]).toBe(msgs[0]);
			expect(out[1]).toBe(msgs[1]);
		});

		it('does not double a cachepoint already present in array content', () => {
			const { logger } = makeLogger();
			const content = [
				{ type: 'text', text: 'x' },
				{ cachePoint: { type: 'default' } },
			];
			const msgs = [systemMsg(content)];
			const out = injectCachePoints(msgs, {}, logger);

			expect(out[0].content).toBe(content);
		});

		it('skips system messages with empty content', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg(''), userMsg('hi')];
			const out = injectCachePoints(msgs, {}, logger);

			expect(out[0]).toBe(msgs[0]);
		});
	});

	describe('multi-cachepoint path', () => {
		it('replaces system content with [text,cp,text,cp] for 2 blocks', () => {
			const { logger, warn, error } = makeLogger();
			const msgs = [systemMsg(''), userMsg('hi')];
			const out = injectCachePoints(
				msgs,
				{ systemPromptBlocks: [B1, B2] },
				logger,
			);

			expect(out[0].content).toEqual([
				{ type: 'text', text: B1 },
				CACHEPOINT,
				{ type: 'text', text: B2 },
				CACHEPOINT,
			]);
			expect(out[1]).toBe(msgs[1]);
			expect(warn).toEqual([]);
			expect(error).toEqual([]);
		});

		it('emits 4 cachepoints for 4 blocks', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg(''), userMsg('hi')];
			const out = injectCachePoints(
				msgs,
				{ systemPromptBlocks: [B1, B2, B3, B4] },
				logger,
			);

			const content = out[0].content as any[];
			const cachepoints = content.filter((b) => b.cachePoint);
			const texts = content.filter((b) => b.type === 'text');
			expect(cachepoints).toHaveLength(4);
			expect(texts).toHaveLength(4);
			expect(texts.map((t) => t.text)).toEqual([B1, B2, B3, B4]);
		});

		it('warns when existing system content would be replaced', () => {
			const { logger, warn } = makeLogger();
			const msgs = [systemMsg('existing prompt content'), userMsg('hi')];
			injectCachePoints(msgs, { systemPromptBlocks: [B1, B2] }, logger);

			expect(
				warn.some((m) => m.includes('replacing the existing system message')),
			).toBe(true);
		});

		it('does not warn when existing system content is empty', () => {
			const { logger, warn } = makeLogger();
			const msgs = [systemMsg(''), userMsg('hi')];
			injectCachePoints(msgs, { systemPromptBlocks: [B1, B2] }, logger);

			expect(warn.filter((m) => m.includes('replacing'))).toEqual([]);
		});

		it('emits info log under enableDebugLogs', () => {
			const { logger, info } = makeLogger();
			injectCachePoints(
				[systemMsg(''), userMsg('hi')],
				{ systemPromptBlocks: [B1, B2], enableDebugLogs: true },
				logger,
			);

			expect(
				info.some((m) => m.includes('2 blocks, 2 cachepoints')),
			).toBe(true);
		});

		it('falls back to legacy when cacheSystemPrompt is false even with systemBlocks set', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg('x'), userMsg('y')];
			const out = injectCachePoints(
				msgs,
				{ cacheSystemPrompt: false, systemPromptBlocks: [B1, B2] },
				logger,
			);

			expect(out[0]).toBe(msgs[0]);
		});

		it('applies blocks only to the first system message; subsequent fall back to legacy wrap', () => {
			const { logger } = makeLogger();
			const msgs = [
				systemMsg(''),
				systemMsg('second system'),
				userMsg('hi'),
			];
			const out = injectCachePoints(
				msgs,
				{ systemPromptBlocks: [B1, B2] },
				logger,
			);

			const firstContent = out[0].content as any[];
			expect(firstContent.filter((b) => b.cachePoint)).toHaveLength(2);
			expect(out[1].content).toEqual([
				{ type: 'text', text: 'second system' },
				CACHEPOINT,
			]);
		});
	});

	describe('conversation history caching', () => {
		it('caches at the last non-current AI message when cacheConversationHistory is true', () => {
			const { logger } = makeLogger();
			const msgs = [
				systemMsg('sys'),
				userMsg('hello'),
				aiMsg('hi'),
				userMsg('current'),
			];
			const out = injectCachePoints(
				msgs,
				{ cacheConversationHistory: true },
				logger,
			);

			expect(out[2].content).toEqual([
				{ type: 'text', text: 'hi' },
				CACHEPOINT,
			]);
		});

		it('skips tool messages and tool-use-only AI messages when finding history target', () => {
			const msgs = [
				systemMsg('sys'),
				userMsg('q'),
				aiMsg('thinking', [{ id: 't1' }]),
				toolMsg('result'),
				aiMsg('answer'),
				userMsg('follow-up'),
			];
			expect(findHistoryCacheTarget(msgs)).toBe(4);
		});

		it('returns -1 when no suitable AI history message exists', () => {
			const msgs = [systemMsg('sys'), userMsg('current')];
			expect(findHistoryCacheTarget(msgs)).toBe(-1);
		});
	});

	describe('identity', () => {
		it('returns a new array (does not mutate input)', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg('x'), userMsg('y')];
			const out = injectCachePoints(msgs, {}, logger);

			expect(out).not.toBe(msgs);
			expect(msgs[0].content).toBe('x'); // original unchanged
		});
	});

	describe('synthetic system message prepend (Agent v2 with empty systemMessage)', () => {
		it('prepends a synthetic system message filled with the blocks when input has none', () => {
			const { logger, warn } = makeLogger();
			const msgs = [userMsg('hi')];
			const out = injectCachePoints(
				msgs,
				{ systemPromptBlocks: [B1, B2] },
				logger,
			);

			expect(out).toHaveLength(2);

			const firstType = out[0]._getType?.() ?? out[0].getType?.();
			expect(firstType).toBe('system');
			expect(out[0].content).toEqual([
				{ type: 'text', text: B1 },
				CACHEPOINT,
				{ type: 'text', text: B2 },
				CACHEPOINT,
			]);

			expect(out[1]).toBe(msgs[0]);

			// prepended system was empty, so no "replacing" warn
			expect(warn.filter((m) => m.includes('replacing'))).toEqual([]);
		});

		it('does NOT prepend when systemBlocks is empty (legacy path)', () => {
			const { logger } = makeLogger();
			const msgs = [userMsg('hi')];
			const out = injectCachePoints(msgs, {}, logger);

			expect(out).toHaveLength(1);
			expect(out[0]).toBe(msgs[0]);
		});

		it('does NOT prepend when cacheSystemPrompt is false even with systemBlocks set', () => {
			const { logger } = makeLogger();
			const msgs = [userMsg('hi')];
			const out = injectCachePoints(
				msgs,
				{ cacheSystemPrompt: false, systemPromptBlocks: [B1, B2] },
				logger,
			);

			expect(out).toHaveLength(1);
			expect(out[0]).toBe(msgs[0]);
		});

		it('does NOT prepend when an existing system message is already present', () => {
			const { logger } = makeLogger();
			const msgs = [systemMsg('existing'), userMsg('hi')];
			const out = injectCachePoints(
				msgs,
				{ systemPromptBlocks: [B1, B2] },
				logger,
			);

			// 2 in, 2 out — no prepend
			expect(out).toHaveLength(2);
			// First was replaced with blocks (via the map branch, not prepend)
			expect((out[0].content as any[]).filter((b) => b.cachePoint)).toHaveLength(2);
		});
	});
});
