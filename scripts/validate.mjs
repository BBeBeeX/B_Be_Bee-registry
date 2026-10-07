#!/usr/bin/env node
/**
 * scripts/validate.mjs — 注册表的全量校验门禁（CI 与本地同用）。
 *
 *   node scripts/validate.mjs            # URL 连通性检查为 WARN-ONLY
 *   node scripts/validate.mjs --strict   # 警告也按失败处理
 *
 * 检查项（收集全部问题后统一报告，存在 error 即退非零）：
 *   a. 目录/文件命名规范（{author}-{name}、<id>.json）
 *   b. music/lyric：source.json 可解析 + 通过主仓 validator、source.js 通过
 *      可读性门禁、README.md 存在、dist 产物存在且与重新编译逐字节一致
 *   c. theme：结构完整 + 深浅双模式 WCAG AA + preview.png 存在
 *   d. plugin：元数据 schema（含文件名 = <id>.json）
 *   e. 同类 id / 音乐 sourceUrl 不重复（与 generate-index 共用逻辑）
 *   f. registry.json / README.md 与重新生成的内容逐字节一致（防手改、防漏跑脚本）
 *   g. downloadUrl / repo / previewUrl 连通性（默认只警告——新增条目的
 *      raw.githubusercontent.com 链接在合并前 404，按错误会挡掉每个内容 PR）
 *
 * 零 npm 依赖；用 plain node 运行（.ts 经类型擦除直接加载）。
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, dirNameIssues, scanEntryDirs } from './lib/registry-model.ts'
import { compileSource } from './lib/compile.ts'
import { readabilityIssues } from './lib/readability.ts'
import { themeShapeIssues, themeContrastIssues } from './lib/theme-contrast.ts'
import { pluginMetaIssues } from './lib/plugin-meta.ts'
import { buildIndex, buildReadme, collectEntries, duplicateIssues, scanPluginMetaFiles } from './generate-index.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const strict = process.argv.slice(2).includes('--strict')
const errors = []
const warnings = []
const err = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)

/** compile.ts 同款的候选顺序：source.js 优先，其次 <dirName>.js。 */
async function findJsFile(dir, dirName) {
  for (const name of ['source.js', `${dirName}.js`]) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

/* ── a. 命名规范 ───────────────────────────────────────────────────────── */

async function checkNaming() {
  for (const spec of KINDS) {
    if (spec.kind === 'plugin') continue // 插件是文件，由 pluginMetaIssues 校验文件名
    for (const dirName of await scanEntryDirs(join(repoRoot, spec.dir))) {
      const issue = dirNameIssues(spec.kind, dirName)
      if (issue) err(`${spec.dir}/${dirName}: ${issue}`)
    }
  }

  // plugins/ 的条目是文件：只允许 <id>.json、<id>.preview.png 与 .gitkeep
  for (const d of await readdir(join(repoRoot, 'plugins'), { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory()) {
      err(`plugins/${d.name}: plugin entries are files (<id>.json), not directories`)
    } else if (d.name !== '.gitkeep' && !d.name.endsWith('.preview.png') && !d.name.endsWith('.json')) {
      err(`plugins/${d.name}: unexpected file (expected <id>.json metadata or <id>.preview.png)`)
    }
  }
}

/* ── d. 插件元数据 ─────────────────────────────────────────────────────── */

async function checkPlugins() {
  const pluginDir = join(repoRoot, 'plugins')
  for (const fileName of await scanPluginMetaFiles(pluginDir)) {
    let meta
    try {
      meta = JSON.parse(await readFile(join(pluginDir, fileName), 'utf8'))
    } catch (e) {
      err(`plugins/${fileName}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    for (const { path, message } of pluginMetaIssues(meta, fileName)) {
      err(`plugins/${fileName}${path ? `:${path}` : ''}: ${message}`)
    }
  }
}

/* ── b. 音乐源 / 歌词源 ────────────────────────────────────────────────── */

async function checkSources() {
  for (const spec of KINDS) {
    if (!spec.distDir) continue
    for (const dirName of await scanEntryDirs(join(repoRoot, spec.dir))) {
      const dir = join(repoRoot, spec.dir, dirName)
      const label = `${spec.dir}/${dirName}`

      // 源码可读性（硬性）：只检查编译器会内联的那个 JS 文件
      const jsFile = await findJsFile(dir, dirName)
      if (jsFile) {
        const js = await readFile(jsFile, 'utf8')
        for (const { rule, message } of readabilityIssues(js, basename(jsFile))) {
          err(`${label}/${basename(jsFile)} [${rule}]: ${message}`)
        }
      }

      // 人读的说明文档必须有
      if (!existsSync(join(dir, 'README.md'))) {
        err(`${label}: README.md is missing`)
      }

      try {
        JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'))
      } catch (e) {
        err(`${label}/source.json: cannot parse — ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      // schema：与主仓同一份 validator。lyric 文档的 `script` 字段要等编译内联
      // 后才存在，所以两条路径都走编译器（compileSource 内联后对完整文档跑同一
      // 个 validator）；编译结果同时用于下面的 dist 字节比对。
      let compiled
      try {
        compiled = await compileSource({ sourceDir: dir, validate: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        err(`${label}: ${msg.replace(/^Validation failed for source in .*: /, 'source.json: ')}`)
        continue
      }

      // dist 必须存在且与内存重新编译的结果逐字节一致
      const committed = await readFile(join(repoRoot, spec.distDir, `${dirName}.json`), 'utf8').catch(() => null)
      if (committed === null) {
        err(`${spec.distDir}/${dirName}.json is missing — run scripts/compile.mjs first`)
      } else if (committed !== compiled) {
        err(`${spec.distDir}/${dirName}.json is stale — run scripts/compile.mjs (generated files are stale)`)
      }
    }
  }
}

/* ── c. 主题 ───────────────────────────────────────────────────────────── */

async function checkThemes() {
  for (const dirName of await scanEntryDirs(join(repoRoot, 'themes'))) {
    const label = `themes/${dirName}`
    let theme
    try {
      theme = JSON.parse(await readFile(join(repoRoot, 'themes', dirName, 'theme.json'), 'utf8'))
    } catch (e) {
      err(`${label}/theme.json: cannot parse — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const shape = themeShapeIssues(theme)
    for (const issue of shape) err(`${label}/theme.json: ${issue}`)
    // 结构完整才跑对比度（否则 contrast 只会抛空引用）；应用要求深色主题同时
    // 自带通过 AA 的 lightTokens，所以两种模式都必须过。
    if (shape.length === 0) {
      for (const scheme of ['dark', 'light']) {
        for (const { scheme: s, pair, ratio, required } of themeContrastIssues(theme, scheme)) {
          err(`${label}/theme.json: contrast (${s}) ${pair} — ${ratio} < ${required} (WCAG AA)`)
        }
      }
    }
    if (!existsSync(join(repoRoot, 'themes', dirName, 'preview.png'))) {
      err(`${label}: preview.png is missing`)
    }
  }
}

/* ── e. 重复 + f. 生成文件新鲜度 ───────────────────────────────────────── */

async function checkIndexAndFreshness() {
  const collected = await collectEntries(repoRoot).catch(() => null)
  if (collected) {
    for (const issue of duplicateIssues(collected.map((c) => c.entry))) err(`registry.json: ${issue}`)
  }

  let index = null
  try {
    index = await buildIndex(repoRoot)
  } catch (e) {
    for (const line of String(e instanceof Error ? e.message : e).split('\n')) {
      err(`registry.json: ${line}`)
    }
  }

  if (index) {
    const expectedRegistry = JSON.stringify(index, null, 2) + '\n'
    const committedRegistry = await readFile(join(repoRoot, 'registry.json'), 'utf8').catch(() => null)
    if (committedRegistry === null) {
      err('registry.json is missing — run scripts/generate-index.mjs')
    } else if (committedRegistry !== expectedRegistry) {
      err('registry.json is stale — run scripts/generate-index.mjs (generated files are stale)')
    }

    const expectedReadme = await buildReadme(repoRoot, index)
    const committedReadme = await readFile(join(repoRoot, 'README.md'), 'utf8').catch(() => null)
    if (committedReadme === null) {
      err('README.md is missing — run scripts/generate-index.mjs')
    } else if (committedReadme !== expectedReadme) {
      err('README.md is stale — run scripts/generate-index.mjs (generated files are stale)')
    }
  }
  return index
}

/* ── g. 链接连通性（WARN-ONLY） ────────────────────────────────────────── */

async function checkUrl(url) {
  for (const method of ['HEAD', 'GET']) {
    let res
    try {
      res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(8000) })
    } catch (e) {
      if (method === 'GET') {
        const reason =
          e?.name === 'TimeoutError' || e?.name === 'AbortError'
            ? 'timeout after 8s'
            : (e?.cause?.code ?? e?.message ?? 'network error')
        return String(reason)
      }
      continue // HEAD 网络失败再试一次 GET（有的服务器拒 HEAD）
    }
    if (res.ok) return null
    if (method === 'GET') return `HTTP ${res.status}`
  }
  return null
}

async function checkLinks(index) {
  if (!index) return
  const urls = new Set()
  for (const e of index.entries) {
    if (typeof e.downloadUrl === 'string') urls.add(e.downloadUrl)
    if (typeof e.previewUrl === 'string') urls.add(e.previewUrl)
    if (e.kind === 'plugin' && typeof e.repo === 'string') urls.add(e.repo)
  }
  const results = await Promise.all([...urls].map(async (url) => [url, await checkUrl(url)]))
  for (const [url, reason] of results) {
    if (reason) warn(`${url}: unreachable (${reason})`)
  }
}

/* ── 汇总 ──────────────────────────────────────────────────────────────── */

async function main() {
  await checkNaming()
  await checkPlugins()
  await checkSources()
  await checkThemes()
  const index = await checkIndexAndFreshness()
  await checkLinks(index)

  for (const e of errors) console.error(`[error] ${e}`)
  for (const w of warnings) console.error(`[warn]  ${w}`)
  console.log(`validate: ${errors.length} errors, ${warnings.length} warnings`)
  if (strict && warnings.length > 0) {
    console.log('strict mode: warnings treated as failures')
    process.exitCode = 1
  } else if (errors.length > 0) {
    process.exitCode = 1
  } else {
    console.log('OK')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
