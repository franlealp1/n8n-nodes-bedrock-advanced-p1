/**
 * Spec of `cacheToolResults` (flock#1575), asserted on the HTTP body the real
 * AWS SDK client would send. Derived from the Bedrock Converse API and the plan,
 * NOT from the implementation:
 *
 *  - `cachePoint` is a member of `ContentBlock`, not of `ToolResultContentBlock`
 *    ⇒ it goes as a SIBLING after the last `toolResult`, never inside one.
 *  - Bedrock rejects more than 4 cache points per request (measured 2026-10-12:
 *    "A maximum of 4 blocks with cache_control may be provided. Found 5.").
 *  - The only change the option may make to a request is ONE block appended to
 *    the end of the last user message, and only when that message carries tool
 *    results. Everything else stays byte for byte as in alpha.9 (golden).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApplyGuardrailCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

import {
	BUILDER_OPTIONS,
	CONVERSATIONS,
	PROD_OPTIONS,
	TOOLS,
	captureCall,
	captureClient,
	countWireCachePoints,
	expectSentinel,
	makeCaptureModel,
	type Route,
} from './__testing__/converseCapture';
import type { PatchOptions } from './PatchedChatBedrockConverse';

const GOLDEN = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'converse-body-alpha9.json'), 'utf8'));
const ROUTES: Route[] = ['nonStreaming', 'streaming'];
const ON: PatchOptions = { ...PROD_OPTIONS, cacheToolResults: true } as PatchOptions;
const BUILDER_ON: PatchOptions = { ...BUILDER_OPTIONS, cacheToolResults: true } as PatchOptions;
const SIBLING = { cachePoint: { type: 'default' } };

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const isCp = (b: any) => b && typeof b === 'object' && 'cachePoint' in b;

/** golden body with exactly one sibling cachePoint appended to the last message. */
function goldenPlusSibling(key: string) {
	const g = structuredClone(GOLDEN[key]);
	g.messages.at(-1).content.push(SIBLING);
	return g;
}

describe.each(ROUTES)('cacheToolResults ON — %s', (route) => {
	it('one tool result: the ONLY change vs alpha.9 is a sibling cachePoint after the toolResult', async () => {
		const body = await captureCall(route, ON, CONVERSATIONS.oneToolResult());
		expect(body).toEqual(goldenPlusSibling(`prod/oneToolResult/${route}`));
		const last = body.messages.at(-1);
		expect(last.role).toBe('user');
		expect(Object.keys(last.content.at(-2))).toEqual(['toolResult']);
		expect(last.content.at(-1)).toEqual(SIBLING); // no ttl: same 5m as system/history
		expect(countWireCachePoints(body)).toBe(4);
	});

	it('never puts a cachePoint inside any toolResult.content', async () => {
		for (const conv of Object.values(CONVERSATIONS)) {
			const body = await captureCall(route, ON, conv());
			for (const m of body.messages) {
				for (const b of m.content) {
					if (b.toolResult) expect(b.toolResult.content.some(isCp)).toBe(false);
				}
			}
		}
	});

	it('parallel tools (merged into one user message): exactly one cachePoint, at the end', async () => {
		const body = await captureCall(route, ON, CONVERSATIONS.parallelTools());
		expect(body).toEqual(goldenPlusSibling(`prod/parallelTools/${route}`));
		const last = body.messages.at(-1).content;
		expect(last.filter(isCp)).toHaveLength(1);
		expect(last.slice(0, -1).every((b: any) => b.toolResult)).toBe(true);
	});

	it('second round: only the LAST tool-result message gets it; earlier ones stay as in alpha.9', async () => {
		const body = await captureCall(route, ON, CONVERSATIONS.twoRounds());
		expect(body).toEqual(goldenPlusSibling(`prod/twoRounds/${route}`));
	});

	it('tool message with array content: sibling outside, toolResult content untouched', async () => {
		const body = await captureCall(route, ON, CONVERSATIONS.arrayContentTool());
		expect(body).toEqual(goldenPlusSibling(`prod/arrayContentTool/${route}`));
	});

	it('first call of a turn (no tool results): identical to alpha.9', async () => {
		const body = await captureCall(route, ON, CONVERSATIONS.firstCallNoTools());
		expect(body).toEqual(GOLDEN[`prod/firstCallNoTools/${route}`]);
	});

	it('Builder/Onboarding shape (4 points already): identical to alpha.9, never 5', async () => {
		for (const name of Object.keys(CONVERSATIONS)) {
			const body = await captureCall(route, BUILDER_ON, CONVERSATIONS[name]());
			expect(body, name).toEqual(GOLDEN[`builder/${name}/${route}`]);
			expect(countWireCachePoints(body), name).toBeLessThanOrEqual(4);
		}
	});

	it('budget skip warns ONCE per model instance, not once per call', async () => {
		const log = logger();
		const cap = captureClient();
		const model = makeCaptureModel(route, BUILDER_ON, cap.client, log);
		for (let i = 0; i < 3; i++) await expectSentinel(model.bindTools(TOOLS as any).invoke(CONVERSATIONS.oneToolResult()));
		expect(cap.captured).toHaveLength(3);
		const budgetWarns = log.warn.mock.calls.filter(([m]) => /toolResultCache/i.test(String(m)));
		expect(budgetWarns).toHaveLength(1);
	});

	it('invariant: no request ever leaves with more than 4 cache points', async () => {
		for (const cfg of [ON, BUILDER_ON]) {
			for (const conv of Object.values(CONVERSATIONS)) {
				expect(countWireCachePoints(await captureCall(route, cfg, conv()))).toBeLessThanOrEqual(4);
			}
		}
	});

	it('debug log reports the decision without leaking message content', async () => {
		const log = logger();
		await captureCall(route, { ...ON, enableDebugLogs: true }, CONVERSATIONS.oneToolResult(), { logger: log });
		const lines = log.info.mock.calls.map(([m]) => String(m)).filter((m) => /toolResultCache/i.test(m));
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.join('\n')).toMatch(/add/);
		expect(lines.join('\n')).not.toMatch(/fragmento|instrucciones del agente|plazos/);
	});
});

