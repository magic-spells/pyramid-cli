// Unit tests for the local credential commands (FILE-AUTH-COMMANDS). Side effects
// are injected via a fake AuthIO, so NO real keychain / `security` call happens.

import { get } from 'node:http';
import { describe, it, expect } from 'vitest';

import {
	AUTH_COMMANDS,
	maskKey,
	runLogin,
	runLogout,
	runSetKey,
	runShowKey,
	type AuthIO,
} from '../src/auth-commands.js';

const KEY = 'pyk_ab23cd45_0123456789abcdef0123456789abcdef';
const SECRET = '0123456789abcdef0123456789abcdef';

function fakeIO(stored: string | null = null, overrides: Partial<AuthIO> = {}) {
	const lines: string[] = [];
	let key = stored;
	return {
		io: {
			out: (l: string) => lines.push(l),
			getKey: () => key,
			setKey: (k: string) => {
				key = k;
			},
			deleteKey: () => {
				key = null;
			},
			openBrowser: () => true,
			env: {},
			randomState: () => 'test-state',
			loginTimeoutMs: 100,
			...overrides,
		} satisfies AuthIO,
		lines,
		get stored() {
			return key;
		},
	};
}

function callbackFromLoginURL(
	loginURL: string,
	params: Record<string, string>,
	useState: string | null = new URL(loginURL).searchParams.get('state')
): Promise<void> {
	const login = new URL(loginURL);
	const callback = new URL(login.searchParams.get('redirect_uri') ?? '');
	if (useState != null) callback.searchParams.set('state', useState);
	for (const [k, v] of Object.entries(params)) callback.searchParams.set(k, v);

	return new Promise((resolve, reject) => {
		const req = get(callback, (res) => {
			res.resume();
			res.on('end', resolve);
		});
		req.on('error', reject);
	});
}

describe('maskKey', () => {
	it('keeps the prefix, hides the secret, shows the last 4', () => {
		expect(maskKey(KEY)).toBe('pyk_ab23cd45_…cdef');
	});
	it('never reveals the full secret', () => {
		expect(maskKey(KEY)).not.toContain(SECRET);
	});
	it('degrades gracefully on a malformed key', () => {
		expect(maskKey('garbage')).toBe('pyk_…');
	});
});

describe('runSetKey', () => {
	it('stores a valid key and returns 0', () => {
		const f = fakeIO();
		expect(runSetKey(['set-key', KEY], f.io)).toBe(0);
		expect(f.stored).toBe(KEY);
		expect(f.lines.join(' ')).toContain('keychain');
	});
	it('does NOT store and returns 1 on a non-pyk_ value', () => {
		const f = fakeIO();
		expect(runSetKey(['set-key', 'sk_live_nope'], f.io)).toBe(1);
		expect(f.stored).toBeNull();
	});
	it('returns 2 (usage) when no key is given', () => {
		const f = fakeIO();
		expect(runSetKey(['set-key'], f.io)).toBe(2);
	});
	it('does not print the full secret in the confirmation', () => {
		const f = fakeIO();
		runSetKey(['set-key', KEY], f.io);
		expect(f.lines.join(' ')).not.toContain(SECRET);
	});
});

describe('runShowKey', () => {
	it('reports no key when none is stored', () => {
		const f = fakeIO(null);
		expect(runShowKey(['show-key'], f.io)).toBe(0);
		expect(f.lines.join(' ')).toMatch(/No Pyramid key/i);
	});
	it('shows the masked key when one is stored (never the full secret)', () => {
		const f = fakeIO(KEY);
		runShowKey(['show-key'], f.io);
		expect(f.lines.join(' ')).toContain('pyk_ab23cd45_…cdef');
		expect(f.lines.join(' ')).not.toContain(SECRET);
	});
});

describe('runLogout', () => {
	it('clears the stored key and returns 0', () => {
		const f = fakeIO(KEY);
		expect(runLogout(['logout'], f.io)).toBe(0);
		expect(f.stored).toBeNull();
	});
});

describe('runLogin', () => {
	it('stores the callback key and never prints the full secret', async () => {
		const f = fakeIO(null, {
			openBrowser: async (url) => {
				await callbackFromLoginURL(url, { key: KEY });
				return true;
			},
		});

		expect(await runLogin(['login'], f.io)).toBe(0);
		expect(f.stored).toBe(KEY);
		const output = f.lines.join(' ');
		expect(output).toContain('pyk_ab23cd45_…cdef');
		expect(output).not.toContain(SECRET);
	});

	it('rejects a callback with a mismatched state', async () => {
		const f = fakeIO(null, {
			openBrowser: async (url) => {
				await callbackFromLoginURL(url, { key: KEY }, 'wrong-state');
				return true;
			},
		});

		expect(await runLogin(['login'], f.io)).toBe(1);
		expect(f.stored).toBeNull();
		expect(f.lines.join(' ')).toContain('invalid state');
	});

	it('handles browser cancellation without storing a key', async () => {
		const f = fakeIO(null, {
			openBrowser: async (url) => {
				await callbackFromLoginURL(url, { error: 'access_denied' });
				return true;
			},
		});

		expect(await runLogin(['login'], f.io)).toBe(1);
		expect(f.stored).toBeNull();
		expect(f.lines.join(' ')).toContain('cancelled');
	});

	it('prints the login URL when browser opening fails and still accepts manual completion', async () => {
		let seenURL = '';
		const f = fakeIO(null, {
			openBrowser: (url) => {
				seenURL = url;
				setImmediate(() => {
					void callbackFromLoginURL(url, { key: KEY });
				});
				return false;
			},
		});

		expect(
			await runLogin(['login', '--web-url', 'http://localhost:5173', '--name', 'Local CLI'], f.io)
		).toBe(0);
		expect(f.stored).toBe(KEY);
		const login = new URL(seenURL);
		expect(login.origin).toBe('http://localhost:5173');
		expect(login.pathname).toBe('/auth/cli');
		expect(login.searchParams.get('name')).toBe('Local CLI');
		expect(f.lines.join(' ')).toContain(seenURL);
	});

	it('times out if no callback arrives', async () => {
		const f = fakeIO(null, {
			openBrowser: () => true,
			loginTimeoutMs: 5,
		});

		expect(await runLogin(['login'], f.io)).toBe(1);
		expect(f.stored).toBeNull();
		expect(f.lines.join(' ')).toContain('timed out');
	});
});

describe('AUTH_COMMANDS', () => {
	it('routes set-key, set-api-key and set-token to the same handler', () => {
		expect(AUTH_COMMANDS['set-api-key']).toBe(AUTH_COMMANDS['set-key']);
		expect(AUTH_COMMANDS['set-token']).toBe(AUTH_COMMANDS['set-key']);
	});
	it('exposes show-key, logout and login', () => {
		expect(typeof AUTH_COMMANDS['show-key']).toBe('function');
		expect(typeof AUTH_COMMANDS['logout']).toBe('function');
		expect(typeof AUTH_COMMANDS['login']).toBe('function');
	});
});
