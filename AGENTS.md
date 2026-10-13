# AGENTS.md — working on B_Be_Bee-registry

A distilled guide for AI programming assistants and contributors working on `B_Be_Bee-registry`.

---

## 1. What this repository is

`B_Be_Bee-registry` is the decentralized metadata registry for the BBeBee music player ecosystem.
It is a **pure metadata index**:
- **Music & lyric sources**: Pointers only (`{username}-{name}.json`), pointing to author GitHub repos.
- **Plugins**: Pointers only (`{username}-{pluginname}.json`), pointing to author GitHub repos.
- **Themes**: Content in-repo (`themes/{author}-{name}/`), containing `theme.json` and `preview.png`.
- **Zero build output**: No `dist/`, no `registry.json`, no centralized bundle.

---

## 2. Commands

```bash
# Full validation (offline/sandbox falls back to warnings for unreachable networks)
node scripts/validate.mjs

# Strict mode (warnings treated as failures)
node scripts/validate.mjs --strict

# Skip network connectivity checks (syntax & schema validation only)
node scripts/validate.mjs --skip-network

# Negative test suite (verifies that invalid entries are blocked)
node scripts/validate.mjs --test
```

---

## 3. Four Entry Types & Schema Rules

### 3.1 Music Sources & Lyric Sources
Path: `music-sources/{username}-{name}.json` / `lyric-sources/{username}-{name}.json`
- **Required**: `id`, `name`, `repo`, `author`, `description`, `version`.
- **Optional**: `minAppVersion`, `params` (string[] — customizable parameter keys, e.g. `["sourceurl", "username", "password"]`).
- **Repo constraint**: Must match `https://github.com/<owner>/<repo>`, where `<owner>` equals `{username}` in the filename.
- **Reject unknown fields**.

### 3.2 Plugins
Path: `plugins/{username}-{pluginname}.json`
- **Required**: `id`, `name`, `repo`, `author`, `description`, `capabilities` (string[]), `category`, `dependencies` (string[]), `compositors` (string[]), `i18n` (boolean), `version`.
- **Optional**: `minAppVersion`, `screenshot` (https URL), `engines`, `homepage` (https URL).
- **Category enum**: `ui-enhancement`, `notifications-integration`, `development-runtime`, `security-permissions`, `remote-mobile`, `marketplace-management`, `other`.
- **Compositors enum**: `now-playing.actions`, `now-playing.panel`, `now-playing.visualizer`, `track.context-menu`, `album.context-menu`, `library.sidebar`, `search.results-section`, `settings.sources`, `source.browse`, `topbar.tray`, `status-bar`, `tray`.
- **Repo constraint**: `<owner>` in repo URL must equal `{username}` in the filename.
- **Reject unknown fields**.

### 3.3 Themes
Path: `themes/{author}-{name}/`
- **Required files**: `theme.json`, `preview.png`.
- **theme.json required**: `id`, `name`, `version`, `author`, `description`, `tokens`.
- **Tokens**: Must contain `dark` and/or `light` modes (at least one). All values must be valid `#hex` colors (`#rrggbb`, `#rrggbbaa`, `#rgb`).
- **Contrast gate**: Must pass WCAG AA contrast requirements (normal text >= 4.5:1, bold/large text & components >= 3:1).
- Does not use `repo`.
- **Reject unknown fields**.

---

## 4. Acceptance Gate

Before finishing any change:
- `node scripts/validate.mjs` must output **0 errors**.
- `node scripts/validate.mjs --test` must pass all negative tests.
