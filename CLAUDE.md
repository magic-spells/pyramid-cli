# CLAUDE.md

Guidance for Claude Code working in this repo. Read this first, then the
constellation plan for design intent and the code for ground truth.

## What this is

`@magic-spells/pyramid` — an **MCP server *and* CLI over one shared core** for the
[Pyramid](https://pyramid.magicspells.io) project-management HTTP API. It is
**stateless**: no database, no on-disk state except an optional keychain-stored API
key. It translates intent ("move WEB-42 to QA and assign Sam") into authenticated
Pyramid API calls, resolving human **names → UUIDs** and **hydrating names back** into
every response so the model reasons in names, not IDs.

## Commands

```sh
npm run build          # tsc → dist/
npm test               # vitest run (all suites)
npx vitest run tests/config.test.ts   # one suite
npm run dev -- <args>  # run the bin from source via tsx, e.g. npm run dev -- doctor
```

Entry point `bin/pyramid.ts` dispatches on `argv[2]`:
- `version` / `-v` — print version (stdout, scriptable).
- `set-key` / `show-key` / `logout` / `login` — local keychain credential ops, **no
  network**; handled before config load.
- `mcp` — start the stdio MCP server (graceful shutdown on SIGINT/SIGTERM/stdin close).
- `doctor` — auth check: `whoami` + `list_projects` + ping first workflow.
- anything else (incl. none) — hand off to the CLI (`src/cli/index.ts`).

## Source of truth — read before changing behavior

1. **Design intent lives in the Constellation plan** (`constellation/` — typed,
   connected markdown cards). The plan is authoritative for design: behavior changes
   go in the **cards first, then the code**, never the reverse. Query it with the
   `constellation` MCP (`get_card`/`search`/`traverse`) or just read the `.md` files.
2. **The Pyramid HTTP contract is fixed and external** — owned by the sibling repo
   `../pyramid` (the Go API in its `server/` directory; card `EXTERNAL-PYRAMID-API`).
   This package **adapts** to it; it never drives changes to it. Don't guess a response
   shape — confirm it against that repo, and keep parsing **defensive/tolerant**.
3. **Source-file headers cite their Constellation card handles** (e.g. `FILE-SERVER`,
   `DOC-CLI-OUTPUT`, `DOC-NAME-RESOLUTION`) — follow the handle into `constellation/`
   for the detailed contract behind a module. There is no separate flattened spec: the
   old `BUILD-SPEC.md` / `BUILD-SPEC-PHASE1.md` build briefs were removed in favor of
   the **cards + code as the single source of truth** (they had already drifted — e.g.
   stale base URL and module layout). The cards lead; code follows.

## Architecture — one seam

The **operation registry** (`src/operations/index.ts`) is THE single seam. An
`Operation` is `{ name, summary, input (zod), run(input, ctx), meta? }`, and its `run`
owns everything Pyramid-specific: **name→UUID resolution → client call → hydration**.
Both surfaces render from this one registry — no Pyramid/business logic lives anywhere
else:

- `src/mcp/server.ts` registers each op as an MCP tool (`name` / `summary` /
  `input.shape`).
- `src/cli/index.ts` derives CLI commands from `op.meta.cli`.

Runtime flow: `bin` → `loadConfig()` → context `{ config, client, resolver }` →
`operation.run` → render (MCP tool result, or CLI human/JSON + exit code).

## Module map

| File | Responsibility |
|---|---|
| `bin/pyramid.ts` | Thin entry: argv dispatch, transport, signals, exit codes. Lazy-imports the operations graph so it stays off the `mcp`/`doctor`/config-failure paths. |
| `src/config.ts` | env + keychain → `PyramidConfig`. Throws a **plain `Error`** (one stderr line), never a stack. |
| `src/errors.ts` | `McpError { code, message, hint?, candidates? }` + the HTTP-envelope → `code` mapping. |
| `src/types.ts` | Domain types (the `DATATYPE-*` cards). Pure types, no runtime code. |
| `src/client/pyramid-client.ts` | `undici` wrapper — one method per endpoint; joins `baseUrl + /v1 + path`. |
| `src/cache/resolver.ts` | Name/key → UUID resolution with a short-TTL cache. |
| `src/hydrate.ts` | Raw server rows → strict, name-bearing MCP types. |
| `src/operations/index.ts` | The registry — discovery + task read/write + comments. |
| `src/mcp/{server,resources,prompts}.ts` | The MCP skin (tools, `pyramid://` resources, prompts). |
| `src/cli/{index,render}.ts` | argv → operation → render; the output + exit-code contract. |
| `src/keychain.ts` | OS keychain store (macOS `security`; else chmod-600 JSON). The key is never logged. |
| `src/auth-commands.ts` | `set-key` / `show-key` / `logout` / `login` (no network). |
| `src/version.ts` | Package version (read by `pyramid version`). |

## Hard conventions (non-negotiable)

1. **ESM + `NodeNext`** → every relative import path **ENDS IN `.js`**
   (`import { mapError } from './errors.js'`). This is the #1 thing to get right.
   Type-only imports use `import type` (`verbatimModuleSyntax` is on).
2. **Diagnostics/logs → STDERR ONLY** (`process.stderr.write` / `console.error`).
   `stdout` is reserved for the MCP JSON-RPC channel and real CLI data. **Never log the
   API key.**
3. **Every failure is an `McpError { code, ... }`.** Callers act on `code`; they never
   parse `message`. Map HTTP → `code` in `src/errors.ts`.
4. **Names in, hydrated names out.** Inputs accept human names/keys (resolver → UUIDs);
   outputs hydrate names alongside UUIDs. All operation inputs are **zod** schemas.
5. **The operation registry is the only seam** (see Architecture). MCP and CLI both
   render from it; don't add a parallel surface.
6. **Config is env-only** (plus the keychain for the key):
   - `PYRAMID_API_KEY` — required, must start with `pyk_`. Resolves
     `PYRAMID_API_KEY` (env) → OS keychain → error.
   - `PYRAMID_BASE_URL` — default **`https://api.pyramid.magicspells.io`**. The API
     lives on the `api.` subdomain; the bare host serves the web app.
   - `PYRAMID_ALLOW_DESTRUCTIVE` — `"1"` enables destructive ops (e.g. `delete_task`).
     The var was renamed from `PYRAMID_MCP_ALLOW_DESTRUCTIVE`; **only** the new name is
     read.
7. **Stateless** — no DB, no on-disk state except the optional keychain key.

## Testing

`vitest`; `tests/` mirror the `src` modules (config, errors, resolver, operations, cli,
pyramid-client, keychain, auth-commands, version). Tests inject their dependencies (env,
keychain reader, IO sink) so they never touch the real keychain or network. Run
`npm test`.

## Connected repos (siblings)

- `../pyramid` — the Pyramid product repo. Since 2026-09-17 it is one repo, one binary:
  - `server/` — the Go API (chi + pgx + sqlc). Owns the **fixed HTTP contract** and the
    `pyk_` bearer-auth path. Read it to confirm exact endpoint/field shapes.
  - `web/` — the **Puzzle** SPA (not Svelte; the Svelte app of the same name is retired).
    Owns the **Settings → API Keys** screen where users mint `pyk_` keys, and the
    `/auth/cli` page `pyramid login` hands off to. Out of scope here.

  Both halves share one Constellation plan at that repo's root — use `repo: "pyramid"`.

## Publishing

Published to npm as `@magic-spells/pyramid`. `files: ["dist"]` — the compiled `dist/`
only. `bin: { pyramid: "dist/bin/pyramid.js" }`. `prepublishOnly` runs the build.
