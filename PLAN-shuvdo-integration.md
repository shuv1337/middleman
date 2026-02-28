# PLAN: Shuvdo Integration

## 0. Shuvlr Rebrand + Telemetry Prerequisites
### Problem / Current State
This plan originally referenced Shuvdo contracts without pinning a concrete source. Investigation confirms the canonical contract behavior currently lives in the Overseer repo (`/home/shuv/repos/overseer`) on branch `main` at commit `c645b9e`.

### Confirmed Contract Sources (Investigated)
Primary HTTP contract (routes, auth, request validation, response envelopes):
- `/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/legacy-app.ts`

Supporting domain/queue semantics:
- `/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/domain.ts` (repeat rules, idempotency normalization, reminder completion semantics)
- `/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/store.ts` (queue payload shapes, bot/signal consumer scoping, agent queue assembly)

Behavioral parity tests (contract guardrails):
- `/home/shuv/repos/overseer/apps/fleet-relay/tests/integration/shuvdo-http-parity.test.ts`
- `/home/shuv/repos/overseer/apps/fleet-relay/tests/integration/shuvdo-routes.test.ts`

### Proposed Changes (with file paths)
- Use **Shuvlr** as canonical product naming in all new skill/docs/UI copy touched by this integration.
- Do not carry forward legacy Middleman aliases in this plan; use Shuvlr naming only.
- Add local Shuvdo contract reference doc in this repo at `docs/integrations/shuvdo-api-contract.md`, explicitly sourced from the Overseer files above (with commit pin).
- Add telemetry requirements for every new integration path, exported via OTLP to Maple ingest:
  - queue polling loop instrumentation,
  - reminder dispatch success/failure + latency,
  - reminder completion ACK success/failure + latency,
  - migration conversion/report counters.

### Task Breakdown
- [x] Add `docs/integrations/shuvdo-api-contract.md` with endpoint semantics sourced from Overseer (`legacy-app.ts`, `domain.ts`, `store.ts`, parity tests) and include source commit pin.
- [x] Update plan wording/examples to use Shuvlr naming by default.
- [x] Add explicit telemetry deliverables and validation to scheduler/tools/skill sections below.

### Validation Criteria
- Implementers can complete this plan without depending on undocumented or ambiguous contract assumptions.
- New user-facing copy introduced by this work uses Shuvlr branding.
- Telemetry coverage is defined for every new Shuvdo code path before implementation begins and is wired to Maple OTLP ingest.

## 1. Shuvdo Skill (SKILL.md)
### Problem / Current State
Shuvlr (current codebase still using Middleman-era internals) currently ships built-in skills for `memory`, `brave-search`, `cron-scheduling`, `agent-browser`, `image-generation`, and `gsuite` (`apps/backend/src/swarm/swarm-manager.ts:1989-2015`), but no Shuvdo skill.

Skill env requirements are discovered from YAML frontmatter via `parseSkillFrontmatter()` and `parseSkillEnvDeclarations()` (`apps/backend/src/swarm/swarm-manager.ts:3201-3320`). `listSettingsEnv()` reads these declarations and exposes them in Settings (`apps/backend/src/swarm/swarm-manager.ts:1315-1357`, `apps/backend/src/ws/server.ts:778-825`).

Shuvdo API surface is available in Overseer via bearer auth (`/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/legacy-app.ts:352-370`) and includes all required task/reminder/project/queue endpoints.

### Proposed Changes (with file paths)
- Add built-in skill doc at `apps/backend/src/swarm/skills/builtins/shuvdo/SKILL.md`.
- Follow existing skill format conventions from:
- `apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md:1-9`
- `apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md:1-4`
- `apps/backend/src/swarm/skills/builtins/memory/SKILL.md:1-4`
- `apps/backend/src/swarm/skills/builtins/gsuite/SKILL.md:1-17`
- Include YAML frontmatter env declarations:
- `SHUVDO_API` (required)
- `SHUVDO_TOKEN` (required)
- Teach manager to use direct `curl` workflows with `Authorization: Bearer $SHUVDO_TOKEN` against `$SHUVDO_API`.

Route coverage to include in SKILL (from `/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/legacy-app.ts`):

