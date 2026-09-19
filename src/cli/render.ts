// CLI output + exit-code contract (DOC-CLI-OUTPUT).
//
// The rendering surface is intentionally dumb: it owns FORMAT and STREAMS only —
// never business logic. Operations produce results/McpErrors; this module turns
// them into bytes on the right stream and the right exit code.
//
// Hard rules (DOC-CLI-OUTPUT):
//   - stdout is the DATA channel: only real CLI output (human lines or JSON).
//   - stderr is the DIAGNOSTIC channel: pagination notes, hints, errors.
//   - JSON when `opts.json` OR stdout is not a TTY (auto-JSON for pipes/agents);
//     a TTY without --json gets a compact human table/lines. `--json` wins.

import type { McpError } from '../errors.js';
import type { McpErrorCode } from '../types.js';

/** Global CLI options parsed before the subcommand (DATATYPE-CLI-OPTIONS). */
export interface CliGlobalOptions {
	/** --json — force JSON output (else auto-JSON when stdout is not a TTY). */
	json: boolean;
	/** --project — default project for verbs that take one. */
	project?: string;
	/** --base-url — overrides PYRAMID_BASE_URL. */
	baseUrl?: string;
	/** --yes / -y — confirm destructive actions non-interactively. */
	yes: boolean;
	/** --no-color — disable ANSI color (also honors NO_COLOR env). */
	color?: boolean;
	/** --quiet / -q — suppress non-error diagnostics on stderr. */
	quiet: boolean;
	/** --no-cache — bypass the resolver's 60s workflow cache (debug). */
	noCache?: boolean;
}

// ============ Stream helpers ============

/** Write a line of DATA to stdout. */
function out(line: string): void {
	process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

/** Write a line of DIAGNOSTIC text to stderr. */
function diag(line: string): void {
	process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

/**
 * Resolve the effective output mode. JSON is forced by `--json` and is the
 * default whenever stdout is not a TTY (pipes, files, agents) so machine
 * consumers always get parseable output.
 */
function jsonMode(opts: CliGlobalOptions): boolean {
	return opts.json || process.stdout.isTTY !== true;
}

// ============ Success rendering ============

/**
 * Render a successful operation result. JSON mode prints the result verbatim to
 * stdout; human mode prints a compact table/lines and (for paginated results)
 * notes remaining pages on stderr — never silently truncating (DOC-DESIGN-RULES r8).
 */
export function render(result: unknown, opts: CliGlobalOptions): void {
	if (jsonMode(opts)) {
		out(JSON.stringify(result, null, 2));
		return;
	}
	renderHuman(result, opts);
}

/** A paginated envelope: `{ items: T[]; next_cursor: string | null }`. */
function isPage(
	v: unknown
): v is { items: unknown[]; next_cursor: string | null; has_more?: boolean } {
	return (
		typeof v === 'object' &&
		v !== null &&
		Array.isArray((v as { items?: unknown }).items) &&
		'next_cursor' in v
	);
}

/** Compact human rendering — tables for lists, key/value lines for objects. */
function renderHuman(result: unknown, opts: CliGlobalOptions): void {
	// null / undefined → a single explicit line so the user isn't left guessing.
	if (result === null || result === undefined) {
		out('(none)');
		return;
	}

	// Paginated list → table of its items + a pagination note on stderr.
	if (isPage(result)) {
		renderRows(result.items);
		if (result.next_cursor && !opts.quiet) {
			diag(`… more results available (use --all or --cursor ${result.next_cursor}).`);
		}
		return;
	}

	// Bare array → table.
	if (Array.isArray(result)) {
		renderRows(result);
		return;
	}

	// Scalar → print directly.
	if (typeof result !== 'object') {
		out(String(result));
		return;
	}

	// Single object → aligned key: value lines (flattening nested name refs).
	const rec = result as Record<string, unknown>;
	const keys = Object.keys(rec);
	if (keys.length === 0) {
		out('(empty)');
		return;
	}
	const width = Math.max(...keys.map((k) => k.length));
	for (const k of keys) {
		out(`${k.padEnd(width)}  ${cell(rec[k])}`);
	}
}

/** Render an array of rows as a compact table (objects) or one-per-line (scalars). */
function renderRows(rows: unknown[]): void {
	if (rows.length === 0) {
		out('(no results)');
		return;
	}

	// Scalars → one per line.
	if (rows.every((r) => typeof r !== 'object' || r === null)) {
		for (const r of rows) out(cell(r));
		return;
	}

	// Objects → union of keys as columns, values flattened to one cell each.
	const objs = rows.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}));
	const cols: string[] = [];
	for (const o of objs) {
		for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
	}

	const matrix = objs.map((o) => cols.map((c) => cell(o[c])));
	const widths = cols.map((c, i) => Math.max(c.length, ...matrix.map((row) => row[i]!.length)));

	out(cols.map((c, i) => c.padEnd(widths[i]!)).join('  '));
	for (const row of matrix) {
		out(row.map((v, i) => v.padEnd(widths[i]!)).join('  '));
	}
}

