# Shuvlr Improvements Plan (formerly Middleman)

Consolidated plan covering rebrand rollout, backend refactoring, CI recovery, security hardening, and test coverage.

**Execution order:** rebrand foundation -> CI fix (quick win) -> runtime utils extraction (low-risk) -> data dir configurability -> server.ts decomposition -> auth/CORS hardening -> Codex sandbox + approval policies -> model resolution UX -> test coverage expansion.

**Cross-cutting requirement:** telemetry is day-zero for every phase with full OTLP logs/metrics/traces routed to Maple ingest (success, failure, and latency on new/changed paths).

---

## Phase 0: Full Rebrand to Shuvlr (Priority: Critical, Cross-Cutting)

### Problem
The product is still branded as Middleman across package names, env vars, data directory defaults, UI copy, and marketing metadata. A full rebrand now requires canonical Shuvlr naming without legacy aliases.

**References:**
- `package.json:2` -- root package name is `middleman`
- `apps/backend/package.json:2`, `apps/ui/package.json:2`, `apps/site/package.json:2` -- `@middleman/*` scopes
- `apps/backend/src/config.ts:10` -- hardcoded `~/.middleman` data dir
- `apps/backend/src/config.ts:33-34` -- `MIDDLEMAN_HOST`, `MIDDLEMAN_PORT`
- `apps/ui/src/routes/__root.tsx:22` -- UI title contains Middleman
- `apps/site/src/routes/__root.tsx:9-15` -- site metadata/OG tags contain Middleman
- `README.md:5-67` -- product naming and clone path references

### Tasks
- [ ] Rename product-facing identity to **Shuvlr** across UI, site, README, and docs touched by this plan.
- [ ] Update README naming notes to explain **(slop)shuvlr** as the “shoveling slop” / vibecoding reference while keeping **Shuvlr** as the canonical product name.
- [ ] Keep scope boundary for this pass: rename public identifiers/package/env/data-dir surfaces now; defer deep internal `swarm` symbol/file refactors.
- [ ] Rename workspace package scopes from `@middleman/*` to `@shuvlr/*` and update root scripts/filters accordingly.
- [ ] Rename repository/URL references to `shuv1337/shuvlr` (README, site links, metadata, clone instructions).
- [ ] Introduce canonical env vars with `SHUVLR_*` prefix only (no legacy aliases).
- [ ] Use canonical data dir `~/.shuvlr` only (no automatic migration/copy/read-fallback from `~/.middleman`).
- [ ] Update tests and snapshots that assert package names, env vars, titles, filesystem paths, and repo URLs.
- [ ] Add upgrade notes documenting explicit breaking changes (renamed env vars, package scopes, data dir, repo URL).

### Validation
- No user-facing “Middleman” branding remains in shipped app surfaces (UI/site/README/docs touched).
- Canonical runtime/docs use Shuvlr naming and prefixes.
- Scope boundary (public rebrand vs deferred internal `swarm` refactor) is documented and agreed before implementation.
- No legacy `MIDDLEMAN_*` aliases are required for normal operation.
- Runtime uses `~/.shuvlr` only.
- Telemetry includes explicit Shuvlr resource identity and full OTLP traces/metrics/logs routed through Maple ingest.

---

## Phase 1: CI Recovery (Priority: Critical)

### Problem
CI is broken. `.github/workflows/ci.yml` references `@swarm/backend` and `@swarm/ui` (stale), while packages are currently `@middleman/*` and will be renamed to `@shuvlr/*` in Phase 0. Backend tests also use `continue-on-error: true`, masking failures. UI tests are not run at all.

**References:**
- `.github/workflows/ci.yml:35` -- `@swarm/backend` (stale)
- `.github/workflows/ci.yml:38` -- `@swarm/ui` (stale)
- `.github/workflows/ci.yml:41` -- `continue-on-error: true`
- `apps/backend/package.json:2` -- current scope `@middleman/backend` (target: `@shuvlr/backend`)
- `apps/ui/package.json:2` -- current scope `@middleman/ui` (target: `@shuvlr/ui`)

