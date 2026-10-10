#!/usr/bin/env node
/**
 * scripts/validate.mjs — 注册表的全量校验门禁（CI 与本地同用）。
 *
 *   node scripts/validate.mjs            # 全量校验（网络不可达警告处理）
 *   node scripts/validate.mjs --strict   # 警告也按失败处理
 *   node scripts/validate.mjs --skip-network # 跳过网络连通性检查
 *   node scripts/validate.mjs --test     # 运行内置负向测试套件
 *
 * 检查项：
 *   a. 命名规范（{username}-{name}.json、themes/{author}-{name}/）
 *   b. 四类元数据 schema 及未知字段拦截（music-source, lyric-source, plugin, theme）
 *   c. 源与插件硬门禁：必须声明合法的 https://github.com/<owner>/<repo> 且 owner 与文件名一致
 *   d. 主题 WCAG AA 对比度门禁与合法 #hex 颜色值校验，preview.png 存在性检查
 *   e. 同类 id 不重复
 *   f. repo 连通性检查（有网环境可达；离线/沙箱 EAI_AGAIN/ENOTFOUND 降级为警告）
 *
 * 零 npm 依赖；纯 Node 内置模块运行。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, scanFileEntries, scanThemeDirs } from './lib/registry-model.ts'
import { validatePluginPointer, validateSourcePointer, PLUGIN_CATEGORIES, PLUGIN_COMPOSITORS } from './lib/schemas.ts'
import { themeValidationIssues } from './lib/theme-contrast.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const isTestMode = args.includes('--test')
const isStrict = args.includes('--strict')
const skipNetwork = args.includes('--skip-network')

const errors = []
const warnings = []
const err = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)

/* ── 检查 repo URL 连通性 ───────────────────────────────────────────────── */

async function checkUrl(url) {
  for (const method of ['HEAD', 'GET']) {
    let res
    try {
      res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(8000) })
    } catch (e) {
      if (method === 'HEAD') continue
      const reason =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? 'timeout after 8s'
          : (e?.cause?.code ?? e?.code ?? e?.message ?? 'network error')
      return { reachable: false, errorType: 'network', reason: String(reason) }
    }
    if (res.ok) return { reachable: true }
    if (method === 'HEAD' && (res.status === 405 || res.status === 403)) continue
    return { reachable: false, errorType: 'http', status: res.status }
  }
  return { reachable: true }
}

/* ── 校验四类条目 ──────────────────────────────────────────────────────── */