| Capability | Method + Route | Source |
|---|---|---|
| List accessible lists | `GET /api/lists` | `405-409` |
| Get list + items | `GET /api/list/:name` | `411-429` |
| Add item | `POST /api/list/:name/add` | `431-562` |
| Update item | `PATCH /api/list/:name/:id` | `611-802` |
| Complete/toggle item | `POST /api/list/:name/:id/done` | `564-609` |
| Delete item | `DELETE /api/list/:name/:id` | `804-816` |
| Due reminders | `GET /api/reminders/next` | `1006-1038` |
| Complete reminder | `POST /api/reminders/:id/complete` | `1040-1088` |
| Claim agent task | `POST /api/list/:name/:id/claim` | `1091-1131` |
| Release agent task | `POST /api/list/:name/:id/release` | `1133-1154` |
| Agent queue | `GET /api/agents/:id/queue` | `1156-1179` |
| List projects | `GET /api/projects` | `1670-1702` |
| Create project | `POST /api/projects/add` | `1704-1784` |
| Show project | `GET /api/projects/:id` | `1786-1809` |
| Update project | `PATCH /api/projects/:id` | `1811-1871` |
| Add milestone | `POST /api/projects/:id/milestones/add` | `1919-1949` |
| Update milestone | `PATCH /api/projects/:id/milestones/:milestoneId` | `1951-1989` |

Behavior notes to include in SKILL examples:
- Reminder recurrence format and auto-advance logic use `repeatRule` + domain completion logic (`/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/domain.ts`: `parseRepeatRule` ~154, `completeReminderItem` ~240).
- Idempotency keys are supported for reminder completion (`/home/shuv/repos/overseer/apps/fleet-relay/src/shuvdo/legacy-app.ts:1040-1088`).
- Queue returns `tasks` + `reminders` (`/api/agents/:id/queue`, `legacy-app.ts:1156-1179`) with bot-consumer reminder filtering in store (`store.ts:1372+`).
- For token callers, `/api/reminders/next` defaults to `consumer=bot` unless explicitly overridden (`legacy-app.ts:1006-1038`).

### Task Breakdown
- [ ] Create `apps/backend/src/swarm/skills/builtins/shuvdo/SKILL.md` with YAML frontmatter including required `SHUVDO_API` and `SHUVDO_TOKEN`.
- [ ] Add setup section showing expected env configuration in Shuvlr Settings.
- [ ] Add `curl` command cookbook for all requested operations: list/items CRUD, reminders, projects, milestones, queue claim/release + read queue.
- [ ] Add troubleshooting section for common 401/403/404/400 failures tied to Shuvdo RBAC and list permissions.
- [ ] Add examples using `X-Idempotency-Key` for reminder completion retries.

### Validation Criteria
- `SKILL.md` frontmatter parses with `name` and `env` declarations accepted by `parseSkillFrontmatter()` (`swarm-manager.ts:3201-3320`).
- Manager can follow documented commands against live Shuvdo API without needing extra wrappers.
- Skill doc explicitly covers every route category requested in this plan.

## 2. Native Swarm Tools (First-Wave Scope)
### Problem / Current State
Swarm tools are currently limited to orchestration primitives (`list_agents`, `send_message_to_agent`, `spawn_agent`, `kill_agent`, `speak_to_user`) in `apps/backend/src/swarm/swarm-tools.ts:62-241`. `SwarmToolHost` has no Shuvdo capabilities (`apps/backend/src/swarm/swarm-tools.ts:14-30`).

This forces manager workflows to shell out with `curl`, increasing prompt/tool verbosity and error handling burden.

### Proposed Changes (with file paths)
- Add a Shuvdo HTTP client module in backend runtime layer, e.g. `apps/backend/src/swarm/shuvdo-client.ts`.
- Use integration approach **Option B**: keep `SwarmToolHost` minimal and inject a dedicated `shuvdoClient` dependency into `buildSwarmTools()`.
- Add manager-only native tools in `apps/backend/src/swarm/swarm-tools.ts` with TypeBox schemas.