### Tasks
- [ ] Update `.github/workflows/ci.yml` package filters from `@swarm/*` to canonical rebranded scope `@shuvlr/*`.
- [ ] Remove `continue-on-error: true` from backend test step.
- [ ] Add explicit UI test step (`pnpm --filter @shuvlr/ui test`).
- [ ] Ensure CI step names clearly distinguish backend vs UI failures.
- [ ] Verify lockfile/install/build/typecheck/test order is deterministic.

### Validation
- CI fails on backend test failure
- CI fails on UI test failure
- Build + both typechecks + both test suites pass with correct filters

---

## Phase 2: Extract Shared Runtime Utilities (Priority: High, Low-Risk)

### Problem
Five utility functions are copy-pasted between `agent-runtime.ts` and `codex-agent-runtime.ts`:
- `normalizeRuntimeUserMessage` (agent-runtime.ts:435, codex-agent-runtime.ts:1098)
- `buildMessageKey` (agent-runtime.ts:606, codex-agent-runtime.ts:1206)
- `normalizeRuntimeImageAttachments` (agent-runtime.ts:485, codex-agent-runtime.ts:1112)
- `previewForLog` (agent-runtime.ts:583, codex-agent-runtime.ts:1234)
- `normalizeRuntimeError` (agent-runtime.ts:589, codex-agent-runtime.ts:1221)

Drift between copies can cause subtle runtime mismatches.

### Tasks
- [ ] Create `apps/backend/src/swarm/runtime-utils.ts` with shared exports
- [ ] Update `agent-runtime.ts` -- replace inline implementations with imports (lines 435-449, 485-513, 583-619)
- [ ] Update `codex-agent-runtime.ts` -- replace inline implementations with imports (lines 1098-1110, 1112-1140, 1206-1238)
- [ ] Add `apps/backend/src/test/runtime-utils.test.ts` covering edge cases (empty input, image filtering, message key stability, preview truncation)
- [ ] Verify existing runtime tests still pass

### Validation
- No duplicate function bodies in runtime files
- Dedicated unit tests for shared utilities
- `agent-runtime.test.ts` and `codex-agent-runtime*.test.ts` remain green

---

## Phase 3: Configurable Data Directory (Priority: High)

### Problem
Data root is hardcoded to `~/.middleman` in `config.ts:10` with no env var override. Rebrand requires canonical `~/.shuvlr` with no compatibility fallback.

### Tasks
- [ ] Add `SHUVLR_DATA_DIR` env parsing in `createConfig()`.
- [ ] Set canonical fallback to `~/.shuvlr`.
- [ ] Remove/stop honoring legacy `MIDDLEMAN_DATA_DIR` behavior.
- [ ] Add path normalization/validation helper (trim, non-empty, absolute resolution).
- [ ] Update `apps/backend/src/test/config.test.ts` -- default assertions + override test + invalid input test.
- [ ] Update documentation references to canonical Shuvlr data path and explicit breaking change note.

### Validation
- No env var: behavior uses `~/.shuvlr`.
- `SHUVLR_DATA_DIR=/custom/path`: all derived paths use that base.
- Legacy `MIDDLEMAN_DATA_DIR` is no longer part of supported config.
- Backend boots and writes files correctly in overridden directory.

---

## Phase 4: Decompose server.ts (Priority: High)

### Problem
`apps/backend/src/ws/server.ts` is 3054 lines mixing HTTP routing, handler logic, WS command handling, transport lifecycle, parsing helpers, and persistence helpers. HTTP dispatch is a long conditional chain in `handleHttpRequest` (line 274). CORS/method logic is duplicated across handlers and the global error path (lines 360-390).

