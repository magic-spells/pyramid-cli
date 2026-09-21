// FILE-PROMPTS — MCP prompt skin.
//
// One prompt, `doctor`: a self-check. It expands to an instruction telling the
// model to call the `whoami` tool and report the authenticated user, their
// workspace, and the accessible projects — confirming the key + connection are
// wired correctly. No arguments; no Pyramid calls happen here (the model drives
// the tool call when it runs the prompt).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OpContext } from '../operations/index.js';

const DOCTOR_DESCRIPTION =
	'Check your Pyramid setup: confirm the API key authenticates and show the user, workspace, and accessible projects.';

const DOCTOR_INSTRUCTION = [
	'Run a Pyramid setup check.',
	'',
	'Call the `whoami` tool, then report back, in plain language:',
	'  • the authenticated user (display name and email),',
	'  • the workspace (name) you are connected to, and',
	'  • the accessible projects (names).',
	'',
	'Finish by confirming the setup looks good. If `whoami` returns an error,',
	'act on its `code`: for an `auth_*` code, tell the user to regenerate their',
	'key in Pyramid → Settings → API Keys. Never print raw JSON or an HTTP status.',
].join('\n');

/**
 * Register the `doctor` prompt on the server. `ctx` is accepted for parity with
 * the other skins (and future prompts that pre-fetch context); the doctor prompt
 * itself is static — it instructs the model to invoke the `whoami` tool.
 */
export function registerPrompts(server: McpServer, _ctx: OpContext): void {
	server.registerPrompt('doctor', { description: DOCTOR_DESCRIPTION }, () => ({
		messages: [
			{
				role: 'user' as const,
				content: { type: 'text' as const, text: DOCTOR_INSTRUCTION },
			},
		],
	}));
}
