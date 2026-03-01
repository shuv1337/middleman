## UI Theme Migration Plan: `apps/ui` to Fleet-PWA Design Language

## Goals
- Keep the existing shadcn/ui + Radix component architecture.
- Replace the current earthy palette with the fleet-pwa Night Owl palette.
- Move to a dark-first (recommended dark-only) visual system.
- Preserve current chat/settings behavior while updating look-and-feel.

## Source References Reviewed
- `apps/ui/src/styles.css`
- `apps/ui/src/components/Header.tsx`
- `apps/ui/src/components/chat/ChatHeader.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/chat/MessageList.tsx`
- `apps/ui/src/components/chat/MessageInput.tsx`
- `apps/ui/src/components/chat/ArtifactPanel.tsx`
- `apps/ui/src/components/chat/ArtifactsSidebar.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`
- `apps/ui/src/components/ui/button.tsx`
- `apps/ui/src/components/ui/card.tsx`
- `apps/ui/src/components/ui/badge.tsx`
- `apps/ui/src/components/ui/dialog.tsx`
- `apps/ui/src/components/ui/input.tsx`
- `apps/ui/src/lib/theme.ts`
- `/home/shuv/repos/overseer/apps/fleet-pwa/src/app/styles.css`
- `/home/shuv/repos/overseer/apps/fleet-pwa/src/components/WidgetCard.tsx`
- `/home/shuv/repos/overseer/apps/fleet-pwa/src/components/Badge.tsx`
- `/home/shuv/repos/overseer/apps/fleet-pwa/src/components/BottomTabs.tsx`

## Decision Gate (Do First)
- [ ] Confirm theme strategy:
  - Recommended: dark-only (remove light/auto behavior and force fleet theme globally).
  - Alternative: keep theme setting but make dark the default and visually optimize dark only.

## CSS Variable Migration (Exact Mapping)
Primary file: `apps/ui/src/styles.css`

Implementation approach:
- Set `:root` to fleet dark values (dark-by-default).
- If keeping `.dark`, make `.dark` identical to `:root` initially to avoid drift.
- Keep shadcn variable names and map Night Owl values into them.

### Variable Before/After Table
| Variable | Current `:root` | Current `.dark` | Target (fleet) |
|---|---|---|---|
| `--background` | `#f8f5f0` | `#1a1a1a` | `#011627` |
| `--foreground` | `#3e2723` | `#f0ebe5` | `#d6deeb` |
| `--card` | `#f8f5f0` | `#242424` | `rgba(1, 17, 29, 0.86)` |
| `--card-foreground` | `#3e2723` | `#f0ebe5` | `#d6deeb` |
| `--popover` | `#f8f5f0` | `#242424` | `rgba(1, 17, 29, 0.96)` |
| `--popover-foreground` | `#3e2723` | `#f0ebe5` | `#d6deeb` |
| `--primary` | `#2e7d32` | `#4caf50` | `#82aaff` |
| `--primary-foreground` | `#ffffff` | `#0a1f0c` | `#01111d` |
| `--secondary` | `#b6d3b8` | `#333333` | `rgba(13, 43, 69, 0.40)` |
| `--secondary-foreground` | `#1b5e20` | `#d7e0d6` | `#d6deeb` |
| `--muted` | `#f0e9e0` | `#2a2a2a` | `#0b2239` |
| `--muted-foreground` | `#6d4c41` | `#d7cfc4` | `#5f7e97` |
| `--accent` | `#8aba8e` | `#2e7d32` | `#7fdbca` |
| `--accent-foreground` | `#1b5e20` | `#ffffff` | `#01111d` |
| `--destructive` | `#c62828` | `#dc2626` | `#ef5350` |
| `--destructive-foreground` | `#ffffff` | `#ffffff` | `#01111d` |
| `--border` | `#e0d6c9` | `#4a4a4a` | `rgba(130, 170, 255, 0.24)` |
| `--input` | `#e0d6c9` | `#4a4a4a` | `rgba(130, 170, 255, 0.30)` |
| `--ring` | `#2e7d32` | `#4caf50` | `#82aaff` |
| `--chart-1` | `#4caf50` | `#81c784` | `#82aaff` |
| `--chart-2` | `#388e3c` | `#66bb6a` | `#7fdbca` |
| `--chart-3` | `#2e7d32` | `#4caf50` | `#addb67` |
| `--chart-4` | `#1b5e20` | `#43a047` | `#f78c6c` |
| `--chart-5` | `#0a1f0c` | `#388e3c` | `#c792ea` |
| `--sidebar` | `#fcfaf8` | `#161616` | `#01111d` |
| `--sidebar-foreground` | `#3e2723` | `#f0ebe5` | `#d6deeb` |
| `--sidebar-primary` | `#2e7d32` | `#4caf50` | `#82aaff` |
| `--sidebar-primary-foreground` | `#ffffff` | `#0a1f0c` | `#01111d` |
| `--sidebar-accent` | `#f5f2ed` | `#202020` | `rgba(13, 43, 69, 0.40)` |
| `--sidebar-accent-foreground` | `#3e2723` | `#ffffff` | `#d6deeb` |
| `--sidebar-border` | `#e8e0d6` | `#4a4a4a` | `rgba(130, 170, 255, 0.24)` |
| `--sidebar-ring` | `#2e7d32` | `#4caf50` | `#7fdbca` |
| `--radius` | `0.5rem` | inherits | `0.75rem` (12px) |
| `--font-sans` | `Geist` | inherits | `JetBrains Mono` |
| `--font-mono` | `Geist Mono` | inherits | `JetBrains Mono` |

