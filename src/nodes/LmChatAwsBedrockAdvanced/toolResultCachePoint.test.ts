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

describe('createToolResultCachePointMiddleware — never silent in production (no debug)', () => {
	const mkLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
	const call = async (mw: any, commandName: string | undefined, input: any) => {
		const next = vi.fn(async (a: any) => a);
		const args = { input };
		await mw(next, { commandName })(args);
		return { passed: next.mock.calls[0][0], args };
	};
	const said = (fn: any, re: RegExp) => fn.mock.calls.filter(([m]: [string]) => re.test(m));

	it('first successful add leaves ONE info line per instance, with the model label', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false, label: 'eu.model' });
		for (let i = 0; i < 3; i++) await call(mw, 'ConverseCommand', baseInput());
		const lines = said(log.info, /active/);
		expect(lines).toHaveLength(1);
		expect(lines[0][0]).toContain('[eu.model]');
	});

	it('malformed Converse request: ONE warn with shape diagnostics and no content', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false });
		const bad = { modelId: 'm', messages: [{ role: 'user', content: 'texto secreto' }] };
		await call(mw, 'ConverseCommand', bad);
		await call(mw, 'ConverseCommand', bad);
		const warns = said(log.warn, /shape/);
		expect(warns).toHaveLength(1);
		expect(warns[0][0]).toMatch(/lastContent=string/);
		expect(warns[0][0]).not.toContain('texto secreto');
	});

	it('tool results present but not in the last message: ONE warn (cache would silently do nothing)', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false });
		const input = baseInput();
		input.messages.push({ role: 'user', content: [{ text: 'recordatorio' }] } as any);
		await call(mw, 'ConverseCommand', input);
		await call(mw, 'ConverseCommand', input);
		expect(said(log.warn, /last message does not/)).toHaveLength(1);
	});

	it('first call of a turn (no tool results anywhere) is legitimately quiet', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false });
		const input = baseInput();
		input.messages = [input.messages[0]];
		await call(mw, 'ConverseCommand', input);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});

	it('missing commandName: request untouched, ONE warn', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false });
		const { passed, args } = await call(mw, undefined, baseInput());
		await call(mw, undefined, baseInput());
		expect(passed).toBe(args);
		expect(said(log.warn, /commandName/)).toHaveLength(1);
	});

	it('internal error: warned ONCE per instance with the command name, request untouched', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: false });
		const evil = () => { const e = baseInput(); Object.defineProperty(e, 'messages', { get() { throw new Error('boom'); } }); return e; };
		await call(mw, 'ConverseStreamCommand', evil());
		await call(mw, 'ConverseStreamCommand', evil());
		const warns = said(log.warn, /unexpected error/);
		expect(warns).toHaveLength(1);
		expect(warns[0][0]).toMatch(/ConverseStreamCommand.*boom/);
	});

	it('a logger that throws never stops the request (diagnostics are best-effort)', async () => {
		const log = { info: vi.fn(() => { throw new Error('logger down'); }), warn: vi.fn(() => { throw new Error('logger down'); }) };
		const mw = createToolResultCachePointMiddleware(log, { debug: true });
		const { passed } = await call(mw, 'ConverseCommand', baseInput());
		expect(passed.input.messages.at(-1).content.at(-1)).toEqual(CP);
	});

	it('debug hashing survives binary payloads (documents/images as bytes)', async () => {
		const log = mkLogger();
		const mw = createToolResultCachePointMiddleware(log, { debug: true });
		const input = baseInput();
		input.messages[0].content.unshift({ document: { name: 'd', format: 'pdf', source: { bytes: new Uint8Array(5_000_000) } } } as any);
		const { passed } = await call(mw, 'ConverseCommand', input);
		expect(passed.input.messages.at(-1).content.at(-1)).toEqual(CP);
		expect(said(log.info, /decision=add/)).toHaveLength(1);
	});
});
