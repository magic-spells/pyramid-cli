---
name: CLI design
kind: guide
status: built
connections:
  - DOC-ARCHITECTURE
  - FILE-OPERATIONS
  - FILE-CLI
  - DOC-CLI-OUTPUT
  - DATATYPE-CLI-OPTIONS
  - DOC-NAME-RESOLUTION
---

# CLI design

## Why a CLI when there's already an MCP

The MCP serves agents that *speak MCP* (Claude Code / Desktop, Cursor, custom MCP runtimes).
The CLI covers the quadrant MCP structurally cannot:

- **Humans** at a terminal.
- **Scripts / CI / cron** — non-LLM automation.
- **Shell-only agents** — a model given a Bash tool but no MCP host. For these the CLI *is* the
  integration surface: `pyramid task next --json`, do the work, `pyramid task update`.

It is additive, not a replacement — same core, second skin ([[DOC-ARCHITECTURE]]).

## One bin, subcommands

`pyramid <group> <verb> [args] [--flags]` ([[DATATYPE-CLI-OPTIONS]]). `pyramid mcp` starts the
stdio server; `pyramid doctor` is the auth check; the rest mirror the MCP tools **1:1** because
both render from [[FILE-OPERATIONS]]. Verb ≡ tool, so an agent's mental model transfers between
the two surfaces.

## Surface (mirrors the MCP operations)

- `pyramid whoami` · `pyramid project list` · `pyramid project workflow <PROJECT>`
- `pyramid task list [--project P] [--status S] [--owner U] [--reviewer U] [--mine] [--archived]`
- `pyramid task show <KEY>` · `pyramid task next` — the caller's work queue
- `pyramid task timeline <KEY> [--event-type owner_changed] [--limit N]` — what happened to it
- `pyramid task create <TITLE> [--owner U] [--reviewer U] …` · `pyramid task bulk <PROJECT> --template T --file tasks.json` · `pyramid task update <KEY> [--owner U|--owner ""] …`
- `pyramid task move <KEY> --status "In Review" [--after KEY | --before KEY]`
- `pyramid task comment <KEY> "…"` · `pyramid comment reply <ID> "…"`
- `pyramid task archive <KEY>` (`--unarchive` restores) · `pyramid task delete <KEY> --yes` — gated ([[DOC-DESIGN-RULES]] r11)

People are named with `--owner` and `--reviewer` everywhere — never "assignee". On
`task update`, an empty `--owner ""` clears the field.

Inputs accept **names / keys**, not UUIDs ([[DOC-NAME-RESOLUTION]]); output hydrates names —
the same invariants the MCP upholds. The headline path is the agent loop: `task next` →
do work → `task update` / `task comment`. Output / exit-code / stream contract:
[[DOC-CLI-OUTPUT]].
