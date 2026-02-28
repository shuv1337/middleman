# Upgrading to Shuvlr (Breaking Changes)

This release finalizes the Shuvlr rebrand and removes legacy Middleman aliases.

## Required updates

- Env vars
  - `MIDDLEMAN_HOST` -> `SHUVLR_HOST`
  - `MIDDLEMAN_PORT` -> `SHUVLR_PORT`
- New optional env vars
  - `SHUVLR_DATA_DIR`
  - `SHUVLR_AUTH_TOKEN`
  - `SHUVLR_ALLOWED_ORIGINS`
  - `SHUVLR_DEFAULT_MODEL_PRESET`
  - `SHUVLR_CODEX_SANDBOX_MODE`
  - `SHUVLR_CODEX_APPROVAL_POLICY`
- Data directory default
  - `~/.middleman` -> `~/.shuvlr`
  - No automatic `.middleman` read-fallback
- Package scopes
  - `@middleman/*` -> `@shuvlr/*`
- Repository URL
  - `https://github.com/SawyerHood/middleman` -> `https://github.com/shuv1337/shuvlr`
