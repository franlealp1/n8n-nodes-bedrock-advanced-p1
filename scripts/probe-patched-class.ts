/**
 * Fase 3 de flock#1575: la clase REAL del nodo contra Bedrock (noprod), fuera de N8N.
 *
 * Reproduce lo que hace `supplyData` (LmChatAwsBedrockAdvanced.node.ts):
 *   - cliente propio por modelo con auth Bearer (ruta `apiKey`);
 *   - métricas por el mismo camino: `buildTokensUsage(llmOutput.tokenUsage, streamUsageSink)`;
 *   - logger que recoge info/warn (los `[toolResultCache]` incluidos).
 *
 * Simula un turno de agente: system + historial + humano, y N rondas de
 * AIMessage(tool_calls) + ToolMessage grande. Cada llamada envía la conversación
 * acumulada, como el bucle de LangChain. Datos 100 % sintéticos; sal por corrida
 * en el system para empezar con caché fría.
 *
 * Criterio (plan §Acceptance): con la opción ON, para k≥2,
 *   cacheRead[k] = cacheRead[k-1] + cacheWrite[k-1] + promptTokens[k-1]   (tolerancia 0)
 * y con OFF el patrón de hoy (lectura plana).
 *
 * Uso (desde la raíz del worktree):
 *   npx esbuild scripts/probe-patched-class.ts --bundle --platform=node --format=cjs \
 *     --external:n8n-workflow --outfile=/tmp/probe.cjs && node /tmp/probe.cjs
 * Credenciales: `.env` del worktree (symlink a server/.env de Flock = NOPROD), con dotenv
 * del repo de Flock (FLOCK_REPO, por defecto ../chat-flock-pre-coolify). No imprime valores.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import { PatchedChatBedrockConverse, type PatchOptions, type StreamUsageSink } from '../src/nodes/LmChatAwsBedrockAdvanced/PatchedChatBedrockConverse';
import { ChatAwsBedrockAdvancedStreaming } from '../src/nodes/LmChatAwsBedrockAdvancedStreaming/ChatAwsBedrockAdvancedStreaming';
import { buildTokensUsage } from '../src/nodes/LmChatAwsBedrockAdvanced/buildTokensUsage';

const root = resolve(process.cwd());
const flockRepo = resolve(root, process.env.FLOCK_REPO ?? '../chat-flock-pre-coolify');
const env: Record<string, string> =
	createRequire(resolve(flockRepo, 'package.json'))('dotenv').config({ path: resolve(root, '.env'), processEnv: {} }).parsed ?? {};
const API_KEY = env.COMPANY_BEDROCK_API_KEY;
if (!API_KEY) throw new Error('Falta COMPANY_BEDROCK_API_KEY en .env');
const REGION = env.COMPANY_BEDROCK_REGION ?? 'eu-central-1';
const MODEL = process.env.PROBE_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const RUN = Date.now().toString(36);

function bearerClient(): BedrockRuntimeClient {
	const client = new BedrockRuntimeClient({
		region: REGION,
		credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
	});
	client.middlewareStack.add(
		(next: any) => async (args: any) => {
			args.request.headers['authorization'] = `Bearer ${API_KEY}`;
			delete args.request.headers['x-amz-security-token'];
			return next(args);
		},
		{ step: 'finalizeRequest', priority: 'low', name: 'bedrockBearerTokenMiddleware' },
	);
	if (process.env.PROBE_TRACE) {
		client.middlewareStack.add(
			(next: any) => async (args: any) => {
				TRACE.push({ kind: 'body', body: JSON.parse(String(args.request.body)) });
				return next(args);
			},
			{ step: 'finalizeRequest', priority: 'high', name: 'probeBodySpy' },
		);
		client.middlewareStack.add(
			(next: any) => async (args: any) => {
				const res = await next(args);
				TRACE.push({ kind: 'usage', usage: res.output?.usage, stopReason: res.output?.stopReason, content: res.output?.output?.message?.content?.map((c: any) => Object.keys(c)[0]) });
				return res;
			},
			{ step: 'initialize', priority: 'high', name: 'probeUsageSpy' },
		);
	}
	return client;
}
export const TRACE: any[] = [];

/**
 * Texto coherente: cláusulas de un contrato de arrendamiento ficticio, distintas por
 * cifras y fechas. El texto al azar (listas de palabras) provocó stopReason=content_filtered
 * en la 1.ª corrida del 2026-10-12, y una respuesta filtrada NO deja su caché: la medida
 * no valía. PROBE_VOCAB=random recupera el comportamiento anterior.
 */
