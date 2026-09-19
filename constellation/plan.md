---
name: Pyramid
connected_repos:
  - name: pyramid-server
    path: ../pyramid-server
    description: >-
      Go API (chi + pgx + sqlc) the MCP calls. Owns the fixed HTTP contract + the api_keys auth
      path.
  - name: pyramid-web
    path: ../pyramid-web
    description: >-
      Svelte SPA. Owns the Settings → API Keys screen where users mint pyk_ keys (out of scope
      here).
  - name: pyramid-ios
    path: ../pyramid-ios
    description: >-
      Native SwiftUI iOS viewer app (iOS 26+). Sibling client of the same pyramid-server API; no
      direct interaction with the MCP/CLI.
---

## What this is

`@magic-spells/pyramid` is a TypeScript client package with two thin surfaces over one shared core:

- `pyramid mcp` — a stdio MCP server for AI clients such as Claude Code, Claude Desktop, and Cursor.
- `pyramid ...` — a terminal CLI for humans, scripts, CI, and shell-only agents.

Both surfaces drive [Pyramid](../pyramid-server) from natural language or command-line intent, resolving human names and task keys (`WEB-42`, `"In Review"`, an email) to UUIDs and hydrating responses back into names so the caller does not reason over raw IDs.

This plan owns the MCP/CLI package design itself; the server-side backend contract is owned by `pyramid-server` and referenced through [[EXTERNAL-PYRAMID-API]]. See [[DOC-ARCHITECTURE]] and [[DIAGRAM-OVERVIEW]].

## Source of truth


The **Pyramid HTTP contract is fixed and external** — owned by `pyramid-server` ([[EXTERNAL-PYRAMID-API]]). This package adapts to that contract; it does not drive backend behavior. When building a tool, read the real endpoint shape from the server plan via the `repo:` selector (`repo: "pyramid-server"`) rather than guessing.

Auth is settled and shipped ([[DOC-AUTH-ORGANIZATION]]): a `pyk_` key is pinned to one organization and inherits exactly its owner's access.

## Stack & distribution

- **TypeScript** (ESM, Node >= 22) builds to `dist/`; npm package is `@magic-spells/pyramid`, run with `npx -y @magic-spells/pyramid ...`. The MCP server is explicit: `npx -y @magic-spells/pyramid mcp`. See [[DOC-PACKAGE-RENAME]] and [[DOC-PACKAGING]].
- `@modelcontextprotocol/sdk` (server), `zod` (tool schemas), and `undici` (HTTP client). MCP transport is **stdio**. See [[FILE-SERVER]] and [[FILE-PYRAMID-CLIENT]].
- Config is read once by [[FILE-CONFIG]]. API key resolution is `PYRAMID_API_KEY` env -> OS keychain -> error ([[FLOW-CREDENTIAL-RESOLUTION]], [[DOC-CREDENTIAL-STORAGE]]). `PYRAMID_BASE_URL` defaults to `https://api.pyramid.magicspells.io`; destructive operations are gated by `PYRAMID_ALLOW_DESTRUCTIVE=1`.
- `pyramid login` is the preferred local setup path: it opens `pyramid-web` `/auth/cli`, receives a minted `pyk_` key through a loopback callback, and stores it in the same keychain slot used by `mcp`, `doctor`, and CLI commands.

## Current maturity

- Built and unit-tested: package/bin dispatch, `mcp`, `doctor`, `version`, local credential commands including browser login handoff, config/keychain resolution, MCP resources/prompts, CLI rendering, resolver/client/error plumbing, and the core task/comment operations represented by the operation registry.
- Still future/planned: collaboration/admin extras ([[PLAN-PHASE-3-COLLAB-ADMIN]]) and v2 roadmap items ([[PLAN-V2-ROADMAP]]).

## Conventions

- Every operation: inputs accept **names** not UUIDs where possible; outputs **hydrate** names alongside UUIDs; errors are **typed** ([[DATATYPE-MCP-ERROR]]). The invariants that close off AI failure modes are in [[DOC-DESIGN-RULES]].
- MCP tools are modeled as `API-` cards with `kind: mcp-tool`. Core mutations get their own card; read and discovery tools are grouped in `DOC-TOOLS-*` cards.
- Read-friendly by default: shipped hard delete requires `PYRAMID_ALLOW_DESTRUCTIVE=1`, and the CLI requires `--yes`; future bulk fan-outs should use preview/confirm before touching many tasks.
