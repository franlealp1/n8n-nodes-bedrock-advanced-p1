#!/usr/bin/env node
/**
 * Sonda contra Bedrock (noprod) para la técnica 3 de flock#1571 / #1575.
 *
 * Responde, ANTES de implementar, a lo único que no se puede saber leyendo código:
 *   1. ¿Acepta Bedrock un `cachePoint` como bloque HERMANO tras el último `toolResult`
 *      de un mensaje `user`? (si no, ValidationException)
 *   2. Si el punto se MUEVE de una llamada a la siguiente (como hará el nodo en cada
 *      ronda, y como ya hace el del historial), ¿la llamada siguiente LEE todo el
 *      prefijo anterior y solo escribe lo nuevo?
 *   3. Con varias tools en paralelo (varios toolResult en el mismo mensaje), igual.
 *   4. Con 5 puntos, ¿rechaza? (confirma que el guard de 4 hace falta)
 *   5. Control: sin el punto nuevo, la lectura se queda plana (lo de hoy).
 *
 * Usa el SDK pelado, con el payload Converse construido a mano en la forma exacta
 * que producirá el nodo. Conversación 100 % sintética: ningún dato de clientes.
 * Las respuestas del asistente con toolUse las fabricamos nosotros (Converse lo
 * admite), así el prefijo no depende de lo que conteste el modelo.
 *
 * Credenciales: `.env` del worktree (symlink a server/.env de Flock = NOPROD), leído con
 * el dotenv del repo de Flock (FLOCK_REPO, por defecto ../chat-flock-pre-coolify): COMPANY_BEDROCK_API_KEY + COMPANY_BEDROCK_REGION. Autentica igual que la ruta
 * `apiKey` del nodo (LmChatAwsBedrockAdvanced.node.ts:533-568): IAM ficticio + Bearer en
 * finalizeRequest. No imprime ningún valor.
 * Uso: node scripts/probe-tool-result-cache.mjs [--only <escenario>]
 * Coste: ~1 $ como mucho (entradas de ~10-40k tokens, maxTokens 16).
 *
 * ⚠️ Mira `stop` en cada fila: una respuesta `content_filtered` NO deja su caché y
 * falsea la medida (texto al azar puede provocarlo; ver probe-patched-class.ts).
 */
import { createRequire } from 'node:module';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

import { resolve } from 'node:path';
const flockRequire = createRequire(resolve(process.cwd(), process.env.FLOCK_REPO ?? '../chat-flock-pre-coolify', 'package.json'));
const env = flockRequire('dotenv').config({ path: new URL('../.env', import.meta.url).pathname, processEnv: {} }).parsed ?? {};
const API_KEY = env.COMPANY_BEDROCK_API_KEY;
if (!API_KEY) throw new Error('Falta COMPANY_BEDROCK_API_KEY en .env');

const MODEL = process.env.PROBE_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const REGION = env.COMPANY_BEDROCK_REGION ?? 'eu-central-1';
const client = new BedrockRuntimeClient({
	region: REGION,
	credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
});
client.middlewareStack.add(
	(next) => async (args) => {
		args.request.headers['authorization'] = `Bearer ${API_KEY}`;
		delete args.request.headers['x-amz-security-token'];
		return next(args);
	},
	{ step: 'finalizeRequest', priority: 'low', name: 'probeBearerToken' },
);
const RUN = Date.now().toString(36); // sal por ejecución: cada corrida empieza con caché fría

// Texto sintético determinista y poco compresible (el tokenizador no lo colapsa).
function synth(seed, words) {
	const vocab = ['expediente', 'cláusula', 'arrendamiento', 'notificación', 'plazo', 'demanda', 'contrato',
		'resolución', 'prueba', 'testigo', 'recurso', 'sentencia', 'auto', 'diligencia', 'informe', 'perito',
		'factura', 'importe', 'fecha', 'parte', 'anexo', 'acta', 'escritura', 'poder', 'registro', 'finca'];
	let x = seed * 2654435761 % 4294967296;
	const out = [];
	for (let i = 0; i < words; i++) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.push(vocab[x % vocab.length] + (x % 7 === 0 ? ` ${x % 10000}` : ''));
	}
	return out.join(' ');
}

