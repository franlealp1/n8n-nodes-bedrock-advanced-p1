# Changelog

## 0.10.0-alpha.1 (2026-04-26)

### Feat: Side-channel semantic events (`tool-call-start`, `agent-finish`)

The `_streamResponseChunks` override of `ChatAwsBedrockAdvancedStreaming` now
inspects three signal types in addition to text deltas:

- **tool_call_chunks** (Bedrock `contentBlockStart`+`contentBlockDelta` with
  `toolUse`): name/id from the start chunk and JSON-fragment args from the
  delta chunks are accumulated by `index` and emitted as a single
  `tool-call-start` POST when the stream closes with `stopReason: 'tool_use'`.
  Body: `{streamId, seq, type:'tool-call-start', tools:[{name,args,id}], ...}`.
- **messageStop with stopReason ∈ {end_turn, max_tokens, stop_sequence}**:
  emits an `agent-finish` POST with the aggregated text of the stream + the
  finish reason. Body: `{streamId, seq, type:'agent-finish', text, finishReason, ...}`.
- Existing **text deltas**: unchanged. Now sent with explicit `type:'delta'`
  discriminator and routed to a different path (see below).

Body schema gains a `type` discriminator (`'delta' | 'tool-call-start' |
'agent-finish' | 'error'`). Backend backwards-compat: a body without `type`
is interpreted as `delta` (the v0.9.0 shape).

### Feat: Callback URL is now a base URL (path routing)

Previously the Callback URL was the full path of every POST. Now the node
treats it as a **base** and internally appends:
- `${url}/stream-token` for `delta` events (high frequency, non-persistent).
- `${url}/agent-event` for `tool-call-start` / `agent-finish` / `error`
  events (low frequency, persistent).

Trailing slash on the URL is trimmed. Auth header (`x-webhook-auth`) is
identical for both endpoints.

### Feat: Two new optional descriptor params

The "Streaming" collection on the `lmChatAwsBedrockAdvancedP1` node gains:
- **Stream Agent Name** (`agentName`): label included in every event body.
- **Stream Agent Color** (`agentColor`): color token included in every body.

Existing **Session ID** field renamed in UI to **Stream Session Id**
(generic semantics — workflow decides if value is `chatId`, `turnId`, etc.).
Internal field name `sessionId` preserved for workflow JSON compatibility.

### Byte-identity preserved (AC1)

With Callback URL empty, the async generator output is bit-identical to
`PatchedChatBedrockConverse._streamResponseChunks`. Zero allocations, zero
timers, zero network calls. Verified by `ChatAwsBedrockAdvancedStreaming.test.ts`
Case 1 + Case 2 with the extended rich `fakeSuperStream` (text deltas +
tool_call_chunks + messageStop).

### Migration

- Workflows with **Callback URL empty** (the current state of all noprod
  deployments): zero migration. Behavior identical.
- Workflows with **Callback URL set** to a path that points to an endpoint
  expecting v0.9.0 shape: must update the URL to the base prefix (drop the
  path component); backend (separate release) will expose `/stream-token`
  and `/agent-event` separately.

---

## 0.9.0-alpha.1 (2026-04-24)

### Refactor: extract PatchedChatBedrockConverse to own file

The inline ChatBedrockConverse subclass that lived inside
LmChatAwsBedrockAdvanced.node.ts supplyData() (158 lines) is now in its own
file `src/nodes/LmChatAwsBedrockAdvanced/PatchedChatBedrockConverse.ts` with
an explicit `patchOptions` + `patchLogger` constructor contract. The Advanced
node keeps its public behavior byte-identical (15 byte-identity tests cover
all 6 overrides: invocationParams, sanitizeMessages, _generateNonStreaming,
_generate, _streamResponseChunks, formatCacheMetrics).

### Feat: streaming-as-toggle on the Advanced node

The existing `lmChatAwsBedrockAdvancedP1` node gains a new **"Streaming"**
collection with 5 fields: Callback URL, Session ID, Auth Header Value,
Batch Interval (Ms), Max Batch Chars.

- **Callback URL empty (default)**: non-streaming Converse API, behavior
  byte-identical to pre-0.9.0. Zero migration required for existing
  workflows.
- **Callback URL set**: node transparently uses a subclass
  (`ChatAwsBedrockAdvancedStreaming`) that forces `streaming=true` and
  overrides `_streamResponseChunks` with the streamCallback helper —
  fire-and-forget POSTs `{streamId, seq, delta, done}` to the URL during
  generation, batched by timer + char threshold. Output of the LLM to
  the agent is unchanged; streaming is a side-channel.

