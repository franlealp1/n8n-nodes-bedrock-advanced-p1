# Changelog

## 0.5.2-p1.1 (2026-04-08)

People1 fork of `n8n-nodes-bedrock-advanced@0.5.2` by Amir Souchami.

### Bug fix: cache token metrics not propagated to N8N node output

**Problem:** Both nodes (`LmChatAwsBedrockAdvanced` and `LmChatBedrockClaude`) extract
`cacheReadInputTokens` / `cacheWriteInputTokens` from the Bedrock API response and log them
via `enableDebugLogs`, but do NOT include them in `llmOutput.tokenUsage`. Since N8N's
`N8nLlmTracing` callback only reads `llmOutput.tokenUsage` to populate the node output,
cache metrics are invisible to the user and to downstream scripts.

**Fix:** Added `cacheReadInputTokens` and `cacheWriteInputTokens` to the `tokenUsage` object
in all code paths:

- `LmChatAwsBedrockAdvanced._generate()` (non-streaming, Converse API)
- `LmChatBedrockClaude._generate()` (non-streaming, InvokeModel API)
- `LmChatBedrockClaude._generateStreaming()` (streaming, InvokeModel API)

**Result:** Cache metrics now appear in the N8N execution output JSON and can be queried
via `GET /api/v1/executions/{id}` without needing container log access.

### Files changed

- `dist/nodes/LmChatAwsBedrockAdvanced/LmChatAwsBedrockAdvanced.node.js` (2 lines added)
- `dist/nodes/LmChatBedrockClaude/LmChatBedrockClaude.node.js` (4 lines added)
