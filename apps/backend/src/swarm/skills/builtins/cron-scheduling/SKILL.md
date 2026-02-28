---
name: cron-scheduling
description: Create, list, and remove persistent scheduled tasks using cron expressions.
---

# Cron Scheduling (Legacy)

Use this legacy skill only for backwards compatibility with existing cron schedules.
Prefer the `shuvdo` skill for new reminders/tasks.

Use this skill when the user asks to schedule, reschedule, or cancel reminders/tasks for later.

Before creating a schedule, confirm:
- exact schedule timing (cron expression),
- timezone (IANA, for example `America/Los_Angeles`),
- task message content.

If the request is ambiguous, ask a follow-up question before adding a schedule.

## Storage

Schedules are stored at:
- `${SWARM_DATA_DIR}/schedules/<managerId>.json`

## Commands

Run the scheduler CLI from the repository root:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js add \
  --manager "manager" \
  --name "Daily standup reminder" \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --timezone "America/Los_Angeles"
```

One-shot schedule (fires once at the next matching cron time):

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js add \
  --manager "manager" \
  --name "One-time deployment check" \
  --cron "30 14 * * *" \
  --message "Check deployment status" \
  --timezone "America/Los_Angeles" \
  --one-shot
```

Remove a schedule:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js remove \
  --manager "manager" \
  --id "<schedule-id>"
```

List schedules:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js list --manager "manager"

`--manager` is optional. If omitted, the CLI will auto-select a manager when there is only one manager
or when a known default manager is detected.
```

## Output

All commands return JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`
