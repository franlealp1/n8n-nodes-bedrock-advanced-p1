/**
 * In-turn caching of tool results (flock#1575, technique 3 of flock#1571).
 *
 * In an agent loop every call re-sends the tool results gathered so far, and
 * they sit AFTER the last cache point (the history one skips tool messages on
 * purpose, see `findHistoryCacheTarget`). So they are billed as full-price input
 * on every round. This module adds ONE `cachePoint` right after the last
 * `toolResult` of the request, so the next call reads all of that from cache
 * and only writes what is new.
 *
 * Why an AWS SDK middleware and not something earlier:
 *  - In @langchain/aws 0.1.15 a cache point placed on a ToolMessage ends up
 *    INSIDE `toolResult.content` (common.js:323-365), where Bedrock does not
 *    accept it: `cachePoint` is a member of ContentBlock, not of
 *    ToolResultContentBlock. It has to be a SIBLING in the converted message.
 *  - Only the converted Converse input is the real request, `toolConfig`
 *    included, which the 4-point budget has to see.
 *  - Converse and ConverseStream both go through `client.send`
 *    (chat_models.js:681, :712), so one middleware covers both routes.
 *
 * Measured against Bedrock on 2026-10-12 (noprod, eu.anthropic.claude-sonnet-4-6):
 * with this placement every call read exactly `read + write` of the previous one,
 * and 5 cache points is rejected ("A maximum of 4 blocks with cache_control may
 * be provided"). Hence the budget guard.
 */

import { createHash } from 'node:crypto';

import { MAX_CACHEPOINTS } from './parseSystemPromptBlocks';

export const TOOL_RESULT_CACHE_POINT_MIDDLEWARE = 'flockToolResultCachePoint';

const CONVERSE_COMMANDS = new Set(['ConverseCommand', 'ConverseStreamCommand']);
const LOG_PREFIX = '[BedrockAdvanced] [toolResultCache]';

export interface ToolResultCacheLogger {
	info: (msg: string) => void;
	warn: (msg: string) => void;
}

export type ToolResultCachePlan =
	| { action: 'add'; input: any; points: number }
	| { action: 'skip'; reason: 'bad-shape' | 'last-not-user' | 'no-toolResult' | 'already-has-cachepoint'; points?: number }
	| { action: 'skip'; reason: 'budget'; points: number };

const isCachePoint = (block: unknown): boolean =>
	typeof block === 'object' && block !== null && 'cachePoint' in block;

const countIn = (blocks: unknown): number =>
	Array.isArray(blocks) ? blocks.filter(isCachePoint).length : 0;

/**
 * Cache points exactly where Bedrock counts them: top level of `system`,
 * `toolConfig.tools` and each message's `content`. Not recursive on purpose —
 * data inside a `toolResult` is payload, not a cache point.
 */
export function countCachePoints(input: any): number {
	if (!input || typeof input !== 'object') return 0;
	let n = countIn(input.system) + countIn(input.toolConfig?.tools);
	if (Array.isArray(input.messages)) {
		for (const m of input.messages) n += countIn(m?.content);
	}
	return n;
}

/** Pure decision. Never mutates `input`; on `add` returns a new input with a new messages array and last message. */
export function planToolResultCachePoint(input: any): ToolResultCachePlan {
	const messages = input?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return { action: 'skip', reason: 'bad-shape' };
	const last = messages[messages.length - 1];
	if (!last || typeof last !== 'object' || !Array.isArray(last.content)) return { action: 'skip', reason: 'bad-shape' };
	if (last.role !== 'user') return { action: 'skip', reason: 'last-not-user' };
	if (!last.content.some((b: any) => b && typeof b === 'object' && 'toolResult' in b)) {
		return { action: 'skip', reason: 'no-toolResult' };
	}
	if (last.content.some(isCachePoint)) return { action: 'skip', reason: 'already-has-cachepoint' };

	const points = countCachePoints(input);
	if (points + 1 > MAX_CACHEPOINTS) return { action: 'skip', reason: 'budget', points };

	// No `ttl`: same 5m as the system/history points, whose ttl the 0.1.15 converter
	// drops anyway (common.js:198, 224, 273). A 1h tools point still comes first.
	const newLast = { ...last, content: [...last.content, { cachePoint: { type: 'default' } }] };
	return { action: 'add', input: { ...input, messages: [...messages.slice(0, -1), newLast] }, points: points + 1 };
}

/** JSON for hashing only: binary payloads (images, documents) are replaced by their size. */
const hashReplacer = (_key: string, value: any) => {
	if (value instanceof Uint8Array) return `<bytes:${value.length}>`;
	if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `<bytes:${value.data.length}>`;
	return value;
};

const shortHash = (value: unknown): string =>
	createHash('sha256').update(JSON.stringify(value, hashReplacer) ?? '').digest('hex').slice(0, 10);

/** Shape of a request, for diagnostics. Never includes content. */
function describeShape(input: any): string {
	const messages = input?.messages;
	const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
	const lastContent = last?.content;
	return (
		`keys=[${input && typeof input === 'object' ? Object.keys(input).join(',') : typeof input}] ` +
		`messages=${Array.isArray(messages) ? messages.length : typeof messages} lastRole=${last?.role} ` +
		`lastContent=${Array.isArray(lastContent) ? `array(${lastContent.length})` : typeof lastContent}`
	);
}