### Tasks
- [ ] Create `apps/backend/src/ws/http/context.ts` -- typed `HttpRequestContext` with shared dependencies
- [ ] Create `apps/backend/src/ws/http/http-io.ts` -- extract `readJsonBody`, `readRequestBody`, `parseJsonBody`, `sendJson`, `applyCorsHeaders` (lines 1346-1424)
- [ ] Create route/domain parser modules:
  - Schedules (`resolveSchedulesRoute`, `isSchedulesPath`; lines 2654-2670)
  - Slack (`isSlackIntegrationPath`, `resolveSlackIntegrationRoute`; lines 2639-2645, 2672-2705)
  - Telegram (`isTelegramIntegrationPath`, `resolveTelegramIntegrationRoute`; lines 2647-2652, 2707-2730)
  - Shared path helpers (`decodePathSegment`, `resolveSettingsAuthLoginProviderId`; lines 2732-2752)
- [ ] Extract per-domain HTTP handlers:
  - `reboot-handler.ts` (lines 396-418)
  - `read-file-handler.ts` (lines 420-536)
  - `transcribe-handler.ts` + multipart helpers (lines 538-659, 2277-2329)
  - `schedules-handler.ts` (lines 661-713, 2774-2822)
  - `compact-handler.ts` (lines 715-776, 2352-2372)
  - `settings-env-handler.ts` (lines 778-825, 2374-2400)
  - `settings-auth-handler.ts` + SSE flow (lines 827-1125, 2402-2441)
  - Integration handlers (lines 1127-1344, 2443-2623)
- [ ] Build `http/router.ts` route table; replace `handleHttpRequest` conditional chain with delegation
- [ ] Move HTTP-only helper functions from server.ts bottom (lines 2244-3054) into domain modules
- [ ] Keep `SwarmWebSocketServer` public API unchanged (`start`, `stop`)
- [ ] Verify all existing tests pass unchanged

### Validation
- `ws-server.test.ts` and `ws-server-p0-endpoints.test.ts` pass with no behavior changes
- No API path/method/status regressions
- WS commands (subscribe, user_message, create/delete manager) work identically
- `server.ts` reduced to WS lifecycle + delegation

---

## Phase 5: HTTP/WS Authentication + CORS Hardening (Priority: High)

### Problem
Zero authentication on the WS/HTTP server. CORS reflects any origin (server.ts:1383-1390). No auth gate before sensitive endpoints like `/api/reboot` (line 396). WS accepts all connections (lines 193-201). If `SHUVLR_HOST=0.0.0.0`, everything is exposed -- API keys, secrets, full agent control.

### Tasks
- [ ] Extend `SwarmConfig` with optional auth token and origin allowlist settings.
- [ ] Add canonical `SHUVLR_AUTH_TOKEN` env var.
- [ ] When auth token is configured, require `Authorization: Bearer <token>` on all HTTP endpoints.
- [ ] Enforce auth on WS handshake (header preferred; query-param fallback only when required by browser constraints).
- [ ] Replace permissive CORS origin reflection with explicit allowlist (`SHUVLR_ALLOWED_ORIGINS`).
- [ ] Add startup warning when binding non-loopback host without auth configured.
- [ ] Update UI WS client (`ws-client.ts:419-423`) and settings API helpers (`settings-api.ts`) to attach auth token when configured.
- [ ] Maintain backward compatibility: no token configured = current behavior.
- [ ] Add backend tests for 401/403/200 cases (HTTP + WS + CORS preflight).

### Validation
- With token: unauthenticated requests return 401; authenticated requests succeed
- With origin allowlist: disallowed origins rejected
- Without token on loopback: existing local dev unchanged
- Warning logged when binding 0.0.0.0 without auth

---

## Phase 6: Configurable Codex Sandbox + Approval Policies (Priority: Medium)

### 6a: Sandbox Mode

**Problem:** Sandbox mode hardcoded to `danger-full-access` (codex-agent-runtime.ts:27, :878-889). No config field exists in `SwarmConfig`.

- [ ] Extend `SwarmConfig` with `codexSandboxMode` field.
- [ ] Add canonical `SHUVLR_CODEX_SANDBOX_MODE` env parsing with validation + `danger-full-access` default.
- [ ] Thread config through `SwarmManager.createCodexRuntimeForDescriptor` (swarm-manager.ts:2348-2371) to `CodexAgentRuntime.create()`.
- [ ] Refactor `buildCodexSandboxSettings()` (line 880) to accept injected mode.
- [ ] Add tests asserting sandbox fields in `thread/start`, `thread/resume`, `turn/start` requests.

