/**
 * Shared model for the registry scripts: the four content kinds, how entry
 * directories are scanned, last-commit dates, and the raw download-URL base.
 */

import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const REGISTRY_REPO_DEFAULT = 'BBeBeeX/B_Be_Bee-registry'
export const REGISTRY_BRANCH = 'main'

/**
 * The GitHub org/repo used for raw download URLs. `REGISTRY_REPOSITORY`
 * (env, "org/repo") overrides — the app's default endpoint and the CI both
 * derive from this, so forking the registry and pointing a build at the fork
 * is one variable.
 */
export function registryRepository(): string {
  const fromEnv = process.env['REGISTRY_REPOSITORY']
  if (fromEnv && /^[^/\s]+\/[^/\s]+$/.test(fromEnv)) return fromEnv
  return REGISTRY_REPO_DEFAULT
}

export function rawBaseUrl(): string {
  return `https://raw.githubusercontent.com/${registryRepository()}/${REGISTRY_BRANCH}`
}

export type RegistryKind = 'music-source' | 'lyric-source' | 'theme' | 'plugin'

export interface KindSpec {
  /** Directory at the repo root holding one sub-directory per entry. */
  dir: string
  kind: RegistryKind
  /** Where compiled single-file output goes (music/lyric only). */
  distDir?: string
}

export const KINDS: KindSpec[] = [
  { dir: 'music-sources', kind: 'music-source', distDir: 'dist/music-sources' },
  { dir: 'lyric-sources', kind: 'lyric-source', distDir: 'dist/lyric-sources' },
  { dir: 'themes', kind: 'theme' },
  { dir: 'plugins', kind: 'plugin' },
]

/**
 * Entries seeded before the {author}-{name} convention existed (they moved
 * here from the main repo, which consumed their directory names as fixture
 * file names). New entries must follow the convention; these are exempt.
 */
export const SEED_DIR_ALLOWLIST = new Set([
  'bilibili',
  'lrclib',
  'direct-url',
  'podcast-json-feed',
  'subsonic',
])

const DIR_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Sub-directories of a kind directory that are entries. Files (README.md,
 * .gitkeep) and dot/underscore-prefixed dirs are skipped — the same rule the
 * main repo's build uses.
 */
export async function scanEntryDirs(kindRoot: string): Promise<string[]> {
  const entries = await readdir(kindRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()
}

/** Naming-rule issues for one entry directory name. */
export function dirNameIssues(kind: RegistryKind, dirName: string): string | undefined {
  if (!DIR_NAME.test(dirName)) {
    return `directory name "${dirName}" must be lowercase letters/digits separated by single hyphens`
  }
  if (kind === 'plugin') {
    // Plugin metadata is a single file plugins/<id>.json; handled separately.
    return undefined
  }
  if (dirName.includes('-') || SEED_DIR_ALLOWLIST.has(dirName)) return undefined
  return `directory name "${dirName}" must follow the {author}-{name} convention (e.g. "alice-mydreamfm"), or be added to SEED_DIR_ALLOWLIST with a reason`
}

/**
 * The entry's last-commit time (ISO 8601), the registry's `updatedAt`. Falls
 * back to null when git has no history yet (fresh clones of a not-yet-pushed
 * repo, or CI shallow checkouts without fetch-depth: 0).
 */
export function gitLastCommitDate(paths: string[]): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...paths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}
