#!/usr/bin/env node
/**
 * scripts/sync-service-keys.mjs — 刷新 vendored 的服务键白名单副本。
 *
 * 服务键全集的单一事实来源在 BBeBee 仓库：由其 codegen 从全部插件
 * manifest 的 `contributes.services` 并集 ∪ SHELL_MANIFEST 生成，提交为
 * `packages/protocol/service-keys.json`。本仓库只保存一份 vendored 副本
 * （`scripts/lib/service-keys.generated.json`），校验时读取它。
 *
 *   node scripts/sync-service-keys.mjs
 *     从 GitHub raw（BBeBee main）拉取上游产物并重写 vendored 副本。
 *   node scripts/sync-service-keys.mjs --from <本地路径>
 *     离线同步：从本地文件（如同机 BBeBee checkout 的
 *     packages/protocol/service-keys.json）读取。
 *   node scripts/sync-service-keys.mjs --check
 *     只比对新鲜度不写文件：确认过期退出码 1 并打印差异；
 *     上游不可达/未发布则警告并退出 0（无法证伪不误杀）。
 *
 * 零 npm 依赖；纯 Node 内置模块运行。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  SERVICE_KEYS_UPSTREAM_URL,
  checkServiceKeysFreshness,
  loadVendoredServiceKeysArtifact,
  parseServiceKeysArtifact,
} from './lib/service-keys.ts'

const VENDORED_PATH = fileURLToPath(new URL('./lib/service-keys.generated.json', import.meta.url))

const UPSTREAM_PROVENANCE = {
  repo: 'BBeBeeX/BBeBee',
  ref: 'main',
  path: 'packages/protocol/service-keys.json',
  url: SERVICE_KEYS_UPSTREAM_URL,
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const fromIdx = args.indexOf('--from')
const fromPath = fromIdx >= 0 ? args[fromIdx + 1] : undefined

function diffKeys(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((k) => !beforeSet.has(k)),
    removed: before.filter((k) => !afterSet.has(k)),
  }
}

async function loadSourceArtifact() {
  if (fromPath) {
    const raw = JSON.parse(await readFile(fromPath, 'utf8'))
    return parseServiceKeysArtifact(raw, fromPath)
  }
  let res
  try {
    res = await fetch(SERVICE_KEYS_UPSTREAM_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    throw new Error(
      `cannot fetch upstream service-keys artifact: ${e instanceof Error ? e.message : String(e)} ` +
        `(offline? use --from <path to BBeBee>/packages/protocol/service-keys.json)`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `upstream service-keys artifact returned HTTP ${res.status} (${SERVICE_KEYS_UPSTREAM_URL}) ` +
        `(not published yet? use --from <path to BBeBee>/packages/protocol/service-keys.json)`,
    )
  }
  return parseServiceKeysArtifact(await res.json(), SERVICE_KEYS_UPSTREAM_URL)
}

async function main() {
  if (checkOnly) {
    const fresh = await checkServiceKeysFreshness()
    if (fresh.status === 'fresh') {
      console.log('service-keys: vendored copy is up to date with BBeBee upstream')
      return
    }
    if (fresh.status === 'unverifiable') {
      console.warn(`service-keys: freshness unverified (${fresh.reason}); continuing with vendored copy`)
      return
    }
    console.error('service-keys: vendored copy is STALE vs BBeBee upstream')
    if (fresh.added.length > 0) console.error(`  upstream-only keys: ${fresh.added.join(', ')}`)
    if (fresh.removed.length > 0) console.error(`  vendored-only keys: ${fresh.removed.join(', ')}`)
    console.error('run: node scripts/sync-service-keys.mjs')
    process.exitCode = 1
    return
  }

  const source = await loadSourceArtifact()
  let previous = { serviceKeys: [], providers: {} }
  try {
    previous = loadVendoredServiceKeysArtifact()
  } catch {
    // No (readable) vendored copy yet — syncing from scratch.
  }

  const vendored = {
    vendoredFrom: UPSTREAM_PROVENANCE,
    serviceKeys: source.serviceKeys,
    providers: source.providers,
  }
  await writeFile(VENDORED_PATH, JSON.stringify(vendored, null, 2) + '\n', 'utf8')

  const { added, removed } = diffKeys(previous.serviceKeys, source.serviceKeys)
  console.log(
    `service-keys: synced ${source.serviceKeys.length} keys from ${fromPath ?? SERVICE_KEYS_UPSTREAM_URL}`,
  )
  if (added.length > 0) console.log(`  added: ${added.join(', ')}`)
  if (removed.length > 0) console.log(`  removed: ${removed.join(', ')}`)
  if (added.length === 0 && removed.length === 0) console.log('  no key changes')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
