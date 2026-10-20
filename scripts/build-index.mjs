#!/usr/bin/env node
/**
 * scripts/build-index.mjs — aggregates `plugins/*.json` into the committed
 * `plugins/index.json`. Clients fetch this single file to browse the
 * plugin menu, then resolve versions via npm.
 *
 *   node scripts/build-index.mjs
 *
 * Index shape: { "entries": [ …entry documents, sorted by id… ],
 *                "blocked": [ { "id", "reason" } ] }
 * `blocked` carries the blocklist's plugin ids (the recall channel for
 * already-installed copies) and is always present, empty list included.
 * The computation lives in scripts/lib/plugin-index.ts and is shared
 * with validate.mjs, which recomputes the index in memory and compares
 * it against the committed file.
 *
 * The file is generated AND committed: CI regenerates it and fails when
 * the committed copy is stale (mirrors BBeBee's `pnpm gen:plugins`
 * no-diff gate).
 *
 * 零 npm 依赖；纯 Node 内置模块运行。
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computePluginIndex, serializePluginIndex } from './lib/plugin-index.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const indexPath = join(repoRoot, 'plugins', 'index.json')

async function main() {
  const { data, problems } = await computePluginIndex(repoRoot)
  if (problems.length > 0) {
    for (const p of problems) console.error(`[error] ${p}`)
    process.exitCode = 1
    return
  }
  await writeFile(indexPath, serializePluginIndex(data), 'utf8')
  console.log(
    `build-index: wrote ${data.entries.length} entr${data.entries.length === 1 ? 'y' : 'ies'}, ${data.blocked.length} blocked → plugins/index.json`,
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