Suggested first tool set (manager-only):
- `create_task` -> `POST /api/list/:name/add`
- `complete_task` -> `POST /api/list/:name/:id/done`
- `list_tasks` -> `GET /api/list/:name`
- `create_reminder` -> `POST /api/list/:name/add` with reminder fields
- `list_due_reminders` -> `GET /api/reminders/next`
- `complete_reminder` -> `POST /api/reminders/:id/complete`
- `list_projects` -> `GET /api/projects`
- `create_project` -> `POST /api/projects/add`
- `show_project` -> `GET /api/projects/:id`
- `update_project` -> `PATCH /api/projects/:id`
- `create_milestone` -> `POST /api/projects/:id/milestones/add`
- `update_milestone` -> `PATCH /api/projects/:id/milestones/:milestoneId`
- `get_agent_queue` -> `GET /api/agents/:id/queue`

Schema guidance:
- Reuse status constraints from the locally vendored Shuvdo contract doc/types (Section 0; source: Overseer `domain.ts`).
- `create_reminder` must require `dueAt` (Shuvdo reminders enforce due date requirements via list workflow validation).
- Include optional idempotency key parameter for `complete_reminder`.
- For `list_due_reminders`, include `consumer` option (`bot|signal`) and document token-default behavior (`bot`).
- Project creation/mutation tooling should surface authorization expectations clearly (non-admin/non-owner contexts return 403 in contract tests).
- Standardize tool return payloads to mirror Shuvdo response JSON (`item`, `projects`, `project`, `tasks`, `reminders`).

### Task Breakdown
- [ ] Add Shuvdo client abstraction with typed request helpers and consistent error mapping.
- [ ] Add `shuvdoClient` dependency plumbing from `SwarmManager` into `buildSwarmTools()` (Option B integration).
- [ ] Add manager-only TypeBox tool definitions for first tool set.
- [ ] Add auth/env preflight checks so tool errors clearly state missing `SHUVDO_API`/`SHUVDO_TOKEN`.
- [ ] Add telemetry for each Shuvdo tool call (tool name, manager id, endpoint, latency, success/failure, error type).
- [ ] Add tests in `apps/backend/src/test/swarm-tools.test.ts` for schema validation and endpoint call mapping.

### Validation Criteria
- Manager runtime exposes new Shuvdo tools only when config/env is present.
- Worker runtimes remain unchanged (still shared tools only).
- Tool calls return predictable JSON payloads equivalent to current Shuvdo HTTP responses.
- Tool telemetry is emitted for success/failure and latency on every Shuvdo native tool invocation.

## 3. Cron Scheduler Migration Path
### Problem / Current State
Shuvlr currently runs per-manager JSON-file cron services (`apps/backend/src/index.ts:23-48`) using `CronSchedulerService` (`apps/backend/src/scheduler/cron-scheduler-service.ts:34-378`) and manager-scoped files from `schedule-storage.ts` (`14-20`).

Scheduler dispatch currently injects a synthetic user message into manager runtime via `swarmManager.handleUserMessage(...)` (`cron-scheduler-service.ts:217-251`).

HTTP schedule reads are file-backed at `GET /api/managers/:managerId/schedules` (`apps/backend/src/ws/server.ts:661-713`).

Shuvdo already supports reminders with due queueing and recurrence (`legacy-app.ts:1006-1088`, `store.ts:1141-1195`, `store.ts:1238-1331`) and agent queue aggregation (`store.ts:1372-1480`).

### Proposed Changes (with file paths)
- Add new scheduler integration service in Shuvlr, e.g. `apps/backend/src/scheduler/shuvdo-queue-scheduler-service.ts`.
- Replace cron polling source with Shuvdo queue polling:
- Poll `GET /api/agents/:managerId/queue?limit=...` (`legacy-app.ts:1156-1179`) using bearer token.
- For each due reminder item in `queue.reminders`, send manager an internal message via `SwarmManager.sendMessage()` or `handleUserMessage()` with structured context.
- Ack completion using `POST /api/reminders/:id/complete` with idempotency key.
- Persist a local dedupe cache for delivery IDs keyed by `reminderId + dueAt` to guard retries.
- Account for queue consumer semantics from Overseer store: agent queue reminders are sourced from bot-consumer reminder lists; signal-consumer reminders are not surfaced in agent queue.

