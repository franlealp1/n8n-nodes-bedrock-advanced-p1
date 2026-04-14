/**
 * Converts langchain tool definitions to Anthropic tool format.
 *
 * Supports:
 * - OpenAI-style tools (ToolDefinition with function.name/description/parameters)
 * - LangChain StructuredTool (name/description/schema)
 * - Raw Anthropic tools (passed through as-is)
 *
 * Also handles built-in Claude tools (web_search, computer_use, bash, text_editor)
 * which use a `type` field instead of `input_schema`.
 */

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: Record<string, any>;
	cache_control?: { type: 'ephemeral' };
}

export interface AnthropicBuiltInTool {
	type: string;
	name: string;
	[key: string]: any;
}

export type AnthropicToolEntry = AnthropicTool | AnthropicBuiltInTool;

function isOpenAITool(tool: any): boolean {
	return tool?.type === 'function' && tool?.function?.name;
}

function isLangChainTool(tool: any): boolean {
	return typeof tool?.name === 'string' && typeof tool?.description === 'string' && tool?.schema;
}

function isAnthropicTool(tool: any): boolean {
	return typeof tool?.name === 'string' && tool?.input_schema;
}

function isBuiltInTool(tool: any): boolean {
	return typeof tool?.type === 'string' && tool.type !== 'function';
}

/**
 * Check if a value is a raw Zod schema (not yet converted to JSON schema).
 */
function isZodSchema(schema: any): boolean {
	if (!schema || typeof schema !== 'object') return false;
	return '_def' in schema || '~standard' in schema || schema?._def?.typeName?.startsWith('Zod');
}

/**
 * Try to convert a Zod schema to JSON schema, or return a fallback.
 */
function convertZodSchema(schema: any): Record<string, any> {
	// Try using the parse function to detect Zod, then convert
	if (typeof schema?.parse === 'function' || typeof schema?.safeParse === 'function') {
		try {
			const { zodToJsonSchema } = require('zod-to-json-schema');
			return zodToJsonSchema(schema);
		} catch {
			// fall through
		}
	}

	// If it's a ZodEffects wrapping a ZodObject, try the inner schema
	if (schema?._def?.schema) {
		return convertZodSchema(schema._def.schema);
	}

	// Fallback: extract what we can from ZodObject shape
	if (schema?._def?.typeName === 'ZodObject' && schema?.shape) {
		try {
			const { zodToJsonSchema } = require('zod-to-json-schema');
			return zodToJsonSchema(schema);
		} catch {
			// fall through
		}
	}

	return { type: 'object', properties: {} };
}

/**
 * Ensure input_schema is a valid JSON schema with type: "object" as required by the Anthropic API.
 */
function ensureValidSchema(schema: any): Record<string, any> {
	if (!schema || typeof schema !== 'object') {
		return { type: 'object', properties: {} };
	}

	// Detect and convert raw Zod schemas
	if (isZodSchema(schema)) {
		return convertZodSchema(schema);
	}

	if (!schema.type) {
		return { ...schema, type: 'object' };
	}

	return schema;
}

/**
 * Convert a single langchain tool to Anthropic format.
 */
function convertSingleTool(tool: any): AnthropicToolEntry {
	if (isBuiltInTool(tool) && !isOpenAITool(tool)) {
		return tool;
	}

	if (isAnthropicTool(tool)) {
		return { ...tool, input_schema: ensureValidSchema(tool.input_schema) };
	}

	if (isOpenAITool(tool)) {
		return {
			name: tool.function.name,
			description: tool.function.description,
			input_schema: ensureValidSchema(tool.function.parameters),
		};
	}

	if (isLangChainTool(tool)) {
		let schema = tool.schema;
		// If it's a Zod schema, try to convert to JSON schema
		if (typeof schema?.parse === 'function' && typeof schema?.shape !== 'undefined') {
			try {
				const { zodToJsonSchema } = require('zod-to-json-schema');
				schema = zodToJsonSchema(schema);
			} catch {
				schema = { type: 'object', properties: {} };
			}
		}
		return {
			name: tool.name,
			description: tool.description,
			input_schema: ensureValidSchema(schema),
		};
	}

	// Fallback: assume it has name and try to use it
	if (typeof tool?.name === 'string') {
		return {
			name: tool.name,
			description: tool.description || '',
			input_schema: ensureValidSchema(tool.input_schema || tool.parameters),
		};
	}

	throw new Error(`Unsupported tool format: ${JSON.stringify(tool)}`);
}

/**
 * Convert an array of langchain tools to Anthropic format.
 * Optionally adds cache_control to the last tool for prompt caching.
 * cacheTtl is passed through when provided ('1h' sets an explicit TTL;
 * omitting it defaults to 5m on Anthropic's side).
 */
export function convertTools(
	tools: any[],
	cacheTools: boolean,
	cacheTtl?: string,
): AnthropicToolEntry[] {
	if (!tools?.length) return [];

	const converted = tools.map(convertSingleTool);

	if (cacheTools && converted.length > 0) {
		const lastTool = converted[converted.length - 1];
		if ('input_schema' in lastTool) {
			const cacheControl: { type: 'ephemeral'; ttl?: string } = { type: 'ephemeral' };
			if (cacheTtl === '1h') cacheControl.ttl = '1h';
			lastTool.cache_control = cacheControl;
		}
	}

	return converted;
}

/**
 * Create built-in Claude tool definitions.
 */
export function createWebSearchTool(): AnthropicBuiltInTool {
	return {
		type: 'web_search_20250305',
		name: 'web_search',
	};
}

export function createComputerUseTool(
	displayWidth: number,
	displayHeight: number,
): AnthropicBuiltInTool {
	return {
		type: 'computer_20250124',
		name: 'computer',
		display_width_px: displayWidth,
		display_height_px: displayHeight,
	};
}

export function createBashTool(): AnthropicBuiltInTool {
	return {
		type: 'bash_20250124',
		name: 'bash',
	};
}

export function createTextEditorTool(): AnthropicBuiltInTool {
	return {
		type: 'text_editor_20250124',
		name: 'text_editor',
	};
}

export function createToolSearchTool(variant: 'regex' | 'bm25' = 'regex'): AnthropicBuiltInTool {
	if (variant === 'bm25') {
		return {
			type: 'tool_search_tool_bm25_20251119',
			name: 'tool_search_tool_bm25',
		};
	}
	return {
		type: 'tool_search_tool_regex_20251119',
		name: 'tool_search_tool_regex',
	};
}

/**
 * Mark tools with defer_loading: true for tool search.
 * When tool search is enabled, agent tools should be deferred
 * so Claude only loads them on-demand via search.
 */
export function markToolsAsDeferred(tools: AnthropicToolEntry[]): AnthropicToolEntry[] {
	return tools.map(tool => {
		if ('input_schema' in tool) {
			return { ...tool, defer_loading: true };
		}
		return tool;
	});
}
