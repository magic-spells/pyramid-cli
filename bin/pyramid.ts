#!/usr/bin/env node
// FILE-BIN — the package entry point (FLOW-STARTUP-AUTH, DOC-PACKAGE-RENAME).
//
// This file is deliberately THIN. It owns only process lifecycle: argv dispatch,
// transport wiring, signal handling, exit codes, and writing diagnostics to
// STDERR. All Pyramid/business logic lives in the modules it calls
// (loadConfig, PyramidClient, Resolver, createMcpServer).
//
// Dispatch on process.argv[2]:
//   - "mcp"    -> start the stdio MCP server (createMcpServer + StdioServerTransport)
//                 with SIGINT/SIGTERM/stdin-close graceful shutdown.
//   - "doctor" -> run FLOW-STARTUP-AUTH (getMe + listProjects + first-project
//                 workflow ping); print user/workspace/projects; exit by outcome.
//   - anything else (incl. no subcommand) -> hand off to the CLI: lazily import
//                 and `await runCli(argv)`, which loads its own config (layering
//                 --base-url / --project over env), runs the operation, renders
//                 (JSON/human), and returns the process exit code.
//
// STREAM CONTRACT (hard invariant): stdout is reserved for the MCP JSON-RPC
// channel and real CLI data (here, scriptable doctor JSON). Every diagnostic,
// log line, and human-readable summary goes to STDERR ONLY. The API key is never
// logged.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { PyramidClient } from '../src/client/pyramid-client.js';
import { Resolver } from '../src/cache/resolver.js';
import { AUTH_COMMANDS } from '../src/auth-commands.js';
import { getVersion } from '../src/version.js';
import { loadConfig } from '../src/config.js';
import { toMcpError } from '../src/errors.js';
import type { McpError } from '../src/errors.js';
import type { McpErrorCode, PyramidConfig } from '../src/types.js';

// The MCP skin (createMcpServer) and the operation registry are imported LAZILY
// (dynamic import inside runMcp), NOT at module top. The `doctor`, CLI-handoff,
// and config-failure paths must not pull in the whole operations graph — keeping
// these imports lazy means an in-progress operations module can never break those
// paths, and the heavy graph is only evaluated when you actually start the server.

main().catch((err: unknown) => {
	// Last-resort guard: nothing below should reject unhandled, but if it does,
	// surface a clean line to stderr (never a raw stack to stdout) and fail.
	err2line(toMcpError(err).message);
	process.exit(1);
});

/** Write one diagnostic line to STDERR (never stdout). */
function err2line(line: string): void {
	process.stderr.write(`${line}\n`);
}

/**
 * Map an McpError code to a process exit code (DOC-CLI-OUTPUT exit table). The
 * bin only hits the auth/permission/transport classes during startup + doctor;
 * everything else collapses to a generic non-zero.
 */
