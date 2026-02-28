---
name: shuvdo
description: Full Shuvdo operations for tasks, reminders, projects, milestones, and agent queues via direct API calls.
env:
  - name: SHUVDO_API
    description: Base URL for Shuvdo API (for example https://shuvdo.example.com)
    required: true
  - name: SHUVDO_TOKEN
    description: Bearer token for Shuvdo API access.
    required: true
---

# Shuvdo

Use this skill for structured work tracking (tasks/reminders/projects/milestones/agent queue).

- Use memory for durable facts/preferences only.
- Use Shuvdo for actionable work management.

## Setup (Shuvlr Settings)

In **Settings → Environment Variables**, configure:

- `SHUVDO_API`
- `SHUVDO_TOKEN`

All calls below assume:

```bash
export SHUVDO_API="https://your-shuvdo.example.com"
export SHUVDO_TOKEN="..."
```

Optional convenience shell helper:

```bash
shuvdo() {
  local method="$1"; shift
  local path="$1"; shift
  curl -sS -X "$method" \
    -H "Authorization: Bearer $SHUVDO_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHUVDO_API$path" "$@"
}
```

## Lists + Items

### List accessible lists

```bash
shuvdo GET /api/lists
```

### Get list + items

```bash
shuvdo GET /api/list/work
```

### Add item

```bash
shuvdo POST /api/list/work/add \
  --data '{"text":"Draft release notes","priority":"medium"}'
```

### Update item

```bash
shuvdo PATCH /api/list/work/ITEM_ID \
  --data '{"text":"Draft release notes v2","priority":"high"}'
```

### Complete/toggle item

```bash
shuvdo POST /api/list/work/ITEM_ID/done --data '{}'
```

### Delete item

```bash
shuvdo DELETE /api/list/work/ITEM_ID
```

## Reminders

### List due reminders (token callers default to consumer=bot)

```bash
shuvdo GET '/api/reminders/next?limit=25'
shuvdo GET '/api/reminders/next?consumer=signal&limit=25'
```

### Complete reminder (idempotent)

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $SHUVDO_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: reminder-complete-$(date +%s)-$RANDOM" \
  "$SHUVDO_API/api/reminders/REMINDER_ID/complete" \
  --data '{}'
```

### Create reminder via list add

Reminder recurrence and auto-advance use `repeatRule` semantics.

```bash
shuvdo POST /api/list/reminders/add \
  --data '{
    "text":"Check backup health",
    "dueAt":"2026-03-01T15:00:00.000Z",
    "repeatRule":"weekly"
  }'
```

## Agent queue + claim/release

### Get agent queue (`tasks` + `reminders`)

```bash
shuvdo GET /api/agents/manager/queue
```

### Claim task

```bash
shuvdo POST /api/list/work/ITEM_ID/claim \
  --data '{"agentId":"manager"}'
```

### Release task

```bash
shuvdo POST /api/list/work/ITEM_ID/release \
  --data '{"agentId":"manager"}'
```

## Projects + milestones

### List projects

```bash
shuvdo GET /api/projects
```

### Create project

```bash
shuvdo POST /api/projects/add \
  --data '{"name":"Q2 Reliability","status":"active"}'
```

### Show project

```bash
shuvdo GET /api/projects/PROJECT_ID
```

### Update project

```bash
shuvdo PATCH /api/projects/PROJECT_ID \
  --data '{"status":"on_hold"}'
```

### Add milestone

```bash
shuvdo POST /api/projects/PROJECT_ID/milestones/add \
  --data '{"name":"Milestone 1","status":"active"}'
```

### Update milestone

```bash
shuvdo PATCH /api/projects/PROJECT_ID/milestones/MILESTONE_ID \
  --data '{"status":"done"}'
```

## Troubleshooting

- `401 Unauthorized`
  - Missing/invalid bearer token.
  - Verify `SHUVDO_TOKEN` and `Authorization: Bearer ...` header.
- `403 Forbidden`
  - Caller lacks list/project permissions (RBAC).
  - Confirm token has required list grants / admin scope.
- `404 Not Found`
  - Wrong list/project/item/reminder id or inaccessible resource.
- `400 Bad Request`
  - Invalid payload shape/field values (for example missing required fields).

For retries on reminder completion, always send a stable `X-Idempotency-Key`.
