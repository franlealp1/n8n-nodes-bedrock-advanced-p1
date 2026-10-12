/**
 * Unit spec for the pure pieces of flock#1575. Covers the inputs LangChain can
 * never produce (so the integration spec cannot reach them) but a request could
 * still carry: malformed shapes, a cache point already in place, other commands.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	countCachePoints,
	createToolResultCachePointMiddleware,
	planToolResultCachePoint,
} from './toolResultCachePoint';

const CP = { cachePoint: { type: 'default' } };
const toolResult = (id: string, text = 'x') => ({ toolResult: { toolUseId: id, content: [{ text }] } });

const baseInput = () => ({
	modelId: 'm',
	system: [{ text: 'sys' }, CP],
	toolConfig: { tools: [{ toolSpec: { name: 't' } }, CP] },
	messages: [
		{ role: 'user', content: [{ text: 'q' }, CP] },
		{ role: 'assistant', content: [{ text: 'voy' }, { toolUse: { toolUseId: 'a', name: 't', input: {} } }] },
		{ role: 'user', content: [toolResult('a')] },
	],
});

describe('countCachePoints', () => {
	it('counts system, tools and top-level message content', () => {
		expect(countCachePoints(baseInput())).toBe(3);
	});

	it('does NOT count cache-point-looking data nested inside a toolResult (it is not a cache point for Bedrock)', () => {
		const input = baseInput();
		input.messages[2].content = [{ toolResult: { toolUseId: 'a', content: [{ json: { cachePoint: { type: 'default' } } }] } }] as any;
		expect(countCachePoints(input)).toBe(3);
	});

	it('tolerates missing sections', () => {
		expect(countCachePoints({ messages: [] })).toBe(0);
		expect(countCachePoints({})).toBe(0);
	});
});

describe('planToolResultCachePoint', () => {
	it('adds one sibling at the end of the last user message when it carries a toolResult', () => {
		const input = baseInput();
		const plan = planToolResultCachePoint(input);
		expect(plan.action).toBe('add');
		if (plan.action !== 'add') return;
		expect(plan.input.messages.at(-1).content).toEqual([toolResult('a'), CP]);
		expect(countCachePoints(plan.input)).toBe(4);
	});

	it('never mutates the input (new array, new message)', () => {
		const input = baseInput();
		const before = JSON.stringify(input);
		const plan = planToolResultCachePoint(input);
		expect(JSON.stringify(input)).toBe(before);
		if (plan.action === 'add') {
			expect(plan.input.messages).not.toBe(input.messages);
			expect(plan.input.messages.at(-1)).not.toBe(input.messages.at(-1));
		}
	});

	it('skips when the budget would exceed 4', () => {
		const input = baseInput();
		input.system = [{ text: 'a' }, CP, { text: 'b' }, CP] as any;
		expect(planToolResultCachePoint(input)).toEqual({ action: 'skip', reason: 'budget', points: 4 });
	});

	it('adds when it lands exactly on 4 (boundary allowed)', () => {
		expect(planToolResultCachePoint(baseInput()).action).toBe('add');
	});

	it('skips when the last message already ends with / contains a cache point (idempotent)', () => {
		const input = baseInput();
		input.messages[2].content = [toolResult('a'), CP] as any;
		expect(planToolResultCachePoint(input)).toMatchObject({ action: 'skip', reason: 'already-has-cachepoint' });
	});

	it('skips when the last message has no toolResult', () => {
		const input = baseInput();
		input.messages.push({ role: 'user', content: [{ text: 'otra' }] } as any);
		expect(planToolResultCachePoint(input)).toMatchObject({ action: 'skip', reason: 'no-toolResult' });
	});

	it('skips when the last message is not a user message', () => {
		const input = baseInput();
		input.messages.push({ role: 'assistant', content: [{ text: 'prefill' }] } as any);
		expect(planToolResultCachePoint(input)).toMatchObject({ action: 'skip', reason: 'last-not-user' });
	});

	it('skips (never throws) on malformed shapes', () => {
		for (const bad of [undefined, null, {}, { messages: 'x' }, { messages: [] }, { messages: [{ role: 'user', content: 'texto' }] }, { messages: [null] }]) {
			expect(() => planToolResultCachePoint(bad as any)).not.toThrow();
			expect(planToolResultCachePoint(bad as any).action).toBe('skip');
		}
	});
});

describe('createToolResultCachePointMiddleware', () => {
	const run = async (commandName: string, input: any, logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) => {
		const next = vi.fn(async (args: any) => ({ output: {}, args }));
		const mw = createToolResultCachePointMiddleware(logger, { debug: false });
		const args = { input };
		await mw(next as any, { commandName } as any)(args as any);
		return { passed: next.mock.calls[0][0], args, logger };
	};

	it('acts on ConverseCommand and ConverseStreamCommand', async () => {
		for (const name of ['ConverseCommand', 'ConverseStreamCommand']) {
			const { passed } = await run(name, baseInput());
			expect(passed.input.messages.at(-1).content.at(-1)).toEqual(CP);
		}
	});

	it('passes any other command through untouched (same args object)', async () => {
		const { passed, args } = await run('CountTokensCommand', baseInput());
		expect(passed).toBe(args);
	});

	it('on skip passes the very same args object', async () => {
		const input = baseInput();
		input.messages.push({ role: 'user', content: [{ text: 'otra' }] } as any);
		const { passed, args } = await run('ConverseCommand', input);
		expect(passed).toBe(args);
	});

	it('never throws: an internal error degrades to the original request plus a warn', async () => {
		const evil = baseInput();
		Object.defineProperty(evil, 'messages', { get() { throw new Error('boom'); } });
		const { passed, args, logger } = await run('ConverseCommand', evil);
		expect(passed).toBe(args);
		expect(logger.warn).toHaveBeenCalled();
	});
});
