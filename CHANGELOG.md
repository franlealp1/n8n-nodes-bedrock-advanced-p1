# Changelog

## 0.6.0 (2026-04-20)

### Feature: multi-cachepoint system prompt

Adds a new option `systemPromptBlocks` to the **AWS Bedrock Chat Model
(Advanced P1)** node. When set to a non-empty array of strings (or a
JSON string that parses to one), the node REPLACES the AI Agent system
message content with `[{text:b1},{cachePoint},{text:b2},{cachePoint},...]`,
unlocking up to 4 cachepoints per request (the Bedrock Converse hard
limit).

**Why:** the single-cachepoint approach is limited by the most volatile
byte in the system message — one mutation invalidates the full prefix.
Measured techo in Miguel's Onboarding A/B: ~56% hit rate. Multi-
cachepoint lifts that by localising invalidations to one block and
letting infrequently-changing content (rules, identity, static
instructions) stay cached across requests that only mutate the
per-session block (user context, role data, state).

**Semantics:**

- Each block should be ≥ ~1024 tokens (~4000 chars) to reach Bedrock's
  minimum cacheable size; shorter blocks produce a warn log but do not
  fail.
- Max 4 cachepoints per request; if more blocks are provided, the first
  3 are preserved and the rest are merged into the 4th with `\n\n` +
  error log.
- Ignored if `cacheSystemPrompt: false` or `enablePromptCaching: false`.
- Legacy single-cachepoint behaviour is preserved when the option is
  unset / empty.

Contract reference: `docDevsPeople1/planesClaude/CACHING_REFACTOR_CONTRACT.md` §5.

### Also shipped in this release

- **Plan #41 fix**: `additional_kwargs.model` is now set on AI messages
  so the Metrics Analyzer workflow can detect the model name from
  `intermediateSteps`. Already in `src/` since commit `6cbd832`, now in
  the npm bundle.
- **Dev setup**: `vitest` added as devDep; 31 unit tests cover
  `parseSystemPromptBlocks` (16) and `injectCachePoints` (15).
- **Refactor**: `injectCachePoints` and `findHistoryCacheTarget`
  extracted from `PatchedChatBedrockConverse` into a pure module
  (`src/nodes/LmChatAwsBedrockAdvanced/injectCachePoints.ts`). No
  behaviour change.

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
