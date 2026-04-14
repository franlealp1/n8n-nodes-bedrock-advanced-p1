/**
 * Converts between langchain BaseMessage[] and Anthropic Messages API format.
 *
 * Langchain → Anthropic (request):
 *   SystemMessage  → system[] with cache_control
 *   HumanMessage   → { role: "user", content }
 *   AIMessage      → { role: "assistant", content } with tool_use blocks
 *   ToolMessage    → { role: "user", content: [{ type: "tool_result" }] }
 *
 * Anthropic → Langchain (response):
 *   text blocks    → AIMessage.content
 *   tool_use       → AIMessage.tool_calls[]
 *   server_tool_use → AIMessage.tool_calls[] (built-in tools)
 *   usage          → AIMessage.response_metadata / usage_metadata
 */

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';

// ── Anthropic request types ──

export interface AnthropicSystemBlock {
	type: 'text';
	text: string;
	cache_control?: { type: 'ephemeral'; ttl?: string };
}

export interface AnthropicTextBlock {
	type: 'text';
	text: string;
}

export interface AnthropicImageBlock {
	type: 'image';
	source: {
		type: 'base64';
		media_type: string;
		data: string;
	};
}

export interface AnthropicToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, any>;
}

export interface AnthropicToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string | AnthropicContentBlock[];
	is_error?: boolean;
}

export interface AnthropicServerToolUseBlock {
	type: 'server_tool_use';
	id: string;
	name: string;
	input: Record<string, any>;
}

export interface AnthropicServerToolResultBlock {
	type: 'web_search_tool_result';
	tool_use_id: string;
	content: any[];
}

export interface AnthropicCompactionBlock {
	type: 'compaction';
	content: string;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicServerToolUseBlock
	| AnthropicServerToolResultBlock
	| AnthropicCompactionBlock;

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
}

export interface AnthropicResponse {
	id: string;
	type: 'message';
	role: 'assistant';
	content: AnthropicContentBlock[];
	model: string;
	stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
	stop_sequence?: string;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

// ── Conversion: langchain → Anthropic ──

export function extractSystemMessages(
	messages: BaseMessage[],
	enableCaching: boolean,
	cacheTtl?: string,
): AnthropicSystemBlock[] {
	const systemBlocks: AnthropicSystemBlock[] = [];
	const cacheControl: { type: 'ephemeral'; ttl?: string } = { type: 'ephemeral' };
	if (cacheTtl === '1h') {
		cacheControl.ttl = '1h';
	}

	for (const msg of messages) {
		if (msg.getType() !== 'system') continue;

		if (typeof msg.content === 'string') {
			systemBlocks.push({
				type: 'text',
				text: msg.content,
				...(enableCaching ? { cache_control: cacheControl } : {}),
			});
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (typeof block === 'string') {
					systemBlocks.push({ type: 'text', text: block });
				} else if (block.type === 'text' && typeof block.text === 'string') {
					systemBlocks.push({ type: 'text', text: block.text });
				}
			}
			// Add cache_control to the last block
			if (enableCaching && systemBlocks.length > 0) {
				systemBlocks[systemBlocks.length - 1].cache_control = cacheControl;
			}
		}
	}

	return systemBlocks;
}

// When cacheHistoryIndex is set, the message at that LangChain index gets
// cache_control injected on its last Anthropic content block.
export function convertMessagesToAnthropic(
	messages: BaseMessage[],
	cacheHistoryIndex = -1,
	cacheControl?: { type: 'ephemeral'; ttl?: string },
): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const type = msg.getType();
		if (type === 'system') continue; // handled separately

		const isTarget = cacheHistoryIndex === i && cacheControl !== undefined;

		if (type === 'human' || type === 'generic') {
			const content = convertHumanContent(msg.content);
			const anthropicMsg: AnthropicMessage = { role: 'user', content };
			if (isTarget) addCacheControlToLastBlock(anthropicMsg, cacheControl!);
			result.push(anthropicMsg);
		} else if (type === 'ai') {
			const content = convertAIContent(msg);
			// FIX: Bedrock rejects messages with empty content arrays.
			// This can happen with AI messages from chat history that had no text
			// and whose tool_calls were not preserved during serialization.
			if (content.length === 0) {
				content.push({ type: 'text', text: '.' });
			}
			const anthropicMsg: AnthropicMessage = { role: 'assistant', content };
			if (isTarget) addCacheControlToLastBlock(anthropicMsg, cacheControl!);
			result.push(anthropicMsg);
		} else if (type === 'tool') {
			const toolResult: AnthropicToolResultBlock = {
				type: 'tool_result',
				tool_use_id: (msg as any).tool_call_id,
				content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
				...((msg as any).status === 'error' ? { is_error: true } : {}),
			};

			// Merge consecutive tool results into the same user message
			const lastMsg = result[result.length - 1];
			if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) &&
				lastMsg.content.some((b: any) => b.type === 'tool_result')) {
				lastMsg.content.push(toolResult);
			} else {
				result.push({ role: 'user', content: [toolResult] });
			}
		}
	}

	return result;
}