function describeError(err: unknown): string {
	const e = err as Error;
	const where = typeof e?.stack === 'string' ? e.stack.split('\n')[1]?.trim() : undefined;
	return `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}${where ? ` (${where})` : ''}`;
}

const hasToolResult = (message: any): boolean =>
	Array.isArray(message?.content) && message.content.some((b: any) => b && typeof b === 'object' && 'toolResult' in b);

/**
 * The middleware itself. One per model instance (≈ one N8N execution): the
 * "once" state lives in this closure.
 *
 * Two promises, both tested:
 *  - It never breaks a request. Any unexpected failure sends the original
 *    request; diagnostics are best-effort and isolated from the request path.
 *  - With the option on it is never silent in production (no debug needed):
 *    one `info` the first time it works, and one `warn` per anomaly kind —
 *    budget full, malformed request, tool results that are not in the last
 *    message, unknown command context, internal error.
 */
export function createToolResultCachePointMiddleware(
	logger: ToolResultCacheLogger,
	opts: { debug: boolean; label?: string },
) {
	const tag = `${LOG_PREFIX}${opts.label ? ` [${opts.label}]` : ''}`;
	const said = new Set<string>();
	const once = (key: string, emit: () => void) => {
		if (said.has(key)) return;
		said.add(key);
		emit();
	};

	const report = (plan: ToolResultCachePlan, commandName: string, input: any) => {
		if (plan.action === 'add') {
			once('active', () =>
				logger.info(`${tag} active: cache point added after the tool results (${plan.points} cache points in the request).`),
			);
		} else if (plan.reason === 'budget') {
			once('budget', () =>
				logger.warn(
					`${tag} not added: the request already has ${plan.points} cache points and Bedrock allows ${MAX_CACHEPOINTS}. ` +
						'Typical cause: 2 systemPromptBlocks + tools + history (Builder/Onboarding). Warned once per model instance.',
				),
			);
		} else if (plan.reason === 'bad-shape') {
			once('bad-shape', () =>
				logger.warn(`${tag} ${commandName}: unexpected request shape, nothing added (warned once): ${describeShape(input)}`),
			);
		} else if (plan.reason === 'no-toolResult' && Array.isArray(input?.messages) && input.messages.slice(0, -1).some(hasToolResult)) {
			once('tool-results-not-last', () =>
				logger.warn(
					`${tag} ${commandName}: the request has tool results but its last message does not, so nothing was cached ` +
						`(something is appended after the tool messages; warned once): ${describeShape(input)}`,
				),
			);
		}

		if (opts.debug) {
			const sent = plan.action === 'add' ? plan.input : input;
			const hashes = Array.isArray(sent?.messages) ? sent.messages.map(shortHash) : [];
			logger.info(
				`${tag} ${commandName} decision=${plan.action === 'add' ? 'add' : `skip:${plan.reason}`} ` +
					`points=${countCachePoints(sent)} msgHashes=[${hashes.join(',')}]`,
			);
		}
	};

	return (next: (args: any) => Promise<any>, context: { commandName?: string }) => async (args: any) => {
		const commandName = context?.commandName;
		if (!CONVERSE_COMMANDS.has(commandName ?? '')) {
			if (commandName === undefined) {
				once('no-command', () =>
					logger.warn(`${tag} middleware context has no commandName: request sent unchanged, nothing cached (warned once).`),
				);
			}
			return next(args);
		}

		let plan: ToolResultCachePlan;
		try {
			plan = planToolResultCachePoint(args.input);
		} catch (err) {
			once('error', () =>
				logger.warn(
					`${tag} ${commandName}: unexpected error, request sent unchanged and nothing cached for it ` +
						`(further errors in this instance are not logged): ${describeError(err)}`,
				),
			);
			return next(args);
		}

		try {
			report(plan, commandName as string, args.input);
		} catch {
			// Diagnostics are best-effort: they must never stop the request.
		}

		return plan.action === 'add' ? next({ ...args, input: plan.input }) : next(args);
	};
}

/**
 * Registers the middleware on the model's own client.
 *
 * Returns false (feature off, explicit warn) when the client has no middleware
 * stack. Throws when it is already registered: two models sharing one client
 * would share one closure, and the second would silently run with the first's
 * options. The node builds one client per model (LmChatAwsBedrockAdvanced.node.ts),
 * so this never happens in production; if it ever does, it must be loud.
 * Limitation, by construction: a model with the option OFF that shares a client
 * with one ON cannot be detected (it registers nothing).
 */
export function registerToolResultCachePoint(
	client: any,
	logger: ToolResultCacheLogger,
	opts: { debug: boolean; label?: string },
): boolean {
	const stack = client?.middlewareStack;
	if (!stack || typeof stack.add !== 'function' || typeof stack.identify !== 'function') {
		logger.warn(`${LOG_PREFIX} client has no middleware stack: cacheToolResults stays OFF for this model.`);
		return false;
	}
	const already = (stack.identify() as string[]).some((entry) => entry.startsWith(`${TOOL_RESULT_CACHE_POINT_MIDDLEWARE} `));
	if (already) {
		throw new Error(
			`${TOOL_RESULT_CACHE_POINT_MIDDLEWARE} is already registered on this Bedrock client: ` +
				'two models are sharing one client, which would make them share caching options.',
		);
	}
	stack.add(createToolResultCachePointMiddleware(logger, opts), {
		step: 'initialize',
		name: TOOL_RESULT_CACHE_POINT_MIDDLEWARE,
	});
	return true;
}
