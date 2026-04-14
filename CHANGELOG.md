# Changelog

## 0.5.5 (2026-04-14)

### Rebuilt from source with proper build system

- **Extracted original TypeScript source** from npm source maps of `n8n-nodes-bedrock-advanced@0.5.2`
- **Added `src/` directory** with all 6 TypeScript source files
- **Set up esbuild** for reproducible builds (`npm run build`)
- **Re-applied all People1 patches** (cache metrics, P1 rename, tokensUsageParser) to source

### Bug fix: empty content in AI messages crashes Bedrock API

**Problem:** When chat history contains an AI message with empty content (e.g., a tool-use-only
response whose `tool_calls` were not preserved during memory serialization), the
`convertMessagesToAnthropic` function produces `{ role: "assistant", content: [] }`. The Bedrock
InvokeModel API rejects empty content arrays with:

> "The content field in the Message object at messages.N is empty"

The standard Anthropic node (`@langchain/anthropic`) doesn't hit this because the Anthropic SDK
validates and fixes up messages before sending. Our custom node uses `InvokeModel` directly
with manually constructed JSON, bypassing that safety net.

**Fix:** In `messageConverter.ts`, after `convertAIContent()` returns, check if the content array
is empty and inject a minimal placeholder `[{ type: "text", text: " " }]` to satisfy the API.

Code path: `convertMessagesToAnthropic()` → AI message branch → empty content guard.

## 0.5.2-p1.2 (2026-04-08)

### Coexistence mode — renamed node types to avoid conflicts

Node types renamed with `P1` suffix so the fork can be installed alongside the original:

- `lmChatAwsBedrockAdvanced` -> `lmChatAwsBedrockAdvancedP1`
- `lmChatBedrockClaude` -> `lmChatBedrockClaudeP1`

Display names updated: "AWS Bedrock Chat Model (Advanced P1)" and "Bedrock Claude (P1)".

Removed `dist/index.js` (unused by N8N, prevented potential type conflicts).

## 0.5.2-p1.1 (2026-04-08)

People1 fork of `n8n-nodes-bedrock-advanced@0.5.2` by Amir Souchami.

### Bug fix: cache token metrics not propagated to N8N node output

**Problem:** Both nodes extract `cacheReadInputTokens` / `cacheWriteInputTokens` from
the Bedrock API response and log them via `enableDebugLogs`, but do NOT include them in
`llmOutput.tokenUsage`. N8N's `N8nLlmTracing` callback only reads `llmOutput.tokenUsage`
(and its default `tokensUsageParser` only extracts 3 fields), so cache metrics are
invisible in the node output.

**Fix (3 patches per node):**

1. Added `cacheReadInputTokens` and `cacheWriteInputTokens` to `llmOutput.tokenUsage`
2. Custom `tokensUsageParser` passed to `N8nLlmTracing` to preserve cache fields
3. Streaming path fix for BedrockClaude (reads from `response_metadata.usage`)

Code paths patched:
- `LmChatAwsBedrockAdvancedP1._generate()` (Converse API, non-streaming + streaming via super)
- `LmChatBedrockClaudeP1._generate()` (InvokeModel API, non-streaming)
- `LmChatBedrockClaudeP1._generateStreaming()` (InvokeModel API, streaming)

**Result:** Cache metrics now appear in the N8N execution output JSON and can be queried
via `GET /api/v1/executions/{id}` without needing container log access.
