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
import {
  validatePluginPointer,
  validateSourcePointer,
  validatePluginDependencyGraph,
  collectProvidedServiceKeys,
  PLUGIN_CATEGORIES,
  PLUGIN_COMPOSITORS,
} from './lib/schemas.ts'
import { isValidRange, satisfies } from './lib/semver-range.ts'
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

/* ── 检查 npm 包是否存在 ─────────────────────────────────────────────── */

export function npmPackumentUrl(name) {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`
}

/**
 * Checks that a plugin entry's `npm` package exists on the public npm
 * registry (packument fetch). 404 means unpublished or misspelled; network
 * errors degrade to warnings exactly like the repo URL checks. On success
 * also returns `dist-tags.latest`, which the package-content check needs.
 */
async function checkNpmPackage(name) {
  const url = npmPackumentUrl(name)
  let res
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    const reason =
      e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'timeout after 8s'
        : (e?.cause?.code ?? e?.code ?? e?.message ?? 'network error')
    return { exists: false, errorType: 'network', reason: String(reason) }
  }
  if (res.ok) {
    const body = await res.json().catch(() => null)
    const latest =
      body && typeof body === 'object' && typeof body['dist-tags']?.latest === 'string'
        ? body['dist-tags'].latest
        : undefined
    return { exists: true, latest }
  }
  return { exists: false, errorType: 'http', status: res.status }
}

/* ── 检查 npm 包内容（经 jsDelivr 取已发布文件） ───────────────────────── */

export function jsdelivrFileUrl(name, version, file) {
  // jsDelivr accepts the encodeURIComponent form for scoped names ("%40a%2Fb"),
  // the same encoding npmPackumentUrl uses for registry.npmjs.org.
  return `https://cdn.jsdelivr.net/npm/${encodeURIComponent(name)}@${version}/${file}`
}

/**
 * Fetches one published file of a package version from the jsDelivr CDN and
 * parses it as JSON. Result mirrors checkUrl's shape: network errors are
 * distinguishable from HTTP statuses so callers can degrade to warnings.
 */
async function fetchJsdelivrJson(name, version, file) {
  const url = jsdelivrFileUrl(name, version, file)
  let res
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
  } catch (e) {
    const reason =
      e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'timeout after 8s'
        : (e?.cause?.code ?? e?.code ?? e?.message ?? 'network error')
    return { ok: false, errorType: 'network', reason: String(reason) }
  }
  if (!res.ok) return { ok: false, errorType: 'http', status: res.status }
  try {
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false, errorType: 'invalid-json' }
  }
}

/* ── 校验四类条目 ──────────────────────────────────────────────────────── */

