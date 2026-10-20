/**
 * scripts/lib/plugin-index.ts
 *
 * The single computation behind `plugins/index.json`, shared by
 * scripts/build-index.mjs (writes the file) and scripts/validate.mjs
 * (recomputes it in memory and compares — a hand-edited or stale index
 * is caught by validation itself, not only by a CI diff step).
 *
 * Index shape (schema v3 of the index file; the entries themselves are
 * unchanged schema-v2 documents):
 *   {
 *     "entries": [ <plugin entry documents, sorted by id> ],
 *     "blocked": [ { "id": ..., "reason": ... } ]   // from blocklist.json
 *   }
 * `blocked` is the client recall channel: ids a client must quarantine
 * even though they may already be installed. It is always present —
 * an empty blocklist serializes as `"blocked": []`, never omitted.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scanFileEntries } from './registry-model.ts'
import {
  validatePluginPointer,
  validatePluginProvidesGate,
  collectValidProvidedServiceKeys,
} from './schemas.ts'
import { CRITICAL_SERVICE_KEYS } from './service-keys.ts'
import { loadBlocklist, EMPTY_BLOCKLIST, type Blocklist } from './blocklist.ts'

export interface PluginIndexData {
  entries: Record<string, unknown>[]
  blocked: { id: string; reason: string }[]
}

export interface ComputedPluginIndex {
  data: PluginIndexData
  /** Human-readable problems (same strings the CLI tools print). Empty when the index is computable. */
  problems: string[]
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/**
 * Computes the index exactly as build-index.mjs writes it: scans and
 * validates every plugin entry (schema + provides gate), sorts by id,
 * and merges the blocklist's plugin ids into `blocked`.
 */
export async function computePluginIndex(root: string): Promise<ComputedPluginIndex> {
  const problems: string[] = []
  const pluginsDir = join(root, 'plugins')

  const { files, issues } = await scanFileEntries(pluginsDir)
  for (const issue of issues) problems.push(`plugins: ${issue}`)

  const raw: { file: string; doc: Record<string, unknown> }[] = []
  for (const file of files) {
    if (file === 'index.json') continue // never index the index itself
    try {
      const doc: unknown = JSON.parse(await readFile(join(pluginsDir, file), 'utf8'))
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        problems.push(`plugins/${file}: must be a JSON object`)
        continue
      }
      raw.push({ file, doc: doc as Record<string, unknown> })
    } catch (e) {
      problems.push(
        `plugins/${file}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const providedKeys = collectValidProvidedServiceKeys(raw)
  const entries: Record<string, unknown>[] = []
  const seenIds = new Set<string>()
  for (const { file, doc } of raw) {
    const entryProblems = validatePluginPointer(doc, file, providedKeys)
    for (const p of entryProblems) {
      problems.push(`plugins/${file}${p.field ? ` (${p.field})` : ''}: ${p.message}`)
    }
    if (entryProblems.length > 0) continue
    if (seenIds.has(doc.id as string)) {
      problems.push(`plugins/${file}: duplicate plugin id "${doc.id as string}"`)
      continue
    }
    seenIds.add(doc.id as string)
    entries.push(doc)
  }

  if (problems.length === 0) {
    const byIdMap = new Map(entries.map((doc) => [doc.id as string, doc]))
    for (const p of validatePluginProvidesGate(byIdMap, new Set(CRITICAL_SERVICE_KEYS))) {
      problems.push(`plugins (${p.field}): ${p.message}`)
    }
  }

  entries.sort((a, b) => byId(a as { id: string }, b as { id: string }))

  let blocklist: Blocklist = structuredClone(EMPTY_BLOCKLIST)
  try {
    blocklist = await loadBlocklist(root)
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e))
  }
  const blocked = blocklist.pluginIds.map(({ id, reason }) => ({ id, reason })).sort(byId)

  return { data: { entries, blocked }, problems }
}

/** Canonical serialization of the index (what build-index.mjs writes). */
export function serializePluginIndex(data: PluginIndexData): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/**
 * The index-consistency check validate.mjs runs: recomputes the index
 * from the current entries + blocklist and compares it byte-for-byte
 * with the committed `plugins/index.json`. Returns a problem string, or
 * null when consistent. When the index is not even computable (invalid
 * entries), returns null — those problems are reported by the per-entry
 * validation itself; this check exists to catch a stale or hand-edited
 * index, which per-entry validation cannot see.
 */
export async function pluginIndexConsistencyIssue(root: string): Promise<string | null> {
  const { data, problems } = await computePluginIndex(root)
  if (problems.length > 0) return null
  const expected = serializePluginIndex(data)
  let committed: string
  try {
    committed = await readFile(join(root, 'plugins', 'index.json'), 'utf8')
  } catch {
    return 'plugins/index.json is missing — run: node scripts/build-index.mjs'
  }
  if (committed !== expected) {
    return 'plugins/index.json: committed index does not match the index computed from the current entries and blocklist (stale or hand-edited) — run: node scripts/build-index.mjs'
  }
  return null
}
