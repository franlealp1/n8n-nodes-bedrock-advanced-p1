# @people1/n8n-nodes-bedrock-advanced

People1 fork of [`n8n-nodes-bedrock-advanced@0.5.2`](https://www.npmjs.com/package/n8n-nodes-bedrock-advanced) by Amir Souchami.

## Why this fork?

The original node extracts Bedrock prompt cache metrics (`cacheReadInputTokens`, `cacheWriteInputTokens`) from the API response but **does not propagate them to the N8N node output**. They are only written to container debug logs, which requires admin SSH access to read.

This fork fixes that: cache metrics now appear in the standard N8N execution output and can be queried via the REST API (`GET /api/v1/executions/{id}`) by any developer.

## What changed

Three patches applied to both nodes (`LmChatAwsBedrockAdvanced` + `LmChatBedrockClaude`):

1. **Added cache fields to `llmOutput.tokenUsage`** — so cache metrics travel through LangChain's callback chain
2. **Custom `tokensUsageParser` for `N8nLlmTracing`** — so N8N's tracing callback preserves cache fields instead of stripping them
3. **Streaming path fix** (BedrockClaude only) — reads cache metrics from `response_metadata.usage` for the streaming aggregation path

### Output format (after fix)

```json
{
  "tokenUsage": {
    "completionTokens": 500,
    "promptTokens": 150,
    "totalTokens": 650,
    "cacheReadInputTokens": 120,
    "cacheWriteInputTokens": 0
  }
}
```

When cache is disabled or not applicable, `cacheReadInputTokens` and `cacheWriteInputTokens` are `0`.

## Installation

### On the N8N server (admin only)

```bash
# 1. Find the N8N main container
docker ps --format '{{.Names}}' | grep n8n

# 2. Install the fork (replace CONTAINER with actual name)
docker exec CONTAINER sh -c "cd /home/node/.n8n/nodes && npm install github:franlealp1/n8n-nodes-bedrock-advanced-p1"

# 3. Restart N8N to pick up the new node
docker restart CONTAINER
```

### Replacing the original node

If `n8n-nodes-bedrock-advanced` is already installed:

```bash
# Remove original
docker exec CONTAINER sh -c "cd /home/node/.n8n/nodes && npm uninstall n8n-nodes-bedrock-advanced"

# Install fork
docker exec CONTAINER sh -c "cd /home/node/.n8n/nodes && npm install github:franlealp1/n8n-nodes-bedrock-advanced-p1"

# Restart
docker restart CONTAINER
```

> **Note:** The fork uses the same internal node type names (`lmChatAwsBedrockAdvanced`, `lmChatBedrockClaude`), so existing workflows will work without changes.

### Persisting across Coolify deploys

Add to the N8N service's startup command or post-deploy hook in Coolify:

```bash
cd /home/node/.n8n/nodes && npm install github:franlealp1/n8n-nodes-bedrock-advanced-p1
```

## Querying cache metrics (developers)

After installation, any developer with N8N API access can query cache metrics:

```bash
# Get execution details (replace ID with execution ID)
curl -s "$N8N_BASE_URL/api/v1/executions/724002" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for node_name, node_data in data.get('data', {}).get('resultData', {}).get('runData', {}).items():
    for run in node_data:
        for output in run.get('data', {}).get('ai_languageModel', []):
            for item in output:
                tu = item.get('json', {}).get('tokenUsage', {})
                if tu.get('cacheReadInputTokens', 0) > 0 or tu.get('cacheWriteInputTokens', 0) > 0:
                    print(f'{node_name}: read={tu[\"cacheReadInputTokens\"]}, write={tu[\"cacheWriteInputTokens\"]}')
"
```

## Original features (unchanged)

All features from the original node are preserved:

- **AWS Bedrock Chat Model (Advanced)** — Converse API, multi-model, prompt caching (system/tools/history), configurable TTL
- **Bedrock Claude** — InvokeModel API, Claude-specific features (web search, computer use, bash, text editor, tool search, programmatic tool calling, 1M context, context compaction)

See the original README sections in [CHANGELOG.md](CHANGELOG.md) for full feature documentation.

## License

MIT (same as original)
