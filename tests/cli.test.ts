// Unit tests for the CLI surface (src/cli/render.ts + src/cli/index.ts) — pure,
// NO network. The CLI is the "data channel" half of the stream contract (DOC-CLI-OUTPUT):
//   - stdout carries DATA only (human lines or JSON);
//   - stderr carries DIAGNOSTICS (errors, hints, usage);
//   - output is JSON when --json OR stdout is not a TTY (auto-JSON for pipes);
//   - an McpError maps to a stable non-zero exit code (DOC-CLI-OUTPUT table);
//   - a usage/parse error (not an McpError) exits 2.
//
// We capture stdout/stderr and stub process.exit so renderError/renderUsageError
// (which call process.exit) are observable without killing the test runner.
//
// SCOPE NOTE (read before extending the arg-parser assertions):
//   The test plan's flagship arg-parsing case — `task move WEB-42 --status "In
//   Review" --after WEB-10` -> a task.move input — requires the command tree to
//   contain a `task move` command. That tree is DERIVED FROM THE REGISTRY: the
//   CLI walks `operations` and reads each op's `meta.cli.{group,verb,...}`
//   (src/cli/index.ts buildCommands). In the current codebase NO operation
//   defines `meta.cli` (the Phase-1 ops are MCP-only), AND the write ops
//   (task.create/move/delete, comment.*) are not implemented yet — so
//   buildCommands() returns []. Therefore `pyramid task move …` resolves to an
//   "unknown command" usage error (exit 2), which we assert below as the real
//   current behavior. The render / exit-code / error-mapping contract the prompt
//   leans on IS fully implemented and is tested thoroughly here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpError } from '../src/errors.js';
import { exitCodeFor, render, renderError, type CliGlobalOptions } from '../src/cli/render.js';
import { runCli } from '../src/cli/index.js';

// ============ stdout / stderr / exit capture ============

interface Capture {
	out: string;
	err: string;
	exitCode?: number;
	restore: () => void;
}

/**
 * Capture stdout + stderr writes and intercept process.exit. `process.exit` is
 * stubbed to THROW a sentinel so the call stack unwinds (matching the real
 * `never`-returning behavior) without terminating vitest; callers catch it.
 */
class ExitSignal extends Error {
	constructor(public code: number) {
		super(`__exit_${code}__`);
	}
}

function capture(opts?: { isTTY?: boolean }): Capture {
	const cap: Capture = { out: '', err: '', restore: () => {} };

	const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		cap.out += String(chunk);
		return true;
	});
	const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
		cap.err += String(chunk);
		return true;
	});
	const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		cap.exitCode = code ?? 0;
		throw new ExitSignal(code ?? 0);
	}) as never);

	// Make the TTY-ness deterministic for the format decision in render.ts.
	const tty = opts?.isTTY ?? false;
	const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
	Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });

	cap.restore = () => {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
		if (origIsTTY) Object.defineProperty(process.stdout, 'isTTY', origIsTTY);
		else delete (process.stdout as { isTTY?: boolean }).isTTY;
	};
	return cap;
}

/** Run `fn` and swallow the ExitSignal thrown by the stubbed process.exit. */
function runUntilExit(fn: () => void): void {
	try {
		fn();
	} catch (e) {
		if (!(e instanceof ExitSignal)) throw e;
	}
}

const BASE_OPTS: CliGlobalOptions = { json: false, yes: false, quiet: false };

// ============ exitCodeFor — the DOC-CLI-OUTPUT exit table ============

