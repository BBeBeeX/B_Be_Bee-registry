/**
 * scripts/lib/schemas.ts
 *
 * Explicit validators for music-sources, lyric-sources, and plugins metadata pointers.
 * Unknown fields are strictly rejected.
 *
 * Plugin entries follow schema v2 (2026-10-20): no `version` field (version
 * truth lives on npm + inside the plugin package), `services` replaces the
 * old `capabilities` name, `npm` points at the npm package to download, and
 * `platforms` declares supported platforms.
 *
 * An entry may also declare `provides`: the Cordis service keys the plugin
 * itself registers for others. A `services` key is valid when it is a core
 * key (scripts/lib/service-keys.ts) OR appears in some entry's `provides` —
 * that cross-entry half is resolved by collectProvidedServiceKeys() and
 * passed into validatePluginPointer() by the callers (validate.mjs,
 * build-index.mjs), which scan all entries before validating any of them.
 */

import { isKnownServiceKey } from './service-keys.ts'
import { isValidRange } from './semver-range.ts'

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
/** Shape of a service key a plugin may claim to provide (letter first). */
export const SERVICE_KEY_FORMAT = /^[A-Za-z][A-Za-z0-9-]*$/
export const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/)?$/
/** npm package name: optional @scope/, then name (npm naming rules). */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export const SOURCE_ALLOWED_FIELDS = [
  'id', 'name', 'repo', 'author', 'description', 'version', 'minAppVersion', 'params',
  'platforms',
] as const

export const PLUGIN_PLATFORMS = ['desktop', 'mobile'] as const

export const PLUGIN_CATEGORIES = [
  'ui-enhancement',
  'notifications-integration',
  'development-runtime',
  'security-permissions',
  'remote-mobile',
  'marketplace-management',
  'other',
] as const

export const PLUGIN_COMPOSITORS = [
  'now-playing.actions',
  'now-playing.panel',
  'now-playing.visualizer',
  'track.context-menu',
  'album.context-menu',
  'library.sidebar',
  'search.results-section',
  'settings.sources',
  'source.browse',
  'topbar.tray',
  'status-bar',
  'tray',
] as const

export const PLUGIN_ALLOWED_FIELDS = [
  'id', 'name', 'repo', 'author', 'description', 'npm', 'services', 'provides',
  'platforms', 'category', 'dependencies', 'compositors', 'i18n',
  'minAppVersion', 'screenshot', 'engines', 'homepage',
  'reviewedVersion', 'reviewedIntegrity',
] as const

/** sha512 SRI string as npm reports it in dist.integrity ("sha512-…" + base64). */
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}={0,2}$/

export interface ValidationIssue {
  field: string
  message: string
}

/**
 * Validates a GitHub repo URL and extracts owner and repo names.
 */
export function parseGitHubRepo(repoUrl: unknown): { owner: string; repo: string } | null {
  if (typeof repoUrl !== 'string') return null
  const match = repoUrl.trim().match(GITHUB_REPO)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]! }
}

/**
 * Validates filename against GitHub owner (case-insensitive check).
 * Expected filename: {username}-{name}.json where username matches owner.
 */
export function checkFilenameOwner(fileName: string, repoOwner: string): string | undefined {
  const expectedPrefix = `${repoOwner.toLowerCase()}-`
  if (!fileName.toLowerCase().startsWith(expectedPrefix)) {
    return `filename "${fileName}" username prefix does not match repo GitHub owner "${repoOwner}"`
  }
  const rest = fileName.slice(expectedPrefix.length)
  if (!rest.endsWith('.json') || rest.length <= 5) {
    return `filename "${fileName}" must have a name component after "{username}-"`
  }
  return undefined
}

/**
 * Validates a music-source or lyric-source pointer.
 */