export async function validateRegistry(root = repoRoot) {
  const repoUrls = new Set()
  const npmPackages = new Set()
  const idsByKind = new Map()
  const pluginDocs = new Map() // id → parsed doc, for cross-entry dependency checks

  // 插件跨条目预扫描（两步走第一步）：先收集全部插件条目的 `provides` 服务键，
  // 主校验时作为 extras 传入——条目的 services 可以引用其他插件提供的键。
  const pluginProvidedKeys = await (async () => {
    const pluginSpec = KINDS.find((k) => k.kind === 'plugin')
    const dir = join(root, pluginSpec.dir)
    const { files } = await scanFileEntries(dir)
    const docs = []
    for (const file of files) {
      if (file === 'index.json') continue // 生成的聚合索引不是条目
      try {
        docs.push(JSON.parse(await readFile(join(dir, file), 'utf8')))
      } catch {
        // JSON 损坏在主校验流程中报错，这里跳过
      }
    }
    return collectProvidedServiceKeys(docs)
  })()

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
            ? validatePluginPointer(doc, file, pluginProvidedKeys)
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
          if (spec.kind === 'plugin' && doc && typeof doc === 'object' && !Array.isArray(doc)) {
            pluginDocs.set(doc.id, doc)
          }
        }

        if (doc && typeof doc.repo === 'string' && doc.repo.startsWith('https://')) {
          repoUrls.add({ url: doc.repo, file: `${spec.dir}/${file}` })
        }

        if (spec.kind === 'plugin' && doc && typeof doc.npm === 'string' && doc.npm.trim()) {
          npmPackages.add({
            pkg: doc.npm.trim(),
            file: `${spec.dir}/${file}`,
            id: typeof doc.id === 'string' ? doc.id : undefined,
          })
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

  // 跨条目插件依赖检查：依赖 id 必须存在、依赖图必须无环
  for (const { field, message } of validatePluginDependencyGraph(pluginDocs)) {
    err(`plugins (${field}): ${message}`)
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

  // npm 包存在性 + 内容检查：条目的 npm 字段必须对应 npm 上已发布的公开包，
  // 且其最新版必须真的是该条目的 BBeBee 插件包
  // （BBeBee.plugin.json 的 id 与 package.json 的 name 必须与条目一致）。
  if (!skipNetwork && npmPackages.size > 0) {
    const results = await Promise.all(
      [...npmPackages].map(async ({ pkg, file, id }) => {
        const check = await checkNpmPackage(pkg)
        let content = null
        if (check.exists && check.latest) {
          const [manifest, packageJson] = await Promise.all([
            fetchJsdelivrJson(pkg, check.latest, 'BBeBee.plugin.json'),
            fetchJsdelivrJson(pkg, check.latest, 'package.json'),
          ])
          content = { manifest, packageJson }
        }
        return { pkg, file, id, check, content }
      }),
    )

    for (const { pkg, file, id, check, content } of results) {
      if (!check.exists) {
        if (check.errorType === 'network') {
          warn(`${file} [npm:${pkg}]: network unreachable (${check.reason}) (skipped in offline/sandbox environment)`)
        } else if (check.errorType === 'http') {
          if (check.status === 404) {
            err(`${file}: npm package "${pkg}" does not exist on the public npm registry (HTTP 404) — publish it before submitting, or fix the "npm" field`)
          } else {
            warn(`${file} [npm:${pkg}]: registry returned HTTP ${check.status}`)
          }
        }
        continue
      }

      if (!check.latest) {
        warn(`${file} [npm:${pkg}]: packument has no dist-tags.latest — published package content not verified`)
        continue
      }
      if (!content) continue

      const label = `${pkg}@${check.latest}`
      for (const [fileName, res] of [
        ['BBeBee.plugin.json', content.manifest],
        ['package.json', content.packageJson],
      ]) {
        if (res.ok) continue
        if (res.errorType === 'network') {
          warn(`${file} [npm:${label}]: network unreachable fetching ${fileName} via jsDelivr (${res.reason}) (skipped in offline/sandbox environment)`)
        } else if (res.errorType === 'invalid-json') {
          err(`${file}: npm package "${label}" file "${fileName}" is not valid JSON (fetched via jsDelivr)`)
        } else if (res.status === 404) {
          err(`${file}: npm package "${label}" is missing "${fileName}" (HTTP 404 via jsDelivr) — the published package does not look like a BBeBee plugin package`)
        } else {
          warn(`${file} [npm:${label}]: jsDelivr returned HTTP ${res.status} for ${fileName}`)
        }
      }

      if (content.manifest.ok && id !== undefined && content.manifest.json?.id !== id) {
        err(
          `${file}: npm package "${label}" BBeBee.plugin.json id ${JSON.stringify(content.manifest.json?.id)} does not match registry entry id "${id}"`,
        )
      }
      if (content.packageJson.ok && content.packageJson.json?.name !== pkg) {
        err(
          `${file}: npm package "${label}" package.json name ${JSON.stringify(content.packageJson.json?.name)} does not match the entry "npm" field "${pkg}"`,
        )
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
        npm: '@alice/bbebee-plugin-plug',
        services: ['audio'],
        platforms: ['desktop'],
        category: 'other',
        dependencies: [],
        compositors: ['tray'],
        i18n: ['en', 'zh'],
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
        repo: 'https://github.com/alice/plug',
        npm: '@alice/bbebee-plugin-plug',
        services: ['audio'],
        platforms: ['desktop'],
        category: 'unsupported-category',
        dependencies: [],
        compositors: ['tray'],
        i18n: ['en', 'zh'],
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
        repo: 'https://github.com/alice/plug',
        npm: '@alice/bbebee-plugin-plug',
        services: ['audio'],
        platforms: ['desktop'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['invalid.mount', 'tray'],
        i18n: ['en', 'zh'],
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin illegal compositors', issues, ['invalid compositor mount point'])
  }

  // 8. Invalid plugin i18n (boolean / invalid tag / empty array must fail)
  for (const [label, bad] of [
    ['boolean', true],
    ['invalid tag', ['en', 'EN!!']],
    ['empty array', []],
  ]) {
    const issues = validatePluginPointer(
      {
        id: 'alice-plug',
        name: 'Alice Plugin',
        author: 'Alice',
        description: 'Test',
        repo: 'https://github.com/alice/plug',
        npm: '@alice/bbebee-plugin-plug',
        services: ['audio'],
        platforms: ['desktop'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['tray'],
        i18n: bad,
      },
      'alice-plug.json',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError(`plugin i18n ${label}`, issues, ['i18n', 'language'])
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
        repo: 'https://github.com/alice/plug',
        npm: '@alice/bbebee-plugin-plug',
        services: ['audio'],
        platforms: ['desktop'],
        category: 'ui-enhancement',
        dependencies: [],
        compositors: ['tray'],
        i18n: ['en', 'zh'],
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

  // 17. Invalid params in music-source (not array of strings)
  {
    const issues = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/source',
        params: 'invalid-string-not-array',
      },
      'alice-source.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('music-source invalid params (not array)', issues, ['params'])
  }

  // ---- schema v2 negative tests (18+) ----

  // Minimal valid v2 plugin entry; overrides replace individual fields.
  function v2Plugin(overrides = {}) {
    return {
      id: 'alice-plug',
      name: 'Alice Plugin',
      author: 'Alice',
      description: 'Test plugin',
      repo: 'https://github.com/alice/plug',
      npm: '@alice/bbebee-plugin-plug',
      services: ['player', 'store'],
      platforms: ['desktop'],
      category: 'other',
      dependencies: [],
      compositors: ['tray'],
      i18n: ['en', 'zh'],
      ...overrides,
    }
  }

  function assertNoError(testName, issues) {
    if (issues.length === 0) {
      console.log(`  ✓ ${testName}`)
      passed++
    } else {
      console.error(`  ✗ ${testName} FAILED!`)
      console.error(`    Expected no errors, got: ${JSON.stringify(issues)}`)
      failed++
    }
  }

  const pluginIssues = (doc, file = 'alice-plug.json') =>
    validatePluginPointer(doc, file).map((i) => `${i.field}: ${i.message}`)

  // 18. Plugin carrying the removed `version` field
  assertHasError('plugin with removed version field', pluginIssues(v2Plugin({ version: '1.0.0' })), [
    'version',
    'unknown field',
  ])

  // 19. Plugin carrying the renamed `capabilities` field
  assertHasError(
    'plugin with old capabilities field name',
    pluginIssues(v2Plugin({ capabilities: ['player'] })),
    ['capabilities', 'unknown field'],
  )

  // 20. Plugin services with an unknown Cordis service key
  assertHasError('plugin services unknown key', pluginIssues(v2Plugin({ services: ['not-a-service'] })), [
    'services',
    'unknown Cordis service key',
  ])

  // 21. Plugin services empty array is allowed (pure event-driven plugins inject nothing)
  assertNoError('plugin services empty array allowed', pluginIssues(v2Plugin({ services: [] })))

  // 22. Plugin missing services
  {
    const doc = v2Plugin()
    delete doc.services
    assertHasError('plugin missing services', pluginIssues(doc), ['services', 'required'])
  }

  // 23. Plugin missing platforms
  {
    const doc = v2Plugin()
    delete doc.platforms
    assertHasError('plugin missing platforms', pluginIssues(doc), ['platforms', 'required'])
  }

  // 24. Plugin platforms with an illegal value
  assertHasError('plugin platforms illegal value', pluginIssues(v2Plugin({ platforms: ['watch'] })), [
    'platforms',
    'desktop, mobile',
  ])

  // 25. Plugin missing npm
  {
    const doc = v2Plugin()
    delete doc.npm
    assertHasError('plugin missing npm', pluginIssues(doc), ['npm', 'required'])
  }

  // 26. Plugin invalid npm package name
  assertHasError('plugin invalid npm name', pluginIssues(v2Plugin({ npm: 'Not A Package!' })), [
    'npm',
    'invalid npm package name',
  ])

  // 27. Plugin dependency with malformed shape
  assertHasError(
    'plugin dependency malformed',
    pluginIssues(v2Plugin({ dependencies: ['Bad_ID!!'] })),
    ['dependencies', 'invalid dependency'],
  )

  // 28. Plugin dependency with an invalid semver range
  assertHasError(
    'plugin dependency invalid range',
    pluginIssues(v2Plugin({ dependencies: ['bob-lib@1.2.3 - 2.0.0'] })),
    ['dependencies', 'invalid dependency'],
  )

  // 29. Plugin dependency on a non-existent plugin id (graph check)
  {
    const entries = new Map([
      ['alice-plug', v2Plugin({ dependencies: ['ghost-lib@^1.0.0'] })],
    ])
    const issues = validatePluginDependencyGraph(entries).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin dependency unknown id', issues, ['dependencies', 'unknown plugin id'])
  }

  // 30. Plugin dependency cycle (graph check)
  {
    const entries = new Map([
      ['alice-a', v2Plugin({ id: 'alice-a', dependencies: ['alice-b@^1.0.0'] })],
      ['alice-b', v2Plugin({ id: 'alice-b', dependencies: ['alice-c'] })],
      ['alice-c', v2Plugin({ id: 'alice-c', dependencies: ['alice-a@~2.0.0'] })],
    ])
    const issues = validatePluginDependencyGraph(entries).map((i) => `${i.field}: ${i.message}`)
    assertHasError('plugin dependency cycle', issues, ['dependencies', 'cycle'])
  }

  // 31. Valid dependencies (bare id + id@range) pass, acyclic graph is clean
  {
    const entries = new Map([
      ['alice-a', v2Plugin({ id: 'alice-a', dependencies: ['alice-b', 'alice-c@^2.0.0 || >=3.0.0'] })],
      ['alice-b', v2Plugin({ id: 'alice-b' })],
      ['alice-c', v2Plugin({ id: 'alice-c' })],
    ])
    const shapeIssues = [...entries.values()].flatMap((d) => pluginIssues(d))
    const graphIssues = validatePluginDependencyGraph(entries).map((i) => `${i.field}: ${i.message}`)
    assertNoError('plugin valid dependencies (shape + graph)', [...shapeIssues, ...graphIssues])
  }

  // 32. Source platforms: optional, validated when present
  {
    const good = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/source',
        platforms: ['desktop', 'mobile'],
      },
      'alice-source.json',
      'music-source',
    )
    assertNoError('music-source with platforms', good.map((i) => `${i.field}: ${i.message}`))

    const bad = validateSourcePointer(
      {
        id: 'alice-source',
        name: 'Alice Source',
        author: 'Alice',
        description: 'Test',
        version: '1.0.0',
        repo: 'https://github.com/alice/source',
        platforms: ['console'],
      },
      'alice-source.json',
      'music-source',
    ).map((i) => `${i.field}: ${i.message}`)
    assertHasError('music-source platforms illegal value', bad, ['platforms', 'desktop, mobile'])
  }

  // 33. Hand-written semver-range parser sanity
  {
    const checks = [
      satisfies('1.2.3', '^1.0.0') === true,
      satisfies('2.0.0', '^1.0.0') === false,
      satisfies('1.2.9', '~1.2.3') === true,
      satisfies('1.3.0', '~1.2.3') === false,
      satisfies('1.5.0', '>=1.0.0 <2.0.0') === true,
      satisfies('3.1.0', '>=1.0.0 <2.0.0 || >=3.0.0') === true,
      satisfies('2.5.0', '*') === true,
      satisfies('1.2.3', '1.2.3') === true,
      isValidRange('1.2.3 - 2.0.0') === false, // hyphen ranges unsupported
      isValidRange('^1.0') === false, // partial versions rejected
      isValidRange('') === false,
    ]
    if (checks.every(Boolean)) {
      console.log('  ✓ semver-range parser sanity')
      passed++
    } else {
      console.error('  ✗ semver-range parser sanity FAILED!')
      failed++
    }
  }

  // 34. npm packument URL encoding sanity
  {
    const checks = [
      npmPackumentUrl('bbebee-plugin-demo') === 'https://registry.npmjs.org/bbebee-plugin-demo',
      npmPackumentUrl('@alice/bbebee-plugin-demo') === 'https://registry.npmjs.org/%40alice%2Fbbebee-plugin-demo',
    ]
    if (checks.every(Boolean)) {
      console.log('  ✓ npm packument URL encoding sanity')
      passed++
    } else {
      console.error('  ✗ npm packument URL encoding sanity FAILED!')
      failed++
    }
  }

  // 35. Cross-entry `provides`: B may declare a service that A provides;
  //     a key nobody provides (and not a core key) still fails.
  {
    const pluginIssuesWith = (doc, extras, file = 'alice-plug.json') =>
      validatePluginPointer(doc, file, extras).map((i) => `${i.field}: ${i.message}`)

    const docA = v2Plugin({ id: 'alice-suite', provides: ['suiteCore'] })
    const docB = v2Plugin({ id: 'alice-viz', services: ['suiteCore', 'player'] })
    const extras = collectProvidedServiceKeys([docA, docB])

    assertNoError('plugin provides well-formed', pluginIssuesWith(docA, extras))
    assertNoError('plugin services key provided by another entry', pluginIssuesWith(docB, extras))
    assertHasError(
      'plugin services key unknown without provides extras',
      pluginIssues(docB),
      ['services', 'unknown Cordis service key'],
    )
    const docC = v2Plugin({ id: 'alice-other', services: ['ghostService'] })
    assertHasError(
      'plugin services key nobody provides',
      pluginIssuesWith(docC, extras),
      ['services', 'unknown Cordis service key'],
    )
    assertHasError(
      'plugin provides malformed key',
      pluginIssues(v2Plugin({ provides: ['1bad-key'] })),
      ['provides', 'array of service keys'],
    )
    assertHasError(
      'plugin provides not an array',
      pluginIssues(v2Plugin({ provides: 'suiteCore' })),
      ['provides', 'array of service keys'],
    )
  }

  // 36. jsDelivr file URL encoding sanity (scope packages are URL-encoded)
  {
    const checks = [
      jsdelivrFileUrl('bbebee-plugin-demo', '1.2.3', 'BBeBee.plugin.json') ===
        'https://cdn.jsdelivr.net/npm/bbebee-plugin-demo@1.2.3/BBeBee.plugin.json',
      jsdelivrFileUrl('@alice/bbebee-plugin-demo', '2.0.0', 'package.json') ===
        'https://cdn.jsdelivr.net/npm/%40alice%2Fbbebee-plugin-demo@2.0.0/package.json',
    ]
    if (checks.every(Boolean)) {
      console.log('  ✓ jsDelivr file URL encoding sanity')
      passed++
    } else {
      console.error('  ✗ jsDelivr file URL encoding sanity FAILED!')
      failed++
    }
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