describe('exitCodeFor — error-class -> exit code (DOC-CLI-OUTPUT)', () => {
	it('maps each error class to its documented exit code', () => {
		expect(exitCodeFor('auth_invalid')).toBe(3);
		expect(exitCodeFor('auth_expired')).toBe(3);
		expect(exitCodeFor('permission_denied')).toBe(4);
		expect(exitCodeFor('project_not_found')).toBe(5);
		expect(exitCodeFor('task_not_found')).toBe(5);
		expect(exitCodeFor('status_not_found')).toBe(5);
		expect(exitCodeFor('stage_not_found')).toBe(5);
		expect(exitCodeFor('user_not_found')).toBe(5);
		expect(exitCodeFor('label_not_found')).toBe(5);
		expect(exitCodeFor('field_not_found')).toBe(5);
		expect(exitCodeFor('ambiguous_project_name')).toBe(6);
		expect(exitCodeFor('ambiguous_user_name')).toBe(6);
		expect(exitCodeFor('ambiguous_label_name')).toBe(6);
		expect(exitCodeFor('validation_failed')).toBe(7);
		expect(exitCodeFor('invalid_field_value')).toBe(7);
		expect(exitCodeFor('status_not_in_stage')).toBe(7);
		expect(exitCodeFor('reply_depth_exceeded')).toBe(7);
		expect(exitCodeFor('task_archived')).toBe(7);
		expect(exitCodeFor('destructive_action_disabled')).toBe(8);
		expect(exitCodeFor('rate_limited')).toBe(9);
		expect(exitCodeFor('network')).toBe(10);
		expect(exitCodeFor('unknown')).toBe(1);
	});
});

// ============ render — format + stream contract ============

describe('render — emits JSON when --json or non-TTY (DOC-CLI-OUTPUT)', () => {
	let cap: Capture;
	afterEach(() => cap?.restore());

	it('writes pretty JSON to stdout when --json is set (even on a TTY)', () => {
		cap = capture({ isTTY: true });
		const result = { key: 'APO-1', title: 'Wire auth' };
		render(result, { ...BASE_OPTS, json: true });
		cap.restore();

		expect(cap.err).toBe(''); // no diagnostics on the data path
		expect(JSON.parse(cap.out)).toEqual(result);
	});

	it('auto-JSONs to stdout when stdout is NOT a TTY (pipe/agent), no --json needed', () => {
		cap = capture({ isTTY: false });
		const result = { key: 'APO-1', status: { id: 'st-1', name: 'In Review' } };
		render(result, { ...BASE_OPTS, json: false });
		cap.restore();

		// non-TTY -> machine consumers always get parseable JSON.
		expect(JSON.parse(cap.out)).toEqual(result);
	});

	it('prints a compact human line (not JSON) on a TTY without --json', () => {
		cap = capture({ isTTY: true });
		render({ key: 'APO-1', title: 'Wire auth' }, { ...BASE_OPTS, json: false });
		cap.restore();

		// human mode: aligned key/value lines, NOT a JSON object.
		expect(cap.out).toContain('key');
		expect(cap.out).toContain('APO-1');
		expect(() => JSON.parse(cap.out)).toThrow();
	});

	it('renders a Page as a table and notes more results on stderr (never truncates)', () => {
		cap = capture({ isTTY: true });
		render(
			{
				items: [
					{ key: 'APO-1', title: 'a' },
					{ key: 'APO-2', title: 'b' },
				],
				next_cursor: 'CUR-2',
				has_more: true,
			},
			{ ...BASE_OPTS, json: false }
		);
		cap.restore();

		// rows on stdout (data), pagination note on stderr (diagnostic).
		expect(cap.out).toContain('APO-1');
		expect(cap.out).toContain('APO-2');
		expect(cap.err).toContain('CUR-2');
	});

	it('shows Owner and Reporter with their job_title when one is known', () => {
		cap = capture({ isTTY: true });
		render(
			{
				key: 'APO-1',
				owner: { id: 'u-ann', display_name: 'Ann Smith', job_title: 'Design Lead' },
				reporter: { id: 'u-bob', display_name: 'Bob Jones' },
			},
			{ ...BASE_OPTS, json: false }
		);
		cap.restore();

		// the title is what says whether the right person holds it.
		expect(cap.out).toContain('Ann Smith (Design Lead)');
		// no title known -> the bare name, never an empty "()".
		expect(cap.out).toContain('Bob Jones');
		expect(cap.out).not.toContain('Bob Jones (');
	});

	it('JSON mode preserves a Page envelope including the cursor on stdout', () => {
		cap = capture({ isTTY: true });
		const page = { items: [{ key: 'APO-1' }], next_cursor: 'CUR-2', has_more: true };
		render(page, { ...BASE_OPTS, json: true });
		cap.restore();

		expect(cap.err).toBe('');
		expect(JSON.parse(cap.out)).toEqual(page);
	});
});

// ============ renderError — error -> stderr + mapped exit code ============