### New Global Tokens to Add in `styles.css`
- [ ] Add fleet helper tokens while preserving shadcn vars:
  - `--fleet-bg`, `--fleet-bg-deep`, `--fleet-bg-muted`
  - `--fleet-surface`, `--fleet-surface-strong`, `--fleet-surface-soft`
  - `--fleet-ok`, `--fleet-warn`, `--fleet-danger`, `--fleet-purple`, `--fleet-salmon`, `--fleet-comment`
  - `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left`
  - `--tab-bar-height: 64px`
  - `--fleet-shadow: 0 18px 40px rgba(0, 0, 0, 0.35)`

## Ordered Task Checklist

### Phase 1: Foundation Tokens, Typography, and Page Effects
- [ ] Update `apps/ui/src/styles.css` imports from Geist/Geist Mono to JetBrains Mono.
- [ ] Update `@theme inline` font bindings so both `--font-sans` and `--font-mono` use JetBrains Mono.
- [ ] Implement dark-by-default tokens in `:root` using the mapping table above.
- [ ] If dark-only is chosen, make `.dark` token set equal to `:root` or remove `.dark` overrides and force dark class in init code.
- [ ] Replace plain `body` background with fleet layered background:
  - radial teal glow + radial blue glow + deep navy linear gradient.
- [ ] Add global grid overlay pseudo-element (`body::before`) at 28px spacing and 5% line opacity.
- [ ] Add app-level glass defaults via utility classes or reusable global selectors for:
  - translucent backgrounds
  - `backdrop-filter: blur(...)`
  - fleet border color
  - fleet shadow

### Phase 2: Theme Runtime Behavior
- [ ] Update `apps/ui/src/lib/theme.ts` to match selected strategy:
  - Dark-only path: set `ThemePreference` to dark only, remove light/auto branches, ensure init always applies dark class.
  - Dark-default path: keep API but default storage fallback to `dark` instead of `auto`.
- [ ] Update `apps/ui/src/routes/__root.tsx` theme bootstrap usage if `THEME_INIT_SCRIPT` changes.
- [ ] Update `apps/ui/src/components/settings/SettingsGeneral.tsx`:
  - Dark-only path: replace theme select with static “Fleet Dark” indicator.
  - Dark-default path: keep select but reorder default to Dark and mark Light as legacy/de-emphasized.

### Phase 3: shadcn Primitive Restyle (Do before app-specific components)
- [ ] `apps/ui/src/components/ui/card.tsx`:
  - Change base card to glass style (`bg-card/80`, `border-border`, stronger shadow token, 12px radius alignment).
- [ ] `apps/ui/src/components/ui/button.tsx`:
  - Tune `default`, `secondary`, `ghost`, `outline` variants to fleet contrast and hover states.
  - Ensure focus rings use `--ring`/accent blue and stay visible on deep navy.