describe('cacheToolResults OFF / absent', () => {
	it('does not register anything on the client', () => {
		for (const opts of [PROD_OPTIONS, { ...PROD_OPTIONS, cacheToolResults: false } as PatchOptions]) {
			const cap = captureClient();
			makeCaptureModel('nonStreaming', opts, cap.client);
			expect(cap.client.middlewareStack.identify().join('|')).not.toMatch(/flockToolResultCachePoint/);
		}
	});

	it('requires enablePromptCaching too', () => {
		const cap = captureClient();
		makeCaptureModel('nonStreaming', { cacheToolResults: true } as PatchOptions, cap.client);
		expect(cap.client.middlewareStack.identify().join('|')).not.toMatch(/flockToolResultCachePoint/);
	});
});

describe('registration', () => {
	it('registers exactly one middleware per model instance', () => {
		const cap = captureClient();
		makeCaptureModel('nonStreaming', ON, cap.client);
		const entries = cap.client.middlewareStack.identify().filter((s) => s.startsWith('flockToolResultCachePoint'));
		expect(entries).toHaveLength(1);
	});

	it('a second ON model on the SAME client fails loudly instead of sharing options silently', () => {
		const cap = captureClient();
		makeCaptureModel('nonStreaming', ON, cap.client);
		expect(() => makeCaptureModel('streaming', ON, cap.client)).toThrow(/flockToolResultCachePoint/);
	});

	it('a client without middlewareStack: model still builds, feature off, explicit warn', () => {
		const log = logger();
		const stub = { send: async () => ({}) } as any;
		expect(() => makeCaptureModel('nonStreaming', ON, stub, log)).not.toThrow();
		expect(log.warn.mock.calls.some(([m]) => /toolResultCache/i.test(String(m)))).toBe(true);
	});
});

describe('client-level behaviour', () => {
	it('does not mutate the command input it receives', async () => {
		const cap = captureClient();
		makeCaptureModel('nonStreaming', ON, cap.client);
		const input = structuredClone(GOLDEN['prod/oneToolResult/nonStreaming']);
		const cmd = new ConverseCommand({ modelId: 'eu.anthropic.claude-sonnet-4-6', ...input });
		const snapshot = JSON.stringify(cmd.input);
		await expectSentinel(cap.client.send(cmd));
		expect(JSON.stringify(cmd.input)).toBe(snapshot);
		expect(cap.captured[0].body.messages.at(-1).content.at(-1)).toEqual(SIBLING);
	});

	it('leaves other commands sent through the same client untouched', async () => {
		const cap = captureClient();
		makeCaptureModel('nonStreaming', ON, cap.client);
		const input = { guardrailIdentifier: 'g', guardrailVersion: '1', source: 'INPUT' as const, content: [{ text: { text: 'hola' } }] };
		await expectSentinel(cap.client.send(new ApplyGuardrailCommand(input)));
		expect(cap.captured[0].body).toEqual({ content: input.content, source: 'INPUT' });
	});
});
