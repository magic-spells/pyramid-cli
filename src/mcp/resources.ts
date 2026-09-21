// FILE-RESOURCES — MCP resource skin.
//
// Two read-only resources, kept minimal:
//   - pyramid://me        -> the WhoAmI payload (authenticated user + workspace +
//                            projects), via the `whoami` operation.
//   - pyramid://projects  -> the accessible project list, via the `list_projects`
//                            operation.
//
// Both reuse the shared operation registry so a resource read returns exactly
// what the equivalent tool would. If an operation is missing from the registry we
// fall back to the raw client call, so the resources stay functional regardless
// of the registry's naming. Output is the same pretty-printed JSON the tools emit.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { toMcpError } from '../errors.js';
import { operations } from '../operations/index.js';
import type { Operation, OpContext } from '../operations/index.js';

/** Resolve an operation by its MCP tool name (snake_case, or meta.mcpTool). */
function findOp(name: string): Operation | undefined {
	return operations.find((op) => {
		const meta = (op as { meta?: { mcpTool?: string } }).meta;
		const toolName = meta?.mcpTool ?? op.name.replace(/\./g, '_');
		return toolName === name || op.name === name;
	});
}

/**
 * Run an operation (with empty input) and serialize it; on error return the same
 * `{ error: { code, message, hint?, candidates? } }` envelope the tools use, so a
 * resource read never throws raw across the wire.
 */
async function renderOp(op: Operation, ctx: OpContext): Promise<string> {
	try {
		const input = op.input.parse({});
		const result = await op.run(input, ctx);
		return JSON.stringify(result, null, 2);
	} catch (err) {
		return JSON.stringify({ error: toMcpError(err).toJSON() }, null, 2);
	}
}

/** Register `pyramid://me` and `pyramid://projects` as read-only resources. */
export function registerResources(server: McpServer, ctx: OpContext): void {
	server.registerResource(
		'me',
		'pyramid://me',
		{
			title: 'Pyramid identity',
			description: 'The authenticated user, their workspace, and accessible projects (whoami).',
			mimeType: 'application/json',
		},
		async (uri: URL) => {
			const op = findOp('whoami');
			const text = op
				? await renderOp(op, ctx)
				: JSON.stringify({ user: await ctx.client.getMe() }, null, 2);
			return {
				contents: [{ uri: uri.href, mimeType: 'application/json', text }],
			};
		}
	);

	server.registerResource(
		'projects',
		'pyramid://projects',
		{
			title: 'Pyramid projects',
			description: 'The projects accessible to the authenticated user.',
			mimeType: 'application/json',
		},
		async (uri: URL) => {
			const op = findOp('list_projects');
			const text = op
				? await renderOp(op, ctx)
				: JSON.stringify(await ctx.client.listProjects(), null, 2);
			return {
				contents: [{ uri: uri.href, mimeType: 'application/json', text }],
			};
		}
	);

	// pyramid://projects/{handle}/workflow -> the project's assembled workflow (stages,
	// statuses, labels, members, field templates) the model loads to resolve names.
	server.registerResource(
		'project-workflow',
		new ResourceTemplate('pyramid://projects/{handle}/workflow', { list: undefined }),
		{
			title: 'Project workflow',
			description: "A project's stages, statuses, labels, members, and field templates, by handle.",
			mimeType: 'application/json',
		},
		async (uri: URL, variables: Record<string, string | string[]>) => {
			const raw = variables.handle;
			const handle = Array.isArray(raw) ? raw[0] : raw;
			const op = findOp('get_project_workflow');
			let text: string;
			if (op !== undefined && handle) {
				try {
					const result = await op.run(op.input.parse({ project: handle }), ctx);
					text = JSON.stringify(result, null, 2);
				} catch (err) {
					text = JSON.stringify({ error: toMcpError(err).toJSON() }, null, 2);
				}
			} else {
				text = JSON.stringify(
					{ error: { code: 'validation_failed', message: 'missing project handle' } },
					null,
					2
				);
			}
			return {
				contents: [{ uri: uri.href, mimeType: 'application/json', text }],
			};
		}
	);
}