export async function validateRegistry(root = repoRoot) {
  const repoUrls = new Set()
  const idsByKind = new Map()

  for (const spec of KINDS) {
    idsByKind.set(spec.kind, new Set())
    const kindDir = join(root, spec.dir)

    if (spec.isFileEntry) {
      const { files, issues: scanIssues } = await scanFileEntries(kindDir)
      for (const issue of scanIssues) err(`${spec.dir}: ${issue}`)

      for (const file of files) {
        const filePath = join(kindDir, file)
        let doc
        try {
          doc = JSON.parse(await readFile(filePath, 'utf8'))
        } catch (e) {
          err(`${spec.dir}/${file}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
          continue
        }

        const issues =
          spec.kind === 'plugin'
            ? validatePluginPointer(doc, file)
            : validateSourcePointer(doc, file, spec.kind)

        for (const { field, message } of issues) {
          err(`${spec.dir}/${file}${field ? ` (${field})` : ''}: ${message}`)
        }

        if (doc && typeof doc.id === 'string') {
          const kindIds = idsByKind.get(spec.kind)
          if (kindIds.has(doc.id)) {
            err(`${spec.dir}/${file}: duplicate ${spec.kind} id "${doc.id}"`)
          } else {
            kindIds.add(doc.id)
          }
        }

        if (doc && typeof doc.repo === 'string' && doc.repo.startsWith('https://')) {
          repoUrls.add({ url: doc.repo, file: `${spec.dir}/${file}` })
        }
      }
    } else if (spec.kind === 'theme') {
      const { dirs, issues: scanIssues } = await scanThemeDirs(kindDir)
      for (const issue of scanIssues) err(`${spec.dir}: ${issue}`)

      for (const dir of dirs) {
        const themeDir = join(kindDir, dir)
        const themeJsonPath = join(themeDir, 'theme.json')
        const previewPath = join(themeDir, 'preview.png')

        if (!existsSync(themeJsonPath)) {
          err(`${spec.dir}/${dir}: missing theme.json`)
          continue
        }

        let doc
        try {
          doc = JSON.parse(await readFile(themeJsonPath, 'utf8'))
        } catch (e) {
          err(`${spec.dir}/${dir}/theme.json: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
          continue
        }

        const issues = themeValidationIssues(doc)
        for (const issue of issues) {
          err(`${spec.dir}/${dir}/theme.json: ${issue}`)
        }

        if (doc && typeof doc.id === 'string') {
          const kindIds = idsByKind.get(spec.kind)
          if (kindIds.has(doc.id)) {
            err(`${spec.dir}/${dir}: duplicate theme id "${doc.id}"`)
          } else {
            kindIds.add(doc.id)
          }
        }

        if (!existsSync(previewPath)) {
          err(`${spec.dir}/${dir}: preview.png is missing`)
        }
      }
    }
  }

  // 连通性检查
  if (!skipNetwork && repoUrls.size > 0) {
    const results = await Promise.all(
      [...repoUrls].map(async ({ url, file }) => ({
        url,
        file,
        check: await checkUrl(url),
      })),
    )

    for (const { url, file, check } of results) {
      if (check.reachable) continue
      if (check.errorType === 'network') {
        // 沙箱/离线网络错误（EAI_AGAIN / ENOTFOUND 等）降级为警告
        warn(`${file} [${url}]: network unreachable (${check.reason}) (skipped in offline/sandbox environment)`)
      } else if (check.errorType === 'http') {
        if (check.status === 404 || check.status === 410) {
          err(`${file} [${url}]: repository does not exist (HTTP ${check.status})`)
        } else {
          warn(`${file} [${url}]: remote returned HTTP ${check.status}`)
        }
      }
    }
  }
}

/* ── 内置负向测试套件 (--test) ─────────────────────────────────────────── */

export async function runNegativeTests() {
  console.log('Running negative test suite...')
  let passed = 0
  let failed = 0

  function assertHasError(testName, issues, expectedSubstrings) {
    const joined = issues.join('; ')
    const allFound = expectedSubstrings.every((sub) => joined.toLowerCase().includes(sub.toLowerCase()))
    if (issues.length > 0 && allFound) {
      console.log(`  ✓ ${testName}`)
      passed++
    } else {
      console.error(`  ✗ ${testName} FAILED!`)
      console.error(`    Expected errors containing: ${JSON.stringify(expectedSubstrings)}`)
      console.error(`    Actual issues: ${JSON.stringify(issues)}`)
      failed++
    }
  }

  // 1. Music source missing repo
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-music',
        name: 'Alice Music',
        author: 'Alice',
        description: 'Test music source',
        version: '1.0.0',
      },
      'alice-music.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('music-source missing repo', issues, ['repo', 'required'])
  }

  // 2. Lyric source missing repo
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-lyrics',
        name: 'Alice Lyrics',
        author: 'Alice',
        description: 'Test lyrics source',
        version: '1.0.0',
      },
      'alice-lyrics.json',
      'lyric-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('lyric-source missing repo', issues, ['repo', 'required'])
  }

  // 3. Plugin missing repo
  {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test plugin',
        version: '1.0.0',
        capabilities: ['audio'],
        category: 'other',
        dependencies: [],
        compositors: ['tray'],
        i18n: true,
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin missing repo', issues, ['repo', 'required'])
  }

  // 4. Invalid repo URL format (non-github or invalid path)
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://gitlab.com/alice/source',
      },
      'alice-source.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('invalid repo URL format', issues, ['repo', 'https://github.com'])
  }

  // 5. Filename username mismatch with repo owner
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/Bob/source',
      },
      'alice-source.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('filename username mismatch with repo owner', issues, ['username prefix does not match'])
  }

  // 6. Illegal plugin category
  {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/plug',
        capabilities: ['audio'],
        category: 'unsupported-category',
        dependencies: [],
        compositors: ['tray'],
        i18n: true,
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin illegal category', issues, ['invalid category'])
  }

  // 7. Illegal plugin compositors
  {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/plug',
        capabilities: ['audio'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['invalid.mount', 'tray'],
        i18n: true,
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin illegal compositors', issues, ['invalid compositor mount point'])
  }

  // 8. Non-boolean plugin i18n
  {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/plug',
        capabilities: ['audio'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['tray'],
        i18n: 'true',
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin non-boolean i18n', issues, ['i18n', 'boolean'])
  }

  // 9. Unknown field in music-source
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/source',
        extraField: 'not-allowed',
      },
      'alice-source.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('music-source unknown field', issues, ['unknown field'])
  }

  // 10. Unknown field in lyric-source
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-lyrics',
        name: 'Alice Lyrics',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/lyrics',
        unexpectedKey: 123,
      },
      'alice-lyrics.json',
      'lyric-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('lyric-source unknown field', issues, ['unknown field'])
  }

  // 11. Unknown field in plugin
  {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/plug',
        capabilities: ['audio'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['tray'],
        i18n: true,
        extraPluginData: {},
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin unknown field', issues, ['unknown field'])
  }

  // 12. Unknown field in theme
  {
    const issues = themeValidationIssues({
      id: 'alice-theme',
      name: 'Alice Theme',
      version: '1.0.0',
      author: 'Alice',
      description: 'Test theme',
      repo: 'https://github.com/alice/theme', // theme must not have repo
      tokens: {
        dark: {
          'text.primary': '#ffffff',
        },
      },
    })
    assertHasError('theme unknown field (repo)', issues, ['unknown field "repo"'])
  }

  // 13. Illegal #hex in theme tokens
  {
    const issues = themeValidationIssues({
      id: 'alice-theme',
      name: 'Alice Theme',
      version: '1.0.0',
      author: 'Alice',
      description: 'Test theme',
      tokens: {
        dark: {
          'text.primary': 'rgb(255, 255, 255)', // not #hex
        },
      },
    })
    assertHasError('theme illegal #hex (rgb)', issues, ['must be a valid #hex colour'])
  }

  // 14. Theme failing WCAG AA contrast gate
  {
    const issues = themeValidationIssues({
      id: 'alice-theme',
      name: 'Alice Theme',
      version: '1.0.0',
      author: 'Alice',
      description: 'Test theme',
      tokens: {
        dark: {
          'bg.app': '#000000',
          'bg.primary': '#000000',
          'surface.s1': '#000000',
          'surface.s2': '#000000',
          'text.primary': '#050505', // virtually black text on black bg: fails contrast!
          'text.secondary': '#040404',
          'brand.primary': '#030303',
          'semantic.error': '#020202',
          'semantic.success': '#010101',
        },
      },
    })
    assertHasError('theme WCAG AA contrast failure', issues, ['contrast (dark)', 'wcag aa'])
  }

  // 15. Theme missing both dark and light
  {
    const issues = themeValidationIssues({
      id: 'alice-theme',
      name: 'Alice Theme',
      version: '1.0.0',
      author: 'Alice',
      description: 'Test theme',
      tokens: {},
    })
    assertHasError('theme missing both dark and light modes', issues, ['must contain at least one mode'])
  }

  // 16. Theme tokens containing unknown mode
  {
    const issues = themeValidationIssues({
      id: 'alice-theme',
      name: 'Alice Theme',
      version: '1.0.0',
      author: 'Alice',
      description: 'Test theme',
      tokens: {
        neon: {},
      },
    })
    assertHasError('theme unknown mode in tokens', issues, ['unknown field "neon"'])
  }

  console.log(`\nNegative tests finished: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exitCode = 1
  } else {
    console.log('ALL NEGATIVE TESTS PASSED OK\n')
  }
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

async function main() {
  if (isTestMode) {
    await runNegativeTests()
    if (process.exitCode && process.exitCode !== 0) return
  }

  await validateRegistry()

  for (const e of errors) console.error(`[error] ${e}`)
  for (const w of warnings) console.error(`[warn]  ${w}`)
  console.log(`validate: ${errors.length} errors, ${warnings.length} warnings`)

  if (isStrict && warnings.length > 0) {
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