function exitCodeFor(code: McpErrorCode): number {
	switch (code) {
		case 'auth_invalid':
		case 'auth_expired':
			return 3;
		case 'permission_denied':
			return 4;
		case 'rate_limited':
			return 9;
		case 'network':
			return 10;
		default:
			return 1;
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const cmd = argv[0];

	// `pyramid version` (aliases v / -v / --version) — print the version and exit.
	// Data goes to stdout so `pyramid version` is scriptable.
	if (cmd === 'version' || cmd === 'v' || cmd === '-v' || cmd === '--version') {
		process.stdout.write(`pyramid ${getVersion()}\n`);
		process.exit(0);
	}

	// Local credential commands (set-key / show-key / logout / login) manage the
	// keychain-stored API key and make NO network call — handle them HERE, before
	// config load, since you can store a key without already having one.
	// (DOC-CREDENTIAL-STORAGE, FILE-AUTH-COMMANDS.)
	const authHandler = cmd ? AUTH_COMMANDS[cmd] : undefined;
	if (authHandler) {
		process.exit(await authHandler(argv));
		return;
	}

	// The CLI (any argv that isn't `mcp`/`doctor`, including none) owns its own
	// config loading — it layers --base-url / --project over env — so it must NOT
	// go through the pre-load below. Hand off straight to it; runCli renders its own
	// output/errors and returns the process exit code. The lazy import keeps the
	// operations graph off the mcp/doctor/config-failure paths.
	if (cmd !== 'mcp' && cmd !== 'doctor') {
		const { runCli } = await import('../src/cli/index.js');
		process.exit(await runCli(argv));
		return;
	}

	// mcp + doctor need a validated config up front. A bad/missing key is a clean,
	// single-line failure to stderr (loadConfig throws a plain Error) — not a stack
	// dump — and exits non-zero.
	let config: PyramidConfig;
	try {
		config = loadConfig();
	} catch (err) {
		err2line(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	if (cmd === 'mcp') {
		await runMcp(config);
		return;
	}
	await runDoctor(config, argv);
}

/** The shared context the MCP surface + resolver render from. */
interface Context {
	config: PyramidConfig;
	client: PyramidClient;
	resolver: Resolver;
}

/**
 * Build the shared context: config + client + resolver. `config` is a
 * PyramidConfig; the resolver consumes the client structurally (ResolverClient).
 */
function buildContext(config: PyramidConfig): Context {
	const client = new PyramidClient(config);
	const resolver = new Resolver(client);
	return { config, client, resolver };
}

/**
 * Serve the MCP surface over stdio. Connects the server, logs readiness to
 * stderr, and wires graceful shutdown on SIGINT/SIGTERM and stdin close/end (the
 * host closing the pipe). The process stays alive until a shutdown signal fires.
 *
 * `createMcpServer` and the operation registry are imported lazily here so the
 * heavy operations graph is only evaluated on the `mcp` path.
 */
async function runMcp(config: PyramidConfig): Promise<void> {
	const ctx = buildContext(config);
	const [{ createMcpServer }, { operations }] = await Promise.all([
		import('../src/mcp/server.js'),
		import('../src/operations/index.js'),
	]);
	const server = createMcpServer(ctx);
	const transport = new StdioServerTransport();

	// Idempotent shutdown: close the server (which closes the transport), then
	// exit 0. Guard against overlapping signals / a stdin close racing a signal.
	let closing = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (closing) return;
		closing = true;
		err2line(`pyramid mcp: shutting down (${reason}).`);
		try {
			await server.close();
		} catch (err) {
			err2line(`pyramid mcp: error during shutdown: ${toMcpError(err).message}`);
		}
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	// The MCP host closing the pipe ends stdin — treat as a quit signal.
	process.stdin.on('close', () => void shutdown('stdin closed'));
	process.stdin.on('end', () => void shutdown('stdin end'));

	await server.connect(transport);
	err2line(`pyramid mcp: ready on stdio · base ${config.baseUrl} · ${operations.length} tools.`);
}

/**
 * FLOW-STARTUP-AUTH. Confirm the key authenticates against the live backend:
 * getMe + listProjects, then ping the first project's workflow endpoint
 * (PLAN-PHASE-1 exit criterion). A human summary goes to stderr; the same
 * payload is also emitted as JSON to stdout when scriptable (--json or a non-TTY
 * stdout) so the check is pipeable. Exit 0 on success.
 *
 * A 401 surfaces as a mapped McpError (auth_invalid / auth_expired): we print the
 * code + regenerate-key hint to stderr and exit `exitCodeFor(code)` (3).
 */
async function runDoctor(config: PyramidConfig, argv: string[]): Promise<void> {
	const ctx = buildContext(config);
	const wantJson = argv.includes('--json') || !process.stdout.isTTY;

	try {
		// getMe + listProjects in parallel; either can throw a mapped McpError (e.g.
		// 401 -> auth_invalid/auth_expired). listWorkspaces gives the key's pinned
		// workspace when getMe doesn't embed one; tolerate its absence.
		const [me, projects, workspaces] = await Promise.all([
			ctx.client.getMe(),
			ctx.client.listProjects(),
			ctx.client.listWorkspaces().catch(() => [] as unknown[]),
		]);

		const userName = readStr(me, 'display_name') ?? readStr(me, 'email') ?? '(unknown user)';
		const userEmail = readStr(me, 'email') ?? '';

		// Workspace: prefer one embedded on the user payload, else the pinned
		// workspace (the first/only entry from listWorkspaces).
		const workspaceRaw = readField(me, 'workspace') ?? workspaces[0];
		const workspaceName =
			readStr(workspaceRaw, 'name') ?? readStr(workspaceRaw, 'handle') ?? '(workspace)';

		const projectNames = projects
			.map((p) => readStr(p, 'name') ?? readStr(p, 'slug'))
			.filter((n): n is string => typeof n === 'string');

		// Ping the first project's workflow endpoint to confirm it responds. A
		// failure here is reported but does NOT flip the result to an auth failure.
		let workflowOk: boolean | undefined;
		let workflowNote: string | undefined;
		const firstProjectId = readStr(projects[0], 'id');
		if (firstProjectId) {
			try {
				await ctx.resolver.getWorkflow(firstProjectId);
				workflowOk = true;
			} catch (err) {
				workflowOk = false;
				workflowNote = toMcpError(err).message;
			}
		}

		// Human summary -> stderr (never stdout).
		const userLine = userEmail ? `${userName} <${userEmail}>` : userName;
		err2line(
			`Authenticated as ${userLine} · workspace ${workspaceName} · ` +
				`${projectNames.length} project${projectNames.length === 1 ? '' : 's'}` +
				(projectNames.length ? `: ${projectNames.join(', ')}` : '')
		);
		if (workflowOk === true) err2line('Workflow endpoint: OK.');
		if (workflowOk === false) err2line(`Workflow endpoint: FAILED — ${workflowNote}`);

		// Scriptable payload -> stdout (data channel) only when JSON is requested or
		// stdout is piped.
		if (wantJson) {
			const payload = {
				ok: true,
				user: { name: userName, email: userEmail || null },
				workspace: { name: workspaceName },
				projects: projectNames,
				workflow: workflowOk === undefined ? null : { ok: workflowOk },
			};
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		}

		process.exit(0);
	} catch (err) {
		const mapped: McpError = toMcpError(err);
		err2line(`error: ${mapped.code}: ${mapped.message}`);
		if (mapped.code === 'auth_invalid' || mapped.code === 'auth_expired') {
			err2line('Regenerate your key in Pyramid → Settings → API Keys, then set PYRAMID_API_KEY.');
		} else if (mapped.hint) {
			err2line(mapped.hint);
		}
		process.exit(exitCodeFor(mapped.code));
	}
}

/** Read a raw object field by key (any type), else undefined. */
function readField(obj: unknown, key: string): unknown {
	if (obj && typeof obj === 'object' && key in obj) {
		return (obj as Record<string, unknown>)[key];
	}
	return undefined;
}

/** Read a non-empty string field out of a raw object, else undefined. */
function readStr(obj: unknown, key: string): string | undefined {
	const v = readField(obj, key);
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}
