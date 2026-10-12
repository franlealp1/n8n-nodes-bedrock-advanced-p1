/**
 * Golden of the wire payload: "byte for byte what we send today".
 *
 * The fixture was generated from the UNMODIFIED code of v0.10.0-alpha.9 (commit
 * 6baaf8e) with `UPDATE_GOLDEN=1 npx vitest run payloadGolden` run in a detached
 * worktree of that commit (the run always FAILS on purpose). It must never
 * be regenerated to make a test pass: a diff here means the request that every
 * Bedrock engine sends has changed. That is only acceptable when the change is
 * intended and reviewed (flock#1575: with `cacheToolResults` off or absent, it
 * must not change at all).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILDER_OPTIONS, CONVERSATIONS, PROD_OPTIONS, captureCall, type Route } from './__testing__/converseCapture';
import type { PatchOptions } from './PatchedChatBedrockConverse';

const FIXTURE = join(__dirname, '__fixtures__', 'converse-body-alpha9.json');
const ROUTES: Route[] = ['nonStreaming', 'streaming'];

/** Configurations whose payload must be identical to alpha.9. */
const CONFIGS: Record<string, PatchOptions> = {
	noCaching: {},
	prod: PROD_OPTIONS,
	prod1h: { ...PROD_OPTIONS, cacheTtl: '1h' },
	prodToolResultsOff: { ...PROD_OPTIONS, cacheToolResults: false } as PatchOptions,
	builder: BUILDER_OPTIONS,
};

async function captureAll(): Promise<Record<string, any>> {
	const out: Record<string, any> = {};
	for (const [cfgName, cfg] of Object.entries(CONFIGS)) {
		for (const [convName, conv] of Object.entries(CONVERSATIONS)) {
			for (const route of ROUTES) {
				out[`${cfgName}/${convName}/${route}`] = await captureCall(route, cfg, conv());
			}
		}
	}
	return out;
}

describe('wire payload golden (alpha.9)', () => {
	it('every configuration without cacheToolResults sends exactly the alpha.9 body', async () => {
		const actual = await captureAll();
		if (process.env.UPDATE_GOLDEN === '1') {
			writeFileSync(FIXTURE, JSON.stringify(actual, null, '\t') + '\n');
			// Never green while regenerating: a regenerated golden proves nothing.
			expect.fail('golden regenerated — check it was produced from alpha.9 code, then rerun without UPDATE_GOLDEN');
		}
		expect(existsSync(FIXTURE), `missing fixture ${FIXTURE}`).toBe(true);
		const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
		expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
		for (const key of Object.keys(golden)) {
			expect(actual[key], key).toEqual(golden[key]);
		}
	});
});