Migration of existing cron JSON files:
- Add migrator module, e.g. `apps/backend/src/scheduler/cron-to-shuvdo-migrator.ts`.
- Read existing schedule files only from canonical `~/.shuvlr/schedules/<managerId>.json` (no legacy path fallback).
- Convert schedule records:
- `oneShot=true` -> create reminder with `dueAt=nextFireAt`, no `repeatRule`.
- Supported cron patterns -> map to `repeatRule` (`daily`, `weekly`, `monthly`, `every N ...`) and set seed `dueAt`.
- Unsupported cron expressions -> keep in legacy file and emit migration report requiring manual action.
- Write migration report artifact under data dir.

Backward compatibility strategy:
- Phase 1: dual-read, Shuvdo-first; keep legacy cron service behind feature flag.
- Phase 2: legacy cron disabled by default; existing `/api/managers/:managerId/schedules` can return merged/annotated view (`source: "cron" | "shuvdo"`) until UI migration completes.
- Phase 3: remove legacy JSON scheduler and schedule storage endpoint if no longer needed.

Important prerequisite to document:
- Queue auth checks require caller to be admin or matching agent id (`legacy-app.ts:1167-1169`).
- Chosen auth model for this plan: use a single admin Shuvdo token for all manager queue polling and manager-native tools.
- Even admin host tokens are list-scoped in practice (`req.user.lists` drives queue filtering). Ensure this token is granted all lists needed for manager queues/reminders.

### Task Breakdown
- [ ] Add Shuvdo queue polling service and lifecycle wiring in `apps/backend/src/index.ts` alongside current scheduler lifecycle.
- [ ] Add reminder dispatch format standard for manager messages (include reminder id/list/due metadata).
- [ ] Add reminder completion call with `X-Idempotency-Key` and retry-safe semantics.
- [ ] Add startup/preflight validation for scheduler token grants and reminder-consumer list eligibility (bot-consumer lists for queue ingestion).
- [ ] Add telemetry for queue poll cycles, reminder dispatch/ack outcomes, retries, and migration conversion results.
- [ ] Add cron-file migration utility with conversion report + unsupported-pattern handling.
- [ ] Add feature flags for rollout (`legacy cron`, `dual-read`, `queue poll interval`).
- [ ] Update UI schedule surface (`apps/ui/src/components/chat/ArtifactsSidebar.tsx`) to handle merged cron+Shuvdo payloads or dedicated reminder presentation.
- [ ] Update cron skill docs to mark legacy path deprecated and point to Shuvdo reminders.

### Validation Criteria
- Due reminders appear in manager conversation without reading local schedule files.
- Reminder completion is idempotent and safe across retries/restarts.
- Scheduler preflight catches missing list grants or non-bot reminder consumer misconfiguration before silent drops.
- Telemetry confirms queue polling health, reminder dispatch latency, completion outcomes, and retry/error reasons.
- UI schedule/reminder surface remains functional during dual-read migration.
- Recurring reminders auto-advance via Shuvdo repeat-rule completion logic (Overseer `legacy-app.ts` reminder completion path + `domain.ts` repeat helpers).
- Existing cron schedules are either migrated or explicitly reported as unsupported.

## 4. Memory File Restructuring
### Problem / Current State
Default manager memory template includes `## Open Follow-ups` (`apps/backend/src/swarm/swarm-manager.ts:195-208`), encouraging task tracking inside markdown memory.

Manager archetype currently references memory durability but does not explicitly route structured task/reminder tracking to Shuvdo (`apps/backend/src/swarm/archetypes/builtins/manager.md:63-70`).

Memory skill is generic and does not distinguish durable facts vs actionable task tracking (`apps/backend/src/swarm/skills/builtins/memory/SKILL.md:6-29`).

### Proposed Changes (with file paths)
- Update default memory template in `apps/backend/src/swarm/swarm-manager.ts`:
- Keep sections for `User Preferences`, `Project Facts`, `Decisions`.
- Remove `Open Follow-ups` section from new file bootstrap content.
- Update manager archetype prompt (`apps/backend/src/swarm/archetypes/builtins/manager.md`) to state:
- Use memory for durable context only.
- Use Shuvdo lists/reminders/projects for actionable work tracking.
- Update memory skill (`apps/backend/src/swarm/skills/builtins/memory/SKILL.md`) with explicit rule:
- Do not use memory for task queues/open follow-ups; use Shuvdo workflow.

Optional migration helper:
- Add one-time script to extract bullets from existing `## Open Follow-ups` sections in existing memory files and create Shuvdo items in a manager follow-up list.