- [ ] `apps/ui/src/components/ui/badge.tsx`:
  - Update variants for fleet status language (blue/teal/ok/warn/danger).
  - Keep existing API shape; add classes/variants rather than replacing component architecture.
- [ ] `apps/ui/src/components/ui/dialog.tsx`:
  - Glass overlay and content surface (fleet border, blur, deeper backdrop).
- [ ] `apps/ui/src/components/ui/input.tsx`:
  - Dark translucent input backgrounds, fleet border color, strong focus state.

### Phase 4: Chat Surface Updates
- [ ] `apps/ui/src/components/chat/AgentSidebar.tsx`:
  - Set sidebar to deep navy base (`--sidebar`), translucent hover/selected rows, fleet border lines.
  - Replace status dots from emerald/amber utility colors to fleet status tokens.
  - Keep tree behavior, collapse state, and context menu behavior unchanged.
- [ ] `apps/ui/src/components/chat/ChatHeader.tsx`:
  - Use glass-morphism top bar (`bg-card/70`, `backdrop-blur`, fleet border).
  - Restyle channel toggle pills and action buttons to fleet accents.
  - Update streaming/idle indicator colors to fleet ok/muted tokens.
- [ ] `apps/ui/src/components/chat/MessageList.tsx`:
  - Ensure chat feed sits on dark gradient-compatible background with readable contrast.
  - Update bubble/log/error/system message tones to fleet palette.
  - Replace hardcoded slate/amber/rose classes with tokenized palette where possible.
- [ ] `apps/ui/src/components/chat/MessageInput.tsx`:
  - Convert composer to glass panel with fleet border/shadow.
  - Keep sticky behavior; add safe-area-aware bottom padding.
  - Update send/mic/attach button visuals and recording strip colors to fleet status colors.
- [ ] `apps/ui/src/components/chat/ArtifactPanel.tsx`:
  - Restyle modal header/content surfaces to fleet glass treatment and borders.
- [ ] `apps/ui/src/components/chat/ArtifactsSidebar.tsx`:
  - Restyle tabs/list/detail panes to fleet card language.
  - Keep tabs interactions and schedules logic unchanged.

### Phase 5: Settings Panel Updates
- [ ] `apps/ui/src/components/chat/SettingsDialog.tsx` (Settings panel container): ensure inherited surfaces are fleet-compliant.
- [ ] `apps/ui/src/components/settings/SettingsLayout.tsx`:
  - Header/nav/content backgrounds converted to dark translucent panels.
  - Active tab states use fleet blue/teal accents.
- [ ] `apps/ui/src/components/settings/settings-row.tsx`:
  - Section dividers/cards align with fleet border opacity and muted text.
- [ ] `apps/ui/src/components/settings/SettingsAuth.tsx`, `SettingsIntegrations.tsx`, `SettingsSkills.tsx`:
  - Replace hardcoded `emerald/amber/blue` and `dark:` split classes with fleet token classes.
  - Keep all forms and API behavior unchanged.

### Phase 6: Mobile Patterns (Safe Areas + Bottom Tabs)
- [ ] Add safe-area CSS variables usage in `styles.css` and app shell containers.
- [ ] Update `apps/ui/src/routes/index.tsx` main layout to include safe-area-aware padding for top/bottom interactive zones.
- [ ] Add a new mobile bottom tab nav component (recommended new file):
  - `apps/ui/src/components/chat/MobileBottomTabs.tsx`
  - Tabs proposal: `Agents`, `Chat`, `Artifacts`, `Settings`
  - Hook actions to existing state handlers (open sidebar, set active view, toggle artifacts).
- [ ] Add bottom spacer/padding to `MessageList` + `MessageInput` to avoid overlap with bottom tabs on small screens.
- [ ] Preserve current desktop layout exactly (sidebar + main + artifact sidebar) and only enable bottom tabs under `md`.

### Phase 7: Legacy/Unused Surface Alignment
- [ ] `apps/ui/src/components/Header.tsx` is currently unused; either:
  - bring it into fleet style for consistency, or
  - mark/deprecate/remove if confirmed dead.

