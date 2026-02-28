# Legacy Memory Follow-up Migration to Shuvdo

Shuvlr no longer uses memory files for open follow-up/task tracking.

Use this helper to find legacy `## Open Follow-ups` bullets and migrate them into Shuvdo task lists:

```bash
node scripts/migrate-open-followups-to-shuvdo.mjs
```

Dry-run output shows all follow-up bullets found.

To create tasks in Shuvdo:

```bash
export SHUVDO_API="https://your-shuvdo.example.com"
export SHUVDO_TOKEN="..."
export SHUVDO_FOLLOWUPS_LIST="follow-ups" # optional
node scripts/migrate-open-followups-to-shuvdo.mjs --apply
```

The script will call `POST /api/list/:name/add` for each extracted bullet and attach migration context in the task note.
