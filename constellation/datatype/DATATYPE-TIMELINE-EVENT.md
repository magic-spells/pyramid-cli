---
name: TimelineEvent
status: built
connections:
  - DATATYPE-TASK-DETAIL
  - DOC-RENDERING
notes:
  - kind: state
    text: >-
      "Resolves names only where it knows the type" is now actually implemented:
      hydrateTimelineEvent joins old_value/new_value to a UserStub for the two event kinds whose
      values are a bare user uuid (owner_changed, reporter_changed) and passes every other kind
      through verbatim. Two guards matter — a value that is not a non-empty string inside a known
      kind is passed through untouched, and a uuid the cached workflow does not know keeps its raw
      uuid rather than collapsing to the empty display_name that the member lookup returns for a
      stranger (which the generic CLI table would render as a blank cell, losing the only fact in
      the row). The values stay typed `unknown`: an unknown event_type still survives a client that
      has never heard of it.
---

One hydrated row of a task's history, returned by [[API-TOOL-GET-TASK-TIMELINE]]. The server
row is all UUIDs ([[DOC-BACKEND-CONTRACT]]); the MCP joins the actor to a name like every other
surface ([[DOC-DESIGN-RULES]] rule 4) and passes the rest through defensively, because the event
payload shape varies per `event_type` and new types appear without a client change.

```ts
interface TimelineEvent {
  id: string;
  task_id: string;
  event_type: string;        // e.g. "owner_changed", "reviewer_changed", "status_changed"
  actor: UserStub | null;    // actor_id joined to a name; null for system events
  old_value: unknown;        // shape depends on event_type
  new_value: unknown;
  data: Record<string, unknown>;
  created_at: string;        // ISO 8601
}
```

**Do not type the values.** For `owner_changed` / `reviewer_changed` the server sends
`old_value` / `new_value` as a **bare user uuid or null**, not an object — other event types use
other shapes. The op keeps them `unknown` and resolves names only where it knows the type,
rather than inventing a discriminated union that the next server release would break.

Events come back **oldest first**, opposite to every other paginated list in this package, and
`is_deleted` rows (admin/PM redactions) are filtered server-side.
