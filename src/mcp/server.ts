// FILE-SERVER — the MCP skin over the shared operation registry (FILE-OPERATIONS).
//
// `createMcpServer(ctx)` builds a high-level `McpServer` (the installed
// @modelcontextprotocol/sdk API), walks the single `operations[]` registry from
// src/operations, and registers each operation as a tool. The same registry is
// the only source of Pyramid behavior — this file holds NO business logic; it
// only adapts operations -> MCP tools and wires the prompts + resources skins.
//
// Tool contract (per op):
//   - name        = the operation's MCP tool name (snake_case)
//   - description = op.summary
//   - inputSchema = op.input.shape (the zod raw shape the SDK turns into JSON Schema)
//   - handler     = parse args with op.input, op.run(input, ctx), and return the
//                   result as pretty-printed JSON text. A thrown value is coerced
//                   via toMcpError and returned as an `isError` text result whose
//                   body is `{ error: { code, message, hint?, candidates? } }`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { getVersion } from '../version.js';
import { toMcpError } from '../errors.js';
import { operations } from '../operations/index.js';
import type { Operation, OpContext } from '../operations/index.js';

/**
 * The system instructions advertised to the client on initialize. Embedded
 * verbatim from DOC-RENDERING; this is the model-facing contract for how to
 * drive Pyramid and render its output. Do not paraphrase.
 */
const INSTRUCTIONS = `Pyramid MCP v${getVersion()} — drive the Pyramid project tracker. Rules: (1) You act as one user in ONE workspace (the key is workspace-pinned). (2) Inputs accept names/keys, not UUIDs; outputs are already hydrated to names. (3) RENDER tasks as a left-rail card, one field per line, no JSON: \`│ <KEY>\` / \`│ NAME: <title>\` / \`│ DESCRIPTION: <one line; truncate in lists>\` / \`│ <Stage>: <Status>\` — always show stage and status together as \`Stage: Status\`. (4) For a LIST ("get my work"), render one card per task SEPARATED BY A BLANK LINE so each reads as a distinct ticket — never let cards run together — with one-line descriptions; show the page, then say "showing N of M — ask for more"; NEVER auto-paginate. Full description + drill-in only for a single task. (5) Drill-in (comments, git PRs/commits) only when asked, for the named task. (6) Dates are UTC — render UTC-labeled or relative-with-label, never bare local. (7) On error, act on the \`code\` (don't parse the message): \`ambiguous_*\` → show candidates and ask; \`auth_*\` → tell the user to regenerate their key in Pyramid → Settings → API Keys. Never print raw JSON or an HTTP status to the user.`;

/**
 * The MCP tool name for an operation. Every op now names itself in verb_noun
 * snake_case (e.g. `create_task`, `move_task`), so the tool name IS `op.name`. A
 * `meta.mcpTool` override still wins if ever set; the defensive dot->underscore
 * pass is a no-op for the current registry but keeps any legacy dot-form name
 * safe. The result always equals the op's intended snake_case tool name.
 */
function toolNameFor(op: Operation): string {
	const meta = (op as { meta?: { mcpTool?: string } }).meta;
	if (meta?.mcpTool) return meta.mcpTool;
	return op.name.replace(/\./g, '_');
}

/**
 * The zod raw shape for an operation's input — what `registerTool` expects as
 * `inputSchema` (it derives JSON Schema from it). Phase-1 inputs are all
 * `z.object(...)`, which expose `.shape`. We read it defensively and fall back
 * to an empty shape so a non-object schema never crashes registration.
 */
function inputShapeFor(op: Operation): ZodRawShape {
	const shape = (op.input as { shape?: unknown }).shape;
	if (shape && typeof shape === 'object') return shape as ZodRawShape;
	return {} as ZodRawShape;
}

/**
 * Build the Pyramid MCP server: identity + instructions, every operation as a
 * tool, plus the prompt and resource skins. The returned server is not yet
 * connected to a transport — the caller (bin/pyramid.ts) owns transport + lifecycle.
 */
export function createMcpServer(ctx: OpContext): McpServer {
	const server = new McpServer(
		{ name: 'pyramid', version: getVersion() },
		{ instructions: INSTRUCTIONS }
	);

	for (const op of operations) {
		registerOperationTool(server, op, ctx);
	}

	registerPrompts(server, ctx);
	registerResources(server, ctx);

	return server;
}

/** Register one operation as an MCP tool. */
function registerOperationTool(server: McpServer, op: Operation, ctx: OpContext): void {
	server.registerTool(
		toolNameFor(op),
		{
			description: op.summary,
			inputSchema: inputShapeFor(op),
		},
		async (args: unknown) => {
			try {
				// Re-validate at the boundary: the SDK validates against the JSON Schema,
				// but we parse with the source zod schema so `op.run` receives the exact
				// parsed/typed input (defaults applied, unknown keys handled per schema).
				const input = op.input.parse(args ?? {});
				const result = await op.run(input, ctx);
				return {
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (err) {
				const mapped = toMcpError(err);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: mapped.toJSON() }),
						},
					],
					isError: true,
				};
			}
		}
	);
}
