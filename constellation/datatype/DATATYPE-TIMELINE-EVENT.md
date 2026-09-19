---
name: TimelineEvent
status: built
connections:
  - DATATYPE-TASK-DETAIL
  - DOC-RENDERING
---


One hydrated row of a task's history, returned by [[API-TOOL-GET-TASK-TIMELINE]]. The server
row is all UUIDs ([[DOC-BACKEND-CONTRACT]]); the MCP joins the actor to a name like every other
surface ([[DOC-DESIGN-RULES]] rule 4) and passes the rest through defensively, because the event
payload shape varies per `event_type` and new types appear without a client change.

```ts
interface TimelineEvent {
  id: string;
  task_id: string;
  event_type: string;        // e.g. "owner_changed", "reporter_changed", "status_changed"
  actor: UserStub | null;    // actor_id joined to a name; null for system events
  old_value: unknown;        // shape depends on event_type
  new_value: unknown;
  data: Record<string, unknown>;
  created_at: string;        // ISO 8601
}
```

**Do not type the values.** For `owner_changed` / `reporter_changed` the server sends
`old_value` / `new_value` as a **bare user uuid or null**, not an object — other event types use
other shapes. The op keeps them `unknown` and resolves names only where it knows the type,
rather than inventing a discriminated union that the next server release would break.

Events come back **oldest first**, opposite to every other paginated list in this package, and
`is_deleted` rows (admin/PM redactions) are filtered server-side.