const CP = { cachePoint: { type: 'default' } };
const system = [{ text: `[sonda ${RUN}] Eres un asistente de pruebas. ` + synth(1, 1800) }, CP];
const toolConfig = {
	tools: [
		{ toolSpec: { name: 'buscar', description: 'Busca fragmentos en el expediente.',
			inputSchema: { json: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } } },
		{ toolSpec: { name: 'leer', description: 'Lee un documento del expediente.',
			inputSchema: { json: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'] } } } },
		CP,
	],
};

const userQ = (withHistoryCp) => ({
	role: 'user',
	content: withHistoryCp ? [{ text: 'Analiza el expediente y resume los plazos.' }, CP] : [{ text: 'Analiza el expediente y resume los plazos.' }],
});
const asstToolUse = (r, ids) => ({
	role: 'assistant',
	content: [{ text: `Ronda ${r}: consulto.` }, ...ids.map((id, j) => ({ toolUse: { toolUseId: id, name: j % 2 ? 'leer' : 'buscar', input: j % 2 ? { doc: `DOC_${r}` } : { q: `plazos ronda ${r}` } } }))],
});
const toolResults = (r, ids, words) => ({
	role: 'user',
	content: ids.map((id, j) => ({ toolResult: { toolUseId: id, content: [{ text: synth(100 * r + j, words) }] } })),
});
const withSiblingCp = (msg) => ({ ...msg, content: [...msg.content, CP] });

async function call(label, messages) {
	const t0 = Date.now();
	try {
		const res = await client.send(new ConverseCommand({
			modelId: MODEL, system, toolConfig, messages,
			inferenceConfig: { maxTokens: 16, temperature: 0 },
		}));
		const u = res.usage ?? {};
		const row = { label, ok: true, stop: res.stopReason, input: u.inputTokens, cacheRead: u.cacheReadInputTokens ?? 0,
			cacheWrite: u.cacheWriteInputTokens ?? 0, output: u.outputTokens, ms: Date.now() - t0 };
		console.log(JSON.stringify(row));
		return row;
	} catch (e) {
		const row = { label, ok: false, error: e.name, message: String(e.message).slice(0, 300), ms: Date.now() - t0 };
		console.log(JSON.stringify(row));
		return row;
	}
}

/**
 * Construye las llamadas de un turno de N rondas. En la llamada k, el punto nuevo va
 * SOLO tras el último toolResult (como hará el nodo); los anteriores desaparecen.
 */
function turn(rounds, { newCp, historyCp, parallel = 1, words = 2500 }) {
	const calls = [];
	const msgs = [userQ(historyCp)];
	for (let r = 1; r <= rounds; r++) {
		const ids = Array.from({ length: parallel }, (_, j) => `tu_${RUN}_${r}_${j}`);
		msgs.push(asstToolUse(r, ids));
		msgs.push(toolResults(r, ids, words));
		const payload = msgs.slice(0, -1).concat(newCp ? [withSiblingCp(msgs.at(-1))] : [msgs.at(-1)]);
		calls.push(payload);
	}
	return calls;
}

const scenarios = {
	// Lo de hoy: system + tools + historial; sin punto tras la tool. Esperado: cacheRead plano.
	off: () => turn(4, { newCp: false, historyCp: true }),
	// La técnica 3 con la config de PROD (4 puntos). Esperado: read[k+1] ≈ read[k]+write[k]+input[k].
	on: () => turn(4, { newCp: true, historyCp: true }),
	// Sin ancla de historial (3 puntos): ¿cambia la escritura? (decisión «mantener el ancla»).
	onNoHistory: () => turn(4, { newCp: true, historyCp: false }),
	// Tools en paralelo: 3 toolResult en el mismo mensaje y un solo punto al final.
	parallel: () => turn(3, { newCp: true, historyCp: true, parallel: 3, words: 1200 }),
	// >20 bloques por ronda (11 tools ⇒ 22 bloques): ¿alcanza la búsqueda hacia atrás la escritura anterior?
	lookback20: () => turn(3, { newCp: true, historyCp: true, parallel: 11, words: 300 }),
	// Control del anterior: 9 tools ⇒ 18 bloques, dentro del margen.
	lookback18: () => turn(3, { newCp: true, historyCp: true, parallel: 9, words: 300 }),
};

async function fiveCachePoints() {
	// 5 puntos: system, tools, historial, uno extra en el texto del asistente y el nuevo.
	const [first] = turn(1, { newCp: true, historyCp: true });
	first[1] = { ...first[1], content: [first[1].content[0], CP, ...first[1].content.slice(1)] };
	return call('five-cachepoints (debe fallar)', first);
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
console.log(JSON.stringify({ probe: 'tool-result-cache', model: MODEL, region: REGION, run: RUN }));
for (const [name, build] of Object.entries(scenarios)) {
	if (only && only !== name) continue;
	console.log(JSON.stringify({ scenario: name }));
	const calls = build();
	for (let k = 0; k < calls.length; k++) await call(`${name}#${k + 1}`, calls[k]);
}
if (!only || only === 'five') await fiveCachePoints();
