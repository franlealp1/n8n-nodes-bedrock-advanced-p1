/**
 * Pure function that takes the Bedrock Converse message list and intercalates
 * `cachePoint` markers according to the node's caching options.
 *
 * Extracted from `PatchedChatBedrockConverse` so it can be unit-tested without
 * having to instantiate the LangChain wrapper or the N8N supply context.
 *
 * Contract reference: `docDevsPeople1/planesClaude/CACHING_REFACTOR_CONTRACT.md`
 * §2 (mechanics) and §5 (multi-cachepoint).
 */

import {
	parseSystemPromptBlocks,
	type ParseLogger,
} from './parseSystemPromptBlocks';

export interface InjectCachePointsOptions {
	cacheSystemPrompt?: boolean;
	cacheConversationHistory?: boolean;
	systemPromptBlocks?: string | string[];
	enableDebugLogs?: boolean;
}

export interface InjectCachePointsLogger extends ParseLogger {
	info: (msg: string) => void;
}

/**
 * Finds the index of the last "useful" history message whose end should carry
 * the conversation-history cachepoint. Skips the current user message
 * (length-1), tool results, AI tool-use-only messages, and AI messages with no
 * substantial content.
 *
 * Returns -1 when no suitable target exists.
 */
export function findHistoryCacheTarget(messages: any[]): number {
	for (let i = messages.length - 2; i >= 0; i--) {
		const msg = messages[i];
		const msgType = msg._getType?.() ?? msg.getType?.();
		if (msgType === 'system') break;
		if (msgType === 'tool') continue;
		if (msgType === 'ai' && msg.tool_calls?.length > 0) continue;
		if (msgType === 'ai') {
			const content = msg.content;
			const hasSubstantialContent =
				(typeof content === 'string' && content.trim().length > 0) ||
				(Array.isArray(content) && content.length > 0);
			if (!hasSubstantialContent) continue;
		}
		return i;
	}
	return -1;
}

export function injectCachePoints(
	messages: any[],
	options: InjectCachePointsOptions,
	logger: InjectCachePointsLogger,
): any[] {
	const cachePointBlock = { cachePoint: { type: 'default' } };
	const shouldCacheSystem = options.cacheSystemPrompt !== false;
	const historyTargetIndex = options.cacheConversationHistory
		? findHistoryCacheTarget(messages)
		: -1;

	const systemBlocks = shouldCacheSystem
		? parseSystemPromptBlocks(options.systemPromptBlocks, logger)
		: [];
	let systemBlocksApplied = false;

	return messages.map((msg, index) => {
		const msgType = msg._getType?.() ?? msg.getType?.();

		const isSystemToCache = msgType === 'system' && shouldCacheSystem;
		const isHistoryTarget = index === historyTargetIndex;

		// Multi-cachepoint path: REPLACES content of the first system message.
		if (isSystemToCache && systemBlocks.length > 0 && !systemBlocksApplied) {
			systemBlocksApplied = true;
			const originalIsEmpty =
				!msg.content ||
				(typeof msg.content === 'string' && msg.content.trim().length === 0) ||
				(Array.isArray(msg.content) && msg.content.length === 0);
			if (!originalIsEmpty) {
				logger.warn(
					'[BedrockAdvanced] systemPromptBlocks is set; replacing the existing system message content.',
				);
			}
			const newContent: any[] = [];
			for (const block of systemBlocks) {
				newContent.push({ type: 'text', text: block });
				newContent.push({ cachePoint: { type: 'default' } });
			}
			if (options.enableDebugLogs) {
				logger.info(
					`[BedrockAdvanced] systemPromptBlocks: ${systemBlocks.length} blocks, ${systemBlocks.length} cachepoints.`,
				);
			}
			const newMsg = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg);
			newMsg.content = newContent;
			return newMsg;
		}

		// Legacy path: single cachepoint at the end of content.
		const shouldInject = isSystemToCache || isHistoryTarget;
		if (!shouldInject) return msg;

		const hasContent =
			(typeof msg.content === 'string' && msg.content.trim().length > 0) ||
			(Array.isArray(msg.content) && msg.content.length > 0);
		if (!hasContent) return msg;

		const newMsg = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg);
		if (typeof msg.content === 'string') {
			newMsg.content = [{ type: 'text', text: msg.content }, cachePointBlock];
		} else if (Array.isArray(msg.content)) {
			const hasCachePoint = msg.content.some((block: any) => block.cachePoint);
			if (!hasCachePoint) {
				newMsg.content = [...msg.content, cachePointBlock];
			}
		}
		return newMsg;
	});
}