### Task Breakdown
- [ ] Edit default memory bootstrap content to remove `Open Follow-ups`.
- [ ] Update manager archetype wording to reference Shuvdo for structured work.
- [ ] Update memory skill guidance to separate durable memory vs task management.
- [ ] Add migration note/script for existing memory files containing open follow-up bullets.
- [ ] Update tests that assert memory prompt/template behavior.

### Validation Criteria
- Newly bootstrapped memory files only contain durable sections.
- Manager prompt unambiguously directs task/reminder tracking to Shuvdo.
- Memory skill no longer instructs/implicitly encourages task tracking in markdown.

## 5. Config and Wiring
### Problem / Current State
Skill registration is hardcoded in `reloadSkillMetadata()` and currently excludes Shuvdo (`apps/backend/src/swarm/swarm-manager.ts:1989-2031`).

Built-in skill constants/path resolvers are declared explicitly (`swarm-manager.ts:124-194`, `1935-1987`).

Settings env variables are populated dynamically from loaded skill frontmatter (`swarm-manager.ts:1315-1357`) and served via `/api/settings/env` (`ws/server.ts:778-825`).

### Proposed Changes (with file paths)
- Update `apps/backend/src/swarm/swarm-manager.ts`:
- Add constants for repo override and built-in fallback paths for Shuvdo skill.
- Add `resolveShuvdoSkillPath()` helper following current pattern.
- Add Shuvdo entry in `reloadSkillMetadata()` list.
- Ensure codex runtime receives Shuvdo env explicitly in `createCodexRuntimeForDescriptor()` runtimeEnv map (`swarm-manager.ts:2367-2370`) for deterministic behavior.
- Register native tools wiring in runtime creation path:
- Extend `buildSwarmTools(...)` call path (`swarm-manager.ts:2220`, `2330`) to pass Shuvdo host/client capability.

Test updates:
- `apps/backend/src/test/swarm-manager.test.ts`:
- Skill count and ordering assertions currently expect 6 skills (`383-419`); update for Shuvdo.
- Settings env assertions currently cover BRAVE/GEMINI (`421-484`); add SHUVDO vars.
- `apps/backend/src/test/ws-server.test.ts`:
- `/api/settings/env` payload assertions (`652-725`) should include Shuvdo env declarations.
- `apps/backend/src/test/swarm-tools.test.ts`:
- Add coverage for new native tools (required in first wave).

UI note:
- No schema change required in settings UI because env variables are already generic (`apps/ui/src/components/settings/settings-types.ts:5-13`, `apps/ui/src/components/settings/SettingsSkills.tsx:242-299`).

### Task Breakdown
- [ ] Add Shuvdo built-in skill path constants + resolver in `SwarmManager`.
- [ ] Include Shuvdo skill in `reloadSkillMetadata()`.
- [ ] Verify `/api/settings/env` now surfaces `SHUVDO_API` + `SHUVDO_TOKEN`.
- [ ] Add codex runtime env passthrough for Shuvdo vars.
- [ ] Wire native Shuvdo tools in runtime tool assembly path (first-wave requirement).
- [ ] Update backend and ws tests for new skill/env/tool behavior.

### Validation Criteria
- Boot loads Shuvdo skill metadata without regressions to existing six skills.
- Settings API includes Shuvdo env variables with correct `required` and `skillName` values.
- Manager runtime can use both Shuvdo integration paths in first wave (skill-driven curl + native tools).

## 6. Execution Order
1. Complete Section 0 prerequisites first (local API contract snapshot from Overseer sources at commit `c645b9e`: `legacy-app.ts`, `domain.ts`, `store.ts`, parity tests; plus Shuvlr naming alignment and Maple OTLP telemetry deliverables).
2. Implement Section 1 (skill doc) + Section 5 skill registration/settings wiring + Section 2 native tools together as first-wave scope.
3. Implement Section 3 queue-based reminder service behind a feature flag, keeping legacy cron as fallback.
4. Build and run cron-file migrator; generate and review unsupported schedule report.
5. Implement Section 4 prompt/memory restructuring after Shuvdo task/reminder path is available.
6. Update/validate merged schedules UI behavior during dual-read migration.
7. Remove/deprecate legacy cron-only code paths after migration validation is complete.