function coherent(seed: number, words: number): string {
	const out: string[] = [];
	let n = 0;
	let x = (seed * 2654435761) % 4294967296;
	while (out.join(' ').split(' ').length < words) {
		x = (x * 1103515245 + 12345) % 2147483648;
		n++;
		const renta = 600 + (x % 900);
		const dia = 1 + (x % 28);
		const meses = 1 + (x % 11);
		out.push(
			`Cláusula ${seed}.${n}. El arrendatario abonará una renta mensual de ${renta} euros, pagadera antes del día ${dia} de cada mes ` +
				`mediante transferencia bancaria. En caso de retraso superior a ${meses} meses, el arrendador podrá requerir el pago por escrito ` +
				`y, si no se atiende en el plazo de treinta días naturales, resolver el contrato conforme a la Ley de Arrendamientos Urbanos. ` +
				`La fianza equivale a ${1 + (x % 3)} mensualidades y se devolverá al finalizar el contrato, descontados los desperfectos acreditados.`,
		);
	}
	return out.join('\n');
}

function synth(seed: number, words: number): string {
	if (process.env.PROBE_VOCAB !== 'random' && process.env.PROBE_VOCAB !== 'neutral') return coherent(seed, words);
	// PROBE_VOCAB=neutral: vocabulario cotidiano. El jurídico al azar provocó stopReason=content_filtered
	// desde la 2.ª llamada en la primera corrida (2026-10-12), y una respuesta filtrada no deja su caché.
	const vocab = process.env.PROBE_VOCAB === 'neutral'
		? ['mesa', 'ventana', 'jardín', 'lunes', 'naranja', 'bicicleta', 'cuaderno', 'tren', 'montaña', 'café',
			'lápiz', 'puerta', 'otoño', 'música', 'camino', 'plaza', 'río', 'pan']
		: ['expediente', 'cláusula', 'arrendamiento', 'notificación', 'plazo', 'demanda', 'contrato', 'resolución',
			'prueba', 'testigo', 'recurso', 'sentencia', 'auto', 'diligencia', 'informe', 'perito', 'factura', 'importe'];
	let x = (seed * 2654435761) % 4294967296;
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.push(vocab[x % vocab.length] + (x % 7 === 0 ? ` ${x % 10000}` : ''));
	}
	return out.join(' ');
}

