---
name: Pyramid
connected_repos:
  - name: pyramid
    path: ../pyramid
    description: >-
      The Pyramid product repo — one repo, one binary since 2026-09-17. The Go API this MCP/CLI
      calls is in `server/` (owns the fixed HTTP contract + api_keys auth); the Puzzle web client is
      in `web/` (owns Settings -> API Keys and the /auth/cli handoff). One plan at its root.
  - name: pyramid-ios
    path: ../pyramid-ios
    description: >-
      Native SwiftUI iOS viewer app (iOS 26+). Sibling client of the same Pyramid API; no direct
      interaction with the MCP/CLI.
---

## What this is

`@magic-spells/pyramid` is a TypeScript client package with two thin surfaces over one shared core:

- `pyramid mcp` — a stdio MCP server for AI clients such as Claude Code, Claude Desktop, and Cursor.
- `pyramid ...` — a terminal CLI for humans, scripts, CI, and shell-only agents.

Both surfaces drive [Pyramid](../pyramid) from natural language or command-line intent, resolving human names and task keys (`WEB-42`, `"In Review"`, an email) to UUIDs and hydrating responses back into names so the caller does not reason over raw IDs.

This plan owns the MCP/CLI package design itself; the server-side backend contract is owned by the `pyramid` repo (the Go API in its `server/` directory) and referenced through [[EXTERNAL-PYRAMID-API]]. See [[DOC-ARCHITECTURE]] and [[DIAGRAM-OVERVIEW]].

Naming note (2026-09-17): this repo's folder is `pyramid-cli`, while the npm package stays `@magic-spells/pyramid` and the binary stays `pyramid`. The old sibling repos `pyramid-server` and `pyramid-web` were merged into the single `pyramid` repo on the same date — `server/` and `web/` inside it.

## Source of truth


The **Pyramid HTTP contract is fixed and external** — owned by the `pyramid` repo, in its `server/` Go module ([[EXTERNAL-PYRAMID-API]]). This package adapts to that contract; it does not drive backend behavior. When building a tool, read the real endpoint shape from that repo's plan via the `repo:` selector (`repo: "pyramid"`) rather than guessing. That one plan now covers both the API and the web client, so the client's view of an endpoint is in the same place.

Auth is settled and shipped ([[DOC-AUTH-WORKSPACE]]): a `pyk_` key is pinned to one workspace and inherits exactly its owner's access.

## Stack & distribution

- **TypeScript** (ESM, Node >= 22) builds to `dist/`; npm package is `@magic-spells/pyramid`, run with `npx -y @magic-spells/pyramid ...`. The MCP server is explicit: `npx -y @magic-spells/pyramid mcp`. See [[DOC-PACKAGE-RENAME]] and [[DOC-PACKAGING]].
- `@modelcontextprotocol/sdk` (server), `zod` (tool schemas), and `undici` (HTTP client). MCP transport is **stdio**. See [[FILE-SERVER]] and [[FILE-PYRAMID-CLIENT]].
- Config is read once by [[FILE-CONFIG]]. API key resolution is `PYRAMID_API_KEY` env -> OS keychain -> error ([[FLOW-CREDENTIAL-RESOLUTION]], [[DOC-CREDENTIAL-STORAGE]]). `PYRAMID_BASE_URL` defaults to `https://api.pyramid.magicspells.io`; destructive operations are gated by `PYRAMID_ALLOW_DESTRUCTIVE=1`.
- `pyramid login` is the preferred local setup path: it opens the web client's `/auth/cli` page (served by the `pyramid` repo, from `web/`), receives a minted `pyk_` key through a loopback callback, and stores it in the same keychain slot used by `mcp`, `doctor`, and CLI commands.

## Current maturity

- Built and unit-tested: package/bin dispatch, `mcp`, `doctor`, `version`, local credential commands including browser login handoff, config/keychain resolution, MCP resources/prompts, CLI rendering, resolver/client/error plumbing, and the core task/comment operations represented by the operation registry.
- Still future/planned: collaboration/admin extras ([[PLAN-PHASE-3-COLLAB-ADMIN]]) and v2 roadmap items ([[PLAN-V2-ROADMAP]]).

## Conventions

- Every operation: inputs accept **names** not UUIDs where possible; outputs **hydrate** names alongside UUIDs; errors are **typed** ([[DATATYPE-MCP-ERROR]]). The invariants that close off AI failure modes are in [[DOC-DESIGN-RULES]].
- MCP tools are modeled as `API-` cards with `kind: mcp-tool`. Core mutations get their own card; read and discovery tools are grouped in `DOC-TOOLS-*` cards.
- Read-friendly by default: shipped hard delete requires `PYRAMID_ALLOW_DESTRUCTIVE=1`, and the CLI requires `--yes`; future bulk fan-outs should use preview/confirm before touching many tasks.
