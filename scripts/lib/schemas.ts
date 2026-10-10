/**
 * scripts/lib/schemas.ts
 *
 * Explicit validators for music-sources, lyric-sources, and plugins metadata pointers.
 * Unknown fields are strictly rejected.
 */

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/)?$/

export const SOURCE_ALLOWED_FIELDS = [
  'id', 'name', 'repo', 'author', 'description', 'version', 'minAppVersion',
] as const

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
  'id', 'name', 'repo', 'author', 'description', 'capabilities',
  'category', 'dependencies', 'compositors', 'i18n', 'version',
  'minAppVersion', 'screenshot', 'engines', 'homepage',
] as const

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

  return issues
}

/**
 * Validates a plugin pointer metadata document.
 */
export function validatePluginPointer(value: unknown, fileName: string): ValidationIssue[] {
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

  // Required: id, name, repo, author, description, capabilities, category, dependencies, compositors, i18n, version
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

  // capabilities: string[]
  if (!Array.isArray(meta.capabilities) || !meta.capabilities.every((c) => typeof c === 'string')) {
    at('capabilities', 'required array of capability strings')
  }

  // category: enum
  if (typeof meta.category !== 'string') {
    at('category', `required — must be one of: ${PLUGIN_CATEGORIES.join(', ')}`)
  } else if (!(PLUGIN_CATEGORIES as readonly string[]).includes(meta.category)) {
    at('category', `invalid category "${meta.category}", must be one of: ${PLUGIN_CATEGORIES.join(', ')}`)
  }

  // dependencies: string[] (can be empty array)
  if (!Array.isArray(meta.dependencies) || !meta.dependencies.every((d) => typeof d === 'string')) {
    at('dependencies', 'required array of dependency strings (can be empty array [])')
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

  // i18n: boolean
  if (typeof meta.i18n !== 'boolean') {
    at('i18n', 'required boolean')
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

  return issues
}