## File-by-File Change Inventory
- [ ] `apps/ui/src/styles.css`: token remap, font switch, gradient + grid overlay, safe-area tokens, glass utilities.
- [ ] `apps/ui/src/lib/theme.ts`: theme preference behavior (dark-only or dark-default).
- [ ] `apps/ui/src/routes/__root.tsx`: theme init script integration updates.
- [ ] `apps/ui/src/routes/index.tsx`: app shell background hooks, mobile bottom tabs integration, safe-area spacing.
- [ ] `apps/ui/src/components/ui/button.tsx`: fleet button variants.
- [ ] `apps/ui/src/components/ui/card.tsx`: glass card defaults.
- [ ] `apps/ui/src/components/ui/badge.tsx`: fleet status color variants.
- [ ] `apps/ui/src/components/ui/dialog.tsx`: fleet overlay/content surfaces.
- [ ] `apps/ui/src/components/ui/input.tsx`: fleet input states.
- [ ] `apps/ui/src/components/chat/AgentSidebar.tsx`: sidebar visual treatment + status tokenization.
- [ ] `apps/ui/src/components/chat/ChatHeader.tsx`: glass header + fleet controls.
- [ ] `apps/ui/src/components/chat/MessageList.tsx`: message surface color cleanup + token alignment.
- [ ] `apps/ui/src/components/chat/MessageInput.tsx`: fleet composer panel.
- [ ] `apps/ui/src/components/chat/ArtifactPanel.tsx`: fleet modal panel styling.
- [ ] `apps/ui/src/components/chat/ArtifactsSidebar.tsx`: fleet side panel + tabs styling.
- [ ] `apps/ui/src/components/chat/SettingsDialog.tsx`: settings panel shell continuity.
- [ ] `apps/ui/src/components/settings/SettingsLayout.tsx`: settings nav/content styling.
- [ ] `apps/ui/src/components/settings/SettingsGeneral.tsx`: theme control behavior and copy.
- [ ] `apps/ui/src/components/settings/settings-row.tsx`: section row styling.
- [ ] `apps/ui/src/components/settings/SettingsAuth.tsx`: hardcoded status utility replacement.
- [ ] `apps/ui/src/components/settings/SettingsIntegrations.tsx`: hardcoded status utility replacement.
- [ ] `apps/ui/src/components/settings/SettingsSkills.tsx`: hardcoded status utility replacement.
- [ ] `apps/ui/src/components/Header.tsx`: optional cleanup/restyle decision.
- [ ] `apps/ui/src/components/chat/MobileBottomTabs.tsx` (new): mobile fleet bottom navigation.

## Component-Specific Before/After Targets
- [ ] AgentSidebar:
  - Before: opaque sidebar + generic hover classes.
  - After: deep navy surface, translucent hover, fleet border, fleet status dots.
- [ ] ChatHeader:
  - Before: card/80 sticky bar.
  - After: stronger glass bar (`surface-strong` feel), blur 10px+, fleet border accent.
- [ ] MessageList:
  - Before: mixed slate/amber/rose utility colors.
  - After: unified fleet token classes with readable assistant/user/system/tool blocks.
- [ ] MessageInput:
  - Before: standard bordered composer.
  - After: glass composer, rounded 12px+, fleet focus rings and action button tones.
- [ ] Settings:
  - Before: generic shadcn dark/light-adaptive sections.
  - After: fleet translucent cards, fleet borders, fleet accent-active tabs.
- [ ] Badge/status:
  - Before: generic shadcn + ad-hoc tailwind colors.
  - After: centralized fleet status semantics (ok/warn/danger/info/muted).

## Validation Checklist
- [ ] Run typecheck: `pnpm exec tsc --noEmit`.
- [ ] Run build: `pnpm build`.
- [ ] UI smoke checks:
  - manager creation dialog still works.
  - chat send/stop/compact still works.
  - settings tabs/forms persist and submit as before.
  - artifacts panel and schedules tab still open and render correctly.
- [ ] Responsive checks:
  - mobile safe-area behavior on top/bottom edges.
  - bottom tab nav behavior on mobile only.
  - desktop layout parity retained.

## Rollout Strategy
- [ ] Land in two PRs to reduce risk:
  - PR 1: tokens/fonts/theme runtime/shadcn primitive restyle.
  - PR 2: chat/settings/mobile surface refinements and bottom tabs.
- [ ] Capture before/after screenshots for: sidebar, chat thread, input, settings, artifact panel, mobile shell.

