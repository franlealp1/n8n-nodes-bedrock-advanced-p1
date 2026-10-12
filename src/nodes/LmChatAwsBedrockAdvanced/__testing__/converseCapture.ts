/**
 * Test harness: captures the HTTP body that the REAL AWS SDK client would put on
 * the wire for a Converse / ConverseStream call, without any network.
 *
 * Why the body and not `command.input`: anything that rewrites the request
 * between LangChain and the wire (our own middleware included) only shows up
 * after serialization. Asserting on `input` would let a middleware that never
 * runs pass every test (flock#1575).
 *
 * The fake `requestHandler` records the serialized body and throws a sentinel,
 * so every call ends in a rejection the test swallows. One capture per call is
 * an invariant of the harness: a retry would show up as two.
 *
 * Not bundled: esbuild only follows imports from the `.node.ts` entry points.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import { PatchedChatBedrockConverse, type PatchOptions } from '../PatchedChatBedrockConverse';
import { ChatAwsBedrockAdvancedStreaming } from '../../LmChatAwsBedrockAdvancedStreaming/ChatAwsBedrockAdvancedStreaming';

export class CaptureSentinel extends Error {
	constructor() {
		super('capture sentinel: request intercepted before the network');
		this.name = 'CaptureSentinel';
	}
}

export interface Capture {
	path: string;
	body: any;
}

export function captureClient(): { client: BedrockRuntimeClient; captured: Capture[] } {
	const captured: Capture[] = [];
	const client = new BedrockRuntimeClient({
		region: 'eu-central-1',
		credentials: { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake-secret-for-tests-only' },
		maxAttempts: 1,
		requestHandler: {
			handle: async (request: any) => {
				captured.push({ path: request.path, body: JSON.parse(request.body) });
				throw new CaptureSentinel();
			},
		} as any,
	});
	return { client, captured };
}

export const MODEL_ID = 'eu.anthropic.claude-sonnet-4-6';

/** Production config of the Bedrock engines (measured 2026-10-12): caching + system + tools + history, 5m. */
export const PROD_OPTIONS: PatchOptions = {
	enablePromptCaching: true,
	cacheTtl: '5m',
	cacheSystemPrompt: true,
	cacheTools: true,
	cacheConversationHistory: true,
};

export type Route = 'nonStreaming' | 'streaming';

export function makeCaptureModel(route: Route, patchOptions: PatchOptions, client: BedrockRuntimeClient, logger?: any) {
	const base = { client, model: MODEL_ID, region: 'eu-central-1', patchOptions, patchLogger: logger };
	return route === 'streaming'
		? new ChatAwsBedrockAdvancedStreaming({ ...base, streamCallbackUrl: '' })
		: new PatchedChatBedrockConverse(base);
}

