/**
 * Build script for n8n-nodes-bedrock-advanced-p1.
 *
 * Produces one self-contained bundle per node under dist/, matching the
 * structure N8N expects:
 *   dist/index.js
 *   dist/nodes/LmChatAwsBedrockAdvanced/LmChatAwsBedrockAdvanced.node.js
 *   dist/nodes/LmChatBedrockClaude/LmChatBedrockClaude.node.js
 *
 * n8n-workflow is kept external (provided by the N8N runtime).
 * Everything else is bundled to avoid version conflicts.
 */

import * as esbuild from 'esbuild';
import { cpSync } from 'fs';

const commonOptions = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	sourcemap: true,
	// n8n-workflow is provided by the N8N host — never bundle it
	external: ['n8n-workflow'],
	logLevel: 'info',
};

async function build() {
	// 1. Bundle each node and credential independently
	await Promise.all([
		esbuild.build({
			...commonOptions,
			entryPoints: ['src/nodes/LmChatAwsBedrockAdvanced/LmChatAwsBedrockAdvanced.node.ts'],
			outfile: 'dist/nodes/LmChatAwsBedrockAdvanced/LmChatAwsBedrockAdvanced.node.js',
		}),
		esbuild.build({
			...commonOptions,
			entryPoints: ['src/nodes/LmChatBedrockClaude/LmChatBedrockClaude.node.ts'],
			outfile: 'dist/nodes/LmChatBedrockClaude/LmChatBedrockClaude.node.js',
		}),
		esbuild.build({
			...commonOptions,
			entryPoints: ['src/credentials/AwsBedrockApiKeyP1.credentials.ts'],
			outfile: 'dist/credentials/AwsBedrockApiKeyP1.credentials.js',
		}),
		esbuild.build({
			...commonOptions,
			entryPoints: ['src/nodes/LmChatBedrockClaudeStreaming/LmChatBedrockClaudeStreaming.node.ts'],
			outfile: 'dist/nodes/LmChatBedrockClaudeStreaming/LmChatBedrockClaudeStreaming.node.js',
		}),
	]);

	// 2. Build the index that re-exports both nodes
	await esbuild.build({
		...commonOptions,
		entryPoints: ['src/index.ts'],
		outfile: 'dist/index.js',
	});

	// 3. Copy static assets (SVG icons)
	try {
		cpSync(
			'src/nodes/LmChatAwsBedrockAdvanced/bedrock.svg',
			'dist/nodes/LmChatAwsBedrockAdvanced/bedrock.svg',
		);
	} catch { /* icon may not exist in src, keep existing */ }
	try {
		cpSync(
			'src/nodes/LmChatBedrockClaude/bedrock-claude.svg',
			'dist/nodes/LmChatBedrockClaude/bedrock-claude.svg',
		);
	} catch { /* icon may not exist in src, keep existing */ }
	// SVG lives under dist/ (git-tracked) rather than src/ — source from there.
	try {
		cpSync(
			'dist/nodes/LmChatBedrockClaude/bedrock-claude.svg',
			'dist/nodes/LmChatBedrockClaudeStreaming/bedrock-claude.svg',
		);
	} catch { /* icon may not exist, keep existing */ }

	console.log('Build complete.');
}

build().catch((err) => {
	console.error(err);
	process.exit(1);
});