/**
 * Flatten one value to a single table cell. Common hydrated shapes ({id,name} /
 * {id,display_name}) collapse to their human label; arrays join with commas;
 * other objects fall back to compact JSON.
 *
 * A person (Owner / Reporter) renders as "Ann Smith (Design Lead)" when a
 * job_title is known — the title is what tells a reader whether the right person
 * holds the task, and a bare name makes them go look it up.
 */
function cell(v: unknown): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v)) return v.map(cell).join(', ');
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		if (typeof o.name === 'string') return o.name;
		if (typeof o.display_name === 'string') {
			return typeof o.job_title === 'string' && o.job_title.length > 0
				? `${o.display_name} (${o.job_title})`
				: o.display_name;
		}
		if (typeof o.key === 'string') return o.key;
		if (typeof o.id === 'string') return o.id;
		return JSON.stringify(v);
	}
	return String(v);
}

// ============ Error rendering + exit codes ============

/**
 * Map an McpError code to a stable, non-zero exit code (DOC-CLI-OUTPUT).
 * The table is by error CLASS so scripts can branch on exit status alone.
 */
export function exitCodeFor(code: McpErrorCode): number {
	switch (code) {
		case 'auth_invalid':
		case 'auth_expired':
			return 3;
		case 'permission_denied':
			return 4;
		case 'project_not_found':
		case 'task_not_found':
		case 'status_not_found':
		case 'stage_not_found':
		case 'user_not_found':
		case 'label_not_found':
		case 'field_not_found':
			return 5;
		case 'ambiguous_project_name':
		case 'ambiguous_user_name':
		case 'ambiguous_label_name':
			return 6;
		case 'validation_failed':
		case 'invalid_field_value':
		case 'status_not_in_stage':
		case 'reply_depth_exceeded':
		case 'task_archived':
		case 'conflict':
			return 7;
		case 'destructive_action_disabled':
			return 8;
		case 'rate_limited':
			return 9;
		case 'network':
			return 10;
		case 'unknown':
			return 1;
		default: {
			// Exhaustiveness guard: a new code added to the union forces a decision here.
			const _never: never = code;
			void _never;
			return 1;
		}
	}
}

/**
 * Render an McpError to stderr and exit with its mapped code. JSON mode emits the
 * canonical `{ error: { code, message, hint?, candidates? } }` envelope to stderr;
 * human mode emits a compact `error: <code>: <message>` line plus hint/candidates.
 * Never returns (calls `process.exit`).
 */
export function renderError(e: McpError, opts: CliGlobalOptions): never {
	const shape = e.toJSON();
	if (jsonMode(opts)) {
		diag(JSON.stringify({ error: shape }, null, 2));
	} else {
		diag(`error: ${shape.code}: ${shape.message}`);
		if (shape.hint) diag(`  hint: ${shape.hint}`);
		if (shape.candidates && shape.candidates.length > 0) {
			diag(`  candidates: ${shape.candidates.join(', ')}`);
		}
	}
	process.exit(exitCodeFor(e.code));
}

/**
 * Render a CLI usage/parse error (NOT an McpError) to stderr and exit 2
 * (DOC-CLI-OUTPUT: "CLI usage/parse error" → exit 2). Never returns.
 */
export function renderUsageError(message: string, usage?: string): never {
	diag(`error: ${message}`);
	if (usage) diag(usage);
	process.exit(2);
}
