/**
 * Helper: normalises the `systemPromptBlocks` option of the Bedrock Advanced
 * (Converse) node into a `string[]` ready to be intercalated with cachePoint
 * markers by `injectCachePoints`.
 *
 * Returning an empty array signals the caller to fall back to legacy
 * single-cachepoint behaviour.
 *
 * Validation rules (matches the contract in
 * `docDevsPeople1/planesClaude/CACHING_REFACTOR_CONTRACT.md` §5.2):
 *
 * - `undefined` / `null` / `''` / whitespace-only string → `[]`, silent.
 * - `string` that is JSON: parsed; if parse fails → warn log + `[]`.
 * - After parse/casting, non-array → warn log + `[]`.
 * - Array elements that are not strings, or are empty/whitespace strings,
 *   are filtered silently (they do not count toward the max-4 limit).
 * - More than 4 non-empty blocks → first 3 preserved; 4th and onward are
 *   merged into the 4th with `"\n\n"` separator + error log.
 * - Any surviving block shorter than ~1024 tokens (heuristic: 4000 chars) →
 *   warn log per block (Bedrock ignores the cachepoint but does not fail).
 */

export interface ParseLogger {
	warn: (msg: string) => void;
	error: (msg: string) => void;
}

export const MAX_CACHEPOINTS = 4;
export const MIN_BLOCK_CHARS = 4000;

export function parseSystemPromptBlocks(
	raw: unknown,
	logger?: ParseLogger,
): string[] {
	let value: unknown = raw;

	if (value === undefined || value === null) return [];

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return [];
		try {
			value = JSON.parse(trimmed);
		} catch {
			logger?.warn(
				'[BedrockAdvanced] systemPromptBlocks: could not parse JSON string; falling back to legacy single-cachepoint behavior.',
			);
			return [];
		}
	}

	if (!Array.isArray(value)) {
		logger?.warn(
			'[BedrockAdvanced] systemPromptBlocks: expected an array of strings; falling back to legacy single-cachepoint behavior.',
		);
		return [];
	}

	const blocks: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') continue;
		if (item.trim().length === 0) continue;
		blocks.push(item);
	}

	if (blocks.length === 0) return [];

	let result = blocks;
	if (blocks.length > MAX_CACHEPOINTS) {
		const head = blocks.slice(0, MAX_CACHEPOINTS - 1);
		const tail = blocks.slice(MAX_CACHEPOINTS - 1).join('\n\n');
		result = [...head, tail];
		logger?.error(
			`[BedrockAdvanced] systemPromptBlocks: received ${blocks.length} blocks but Bedrock Converse allows max ${MAX_CACHEPOINTS} cachepoints per request; last ${blocks.length - (MAX_CACHEPOINTS - 1)} merged into block ${MAX_CACHEPOINTS} with "\\n\\n" separator.`,
		);
	}

	for (let i = 0; i < result.length; i++) {
		if (result[i].length < MIN_BLOCK_CHARS) {
			logger?.warn(
				`[BedrockAdvanced] systemPromptBlocks: block ${i + 1} is ${result[i].length} chars (< ${MIN_BLOCK_CHARS}) and may not reach Bedrock's minimum cacheable size (~1024 tokens).`,
			);
		}
	}

	return result;
}