// Adds cache_control to the last content block of an Anthropic message.
// Works for text, tool_use, and tool_result blocks — all valid cache targets
// in the Anthropic Messages API.
function addCacheControlToLastBlock(
	msg: AnthropicMessage,
	cacheControl: { type: 'ephemeral'; ttl?: string },
): void {
	if (typeof msg.content === 'string') {
		// String content can't carry cache_control — wrap in a text block
		msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControl } as any];
		return;
	}
	if (Array.isArray(msg.content) && msg.content.length > 0) {
		(msg.content[msg.content.length - 1] as any).cache_control = cacheControl;
	}
}

function convertHumanContent(content: any): string | AnthropicContentBlock[] {
	if (typeof content === 'string') return content;

	if (Array.isArray(content)) {
		const blocks: AnthropicContentBlock[] = [];
		for (const block of content) {
			if (typeof block === 'string') {
				blocks.push({ type: 'text', text: block });
			} else if (block.type === 'text') {
				blocks.push({ type: 'text', text: block.text });
			} else if (block.type === 'image_url') {
				const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
				if (url?.startsWith('data:')) {
					const match = url.match(/^data:(.*?);base64,(.*)$/);
					if (match) {
						blocks.push({
							type: 'image',
							source: { type: 'base64', media_type: match[1], data: match[2] },
						});
					}
				}
			}
		}
		return blocks;
	}

	return String(content);
}

function convertAIContent(msg: BaseMessage): AnthropicContentBlock[] {
	const blocks: AnthropicContentBlock[] = [];

	// Text content
	if (typeof msg.content === 'string' && msg.content !== '') {
		blocks.push({ type: 'text', text: msg.content });
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (typeof block === 'string') {
				blocks.push({ type: 'text', text: block });
			} else if (block.type === 'text' && typeof block.text === 'string') {
				blocks.push({ type: 'text', text: block.text });
			}
		}
	}

	// Tool calls
	const toolCalls = (msg as AIMessage).tool_calls;
	if (toolCalls?.length) {
		for (const tc of toolCalls) {
			blocks.push({
				type: 'tool_use',
				id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
				name: tc.name,
				input: tc.args,
			});
		}
	}

	return blocks;
}

// ── Conversion: Anthropic → langchain ──

export function convertResponseToLangchain(response: AnthropicResponse): AIMessage {
	const textParts: string[] = [];
	const toolCalls: { id: string; name: string; args: Record<string, any>; type: 'tool_call' }[] = [];

	for (const block of response.content) {
		if (block.type === 'compaction') {
			// Compaction block — include the summary as text
			textParts.push(block.content || '');
		} else if (block.type === 'text') {
			textParts.push(block.text);
		} else if (block.type === 'tool_use') {
			toolCalls.push({
				id: block.id,
				name: block.name,
				args: block.input,
				type: 'tool_call',
			});
		}
		// server_tool_use and web_search_tool_result are server-side operations
		// already executed by Anthropic — skip them to avoid the agent framework
		// trying to execute them locally, which causes infinite loops.
	}

	const content = textParts.join('');

	return new AIMessage({
		content,
		tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
		response_metadata: {
			stop_reason: response.stop_reason,
			usage: response.usage,
			model: response.model,
			id: response.id,
		},
		usage_metadata: {
			input_tokens: response.usage.input_tokens,
			output_tokens: response.usage.output_tokens,
			total_tokens: response.usage.input_tokens + response.usage.output_tokens,
			input_token_details: {
				cache_read: response.usage.cache_read_input_tokens || 0,
				cache_creation: response.usage.cache_creation_input_tokens || 0,
			},
		},
	});
}
