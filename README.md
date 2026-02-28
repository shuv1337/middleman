<p align="center">
  <img src="docs/images/middleman-header.png" alt="Shuvlr" width="100%">
</p>

# 🛠️ Shuvlr

Shuvlr is a local-first multi-agent orchestration platform. One manager, many workers, zero tab-juggling.

## Why “Shuvlr” (and “(slop)shuvlr”)?

**Shuvlr** is the canonical product name.

You may also see **(slop)shuvlr** in community/internal shorthand — a tongue-in-cheek vibecoding reference to “shoveling slop quickly, then tightening quality with manager orchestration.”

## Setup

```bash
git clone https://github.com/shuv1337/shuvlr.git
cd shuvlr
pnpm i
pnpm prod:daemon
```

Open the UI, go to **Settings**, and sign in with your OpenAI or Anthropic key. Then create a new manager and start chatting.

For development:

```bash
pnpm dev
# Backend: http://127.0.0.1:47187
# UI:      http://127.0.0.1:47188
```

## Key Features

- Persistent manager agents with memory
- Worker delegation and orchestration
- Parallel execution across model-specialized workers
- Real-time dashboard + chat + artifacts
- Built-in skills and integrations

## Architecture

- **`apps/backend`**: HTTP/WS daemon, orchestration, integrations, scheduler
- **`apps/ui`**: dashboard SPA
- **`apps/site`**: marketing site

## Breaking Upgrade Notes (Shuvlr Rebrand)

This release intentionally removes legacy Middleman aliases.

- **Env vars**
  - `MIDDLEMAN_HOST` -> `SHUVLR_HOST`
  - `MIDDLEMAN_PORT` -> `SHUVLR_PORT`
  - New: `SHUVLR_DATA_DIR`, `SHUVLR_AUTH_TOKEN`, `SHUVLR_ALLOWED_ORIGINS`, `SHUVLR_DEFAULT_MODEL_PRESET`, `SHUVLR_CODEX_SANDBOX_MODE`, `SHUVLR_CODEX_APPROVAL_POLICY`
- **Data directory**
  - Default changed from `~/.middleman` -> `~/.shuvlr`
  - No automatic fallback/migration from `~/.middleman`
- **Workspace package scopes**
  - `@middleman/*` -> `@shuvlr/*`
- **Repository URL**
  - `SawyerHood/middleman` -> `shuv1337/shuvlr`

See also: [`docs/upgrading-to-shuvlr.md`](docs/upgrading-to-shuvlr.md).

## License

Apache-2.0