export function validateSourcePointer(
  value: unknown,
  fileName: string,
  kind: 'music-source' | 'lyric-source',
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const at = (field: string, message: string) => issues.push({ field, message })

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    at('', `${fileName}: must be a JSON object`)
    return issues
  }
  const meta = value as Record<string, unknown>

  // Unknown fields rejected
  for (const key of Object.keys(meta)) {
    if (!(SOURCE_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      at(key, `unknown field (only ${SOURCE_ALLOWED_FIELDS.join(', ')} allowed)`)
    }
  }

  // Required fields: id, name, repo, author, description, version
  if (typeof meta.id !== 'string' || !meta.id.trim()) {
    at('id', 'required')
  } else if (!SLUG.test(meta.id)) {
    at('id', 'must be lowercase letters/digits separated by single hyphens')
  }

  if (typeof meta.name !== 'string' || !meta.name.trim()) at('name', 'required')
  if (typeof meta.author !== 'string' || !meta.author.trim()) at('author', 'required')
  if (typeof meta.description !== 'string' || !meta.description.trim()) at('description', 'required')
  if (typeof meta.version !== 'string' || !SEMVER.test(meta.version)) {
    at('version', 'required, semver (e.g. "1.0.0")')
  }

  // repo check: required, must be https://github.com/<owner>/<repo>
  if (typeof meta.repo !== 'string' || !meta.repo.trim()) {
    at('repo', 'required — must point to author GitHub repository (https://github.com/<owner>/<repo>)')
  } else {
    const parsed = parseGitHubRepo(meta.repo)
    if (!parsed) {
      at('repo', `must be in format https://github.com/<owner>/<repo>, got ${JSON.stringify(meta.repo)}`)
    } else {
      const fnIssue = checkFilenameOwner(fileName, parsed.owner)
      if (fnIssue) at('repo', fnIssue)
    }
  }

  // minAppVersion: optional, semver
  if (meta.minAppVersion !== undefined) {
    if (typeof meta.minAppVersion !== 'string' || !SEMVER.test(meta.minAppVersion)) {
      at('minAppVersion', 'must be a semver string when present')
    }
  }

  // params: optional array of non-empty strings
  if (meta.params !== undefined) {
    if (!Array.isArray(meta.params) || !meta.params.every((p) => typeof p === 'string' && p.trim().length > 0)) {
      at('params', 'must be an array of non-empty strings when present')
    }
  }

  // platforms: optional, non-empty array of 'desktop' | 'mobile' (absent = all platforms)
  const platformsIssue = validatePlatformsField(meta.platforms, false)
  if (platformsIssue) at('platforms', platformsIssue)

  return issues
}

/**
 * Validates a `platforms` field value. When `required` is true the field
 * must be present and non-empty; otherwise it may be absent (all platforms).
 */
export function validatePlatformsField(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    return required ? 'required, non-empty array of: desktop, mobile' : undefined
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((p) => typeof p === 'string' && (PLUGIN_PLATFORMS as readonly string[]).includes(p))
  ) {
    return `must be a non-empty array of: ${PLUGIN_PLATFORMS.join(', ')}`
  }
  return undefined
}

/**
 * Validates a plugin pointer metadata document.
 *
 * @param extraServiceKeys additional valid `services` keys beyond the core
 *   allowlist — the union of every registry entry's `provides` keys, as
 *   collected by {@link collectProvidedServiceKeys}. Callers that validate
 *   more than one entry must collect first and pass the set in; with no
 *   extras only core service keys are accepted.
 */
