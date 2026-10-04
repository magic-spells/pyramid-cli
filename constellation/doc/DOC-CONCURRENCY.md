---
name: Optimistic concurrency (If-Match / ETag)
kind: rule
status: built
connections:
  - DOC-BACKEND-CONTRACT
  - DOC-ERROR-MODEL
  - DATATYPE-MCP-ERROR
  - FILE-PYRAMID-CLIENT
  - API-TOOL-UPDATE-TASK
---

# Optimistic concurrency (If-Match / ETag)

The backend enforces optimistic concurrency on a subset of mutations. A mutation without a
valid precondition is rejected — so the MCP must participate, transparently.

- **Token.** The ETag is the resource's `updated_at` rendered RFC3339Nano (UTC). GET and PATCH
  task responses return it in the **`ETag`** response header; comment responses do **not** —
  read `updated_at` from the comment body instead.
- **Required on:** `PATCH /v1/tasks/{id}` (update), `DELETE /v1/tasks/{id}` (soft+hard),
  `PATCH /v1/comments/{id}`, `DELETE /v1/comments/{id}`. **Not** required on create, move,
  archive/unarchive, or bulk.
- **Failure.** Absent **or** stale `If-Match` → HTTP **409** with envelope code `conflict`
  (the two cases differ only by `message`). There is no 412.

Because owner/reviewer now ride the task PATCH ([[DOC-BACKEND-CONTRACT]]), an ownership change
is covered by the same precondition as any other field — there is no longer an unguarded
`stage-responsibilities` write that could land while the content patch was rejected.

**MCP flow (read-modify-write, hidden from the AI).** For update/delete the client does a
**GET first** to capture the current `ETag` (or the body's `updated_at`), then sends it as
`If-Match` on the PATCH/DELETE. On a 409 it may refetch + retry **once** (a genuine concurrent
edit), then surface a typed `conflict` [[DATATYPE-MCP-ERROR]] with a "task changed underneath
you; reread it" hint. The AI never sees ETags — it passes names, the client handles the
precondition. Owned by [[FILE-PYRAMID-CLIENT]]; mapping in [[DOC-ERROR-MODEL]].