Auth router (apiKey + IAM), model pickers, cache stack (systemPromptBlocks,
cacheSystemPrompt, cacheTools, cacheConversationHistory, cacheTtl),
tokensUsageParser and `N8nLlmTracing` are all shared between both paths —
no duplication.

### Feat: metadata parity between streaming and non-streaming paths

`_streamResponseChunks` now enriches chunks carrying usage with the same
metadata shape that `_generate` sets on non-streaming (response_metadata.usage
normalized, tokenUsage with cache fields, model_name, additional_kwargs.model,
usage_metadata.input_token_details). `tokensUsageParser` in `supplyData`
adds a fallback to `generations[0][0].message.response_metadata.tokenUsage`
for cache fields — LangChain's streaming aggregation drops them from
`llmOutput.tokenUsage` structurally (chat_models.cjs L227-237).

Net effect: cache hit/miss telemetry is visible in both modes.

### Fix: remove LmChatBedrockClaudeStreaming wrong-parent (PRP-1 correction)

PRP-1 (merged in 0.8.0-alpha.1) built the streaming node on ChatBedrockClaude,
which does not support authType=apiKey nor granular caching — it was inert
for every production workflow. The wrong-parent folder and its artifacts
are removed. Replaced by the streaming-as-toggle design above.

---

## 0.7.4 (2026-04-22)

### Fix: model dropdown for Bedrock API key auth (loadOptionsMethod)

N8N's `loadOptions.routing` mechanism does not inject Bearer token headers
from the credential's `authenticate` property, causing "Error fetching options"
for `awsBedrockApiKeyP1`. Replaced declarative routing with programmatic
`loadOptionsMethod` (`getModelsForApiKey` and `getInferenceProfilesForApiKey`)
that make explicit HTTP requests with `Authorization: Bearer <apiKey>`.

Both On-Demand and Inference Profile dropdowns now work for API key auth.
`modelSource` selector is shown for both auth types.

---

## 0.7.0 (2026-04-22)

### Feature: Bedrock API Key authentication (`awsBedrockApiKeyP1`)

Adds a second authentication method alongside the existing AWS IAM credentials.
Nodes can now authenticate with a Bedrock API key (Bearer token) in addition to
AWS IAM (SigV4). Existing nodes default to `authType: iam` and are fully backward
compatible — no workflow changes required.

**New credential type**: `AWS Bedrock API Key (P1)` — Bedrock API key + region.
Includes a built-in connection test via `GET /foundation-models` with Bearer auth.

**Technical approach**: The `BedrockRuntimeClient` is initialized with dummy IAM
credentials (required by the SDK) and a `finalizeRequest` low-priority middleware
replaces the `Authorization` header with `Bearer <apiKey>` after SigV4 signing.

**New node parameter**: `Authentication` (options: `AWS IAM (existing)` / `Bedrock API Key`).
Default is `iam` so all pre-existing nodes continue without any visible change.

---

## 0.6.1 (2026-04-20)

### Fix: systemPromptBlocks silently dropped when Agent v2 has empty systemMessage

In 0.6.0, `injectCachePoints` only REPLACED the content of an existing
system message with the configured blocks. When the caller follows the
caching contract (§3/§10) and leaves the LangChain Agent v2 `systemMessage`
empty, Agent v2 does not emit a system message at all — so the messages
array arrived at the Bedrock node with only the user turn. The replacement
branch never matched, `systemPromptBlocks` were silently dropped, and the
request reached Bedrock with no system prompt.

Verified with smoke test execution 730218 on noprod: the model responded
"I'm Claude, an AI assistant made by Anthropic. I don't recognize that
session token or PING command." instead of honouring the configured
protocol. `usage.inputTokens` was 25 instead of the expected ~2500 for the
two blocks.

The fix prepends a synthetic `SystemMessage({ content: '' })` before the
map iteration runs when `systemPromptBlocks` is set and no system message
already exists in the input. The existing multi-cachepoint branch then
fills the content with the blocks + cache points. Guardrails:
- Prepend only when `systemBlocks.length > 0`.
- Prepend only when `cacheSystemPrompt` is not explicitly `false`.
- Prepend only when no system message already exists.
- `historyTargetIndex` is recomputed after the prepend so indices stay
  coherent.

35 tests pass (16 helper + 19 inject).

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