export function validatePluginPointer(
  value: unknown,
  fileName: string,
  extraServiceKeys?: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const at = (field: string, message: string) => issues.push({ field, message })

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    at('', `${fileName}: must be a JSON object`)
    return issues
  }
  const meta = value as Record<string, unknown>

  // Unknown fields rejected
  for (const key of Object.keys(meta)) {
    if (!(PLUGIN_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      at(key, `unknown field (only ${PLUGIN_ALLOWED_FIELDS.join(', ')} allowed)`)
    }
  }

  // Required: id, name, repo, author, description, npm, services, platforms,
  //           category, dependencies, compositors, i18n.
  // NOTE: `version` was removed in schema v2 — version truth lives on npm
  // and inside the plugin package. `capabilities` was renamed to `services`.
  if (typeof meta.id !== 'string' || !meta.id.trim()) {
    at('id', 'required')
  } else if (!SLUG.test(meta.id)) {
    at('id', 'must be lowercase letters/digits separated by single hyphens')
  }

  if (typeof meta.name !== 'string' || !meta.name.trim()) at('name', 'required')
  if (typeof meta.author !== 'string' || !meta.author.trim()) at('author', 'required')
  if (typeof meta.description !== 'string' || !meta.description.trim()) at('description', 'required')

  // npm: required npm package name (the package clients download)
  if (typeof meta.npm !== 'string' || !meta.npm.trim()) {
    at('npm', 'required — npm package name to download (e.g. "@alice/bbebee-plugin-foo")')
  } else if (!NPM_PACKAGE_NAME.test(meta.npm.trim())) {
    at('npm', `invalid npm package name ${JSON.stringify(meta.npm)}`)
  }

  // repo check
  if (typeof meta.repo !== 'string' || !meta.repo.trim()) {
    at('repo', 'required — must point to author GitHub repository (https://github.com/<owner>/<repo>)')
  } else {
    const parsed = parseGitHubRepo(meta.repo)
    if (!parsed) {
      at('repo', `must be in format https://github.com/<owner>/<repo>, got ${JSON.stringify(meta.repo)}`)
    } else {
      const fnIssue = checkFilenameOwner(fileName, parsed.owner)
      if (fnIssue) at('repo', fnIssue)
    }
  }

  // services: required array of Cordis service keys this plugin injects
  // (used for install-time dependency checks). May be empty [] — a pure
  // event-driven plugin injects nothing. A key is valid when it is a core
  // key (scripts/lib/service-keys.ts) or provided by another registry
  // entry via `provides` (extraServiceKeys).
  if (!Array.isArray(meta.services)) {
    at('services', 'required array of Cordis service keys (may be empty [], e.g. ["player", "store"])')
  } else {
    for (const s of meta.services) {
      if (typeof s !== 'string' || !s.trim()) {
        at('services', 'must contain only non-empty strings')
        break
      }
      if (!isKnownServiceKey(s) && !(extraServiceKeys && extraServiceKeys.has(s))) {
        at(
          'services',
          `unknown Cordis service key "${s}" — must be a core key (scripts/lib/service-keys.ts) or provided by another plugin entry ("provides")`,
        )
      }
    }
  }

  // provides: optional array of service keys THIS plugin registers for other
  // plugins to inject. Format-checked here; the cross-entry union that makes
  // these keys valid in other entries' `services` is collectProvidedServiceKeys().
  if (meta.provides !== undefined) {
    if (
      !Array.isArray(meta.provides) ||
      !meta.provides.every((k) => typeof k === 'string' && SERVICE_KEY_FORMAT.test(k))
    ) {
      at('provides', 'must be an array of service keys (e.g. ["myService"]) when present')
    }
  }

  // platforms: required non-empty array of 'desktop' | 'mobile'
  const platformsIssue = validatePlatformsField(meta.platforms, true)
  if (platformsIssue) at('platforms', platformsIssue)

  // category: enum
  if (typeof meta.category !== 'string') {
    at('category', `required — must be one of: ${PLUGIN_CATEGORIES.join(', ')}`)
  } else if (!(PLUGIN_CATEGORIES as readonly string[]).includes(meta.category)) {
    at('category', `invalid category "${meta.category}", must be one of: ${PLUGIN_CATEGORIES.join(', ')}`)
  }

  // dependencies: required array of "<registry-id>" or "<registry-id>@<semver-range>"
  // (can be empty array []). Existence + cycle checks run in
  // validatePluginDependencyGraph(), which sees all entries at once.
  if (!Array.isArray(meta.dependencies)) {
    at('dependencies', 'required array (can be empty array [])')
  } else {
    for (const d of meta.dependencies) {
      const parsed = parsePluginDependency(d)
      if (!parsed) {
        at('dependencies', `invalid dependency ${JSON.stringify(d)} — expected "<id>" or "<id>@<semver-range>"`)
      }
    }
  }

  // compositors: string[], each in enum
  if (!Array.isArray(meta.compositors) || !meta.compositors.every((c) => typeof c === 'string')) {
    at('compositors', `required array of compositor mount points`)
  } else {
    for (const comp of meta.compositors) {
      if (!(PLUGIN_COMPOSITORS as readonly string[]).includes(comp)) {
        at('compositors', `invalid compositor mount point "${comp}", must be one of: ${PLUGIN_COMPOSITORS.join(', ')}`)
      }
    }
  }

  // i18n: non-empty string[] of language tags (e.g. ["en", "zh", "zh-CN"])
  if (
    !Array.isArray(meta.i18n) ||
    meta.i18n.length === 0 ||
    !meta.i18n.every((l) => typeof l === 'string' && LANG_TAG.test(l))
  ) {
    at('i18n', 'required non-empty array of language tags (e.g. ["en", "zh"])')
  }

  // Optional fields: minAppVersion, screenshot, engines, homepage
  if (meta.minAppVersion !== undefined) {
    if (typeof meta.minAppVersion !== 'string' || !SEMVER.test(meta.minAppVersion)) {
      at('minAppVersion', 'must be a semver string when present')
    }
  }

  if (meta.screenshot !== undefined) {
    if (typeof meta.screenshot !== 'string' || !/^https:\/\//.test(meta.screenshot)) {
      at('screenshot', 'must be an https:// URL when present')
    }
  }

  if (meta.engines !== undefined) {
    if (meta.engines === null || typeof meta.engines !== 'object' || Array.isArray(meta.engines)) {
      at('engines', 'must be an object like { "bbebee": ">=0.1.0" }')
    }
  }

  if (meta.homepage !== undefined) {
    if (typeof meta.homepage !== 'string' || !/^https:\/\//.test(meta.homepage)) {
      at('homepage', 'must be an https:// URL when present')
    }
  }

  // reviewedVersion / reviewedIntegrity: the optional reviewed pin. CI
  // verifies the pinned version exists on npm and its dist.integrity
  // matches, and runs the package-content checks against the pinned
  // version (a newer unreviewed `latest` only warns). The pair is only
  // meaningful together.
  if (meta.reviewedVersion !== undefined) {
    if (typeof meta.reviewedVersion !== 'string' || !SEMVER.test(meta.reviewedVersion)) {
      at('reviewedVersion', 'must be a semver string when present')
    }
  }
  if (meta.reviewedIntegrity !== undefined) {
    if (typeof meta.reviewedIntegrity !== 'string' || !SRI_SHA512.test(meta.reviewedIntegrity)) {
      at('reviewedIntegrity', 'must be a sha512 SRI string ("sha512-…") when present')
    }
  }
  if ((meta.reviewedVersion === undefined) !== (meta.reviewedIntegrity === undefined)) {
    at(
      'reviewedVersion',
      'reviewedVersion and reviewedIntegrity must be declared together (a reviewed pin is only meaningful as a pair)',
    )
  }

  return issues
}

