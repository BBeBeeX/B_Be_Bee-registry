/**
 * scripts/lib/blocklist.ts
 *
 * The machine-readable carrier for MODERATION.md's blacklist policy.
 * `blocklist.json` at the repository root lists plugin ids, npm package
 * names, GitHub accounts and GitHub repos (owner/name) that are banned
 * from the registry, each with a human-readable `reason`.
 *
 * Effects:
 *  - validate.mjs hard-errors any entry that hits any of the four lists
 *    (a blocked author cannot re-enter under a fresh entry name).
 *  - build-index.mjs publishes the pluginIds list as the top-level
 *    `blocked` array of plugins/index.json, so clients can quarantine
 *    already-installed copies of a delisted plugin (the recall channel).
 *
 * Zero npm dependencies, like every registry script.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGitHubRepo } from './schemas.ts'

export interface Blocklist {
  pluginIds: { id: string; reason: string }[]
  npmPackages: { name: string; reason: string }[]
  githubAccounts: { account: string; reason: string }[]
  /** Entries are "owner/name" (no URL), matched case-insensitively. */
  repos: { repo: string; reason: string }[]
}

export const EMPTY_BLOCKLIST: Blocklist = {
  pluginIds: [],
  npmPackages: [],
  githubAccounts: [],
  repos: [],
}

const LIST_KEYS = {
  pluginIds: 'id',
  npmPackages: 'name',
  githubAccounts: 'account',
  repos: 'repo',
} as const

type ListName = keyof typeof LIST_KEYS

const VALUE_FORMATS: Record<ListName, RegExp> = {
  pluginIds: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  npmPackages: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  githubAccounts: /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
  repos: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
}

/**
 * Validates an unknown value as a blocklist document. Throws with the
 * origin named on any malformation — like the service-key allowlist, a
 * malformed blocklist must fail loudly, never silently match nothing.
 */
export function parseBlocklist(raw: unknown, origin: string): Blocklist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`blocklist from ${origin} is not an object`)
  }
  const doc = raw as Record<string, unknown>
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && !(key in LIST_KEYS)) {
      throw new Error(`blocklist from ${origin} has unknown field "${key}"`)
    }
  }
  const out: Blocklist = { pluginIds: [], npmPackages: [], githubAccounts: [], repos: [] }
  for (const listName of Object.keys(LIST_KEYS) as ListName[]) {
    const valueKey = LIST_KEYS[listName]
    const list = doc[listName]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      throw new Error(`blocklist from ${origin}: "${listName}" must be an array`)
    }
    const seen = new Set<string>()
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`blocklist from ${origin}: "${listName}" entries must be objects`)
      }
      const rec = item as Record<string, unknown>
      const value = rec[valueKey]
      const reason = rec.reason
      if (typeof value !== 'string' || !VALUE_FORMATS[listName].test(value)) {
        throw new Error(
          `blocklist from ${origin}: "${listName}" entry has an invalid "${valueKey}" ${JSON.stringify(value)}`,
        )
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new Error(
          `blocklist from ${origin}: "${listName}" entry "${value}" must carry a non-empty "reason"`,
        )
      }
      const dedupeKey = value.toLowerCase()
      if (seen.has(dedupeKey)) {
        throw new Error(`blocklist from ${origin}: "${listName}" lists "${value}" twice`)
      }
      seen.add(dedupeKey)
      ;(out[listName] as { [k: string]: string }[]).push({ [valueKey]: value, reason })
    }
  }
  return out
}

/** Loads and parses `<root>/blocklist.json`. A missing file reads as an empty blocklist. */
export async function loadBlocklist(root: string): Promise<Blocklist> {
  let text: string
  try {
    text = await readFile(join(root, 'blocklist.json'), 'utf8')
  } catch (e) {
    if ((e as { code?: string })?.code === 'ENOENT') return structuredClone(EMPTY_BLOCKLIST)
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(
      `blocklist.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return parseBlocklist(parsed, 'blocklist.json')
}

export interface BlocklistHit {
  list: ListName
  value: string
  reason: string
}

/**
 * Returns every blocklist hit for one entry document (any kind — the
 * id/account/repo lists apply to sources and themes too; the npm list
 * only fires for plugin docs, which are the only ones carrying `npm`).
 */
export function blocklistHitsForDoc(blocklist: Blocklist, doc: Record<string, unknown>): BlocklistHit[] {
  const hits: BlocklistHit[] = []
  if (typeof doc.id === 'string') {
    const hit = blocklist.pluginIds.find((b) => b.id === doc.id)
    if (hit) hits.push({ list: 'pluginIds', value: hit.id, reason: hit.reason })
  }
  if (typeof doc.npm === 'string') {
    const hit = blocklist.npmPackages.find((b) => b.name === doc.npm)
    if (hit) hits.push({ list: 'npmPackages', value: hit.name, reason: hit.reason })
  }
  const parsed = typeof doc.repo === 'string' ? parseGitHubRepo(doc.repo) : null
  if (parsed) {
    const account = blocklist.githubAccounts.find(
      (b) => b.account.toLowerCase() === parsed.owner.toLowerCase(),
    )
    if (account) hits.push({ list: 'githubAccounts', value: account.account, reason: account.reason })
    const slug = `${parsed.owner}/${parsed.repo}`.toLowerCase()
    const repo = blocklist.repos.find((b) => b.repo.toLowerCase() === slug)
    if (repo) hits.push({ list: 'repos', value: repo.repo, reason: repo.reason })
  }
  return hits
}