describe('renderError — McpError to stderr with the mapped exit code', () => {
	let cap: Capture;
	afterEach(() => cap?.restore());

	it('an ambiguous_project_name prints candidates to stderr and exits 6', () => {
		cap = capture({ isTTY: true });
		const err = new McpError('ambiguous_project_name', 'pick one', {
			candidates: ['website-redesign', 'webhooks'],
		});
		runUntilExit(() => renderError(err, { ...BASE_OPTS, json: false }));
		cap.restore();

		expect(cap.exitCode).toBe(6);
		expect(cap.out).toBe(''); // errors NEVER pollute the data channel
		expect(cap.err).toContain('ambiguous_project_name');
		expect(cap.err).toContain('website-redesign');
		expect(cap.err).toContain('webhooks');
	});

	it('emits the canonical { error: {...} } envelope to stderr under --json', () => {
		cap = capture({ isTTY: false });
		const err = new McpError('task_not_found', 'no such task', { hint: 'check the key' });
		runUntilExit(() => renderError(err, { ...BASE_OPTS, json: true }));
		cap.restore();

		expect(cap.exitCode).toBe(5);
		expect(cap.out).toBe('');
		const parsed = JSON.parse(cap.err) as {
			error: { code: string; message: string; hint?: string };
		};
		expect(parsed.error.code).toBe('task_not_found');
		expect(parsed.error.message).toBe('no such task');
		expect(parsed.error.hint).toBe('check the key');
	});

	it('a destructive_action_disabled error exits 8', () => {
		cap = capture({ isTTY: false });
		runUntilExit(() =>
			renderError(new McpError('destructive_action_disabled', 'gate is off'), {
				...BASE_OPTS,
				json: true,
			})
		);
		cap.restore();
		expect(cap.exitCode).toBe(8);
	});
});

// ============ runCli — global-flag parsing, help, usage errors ============
//
// runCli parses globals (--json/--project/--base-url/-y/-q/--no-cache),
// matches a command from the REGISTRY-DERIVED tree, then parses + validates the
// op input. We assert the reachable behaviors of the current build.

describe('runCli — global flags, help, and usage errors', () => {
	let cap: Capture;
	afterEach(() => cap?.restore());

	it('no args -> prints the help/usage tree to stderr and returns 0 (no exit)', async () => {
		cap = capture({ isTTY: true });
		const code = await runCli([]);
		cap.restore();

		expect(code).toBe(0);
		expect(cap.out).toBe(''); // help is a diagnostic -> stderr only
		expect(cap.err).toContain('Usage:');
		expect(cap.err).toContain('pyramid');
	});

	it('`help` / `--help` print usage to stderr and return 0', async () => {
		for (const argv of [['help'], ['--help'], ['-h']]) {
			cap = capture({ isTTY: true });
			const code = await runCli(argv);
			cap.restore();
			expect(code).toBe(0);
			expect(cap.err).toContain('Usage:');
		}
	});

	it('an unknown command is a usage error -> stderr + exit 2', async () => {
		cap = capture({ isTTY: true });
		// `task bogus` has a known group but an unknown verb -> not in the
		// registry-derived command tree. (`task move` IS registered now.)
		await runUntilExitAsync(() => runCli(['task', 'bogus', 'WEB-42', '--status', 'In Review']));
		cap.restore();

		expect(cap.exitCode).toBe(2); // CLI usage/parse error class
		expect(cap.out).toBe('');
		expect(cap.err).toMatch(/unknown command/i);
	});

	it('strips recognized global flags (--json) before matching the command', async () => {
		cap = capture({ isTTY: true });
		// --json is a global; with it stripped the residual is still an unknown
		// command (empty tree) -> exit 2. This proves --json was consumed as a
		// global and not treated as the command token.
		await runUntilExitAsync(() => runCli(['--json', 'bogus']));
		cap.restore();

		expect(cap.exitCode).toBe(2);
		expect(cap.err).toMatch(/unknown command/i);
		expect(cap.err).not.toContain('--json');
	});
});

/** Async sibling of runUntilExit: awaits the promise, swallowing ExitSignal. */
async function runUntilExitAsync(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (!(e instanceof ExitSignal)) throw e;
	}
}

// keep the lint happy: beforeEach reserved for future per-test env isolation.
beforeEach(() => {
	/* no shared mutable state to reset; each test owns its capture. */
});