/**
 * Collects the union of well-formed `provides` keys across plugin entries.
 * Callers scan every entry first, then pass the result as `extraServiceKeys`
 * to {@link validatePluginPointer} — that two-pass flow is what lets an
 * entry's `services` reference a service another plugin provides. Malformed
 * `provides` items are skipped here; they are reported by the per-entry
 * format check in validatePluginPointer().
 */
export function collectProvidedServiceKeys(
  entries: Iterable<Record<string, unknown>>,
): Set<string> {
  const keys = new Set<string>()
  for (const doc of entries) {
    if (!doc || !Array.isArray(doc.provides)) continue
    for (const k of doc.provides) {
      if (typeof k === 'string' && SERVICE_KEY_FORMAT.test(k)) keys.add(k)
    }
  }
  return keys
}

/**
 * Collects `provides` keys from entries that THEMSELVES pass full schema
 * validation — and only those. A rejected entry must not be able to make
 * another entry's `services` legal by declaring the key in `provides`
 * (the pre-scan previously collected from every parseable document,
 * including ones that fail validation on other grounds).
 *
 * Fixed-point: start from every entry's format-valid provides as the
 * candidate extras, keep only the entries that validate cleanly against
 * them, re-collect from the survivors, and repeat until stable. An entry
 * whose only defect is consuming a key provided by a dropped entry is
 * itself dropped in the next round.
 */
export function collectValidProvidedServiceKeys(
  items: Iterable<{ file: string; doc: Record<string, unknown> }>,
): Set<string> {
  let eligible = [...items]
  for (;;) {
    const extras = collectProvidedServiceKeys(eligible.map((i) => i.doc))
    const next = eligible.filter((i) => validatePluginPointer(i.doc, i.file, extras).length === 0)
    if (next.length === eligible.length) return extras
    eligible = next
  }
}

/**
 * Cross-entry gate on `provides` declarations (audit finding: previously
 * any entry could claim any service, unchecked):
 *  (a) an entry may not provide a CRITICAL core key — those services
 *      belong to builtin providers (credentials, code execution, the
 *      data layer, the plugin system itself) and are never replaceable
 *      by a registry entry;
 *  (b) a service key may have at most ONE registry provider — two
 *      entries claiming the same key would make install-time service
 *      resolution ambiguous.
 *
 * @param entries map of plugin id → parsed entry document
 * @param criticalKeys the critical subset of the core allowlist
 *   (scripts/lib/service-keys.ts, vendored from the BBeBee generator)
 */
