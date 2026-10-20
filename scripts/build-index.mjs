#!/usr/bin/env node
/**
 * scripts/build-index.mjs — aggregates `plugins/*.json` into the committed
 * `plugins/index.json` (sorted by id). Clients fetch this single file to
 * browse the plugin menu, then resolve versions via npm.
 *
 *   node scripts/build-index.mjs
 *
 * The file is generated AND committed: CI regenerates it and fails when the
 * committed copy is stale (mirrors BBeBee's `pnpm gen:plugins` no-diff gate).
 *
 * 零 npm 依赖；纯 Node 内置模块运行。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFileEntries } from './lib/registry-model.ts'
import { validatePluginPointer, collectProvidedServiceKeys } from './lib/schemas.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginsDir = join(repoRoot, 'plugins')
const indexPath = join(pluginsDir, 'index.json')

async function main() {
  const { files, issues } = await scanFileEntries(pluginsDir)
  if (issues.length > 0) {
    for (const issue of issues) console.error(`[error] plugins: ${issue}`)
    process.exitCode = 1
    return
  }

  // Two passes: collect every entry's `provides` first so that one entry's
  // `services` may reference a service another entry provides.
  let failed0 = false
  const raw = []
  for (const file of files) {
    if (file === 'index.json') continue // never index the index itself
    let doc
    try {
      doc = JSON.parse(await readFile(join(pluginsDir, file), 'utf8'))
    } catch (e) {
      console.error(`[error] plugins/${file}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
      failed0 = true
      continue
    }
    raw.push({ file, doc })
  }
  const providedKeys = collectProvidedServiceKeys(raw.map((r) => r.doc))

  const entries = []
  const seenIds = new Set()
  let failed = failed0

  for (const { file, doc } of raw) {
    const problems = validatePluginPointer(doc, file, providedKeys)
    if (problems.length > 0) {
      for (const { field, message } of problems) {
        console.error(`[error] plugins/${file}${field ? ` (${field})` : ''}: ${message}`)
      }
      failed = true
      continue
    }
    if (seenIds.has(doc.id)) {
      console.error(`[error] plugins/${file}: duplicate plugin id "${doc.id}"`)
      failed = true
      continue
    }
    seenIds.add(doc.id)
    entries.push(doc)
  }

  if (failed) {
    process.exitCode = 1
    return
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  await writeFile(indexPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  console.log(`build-index: wrote ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} → plugins/index.json`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