### 6b: Approval Policies

**Problem:** All tool calls auto-approved with `{ decision: "accept" }` (codex-agent-runtime.ts:691-699). Thread bootstrap hardcodes `approvalPolicy: "never"` (lines 351, 373). No tests exercise approval request paths.

- [ ] Define policy model: `auto_accept` (default), `deny_all`, `deny_command_execution`, `deny_file_changes`.
- [ ] Add config field + canonical `SHUVLR_CODEX_APPROVAL_POLICY` env parsing.
- [ ] Thread policy to `CodexAgentRuntime.create()`.
- [ ] Replace hardcoded approval decisions with policy-based resolver in `handleServerRequest`.
- [ ] Align thread-level `approvalPolicy` with selected backend policy.
- [ ] Add structured logging for each approval decision.
- [ ] Add unit tests for each policy x request method combination.
- [ ] Regression test confirming default = current behavior.

### Validation
- Default behavior unchanged when env vars unset
- Non-default policies visibly change approval outcomes
- Tests assert decision matrix per policy for `commandExecution` and `fileChange` requests

---

## Phase 7: Model Resolution UX (Priority: Medium)

### Problem
Default model hardcoded to `openai-codex/gpt-5.3-codex` (config.ts:39-42, model-presets.ts:4-11). Runtime silently falls back to first registry model (swarm-manager.ts:2428-2436) which can cause confusing drift. No backend endpoint exposes available models to clients.

### Tasks
- [ ] Create `apps/backend/src/swarm/model-resolution.ts` returning `{ resolvedModel, resolutionMeta }` with explicit fallback reasoning
- [ ] Refactor `SwarmManager.resolveModel` (swarm-manager.ts:2428-2436) -- remove silent `getAll()[0]` fallback, surface as explicit metadata
- [ ] Improve runtime creation failure messages (swarm-manager.ts:2270-2275) to include requested model and available options
- [ ] Add canonical `SHUVLR_DEFAULT_MODEL_PRESET` env override with backward-compatible default
- [ ] Add `GET /api/settings/models` endpoint exposing presets + availability hints
- [ ] Update create_manager error payloads to include actionable remediation info
- [ ] Add tests: success path, fallback path, failure path with expected error messages

### Validation
- Default model selection backward-compatible when env unchanged
- Mismatches rejected with actionable errors (no silent switch)
- Clients can query `/api/settings/models` for options
- Test coverage for success, fallback, and failure paths

---

## Phase 8: Test Coverage Expansion + CI Gates (Priority: Medium)

### Problem
Test coverage is uneven. `schedule-storage.test.ts` is 14 lines. Server auth/CORS logic untested. Codex approval branches untested. Integration config merge/mask logic untested. UI `settings-api.ts` (430+ lines) has no tests. Vitest configs define no coverage thresholds.

### Tasks
- [ ] Expand `schedule-storage.test.ts` -- `normalizeManagerId` error path, `getSchedulesDirectoryPath` output
- [ ] Add server auth/CORS tests (HTTP + WS + preflight variants) -- see Phase 5
- [ ] Add Codex approval policy tests -- see Phase 6b
- [ ] Add unit tests for `settings-api.ts` parsing, endpoint resolution, OAuth SSE event parsing, error handling
- [ ] Add integration config merge/mask tests (Slack + Telegram)
- [ ] Add Slack router tests for inbound dedupe/filter/channel routing
- [ ] Add `gsuite-gog.ts` tests for timeout/error parsing/JSON extraction
- [ ] Enable coverage output in backend + UI Vitest configs
- [ ] Wire coverage reporting into CI
- [ ] Set initial baseline thresholds, ratchet upward incrementally

### Validation
- Coverage reports produced on every CI run
- Critical modules show measurable coverage increase
- CI enforces minimum coverage policy (threshold or non-regression)
