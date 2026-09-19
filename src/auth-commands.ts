// FILE-AUTH-COMMANDS — local credential commands for the `pyramid` bin
// (DOC-CREDENTIAL-STORAGE). These manage the keychain-stored API key, so
// bin/pyramid.ts dispatches to them BEFORE config load (you can store a key
// without already having one). config.ts later READS the key.
//
//   pyramid set-key <pyk_...>   store a pasted key   (aliases: set-api-key, set-token)
//   pyramid show-key            show the stored key, masked
//   pyramid logout              clear the stored key
//   pyramid login               browser handoff -> keychain
//
// Each handler returns a process exit code; bin owns process.exit. Output goes to
// the injected `out` (stderr in production). The full secret is NEVER printed.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deleteKey, getKey, setKey } from './keychain.js';

const DEFAULT_WEB_URL = 'https://pyramid.magicspells.io';
const DEFAULT_LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

/** Injected side effects, so handlers are unit-testable without the keychain. */
export interface AuthIO {
	out: (line: string) => void;
	getKey: () => string | null;
	setKey: (key: string) => void;
	deleteKey: () => void;
	openBrowser: (url: string) => boolean | Promise<boolean>;
	env: NodeJS.ProcessEnv;
	randomState: () => string;
	loginTimeoutMs: number;
}

const realIO: AuthIO = {
	out: (line) => process.stderr.write(`${line}\n`),
	getKey,
	setKey,
	deleteKey,
	openBrowser,
	env: process.env,
	randomState: () => randomBytes(24).toString('base64url'),
	loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
};

/**
 * Mask a `pyk_<prefix>_<secret>` key for display: keep the non-secret prefix,
 * hide the secret (show only its last 4). Never reveals the full secret.
 */
export function maskKey(key: string): string {
	const m = /^pyk_([^_]+)_(.+)$/.exec(key);
	if (!m) return 'pyk_…';
	return `pyk_${m[1]}_…${m[2].slice(-4)}`;
}

/** `pyramid set-key <pyk_...>` — store a pasted key in the OS keychain. */
export function runSetKey(argv: string[], io: AuthIO = realIO): number {
	const key = argv[1]?.trim();
	if (!key) {
		io.out('usage: pyramid set-key <pyk_...>');
		return 2;
	}
	if (!key.startsWith('pyk_')) {
		io.out(
			'That does not look like a Pyramid key (it must start with "pyk_"). ' +
				'Generate one in Pyramid → Settings → API Keys.'
		);
		return 1;
	}
	io.setKey(key);
	io.out(`Saved ${maskKey(key)} to the OS keychain — the MCP and CLI will use it automatically.`);
	return 0;
}

/** `pyramid show-key` — print the stored key, masked (or that none is stored). */
export function runShowKey(_argv: string[], io: AuthIO = realIO): number {
	const key = io.getKey();
	if (!key) {
		io.out('No Pyramid key stored. Run `pyramid set-key <pyk_...>` to save one.');
		return 0;
	}
	io.out(`Stored Pyramid key: ${maskKey(key)} (OS keychain).`);
	return 0;
}

/** `pyramid logout` — clear the stored key. Idempotent. */
export function runLogout(_argv: string[], io: AuthIO = realIO): number {
	io.deleteKey();
	io.out('Cleared the stored Pyramid key from the OS keychain.');
	return 0;
}

interface LoginOptions {
	webUrl: string;
	name: string;
}

function parseLoginOptions(argv: string[], env: NodeJS.ProcessEnv): LoginOptions | string {
	let webUrl = env.PYRAMID_WEB_URL?.trim() || DEFAULT_WEB_URL;
	let name = 'Pyramid CLI';
	const args = argv.slice(1);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--web-url') {
			const next = args[++i];
			if (!next) return 'usage: pyramid login [--web-url <url>] [--name <key name>]';
			webUrl = next;
			continue;
		}
		if (arg.startsWith('--web-url=')) {
			webUrl = arg.slice('--web-url='.length);
			continue;
		}
		if (arg === '--name') {
			const next = args[++i];
			if (!next) return 'usage: pyramid login [--web-url <url>] [--name <key name>]';
			name = next;
			continue;
		}
		if (arg.startsWith('--name=')) {
			name = arg.slice('--name='.length);
			continue;
		}
		return `unknown option for pyramid login: ${arg}`;
	}
	try {
		new URL(webUrl);
	} catch {
		return `PYRAMID_WEB_URL is not a valid URL: "${webUrl}".`;
	}
	return { webUrl, name: name.trim() || 'Pyramid CLI' };
}