const TOOLS = [
	{ toolSpec: { name: 'buscar', description: 'Busca en el expediente.', inputSchema: { json: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } } },
	{ toolSpec: { name: 'leer', description: 'Lee un documento.', inputSchema: { json: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'] } } } },
];

/** Las N llamadas de un turno: la k-ésima lleva k rondas de tool. La 0 es la primera (sin tools). */
function turnCalls(salt: string, rounds: number, parallel: number, words: number): BaseMessage[][] {
	const base: BaseMessage[] = [
		new SystemMessage(`[sonda ${salt}] Eres un asistente jurídico que ayuda a revisar contratos de arrendamiento. Responde en español, con precisión y citando la cláusula. Contrato de referencia:\n` + synth(1, 2500)),
		new HumanMessage('Hola, tengo un expediente.'),
		new AIMessage('Perfecto, dime.'),
		new HumanMessage('Analiza el expediente y resume los plazos.'),
	];
	const calls: BaseMessage[][] = [[...base]];
	const acc = [...base];
	for (let r = 1; r <= rounds; r++) {
		const ids = Array.from({ length: parallel }, (_, j) => `tu_${salt}_${r}_${j}`);
		acc.push(new AIMessage({
			content: `Ronda ${r}: consulto.`,
			tool_calls: ids.map((id, j) => ({ id, name: j % 2 ? 'leer' : 'buscar', args: j % 2 ? { doc: `DOC_${r}` } : { q: `plazos ${r}` }, type: 'tool_call' as const })),
		}));
		ids.forEach((id, j) => acc.push(new ToolMessage({ tool_call_id: id, content: synth(100 * r + j, words) })));
		calls.push([...acc]);
	}
	return calls;
}

interface Row { call: number; ok: boolean; stop?: string; prompt?: number; read?: number; write?: number; out?: number; error?: string; ms: number }

async function runScenario(name: string, route: 'nonStreaming' | 'streaming', opts: PatchOptions, parallel = 1, words = 2500, rounds = 4) {
	const logs: string[] = [];
	const logger = { info: (m: string) => logs.push('INFO ' + m), warn: (m: string) => logs.push('WARN ' + m), error: (m: string) => logs.push('ERROR ' + m) };
	const sink: StreamUsageSink = { last: null };
	const base = { client: bearerClient(), model: MODEL, region: REGION, maxTokens: 32, temperature: 0, patchOptions: opts, patchLogger: logger, streamUsageSink: sink };
	const model = route === 'streaming'
		? new ChatAwsBedrockAdvancedStreaming({ ...base, streamCallbackUrl: '' })
		: new PatchedChatBedrockConverse(base);
	// ChatAwsBedrockAdvancedStreaming fuerza streaming=true; con URL vacía no hace POSTs.
	const bound = model.bindTools(TOOLS as any);
	const rows: Row[] = [];
	const calls = turnCalls(`${RUN}-${name}`, rounds, parallel, words);
	for (let k = 0; k < calls.length; k++) {
		const t0 = Date.now();
		let llmOutput: any;
		try {
			const msg: any = await bound.invoke(calls[k], { callbacks: [{ handleLLMEnd: (o: any) => { llmOutput = o.llmOutput; } }] });
			const rm = msg?.response_metadata ?? {};
			const stop = rm.stopReason ?? rm.messageStop?.stopReason ?? rm.stop_reason;
			const sunk = sink.last; sink.last = null;
			const tu = buildTokensUsage(llmOutput?.tokenUsage, sunk);
			rows.push({ call: k + 1, ok: true, stop, prompt: tu.promptTokens, read: tu.cacheReadInputTokens, write: tu.cacheWriteInputTokens, out: tu.completionTokens, ms: Date.now() - t0 });
		} catch (e: any) {
			rows.push({ call: k + 1, ok: false, error: `${e?.name}: ${String(e?.message).slice(0, 200)}`, ms: Date.now() - t0 });
		}
	}
	// Criterio: desde la 3.ª llamada (2.ª con tool), se lee TODO lo cacheable de la anterior:
	//   read[k] = read[k-1] + write[k-1]   (tolerancia 0)
	// y lo que queda sin caché es solo el token final no cacheable: prompt[k] ≤ 1.
	// (Medido el 2026-10-12: con el punto al final, Bedrock cobra 1 token de input que no
	// entra en ninguna caché; por eso NO se suma prompt[k-1] a lo esperado.)
	const checks = rows.slice(2).map((r, i) => {
		const p = rows[i + 1];
		const expected = (p.read ?? 0) + (p.write ?? 0);
		return { call: r.call, read: r.read, expected, diff: (r.read ?? 0) - expected, prompt: r.prompt };
	});
	// Una respuesta filtrada no deja caché: con alguna, el criterio no se puede evaluar.
	const filtered = rows.filter((r) => r.stop === 'content_filtered').map((r) => r.call);
	const verdict = filtered.length ? `NO EVALUABLE (content_filtered en ${filtered.join(',')})`
		: rows.some((r) => !r.ok) ? 'ERROR'
		: !opts.cacheToolResults ? (checks.every((c) => (c.prompt ?? 0) > 1) ? 'LÍNEA BASE (sin caché del turno)' : 'REVISAR')
		: checks.every((c) => c.diff === 0 && (c.prompt ?? 0) <= 1) ? 'OK (diff 0 y prompt ≤ 1 en todas)' : 'NO CUMPLE';
	console.log(JSON.stringify({ scenario: name, route, opts: { cacheToolResults: !!opts.cacheToolResults }, verdict, rows, checks,
		toolResultCacheLogs: logs.filter((l) => l.includes('toolResultCache')) }));
}

async function main() {
	console.log(JSON.stringify({ probe: 'patched-class', model: MODEL, region: REGION, run: RUN }));
	const PROD: PatchOptions = { enablePromptCaching: true, cacheTtl: '5m', cacheSystemPrompt: true, cacheTools: true, cacheConversationHistory: true };
	const ON: PatchOptions = { ...PROD, cacheToolResults: true };
	const only = process.argv[2];
	const scenarios: Array<[string, () => Promise<void>]> = [
		['off-nonStreaming', () => runScenario('off-ns', 'nonStreaming', PROD)],
		['on-nonStreaming', () => runScenario('on-ns', 'nonStreaming', ON)],
		['off-streaming', () => runScenario('off-st', 'streaming', PROD)],
		['on-streaming', () => runScenario('on-st', 'streaming', ON)],
		['on-parallel-streaming', () => runScenario('on-par', 'streaming', ON, 3, 1200, 3)],
		['off-parallel-streaming', () => runScenario('off-par', 'streaming', PROD, 3, 1200, 3)],
	];
	for (const [n, fn] of scenarios) if (!only || only === n) await fn();
	if (process.env.PROBE_TRACE) console.log(JSON.stringify({ trace: TRACE }));
}

main().catch((e) => { console.error(e); process.exit(1); });
