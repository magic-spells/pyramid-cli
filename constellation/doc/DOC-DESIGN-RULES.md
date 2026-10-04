---
name: Critical design rules
kind: rule
status: built
connections:
  - EXTERNAL-PYRAMID-API
  - DATATYPE-MCP-ERROR
  - DATATYPE-MOVE-TASK-INPUT
  - DATATYPE-MCP-CONFIG
  - FILE-OPERATIONS
---

# Critical design rules

Each closes off a class of failure mode. Every operation ([[FILE-OPERATIONS]]) MUST uphold these —
they hold for BOTH surfaces (MCP tools + CLI).

1. **`task` == `task`** — API and product both say `task`.
2. **Human keys resolve to UUIDs** — `WEB-42` → backing UUID before any mutating call; the key is
   derived, never stored.
3. **Status carries stage (input)** — a task has only `status_id`; stage is derived. Never accept
   both `stage` and `status` except to resolve ambiguity. Placement is by status; a body `stage_id`
   is ignored server-side.
4. **Hydrate every UUID on output** — NO bare UUID in any user-facing field. Every returned
   `status_id` → status name + derived stage; `owner_id`/`reviewer_id`/`author_id`/`mentions` →
   display name; label ids → names. Centralized so no operation can leak an id (a tested invariant).
5. **Comments are stage-scoped** — a root comment needs a `stage_id`; default to the task's current
   stage when omitted.
6. **Replies are 1-level only** — reply-to-reply → `reply_depth_exceeded`, validated before the call.
7. **Positions are server-generated** — pass neighbor keys (`after` / `before`); never expose the
   fractional position string. Reorder accepts at most ONE neighbor (server derives the other bound).
8. **Custom-field values are typed** — validate against the field's `field_type` before sending →
   `invalid_field_value`.
9. **Soft deletes are pervasive** — list operations default `archived = false`; opt in to see
   archived/deleted items.
10. **Never auto-paginate** — list ops take `limit` (default ~25, cap ~50) + `cursor` and return
    `{ items, next_cursor, has_more }`; surface "showing N of M — ask for more," never silently
    walk every page.
11. **Gate destructive and bulk actions** — shipped hard delete requires
    `PYRAMID_ALLOW_DESTRUCTIVE=1` ([[DATATYPE-MCP-CONFIG]]); the CLI additionally requires `--yes`.
    Future bulk fan-outs should use an explicit preview/confirm flow before touching many tasks.
12. **Dates are UTC** — render timestamps UTC-labeled or relative-with-label, never bare local;
    date-only fields (due/start) without a time.