function authURL(webUrl: string, callbackURL: string, state: string, name: string): string {
	const target = new URL('/auth/cli', webUrl);
	target.searchParams.set('redirect_uri', callbackURL);
	target.searchParams.set('state', state);
	target.searchParams.set('name', name);
	return target.toString();
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

/** `pyramid login` — browser handoff that stores a minted API key locally. */
export async function runLogin(argv: string[], io: AuthIO = realIO): Promise<number> {
	const opts = parseLoginOptions(argv, io.env);
	if (typeof opts === 'string') {
		io.out(opts);
		return 2;
	}

	const state = io.randomState();
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	let finish!: (code: number) => void;
	const done = new Promise<number>((resolve) => {
		finish = (code) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(code);
		};
	});

	const server = createServer((req, res) => {
		const requestURL = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (requestURL.pathname !== '/callback') {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('Not found.\n');
			return;
		}

		const gotState = requestURL.searchParams.get('state') ?? '';
		if (gotState !== state) {
			res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('Invalid login state. Return to your terminal.\n');
			io.out('Rejected Pyramid login callback with an invalid state.');
			void closeServer(server).then(() => finish(1));
			return;
		}

		const error = requestURL.searchParams.get('error');
		if (error) {
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('Pyramid login cancelled. Return to your terminal.\n');
			io.out(
				error === 'access_denied' ? 'Pyramid login cancelled.' : `Pyramid login failed: ${error}`
			);
			void closeServer(server).then(() => finish(1));
			return;
		}

		const key = requestURL.searchParams.get('key')?.trim() ?? '';
		if (!key.startsWith('pyk_')) {
			res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('Invalid Pyramid key. Return to your terminal.\n');
			io.out('Pyramid login returned an invalid key.');
			void closeServer(server).then(() => finish(1));
			return;
		}

		io.setKey(key);
		res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Pyramid CLI connected. You can close this tab.\n');
		io.out(`Saved ${maskKey(key)} to the OS keychain — the MCP and CLI will use it automatically.`);
		void closeServer(server).then(() => finish(0));
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
	} catch (err) {
		io.out(
			`Could not start the local Pyramid login server: ${err instanceof Error ? err.message : String(err)}`
		);
		return 1;
	}

	const address = server.address() as AddressInfo;
	const callbackURL = `http://127.0.0.1:${address.port}/callback`;
	const loginURL = authURL(opts.webUrl, callbackURL, state, opts.name);

	timeout = setTimeout(() => {
		io.out('Pyramid login timed out before the browser completed the handoff.');
		void closeServer(server).then(() => finish(1));
	}, io.loginTimeoutMs);

	const opened = await io.openBrowser(loginURL);
	if (opened) {
		io.out('Opened Pyramid in your browser. Authorize the CLI to finish login.');
	} else {
		io.out('Could not open your browser automatically. Open this URL to finish login:');
		io.out(loginURL);
	}

	return done;
}

function openBrowser(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const platform = process.platform;
		const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
		const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		child.once('error', () => resolve(false));
		child.once('close', (code) => resolve(code === 0));
		child.unref();
	});
}

/** Command name -> handler, including aliases. Consumed by bin/pyramid.ts. */
export type AuthCommand = (argv: string[]) => number | Promise<number>;

export const AUTH_COMMANDS: Record<string, AuthCommand> = {
	'set-key': runSetKey,
	'set-api-key': runSetKey,
	'set-token': runSetKey,
	'show-key': runShowKey,
	logout: runLogout,
	login: runLogin,
};
