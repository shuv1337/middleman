# Shuvdo API Contract (for Slopshuvlr integration)

Status: **pinned snapshot** for implementation in this repo.

## Source of truth

Contract investigated from Overseer:

- Repo: `~/repos/overseer`
- Branch: `main`
- Commit: `c645b9e`

Primary source files:

- `apps/fleet-relay/src/shuvdo/legacy-app.ts` (HTTP routes + auth + validation)
- `apps/fleet-relay/src/shuvdo/domain.ts` (repeat rules, idempotency normalization)
- `apps/fleet-relay/src/shuvdo/store.ts` (queue assembly + consumer filtering + item shape)

Behavioral parity tests used as guardrails:

- `apps/fleet-relay/tests/integration/shuvdo-http-parity.test.ts`
- `apps/fleet-relay/tests/integration/shuvdo-routes.test.ts`

---

## Authentication contract

From `legacy-app.ts` auth middleware:

1. Cloudflare Access header:
   - `cf-access-authenticated-user-email`
2. Bearer token:
   - `Authorization: Bearer <token>`
   - host/token identity is resolved by token hash verification in store
3. Dev auto-auth (development mode only)

Failure:

- `401 { "error": "Unauthorized" }`

Important for Slopshuvlr:

- Even admin host tokens are effectively list-scoped through `req.user.lists` in queue/list handlers.

---

## Common response shape

- Success responses are endpoint-specific JSON objects (not a global envelope)
  - examples: `{ lists: [...] }`, `{ item: {...} }`, `{ projects: [...] }`, `{ tasks: [...], reminders: [...] }`
- Error responses are consistently:
  - `{ "error": "<message>" }`

Common statuses used in contract:

- `200` success
- `400` validation/input errors
- `401` unauthenticated
- `403` forbidden
- `404` not found (also used to avoid leaking existence in some access checks)
- `409` conflict (notably claim contention)

---

## Core item payload shape

From `store.ts` `toItem(row)`:

```json
{
  "id": "string",
  "listId": "string",
  "text": "string",
  "done": true,
  "status": "string|null",
  "priority": "string|null",
  "dueAt": "ISO|null",
  "assignee": "string|null",
  "signalGroupId": "string|null",
  "externalRef": "string|null",
  "metadata": {},
  "claimedBy": "string|null",
  "claimedAt": "ISO|null",
  "claimExpiresAt": "ISO|null",
  "repeatRule": "string|null",
  "nextDueAt": "ISO|null",
  "snoozedUntil": "ISO|null",
  "projectId": "string|null",
  "milestoneId": "string|null",
  "addedBy": "string",
  "addedAt": "ISO",
  "doneBy": "string|null",
  "doneAt": "ISO|null",
  "checklist": []
}
```

Queue and project endpoints may enrich items with:

- `list: { id, name, icon, type }`
- `project: { id, name, status }`
- `milestone: { id, name, status }`

---

## Endpoint contract (Slopshuvlr integration scope)

### Lists + item CRUD

- `GET /api/lists` -> `{ lists }`
- `GET /api/list/:name` -> `{ list, items }`
- `POST /api/list/:name/add` -> `{ item }`
- `PATCH /api/list/:name/:id` -> `{ item }`
- `POST /api/list/:name/:id/done` -> `{ item }`
- `DELETE /api/list/:name/:id` -> `{ removed }`

Validation highlights:

- List access check returns `404 List not found` when list missing or not granted.
- Reminder list type requires `dueAt` (workflow required fields).
- `milestoneId` requires `projectId`.

### Reminder queue + completion

- `GET /api/reminders/next?before=<iso>&limit=<n>&consumer=bot|signal` -> `{ reminders }`
- `POST /api/reminders/:id/complete` -> `{ item }`

Rules:

- `limit` must be positive integer.
- `before` must parse as ISO date.
- For token callers, default consumer behavior is effectively `consumer=bot` unless explicitly provided.

Idempotency:

- Supported via `X-Idempotency-Key` header (or `idempotencyKey` body fallback).
- Key format normalization/validation in domain:
  - max length `128`
  - regex `^[A-Za-z0-9._:-]+$`
- Replays return cached result.

Repeat rules:

- Named forms: `daily|weekly|monthly|yearly|hourly`
- Pattern form: `every <n> minute|hour|day|week|month|year` (plural accepted)

### Agent task claim/release + queue

- `POST /api/list/:name/:id/claim` (optional body `ttlMinutes`, default 30)
  - success: `{ item }`
  - conflict when already claimed: `409 { error, claimedBy, claimExpiresAt }`
- `POST /api/list/:name/:id/release` -> `{ item }`
- `GET /api/agents/:id/queue?before=<iso>&limit=<n>` -> `{ tasks, reminders }`

Queue semantics from store:

- `tasks`: agent_tasks assigned to or claimed by `:id`, status != done
- `reminders`: only bot-consumer reminder lists are included
- auth guard: caller must be admin or caller id == `:id` (otherwise `403`)

### Projects + milestones

- `GET /api/projects` -> `{ projects }` (supports `status`, `includeArchived`, `limit`)
- `POST /api/projects/add` -> `{ project }`
- `GET /api/projects/:id` -> `{ project }`
- `PATCH /api/projects/:id` -> `{ project }`
- `POST /api/projects/:id/milestones/add` -> `{ milestone }`
- `PATCH /api/projects/:id/milestones/:milestoneId` -> `{ milestone }`

Authorization model:

- project create: admin user, canCreateProjects user, or admin host token
- project mutate: admin or project owner (or admin host token)
- project view: admin/member/linked-task visibility checks
- unauthorized project view may return `404` intentionally

---

## Integration requirements for Slopshuvlr

1. Treat this document as the contract baseline for implementation in this repo.
2. Do not hardcode behavior that contradicts consumer/list scoping rules above.
3. For scheduler polling (`/api/agents/:id/queue`), ensure token has grants to required lists.
4. For native reminder tooling, expose consumer selection for `/api/reminders/next`.
5. Use idempotency keys for reminder completion retries.
6. Emit OTLP telemetry (Maple ingest) for:
   - queue poll cycles
   - dispatch attempts
   - reminder completion calls
   - retry/failure reasons

---

## Drift policy

If Overseer contract changes:

1. Re-pin commit hash in this doc.
2. Update endpoint semantics here.
3. Re-run or inspect parity tests in Overseer:
   - `shuvdo-http-parity.test.ts`
   - `shuvdo-routes.test.ts`
4. Update Slopshuvlr integration plan/tasks accordingly.
