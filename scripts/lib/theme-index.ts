/**
 * scripts/lib/theme-index.ts
 *
 * The single computation behind `themes/index.json`, shared by
 * scripts/build-index.mjs (writes the file) and scripts/validate.mjs
 * (recomputes it in memory and compares — same contract as the plugin
 * index). The index carries pack *summaries only* — id, name, variant
 * list and preview colours — so a client's browse page renders the full
 * catalogue from one fetch instead of one fetch per theme directory.
 *
 * Index shape:
 *   {
 *     "entries": [ {
 *       "id", "name", "version", "author", "description", "dir",
 *       "variantCount", "variants": [{ "id", "name", "isDark" }],
 *       "previewColors": ["#bg", "#surface", "#brand"]
 *     } ]
 *   }
 * Entries are sorted by id. Legacy single-theme documents appear with a
 * single synthetic variant (their own id/name, dark when they carry dark
 * tokens).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scanThemeDirs } from './registry-model.ts'
import { themeValidationIssues } from './theme-contrast.ts'

export interface ThemeIndexEntry {
  id: string
  name: string
  version?: string
  author?: string
  description?: string
  dir: string
  variantCount: number
  variants: { id: string; name: string; isDark: boolean }[]
  previewColors?: [string, string, string]
}

export interface ComputedThemeIndex {
  data: { entries: ThemeIndexEntry[] }
  problems: string[]
}

type Doc = Record<string, unknown>

function tokenPath(tokens: unknown, group: string, key: string): string | undefined {
  if (!tokens || typeof tokens !== 'object') return undefined
  const g = (tokens as Record<string, unknown>)[group]
  if (!g || typeof g !== 'object') return undefined
  const v = (g as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function summarize(dir: string, doc: Doc): ThemeIndexEntry {
  const base: ThemeIndexEntry = {
    id: String(doc.id),
    name: String(doc.name ?? doc.id),
    dir,
    variantCount: 0,
    variants: [],
  }
  if (typeof doc.version === 'string') base.version = doc.version
  if (typeof doc.author === 'string') base.author = doc.author
  if (typeof doc.description === 'string') base.description = doc.description

  if (Array.isArray(doc.variants)) {
    base.variants = doc.variants.map((raw) => {
      const v = (raw ?? {}) as Doc
      return {
        id: String(v.id ?? ''),
        name: String(v.name ?? v.id ?? ''),
        isDark: v.isDark !== false,
      }
    })
    const first = (doc.variants[0] ?? {}) as Doc
    const bg = tokenPath(first.tokens, 'bg', 'primary')
    const surface = tokenPath(first.tokens, 'surface', 's1')
    const brand = tokenPath(first.tokens, 'brand', 'primary')
    if (bg && surface && brand) base.previewColors = [bg, surface, brand]
  } else {
    const tokens = (doc.tokens ?? {}) as Doc
    const mode = (tokens.dark ?? tokens.light ?? {}) as Doc
    base.variants = [{ id: String(doc.id), name: String(doc.name ?? doc.id), isDark: tokens.dark !== undefined }]
    const bg = tokenPath(mode, 'bg', 'primary')
    const surface = tokenPath(mode, 'surface', 's1')
    const brand = tokenPath(mode, 'brand', 'primary')
    if (bg && surface && brand) base.previewColors = [bg, surface, brand]
  }
  base.variantCount = base.variants.length
  return base
}

export async function computeThemeIndex(root: string): Promise<ComputedThemeIndex> {
  const problems: string[] = []
  const themesDir = join(root, 'themes')
  const { dirs, issues } = await scanThemeDirs(themesDir)
  for (const issue of issues) problems.push(`themes: ${issue}`)

  const entries: ThemeIndexEntry[] = []
  for (const dir of dirs) {
    let doc: Doc
    try {
      doc = JSON.parse(await readFile(join(themesDir, dir, 'theme.json'), 'utf8')) as Doc
    } catch (e) {
      problems.push(`themes/${dir}/theme.json: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const validation = themeValidationIssues(doc)
    for (const issue of validation) problems.push(`themes/${dir}/theme.json: ${issue}`)
    if (!doc || typeof doc.id !== 'string') continue
    entries.push(summarize(dir, doc))
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { data: { entries }, problems }
}

export function serializeThemeIndex(data: { entries: ThemeIndexEntry[] }): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/** Compares the committed themes/index.json against a fresh computation. */
export async function themeIndexConsistencyIssue(root: string): Promise<string | null> {
  const { data, problems } = await computeThemeIndex(root)
  if (problems.length > 0) return null // validation reports the problems themselves
  let committed: string
  try {
    committed = await readFile(join(root, 'themes', 'index.json'), 'utf8')
  } catch {
    return 'themes/index.json: missing — run `node scripts/build-index.mjs`'
  }
  if (committed !== serializeThemeIndex(data)) {
    return 'themes/index.json: stale — run `node scripts/build-index.mjs`'
  }
  return null
}
