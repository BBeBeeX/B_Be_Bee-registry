/**
 * scripts/lib/registry-model.ts
 *
 * Registry model and directory scanner for the four content kinds.
 */

import { readdir } from 'node:fs/promises'

export type RegistryKind = 'music-source' | 'lyric-source' | 'theme' | 'plugin'

export interface KindSpec {
  dir: string
  kind: RegistryKind
  isFileEntry: boolean
}

export const KINDS: KindSpec[] = [
  { dir: 'music-sources', kind: 'music-source', isFileEntry: true },
  { dir: 'lyric-sources', kind: 'lyric-source', isFileEntry: true },
  { dir: 'themes', kind: 'theme', isFileEntry: false },
  { dir: 'plugins', kind: 'plugin', isFileEntry: true },
]

const SLUG_WITH_HYPHEN = /^[a-z0-9]+(-[a-z0-9]+)+$/

/**
 * Validates the base entry name (filename without .json, or theme dir name).
 * Must be lowercase alphanumeric with at least one hyphen separating username/author and name.
 */
export function validateEntryName(name: string): string | undefined {
  if (!SLUG_WITH_HYPHEN.test(name)) {
    return `"${name}" must be lowercase alphanumeric separated by hyphens and follow {username}-{name} convention`
  }
  return undefined
}

/**
 * Scans a file-based entry directory (music-sources, lyric-sources, plugins)
 * Returns array of filenames ending with .json.
 */
export async function scanFileEntries(dir: string): Promise<{ files: string[]; issues: string[] }> {
  const issues: string[] = []
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue
    // Generated aggregate index (see scripts/build-index.mjs) — not an entry.
    if (entry.name === 'index.json') continue
    if (entry.isDirectory()) {
      issues.push(`${entry.name}: directories are not allowed here (entries must be .json files)`)
      continue
    }
    if (!entry.name.endsWith('.json')) {
      issues.push(`${entry.name}: unexpected file (only .json entry files allowed)`)
      continue
    }
    const baseName = entry.name.slice(0, -'.json'.length)
    const nameIssue = validateEntryName(baseName)
    if (nameIssue) {
      issues.push(`${entry.name}: ${nameIssue}`)
    }
    files.push(entry.name)
  }

  files.sort()
  return { files, issues }
}

/**
 * Scans theme directories.
 * Returns array of theme directory names.
 */
export async function scanThemeDirs(dir: string): Promise<{ dirs: string[]; issues: string[] }> {
  const issues: string[] = []
  const dirs: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue
    if (entry.name === 'index.json') continue // the generated theme index lives beside the dirs
    if (!entry.isDirectory()) {
      issues.push(`${entry.name}: unexpected file in themes/ (only theme directories allowed)`)
      continue
    }
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const nameIssue = validateEntryName(entry.name)
    if (nameIssue) {
      issues.push(`${entry.name}: ${nameIssue}`)
    }
    dirs.push(entry.name)
  }

  dirs.sort()
  return { dirs, issues }
}