export const TOOLS = [
	{ toolSpec: { name: 'buscar', description: 'Busca en el expediente.', inputSchema: { json: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } } },
	{ toolSpec: { name: 'leer', description: 'Lee un documento.', inputSchema: { json: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'] } } } },
];

/** Sends one call through the real client and returns what reached the wire. Exactly one capture per call. */
export async function captureCall(
	route: Route,
	patchOptions: PatchOptions,
	messages: BaseMessage[],
	opts: { logger?: any; client?: ReturnType<typeof captureClient> } = {},
): Promise<any> {
	const cap = opts.client ?? captureClient();
	const model = makeCaptureModel(route, patchOptions, cap.client, opts.logger);
	const before = cap.captured.length;
	await expectSentinel(model.bindTools(TOOLS as any).invoke(messages));
	if (cap.captured.length !== before + 1) {
		throw new Error(`harness: expected exactly 1 captured request, got ${cap.captured.length - before}`);
	}
	const path = cap.captured[cap.captured.length - 1].path;
	const expected = route === 'streaming' ? /\/converse-stream$/ : /\/converse$/;
	if (!expected.test(path)) throw new Error(`harness: route ${route} hit ${path}`);
	return cap.captured[cap.captured.length - 1].body;
}

export async function expectSentinel(p: Promise<unknown>): Promise<void> {
	try {
		await p;
	} catch (e: any) {
		if (e instanceof CaptureSentinel || e?.name === 'CaptureSentinel') return;
		throw e;
	}
	throw new Error('harness: call resolved instead of being intercepted');
}

// ── Canonical conversations (synthetic; shapes measured in noprod logs 2026-10-12) ──

const long = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed} ${i}`).join(' ');

/** Every engine sends a system prompt (measured: 1 system cache point in all of them). */
const history = (): BaseMessage[] => [
	new SystemMessage(long('instrucciones del agente', 900)),
	new HumanMessage('Hola, tengo un expediente de arrendamiento.'),
	new AIMessage('Perfecto, ¿qué necesitas?'),
];

const aiToolCall = (round: number, ids: string[]) =>
	new AIMessage({
		content: `Ronda ${round}: consulto.`,
		tool_calls: ids.map((id, j) => ({ id, name: j % 2 ? 'leer' : 'buscar', args: j % 2 ? { doc: `DOC_${round}` } : { q: `plazos ${round}` }, type: 'tool_call' as const })),
	});

const toolMsg = (id: string, text: string) => new ToolMessage({ tool_call_id: id, content: text });

export const CONVERSATIONS: Record<string, () => BaseMessage[]> = {
	/** (a) First call of a turn: no tool results yet. */
	firstCallNoTools: () => [...history(), new HumanMessage('Resume los plazos del contrato.')],
	/** (b) One round: human → AI tool_call → ToolMessage (last). */
	oneToolResult: () => [
		...history(),
		new HumanMessage('Resume los plazos del contrato.'),
		aiToolCall(1, ['tu_1']),
		toolMsg('tu_1', long('fragmento', 400)),
	],
	/** (b') Two rounds: the second call of the turn after a tool. */
	twoRounds: () => [
		...history(),
		new HumanMessage('Resume los plazos del contrato.'),
		aiToolCall(1, ['tu_1']),
		toolMsg('tu_1', long('fragmento', 400)),
		aiToolCall(2, ['tu_2']),
		toolMsg('tu_2', long('documento', 400)),
	],
	/** (c) Three tools in parallel: LangChain merges their results into ONE user message. */
	parallelTools: () => [
		...history(),
		new HumanMessage('Compara los tres documentos.'),
		aiToolCall(1, ['tu_a', 'tu_b', 'tu_c']),
		toolMsg('tu_a', long('a', 200)),
		toolMsg('tu_b', long('b', 200)),
		toolMsg('tu_c', long('c', 200)),
	],
	/** (e) ToolMessage with array content (text blocks). */
	arrayContentTool: () => [
		...history(),
		new HumanMessage('Lee el anexo.'),
		aiToolCall(1, ['tu_x']),
		new ToolMessage({ tool_call_id: 'tu_x', content: [{ type: 'text', text: long('anexo', 200) }] }),
	],
};

/** (d) Builder/Onboarding shape: 2 system blocks (+ tools + history) = 4 cache points already. */
export const BUILDER_OPTIONS: PatchOptions = {
	...PROD_OPTIONS,
	systemPromptBlocks: JSON.stringify([long('bloque fijo del builder', 900), long('contexto del usuario', 900)]),
};

/** Counts cache points exactly where Bedrock counts them: top level of system, tools and message content. */
export function countWireCachePoints(body: any): number {
	const isCp = (b: any) => b && typeof b === 'object' && 'cachePoint' in b;
	let n = 0;
	for (const b of body.system ?? []) if (isCp(b)) n++;
	for (const b of body.toolConfig?.tools ?? []) if (isCp(b)) n++;
	for (const m of body.messages ?? []) for (const b of m.content ?? []) if (isCp(b)) n++;
	return n;
}
