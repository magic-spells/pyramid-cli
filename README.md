# @magic-spells/pyramid

An MCP server **and** CLI over one shared core for the [Pyramid](https://pyramid.magicspells.io) project-management API. Pass human names and task keys (`WEB-42`, `"In Review"`, an email) — the server resolves them to IDs and hydrates names back into every response.

## Install

`@magic-spells/pyramid` is a single package that runs as both a **CLI** and an **MCP server**. Requires Node ≥ 22.

### As a CLI

Zero-install with `npx`:

```sh
npx -y @magic-spells/pyramid --help
```

…or install it globally for a persistent `pyramid` command:

```sh
npm install -g @magic-spells/pyramid
pyramid --help
```

### As an MCP server

The same binary speaks MCP over stdio via the `mcp` subcommand — register it with your client.

**Claude Code:**

```sh
claude mcp add pyramid -- npx -y @magic-spells/pyramid mcp
```

**Claude Desktop / other clients** — add to your MCP config:

```json
{
  "mcpServers": {
    "pyramid": {
      "command": "npx",
      "args": ["-y", "@magic-spells/pyramid", "mcp"],
      "env": {
        "PYRAMID_API_KEY": "pyk_..."
      }
    }
  }
}
```

All diagnostics go to stderr; stdout is the JSON-RPC channel.

## Set your API key

First, mint a key: open Pyramid → **Settings → API Keys** and generate one. It looks like `pyk_<prefix>_<secret>`. Then hand it to Pyramid one of two ways.

### With the CLI

Store it once in your OS keychain — the CLI **and** the MCP server both read it automatically, so you only do this once:

```sh
pyramid set-key pyk_...          # aliases: set-token, set-api-key
pyramid show-key                 # print it back, masked
pyramid logout                   # clear it
```

Prefer an env var for the current shell? `export PYRAMID_API_KEY="pyk_..."` works too and takes priority over the keychain (resolution order: env → keychain → error).

### With the MCP server

Hand the key to your MCP client so the server gets it on launch:

- **Claude Code:** `claude mcp add pyramid -e PYRAMID_API_KEY=pyk_... -- npx -y @magic-spells/pyramid mcp`
- **Claude Desktop / others:** the `PYRAMID_API_KEY` entry in the `env` block above.

If you already ran `pyramid set-key`, you can leave the key out of the MCP config entirely — the server falls back to the keychain. (If your client can't reach the OS keychain, keep it in the `env` block.)

### Confirm it works

```sh
npx -y @magic-spells/pyramid doctor
```

## MCP tools

The server exposes **16 tools**. Every tool takes human **names/keys** as input (`WEB-42`, `"In Review"`, an email) and returns responses **hydrated** with names alongside ids — so the model reasons in names, not UUIDs. The CLI mirrors these 1:1.

**Discovery**

| Tool | What it does |
|---|---|
| `whoami` | The authenticated user, their org, and the projects they can access. |
| `list_projects` | Every project accessible to you. |
| `get_project_workflow` | A project's stages, statuses, labels, members, and custom-field templates — the vocabulary every other call resolves names against. |

**Tasks — read**

| Tool | What it does |
|---|---|
| `list_my_tasks` | Tasks you own or report, newest first, across projects. Cap with `limit`; paginate with `cursor`. |
| `list_tasks` | A project's tasks, filtered by `status` / `stage` / `owner` / `reporter` / `label` / `query`, or `archived` for the archive. Paginated. |
| `get_task` | One task's full detail by key (`WEB-42`) or UUID; `expand` inlines owner/reporter/labels. |
| `get_task_timeline` | A task's history — who changed what, when — oldest first. Narrow with `event_type` (e.g. `owner_changed`). Paginated. |
| `search_tasks` | Full-text search across the org by title/key/content. |

**Tasks — write**

| Tool | What it does |
|---|---|
| `create_task` | Create a task — names/keys for stage, status, owner, reporter, labels, priority, due date, estimate, and custom fields. |
| `create_tasks_bulk` | Create up to 100 tasks at once from a required template, with shared `defaults`. |
| `update_task` | Edit a task — title/description/priority/dates/estimate and its owner/reporter (pass an empty value to clear one), plus add/remove labels and custom fields. |
| `move_task` | Move a task to a target status (which carries its stage), optionally positioned `after_task` / `before_task`. |
| `archive_task` | Soft-archive or unarchive a task. Reversible. |
| `delete_task` | Hard-delete a task. **Gated** — requires `PYRAMID_ALLOW_DESTRUCTIVE=1`, else `destructive_action_disabled`. |

**Comments**

| Tool | What it does |
|---|---|
| `add_comment` | Add a stage-scoped comment (defaults to the task's current stage); `mentions` accepts names/emails. |
| `reply_to_comment` | Reply to a root comment — one level deep (replying to a reply is `reply_depth_exceeded`). |
| `list_comments` | A task's comments, oldest first; defaults to the current stage, `stage: "all"` lists every stage. |

## CLI quickstart

The CLI mirrors the MCP tools 1:1. The agent loop is **`task next → task update → task comment`**:

```sh
# What should I work on?
pyramid task next --json

# Move it forward / change owner / edit fields
pyramid task update WEB-42 --owner cory@example.com --add-labels backend

# Drop a note (stage-scoped — defaults to the task's current stage)
pyramid task comment WEB-42 "Picking this up now"
```

More commands:

```sh
pyramid whoami
pyramid project list
pyramid project workflow <PROJECT>
pyramid task next [--limit N]
pyramid task list <PROJECT> [--status S] [--stage G] [--owner U] [--reporter U] [--label L] [--archived]
pyramid task show <KEY> [--expand]
pyramid task timeline <KEY> [--event-type owner_changed] [--limit N]
pyramid task search <QUERY> [--limit N]
pyramid task create <TITLE> --project P [--status S] [--owner U] [--reporter U] [--labels L] [--priority P] [--due-date D]
pyramid task move <KEY> --status "In Review" [--after-task KEY | --before-task KEY]
pyramid task archive <KEY>
pyramid task delete <KEY>          # gated by PYRAMID_ALLOW_DESTRUCTIVE=1
pyramid comment list <KEY> [--stage G]
pyramid comment reply <COMMENT_ID> "<TEXT>"

# Local — no network call
pyramid set-key <pyk_...>          # store the key in your OS keychain (aliases: set-token, set-api-key)
pyramid show-key                   # print the stored key, masked
pyramid logout                     # clear the stored key
pyramid version                    # print the package version
```

Output is a compact human line in a TTY and JSON when piped or with `--json` (auto-JSON for agents). Diagnostics, prompts, and confirmations go to stderr; stdout is data only. Lists never silently truncate — they surface `next_cursor` (use `--all` to page through, `--limit` to cap).

## Doctor

```sh
pyramid doctor
```

Validates your key, calls `whoami`, lists your projects, and pings the first project's workflow endpoint — the fastest way to confirm auth and connectivity.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PYRAMID_API_KEY` | yes | — | Your `pyk_`-prefixed API key. **Env-only** — never a CLI flag, to keep it out of shell history. Falls back to the OS keychain (`pyramid set-key`) when unset. |
| `PYRAMID_BASE_URL` | no | `https://api.pyramid.magicspells.io` | API base URL — the API lives on the `api.` subdomain (override with `--base-url`). |
| `PYRAMID_ALLOW_DESTRUCTIVE` | no | — | Set to `1` to enable destructive operations (e.g. `task delete`). |

## Errors

Every failure is one shape: `{ code, message, hint?, candidates? }`. **Act on the `code`, never parse the `message`.** `ambiguous_*` errors list `candidates`; `*_not_found` errors hint the closest available names. Full code union: see [`src/errors.ts`](./src/errors.ts).

CLI exit codes encode the error class (`3` auth, `4` permission, `5` not-found, `6` ambiguous, `7` validation/conflict, `8` destructive-disabled, `9` rate-limited, `10` network, `1` unknown, `2` usage).

## License

MIT
