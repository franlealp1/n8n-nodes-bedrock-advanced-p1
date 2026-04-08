# Changelog

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