export function validatePluginProvidesGate(
  entries: Map<string, Record<string, unknown>>,
  criticalKeys: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const at = (field: string, message: string) => issues.push({ field, message })

  const providersByKey = new Map<string, string[]>()
  for (const [id, doc] of entries) {
    if (!doc || !Array.isArray(doc.provides)) continue
    const own = new Set<string>()
    for (const k of doc.provides) {
      if (typeof k !== 'string' || own.has(k)) continue
      own.add(k)
      if (criticalKeys.has(k)) {
        at(
          'provides',
          `plugin "${id}" claims to provide critical core service "${k}" — critical services are reserved to builtin providers and cannot be provided by a registry entry`,
        )
      }
      const list = providersByKey.get(k) ?? []
      list.push(id)
      providersByKey.set(k, list)
    }
  }
  for (const [key, ids] of providersByKey) {
    if (ids.length > 1) {
      at(
        'provides',
        `service key "${key}" is provided by multiple entries (${ids.join(', ')}) — a service key may have only one registry provider`,
      )
    }
  }
  return issues
}

export interface PluginDependency {
  /** Registry id of the depended-upon plugin entry. */
  id: string
  /** Semver range, or null when the dependency pins no range (= latest). */
  range: string | null
}

/**
 * Parses one `dependencies` item: "<registry-id>" or "<registry-id>@<range>".
 * Returns null when the item is malformed or the range is not in the
 * supported semver grammar (see scripts/lib/semver-range.ts).
 */
export function parsePluginDependency(dep: unknown): PluginDependency | null {
  if (typeof dep !== 'string' || !dep.trim()) return null
  const text = dep.trim()
  // Split on the LAST "@" so scoped ids (not used here, but harmless) keep working.
  const atIndex = text.lastIndexOf('@')
  let id: string
  let range: string | null = null
  if (atIndex <= 0) {
    id = text
  } else {
    id = text.slice(0, atIndex)
    range = text.slice(atIndex + 1).trim()
    if (!range || !isValidRange(range)) return null
  }
  if (!SLUG.test(id)) return null
  return { id, range }
}

/**
 * Cross-entry plugin dependency checks: every dependency id must resolve to
 * an existing `plugins/<id>.json` entry, and the dependency graph must be
 * acyclic (DFS; a cycle fails the whole registry).
 *
 * @param entries map of plugin id → parsed entry document
 */
export function validatePluginDependencyGraph(
  entries: Map<string, Record<string, unknown>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const at = (field: string, message: string) => issues.push({ field, message })

  // Build adjacency: id → dependency ids (only for resolvable, well-formed deps)
  const edges = new Map<string, string[]>()
  for (const [id, doc] of entries) {
    const deps = Array.isArray(doc.dependencies) ? doc.dependencies : []
    const targets: string[] = []
    for (const d of deps) {
      const parsed = parsePluginDependency(d)
      if (!parsed) continue // malformed shape already reported per-entry
      if (!entries.has(parsed.id)) {
        at('dependencies', `plugin "${id}" depends on unknown plugin id "${parsed.id}"`)
        continue
      }
      targets.push(parsed.id)
    }
    edges.set(id, targets)
  }

  // Cycle detection (iterative DFS with explicit stack for clear messages)
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of entries.keys()) color.set(id, WHITE)

  const visit = (start: string): void => {
    const stack: Array<{ id: string; childIndex: number }> = [{ id: start, childIndex: 0 }]
    color.set(start, GRAY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const children = edges.get(frame.id) ?? []
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex]!
        frame.childIndex++
        const childColor = color.get(child) ?? BLACK
        if (childColor === GRAY) {
          const cycle = [...stack.map((f) => f.id), child].join(' → ')
          at('dependencies', `dependency cycle detected: ${cycle}`)
        } else if (childColor === WHITE) {
          color.set(child, GRAY)
          stack.push({ id: child, childIndex: 0 })
        }
      } else {
        color.set(frame.id, BLACK)
        stack.pop()
      }
    }
  }

  for (const id of entries.keys()) {
    if (color.get(id) === WHITE) visit(id)
  }

  return issues
}

