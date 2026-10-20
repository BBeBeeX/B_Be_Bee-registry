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
 *   g. 服务键白名单新鲜度（vendored 副本 vs BBeBee 上游生成产物；确认过期报错，上游 404 报错，仅网络不可达降级为警告）
 *
 * 零 npm 依赖；纯 Node 内置模块运行。
 */

import { existsSync } from 'node:fs'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, scanFileEntries, scanThemeDirs } from './lib/registry-model.ts'
import {
  validatePluginPointer,
  validateSourcePointer,
  validatePluginDependencyGraph,
  validatePluginProvidesGate,
  validatePluginNpmUniqueness,
  collectProvidedServiceKeys,
  collectValidProvidedServiceKeys,
  parseGitHubRepo,
  PLUGIN_CATEGORIES,
  PLUGIN_COMPOSITORS,
} from './lib/schemas.ts'
// (collectProvidedServiceKeys is used by test 35; the valid-only variant
// above is what production collection uses.)
import { isValidRange, satisfies } from './lib/semver-range.ts'
import { themeValidationIssues } from './lib/theme-contrast.ts'
import { loadBlocklist, blocklistHitsForDoc, parseBlocklist, EMPTY_BLOCKLIST } from './lib/blocklist.ts'
import { computePluginIndex, serializePluginIndex, pluginIndexConsistencyIssue } from './lib/plugin-index.ts'
import {
  checkServiceKeysFreshness,
  parseServiceKeysArtifact,
  CRITICAL_SERVICE_KEYS,
} from './lib/service-keys.ts'

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
 * returns `dist-tags.latest` plus a per-version map of `dist.integrity`
 * values — the reviewed-pin check needs both.
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
    const versions = {}
    if (body && typeof body === 'object' && body.versions && typeof body.versions === 'object') {
      for (const [v, info] of Object.entries(body.versions)) {
        versions[v] =
          info && typeof info === 'object' && typeof info.dist?.integrity === 'string'
            ? info.dist.integrity
            : undefined
      }
    }
    return { exists: true, latest, versions }
  }
  return { exists: false, errorType: 'http', status: res.status }
}

/**
 * Reviewed-pin resolution for one plugin entry against a fetched
 * packument. Pure and exported for the negative test suite.
 *
 * An entry may pin `reviewedVersion` + `reviewedIntegrity`: the version
 * the registry has actually reviewed. The pin must still exist on npm
 * and its dist.integrity must match the recorded value — a mismatch
 * means the pinned bytes changed (or the pin was recorded wrongly) and
 * is an error. When the pin holds, package-content checks run against
 * the pinned version; a newer `latest` is only a warning ("unreviewed
 * version available"), never an error. Unpinned entries keep the
 * historical behaviour: content checks run against `latest`.
 *
 * @param doc parsed registry entry (only npm/reviewed* fields are read)
 * @param packument { latest?: string, versions?: Record<string, string|undefined> }
 * @returns {{ errors: string[], warnings: string[], targetVersion?: string }}
 */
export function reviewedPinIssues(doc, packument) {
  const errors = []
  const warnings = []
  const pkg = typeof doc?.npm === 'string' ? doc.npm : '?'
  const versions = packument?.versions ?? {}
  const latest = packument?.latest
  const pinned =
    typeof doc?.reviewedVersion === 'string' && doc.reviewedVersion ? doc.reviewedVersion : undefined

  if (!pinned) return { errors, warnings, targetVersion: latest }

  if (!Object.prototype.hasOwnProperty.call(versions, pinned)) {
    errors.push(
      `entry pins reviewedVersion "${pinned}" but npm package "${pkg}" has no such version in its packument — the pin is stale or the version was unpublished`,
    )
    return { errors, warnings, targetVersion: undefined }
  }
  const actual = versions[pinned]
  if (actual !== doc.reviewedIntegrity) {
    errors.push(
      `entry reviewedIntegrity does not match dist.integrity of "${pkg}@${pinned}" (entry records ${JSON.stringify(doc.reviewedIntegrity)}, npm reports ${JSON.stringify(actual ?? null)}) — the pinned bytes changed or the pin was recorded wrongly`,
    )
  }
  if (latest && latest !== pinned) {
    warnings.push(
      `npm package "${pkg}" has unreviewed version ${latest} (entry pins reviewed ${pinned}) — content checks cover the reviewed version only`,
    )
  }
  return { errors, warnings, targetVersion: pinned }
}

/**
 * Cross-checks a registry entry's service declarations against the
 * PUBLISHED package manifest (fetched via jsDelivr). Pure and exported
 * for the negative test suite.
 *
 * Rules, calibrated against the real manifest structure of published
 * BBeBee packages (BBeBee.plugin.json as the assembler emits it):
 *  - `provides` must be truthful: every key the entry claims must be
 *    registered in the manifest's `contributes.services`. (The reverse
 *    is not required: a package may contribute services the entry does
 *    not advertise.)
 *  - `services` (the keys the plugin injects) has no manifest-side
 *    declaration in today's manifest format — the demand lives in code.
 *    When a manifest DOES declare an `inject` array, the entry's
 *    `services` must match it exactly, in both directions.
 */
export function manifestConsistencyIssues(entry, manifest) {
  const errors = []
  const provides = Array.isArray(entry?.provides) ? entry.provides : []
  const contributes =
    manifest?.contributes && Array.isArray(manifest.contributes.services)
      ? manifest.contributes.services
      : []
  for (const k of provides) {
    if (typeof k === 'string' && !contributes.includes(k)) {
      errors.push(
        `entry declares provides "${k}" but the published BBeBee.plugin.json does not register it in contributes.services (found: ${contributes.length > 0 ? contributes.join(', ') : 'none'})`,
      )
    }
  }
  if (Array.isArray(manifest?.inject)) {
    const injected = manifest.inject.filter((x) => typeof x === 'string')
    const services = Array.isArray(entry?.services) ? entry.services : []
    for (const s of services) {
      if (typeof s === 'string' && !injected.includes(s)) {
        errors.push(`entry declares services "${s}" but the published manifest's inject does not list it`)
      }
    }
    for (const s of injected) {
      if (!services.includes(s)) {
        errors.push(`published manifest injects "${s}" but the entry does not declare it in services`)
      }
    }
  }
  return errors
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

/**
 * Official-namespace gate for plugin entries. Pure and exported for
 * the negative test suite.
 *
 * "Official" has exactly one definition (maintainer decision,
 * 2026-10-20): the entry's repo owner is the GitHub account `BBeBeeX`.
 * Nothing else — not the id prefix, not the author string — confers
 * official status, and clients render the official badge from the
 * repo owner alone. Two machine rules protect that definition:
 *  1. The `bbebeex-` id prefix is reserved: an entry whose id starts
 *     with it but whose repo owner is not BBeBeeX is an impersonation
 *     attempt and is rejected outright (no PR context needed).
 *  2. When CI supplies the PR author's association with the BBeBeeX
 *     organization (BBEBEE_PR_AUTHOR_ASSOCIATION), an official entry
 *     submitted by anyone who is not an org OWNER/MEMBER is rejected.
 *     Local runs and direct pushes have no such context: the identity
 *     half is then skipped, and the caller reports the skip — repo-owner
 *     verification still applies.
 *
 * @param entries [{ file, id, owner }] for every plugin entry
 * @param association GitHub author_association value, or undefined
 */
export function officialEntryIssues(entries, association) {
  const errors = []
  let officialCount = 0
  const assoc = association?.trim().toUpperCase() || undefined
  for (const { file, id, owner } of entries) {
    const isOfficial = typeof owner === 'string' && owner.toLowerCase() === 'bbebeex'
    if (isOfficial) officialCount++
    if (typeof id === 'string' && id.toLowerCase().startsWith('bbebeex-') && !isOfficial) {
      errors.push(
        `${file}: plugin id "${id}" uses the reserved official prefix "bbebeex-" but its repo owner is ${JSON.stringify(owner ?? null)} — official means repo owner BBeBeeX, and the prefix may not be claimed by anyone else`,
      )
    }
    if (isOfficial && assoc && assoc !== 'OWNER' && assoc !== 'MEMBER') {
      errors.push(
        `${file}: official entry (repo owner BBeBeeX) submitted with PR author association "${assoc}" — entries in the official namespace require a submitter who is an OWNER or MEMBER of the BBeBeeX organization`,
      )
    }
  }
  return { errors, officialCount, identityChecked: Boolean(assoc) }
}

/* ── 校验四类条目 ──────────────────────────────────────────────────────── */

export async function validateRegistry(root = repoRoot) {
  const repoUrls = new Set()
  const npmPackages = new Set()
  const idsByKind = new Map()
  const pluginDocs = new Map() // id → parsed doc, for cross-entry dependency checks
  const pluginEntryRefs = [] // { file, id, owner } per plugin entry, for the official-namespace gate

  // 黑名单（blocklist.json）：MODERATION 黑名单政策的机器载体。命中任一
  // 类（插件 id / npm 包名 / GitHub 账号 / 仓库）的条目一律硬错误——
  // 被封作者换个条目名也回不来。名单本身畸形也是错误，绝不静默当空名单。
  let blocklist = EMPTY_BLOCKLIST
  try {
    blocklist = await loadBlocklist(root)
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
  }
  const blocklistErrors = (where, doc) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return
    for (const hit of blocklistHitsForDoc(blocklist, doc)) {
      err(
        `${where}: entry is blocklisted (${hit.list}: "${hit.value}" — ${hit.reason}) — see blocklist.json and MODERATION.md`,
      )
    }
  }

  // 插件跨条目预扫描（两步走第一步）：先收集插件条目的 `provides` 服务键，
  // 主校验时作为 extras 传入——条目的 services 可以引用其他插件提供的键。
  // 只从自身通过完整 schema 校验的条目收集：一个会被拒的条目不能靠在
  // provides 里声明某个键，就让同批其他条目的 services 变得合法。
  const pluginProvidedKeys = await (async () => {
    const pluginSpec = KINDS.find((k) => k.kind === 'plugin')
    const dir = join(root, pluginSpec.dir)
    const { files } = await scanFileEntries(dir)
    const items = []
    for (const file of files) {
      if (file === 'index.json') continue // 生成的聚合索引不是条目
      try {
        const doc = JSON.parse(await readFile(join(dir, file), 'utf8'))
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) items.push({ file, doc })
      } catch {
        // JSON 损坏在主校验流程中报错，这里跳过
      }
    }
    return collectValidProvidedServiceKeys(items)
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

        blocklistErrors(`${spec.dir}/${file}`, doc)

        if (spec.kind === 'plugin' && doc && typeof doc === 'object' && !Array.isArray(doc)) {
          pluginEntryRefs.push({
            file: `${spec.dir}/${file}`,
            id: typeof doc.id === 'string' ? doc.id : undefined,
            owner:
              typeof doc.repo === 'string' ? (parseGitHubRepo(doc.repo)?.owner ?? undefined) : undefined,
          })
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
            doc,
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

        blocklistErrors(`${spec.dir}/${dir}`, doc)

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

  // 跨条目 provides 门禁：关键核心服务不可被条目宣称提供（保留给内置
  // 提供者）；同一服务键最多只能有一个条目提供者
  for (const { field, message } of validatePluginProvidesGate(
    pluginDocs,
    new Set(CRITICAL_SERVICE_KEYS),
  )) {
    err(`plugins (${field}): ${message}`)
  }

  // 跨条目 npm 唯一性：一个 npm 包只能支撑一个条目
  for (const { field, message } of validatePluginNpmUniqueness(pluginDocs)) {
    err(`plugins (${field}): ${message}`)
  }

  // 索引一致性：内存重算 plugins/index.json 并与已提交文件逐字比对。
  // 此前该门禁只存在于 CI workflow 的一个 git-diff step——validate
  // 本身不看索引，手改/过期索引绕过 CI 合并时无人发现；现在校验本身
  // 即门禁（CI 的 diff step 保留作双保险）。
  {
    const issue = await pluginIndexConsistencyIssue(root)
    if (issue) err(issue)
  }

  // 官方命名空间门禁：官方 = repo owner 为 BBeBeeX（唯一标准）。
  // `bbebeex-` 前缀被非官方 repo 占用 → 直接错误；CI 传入 PR 作者与
  // 组织的关联（BBEBEE_PR_AUTHOR_ASSOCIATION）时，官方条目由非
  // OWNER/MEMBER 提交 → 错误。本地/直推无此语境：身份半区跳过，
  // 但必须在输出中注明（owner 校验本身不受影响）。
  {
    const association = process.env.BBEBEE_PR_AUTHOR_ASSOCIATION?.trim() || undefined
    const official = officialEntryIssues(pluginEntryRefs, association)
    for (const e of official.errors) err(e)
    if (!official.identityChecked && official.officialCount > 0) {
      console.log(
        `[note] official-entry submitter check skipped for ${official.officialCount} official ` +
          `entr${official.officialCount === 1 ? 'y' : 'ies'}: no PR author context in this environment ` +
          `(CI passes BBEBEE_PR_AUTHOR_ASSOCIATION) — official status verified by repo owner only`,
      )
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

  // npm 包存在性 + 内容检查：条目的 npm 字段必须对应 npm 上已发布的公开包，
  // 且其最新版必须真的是该条目的 BBeBee 插件包
  // （BBeBee.plugin.json 的 id 与 package.json 的 name 必须与条目一致）。
  if (!skipNetwork && npmPackages.size > 0) {
    const results = await Promise.all(
      [...npmPackages].map(async ({ pkg, file, id, doc }) => {
        const check = await checkNpmPackage(pkg)
        let pin = null
        let content = null
        if (check.exists) {
          pin = reviewedPinIssues(doc, check)
          if (pin.targetVersion) {
            const [manifest, packageJson] = await Promise.all([
              fetchJsdelivrJson(pkg, pin.targetVersion, 'BBeBee.plugin.json'),
              fetchJsdelivrJson(pkg, pin.targetVersion, 'package.json'),
            ])
            content = { manifest, packageJson }
          }
        }
        return { pkg, file, id, doc, check, pin, content }
      }),
    )

    for (const { pkg, file, id, doc, check, pin, content } of results) {
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

      // 已审钉扎：钉扎版本必须仍在 npm 上且 integrity 与条目记录一致
      // （篡改/记错即 error）；存在更新的 latest 只警告"有未审新版本"。
      if (pin) {
        for (const e of pin.errors) err(`${file}: ${e}`)
        for (const w of pin.warnings) warn(`${file}: ${w}`)
      }

      if (!pin || !pin.targetVersion) {
        if (!doc?.reviewedVersion && !check.latest) {
          warn(`${file} [npm:${pkg}]: packument has no dist-tags.latest — published package content not verified`)
        }
        continue
      }
      if (!content) continue

      const label = `${pkg}@${pin.targetVersion}`
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
      // 声明属实性交叉校验：条目宣称的 provides 必须真的在包内 manifest
      // 的 contributes.services 中注册；manifest 若声明 inject 数组，
      // 条目 services 必须与之双向一致。
      if (content.manifest.ok) {
        for (const msg of manifestConsistencyIssues(doc, content.manifest.json)) {
          err(`${file}: npm package "${label}": ${msg}`)
        }
      }
    }
  }

  // 服务键白名单新鲜度：白名单不在本仓库维护，而是 vendored 自 BBeBee
  // 仓库的生成产物（scripts/lib/service-keys.generated.json）。能联网时
  // 与上游比对：确认过期是错误；上游不可达/未发布则与其它连通性检查
  // 一样降级为警告。--test 模式跳过，保证负向套件与环境无关。
  if (!skipNetwork && !isTestMode) {
    const fresh = await checkServiceKeysFreshness()
    if (fresh.status === 'stale') {
      const parts = []
      if (fresh.added.length > 0) parts.push(`upstream-only: ${fresh.added.join(', ')}`)
      if (fresh.removed.length > 0) parts.push(`vendored-only: ${fresh.removed.join(', ')}`)
      if (fresh.criticalAdded.length > 0)
        parts.push(`critical upstream-only: ${fresh.criticalAdded.join(', ')}`)
      if (fresh.criticalRemoved.length > 0)
        parts.push(`critical vendored-only: ${fresh.criticalRemoved.join(', ')}`)
      err(
        `service-keys: vendored allowlist is stale vs the BBeBee-generated artifact (${parts.join('; ')}) — run: node scripts/sync-service-keys.mjs`,
      )
    } else if (fresh.status === 'missing') {
      // 上游生成产物 404：单一事实来源消失了。这与"网络不可达"性质
      // 不同——继续用陈旧副本静默放行会让白名单无限期过期，必须报错。
      err(
        `service-keys: upstream artifact is missing (${fresh.reason}) — the BBeBee-generated source of truth was moved or deleted; restore it upstream instead of trusting the vendored copy`,
      )
    } else if (fresh.status === 'unverifiable') {
      warn(`service-keys: freshness could not be verified (${fresh.reason}); vendored copy used as-is`)
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

  const pluginIssues = (doc, file = `${doc.id}.json`) =>
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
    const shapeIssues = [...entries.values()].flatMap((d) => pluginIssues(d, `${d.id}.json`))
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
      // Prerelease ordering is full semver (audit cases): a range bound
      // is an ordering boundary — beta does not satisfy =alpha…
      satisfies('1.2.3-beta', '1.2.3-alpha') === false,
      satisfies('1.2.3-alpha', '1.2.3-alpha') === true,
      satisfies('1.2.3', '1.2.3-alpha') === false,
      // …and a bare "<release" bound admits that release's prereleases
      satisfies('1.2.3-alpha', '<1.2.3') === true,
      // npm admission gate: no same-tuple comparator, no prerelease
      satisfies('1.2.3-alpha', '^1.0.0') === false,
      satisfies('1.2.3-alpha', '^1.2.3-alpha') === true,
      satisfies('1.2.3-alpha.1', '>1.2.3-alpha') === true,
      satisfies('1.2.3-alpha', '>=1.2.3-beta') === false,
      satisfies('1.2.3-rc.1', '>=1.2.3-beta') === true,
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
    const pluginIssuesWith = (doc, extras, file = `${doc.id}.json`) =>
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

  // 37. Service-keys artifact parsing: format / dedupe / non-empty / critical subset
  {
    const good = parseServiceKeysArtifact(
      { serviceKeys: ['player', 'audio', 'player'], criticalKeys: ['player'], providers: {} },
      'test',
    )
    const checks = [
      good.serviceKeys.join(',') === 'player,audio', // duplicates dropped, order kept
      good.criticalKeys.join(',') === 'player',
    ]
    const throws = (raw) => {
      try {
        parseServiceKeysArtifact(raw, 'test')
        return false
      } catch {
        return true
      }
    }
    checks.push(
      throws({ serviceKeys: [] }), // empty allowlist must fail loudly
      throws({ serviceKeys: ['bad key!'] }), // malformed key format
      throws({ serviceKeys: ['player'], criticalKeys: ['notAKey'] }), // critical ⊄ keys
      throws({ serviceKeys: 'player' }), // not an array
      throws(null),
    )
    if (checks.every(Boolean)) {
      console.log('  ✓ service-keys artifact parsing (dedupe, format, critical subset)')
      passed++
    } else {
      console.error('  ✗ service-keys artifact parsing FAILED!')
      failed++
    }
  }

  // 38. Provides gate: critical keys are reserved; one provider per key
  {
    const critical = new Set(['player', 'secrets', 'plugin-manager'])
    const gate = (entries) =>
      validatePluginProvidesGate(entries, critical).map((i) => `${i.field}: ${i.message}`)

    // The audit's mallory shape: claiming core services outright.
    const mallory = new Map([
      ['mallory-evil', v2Plugin({ id: 'mallory-evil', provides: ['player', 'secrets'] })],
    ])
    assertHasError('provides gate rejects critical keys (player)', gate(mallory), [
      'critical core service "player"',
    ])
    assertHasError('provides gate rejects critical keys (secrets)', gate(mallory), [
      'critical core service "secrets"',
    ])

    // Two entries providing the same key (even a non-critical one).
    const dup = new Map([
      ['alice-a', v2Plugin({ id: 'alice-a', provides: ['suiteCore'] })],
      ['alice-b', v2Plugin({ id: 'alice-b', provides: ['suiteCore'] })],
    ])
    assertHasError('provides gate rejects duplicate provider', gate(dup), [
      'provided by multiple entries',
      'alice-a, alice-b',
    ])

    // One provider of a non-critical key is exactly the intended use.
    const legit = new Map([
      ['alice-a', v2Plugin({ id: 'alice-a', provides: ['suiteCore'] })],
      ['alice-b', v2Plugin({ id: 'alice-b', services: ['suiteCore'] })],
    ])
    assertNoError('provides gate allows single non-critical provider', gate(legit))
  }

  // 39. Pre-scan asymmetry: provides are collected only from entries
  //     that themselves pass validation
  {
    // The provider entry is invalid on other grounds (illegal category),
    // so its provides must NOT make the consumer's services legal.
    const badProvider = {
      file: 'mallory-suite.json',
      doc: v2Plugin({ id: 'mallory-suite', category: 'not-a-category', provides: ['evilKey'] }),
    }
    const consumer = {
      file: 'alice-consumer.json',
      doc: v2Plugin({ id: 'alice-consumer', services: ['evilKey'] }),
    }
    const extras = collectValidProvidedServiceKeys([badProvider, consumer])
    const consumerIssues = validatePluginPointer(consumer.doc, consumer.file, extras).map(
      (i) => `${i.field}: ${i.message}`,
    )
    assertHasError('provides from an invalid entry do not count', consumerIssues, [
      'unknown Cordis service key "evilKey"',
    ])

    // Same pair, but the provider is fully valid → the key counts.
    const goodProvider = {
      file: 'alice-suite.json',
      doc: v2Plugin({ id: 'alice-suite', provides: ['suiteCore'] }),
    }
    const consumer2 = {
      file: 'alice-consumer.json',
      doc: v2Plugin({ id: 'alice-consumer', services: ['suiteCore'] }),
    }
    const extras2 = collectValidProvidedServiceKeys([goodProvider, consumer2])
    assertNoError(
      'provides from a valid entry count',
      validatePluginPointer(consumer2.doc, consumer2.file, extras2).map(
        (i) => `${i.field}: ${i.message}`,
      ),
    )
  }

  // 40. Reviewed pin: schema shape, pairing, and packument resolution
  {
    const SRI =
      'sha512-yBDG+V+nWAUyksiRGbBbONbG9Anexa+Pb1hCYip6r8piErrhc/axWcthJQPXTHRTMzwzht6nbREKmShwm6r47w=='
    assertHasError(
      'reviewedVersion not semver',
      pluginIssues(v2Plugin({ reviewedVersion: 'soon', reviewedIntegrity: SRI })),
      ['reviewedVersion', 'semver'],
    )
    assertHasError(
      'reviewedIntegrity not an SRI sha512',
      pluginIssues(v2Plugin({ reviewedVersion: '1.0.0', reviewedIntegrity: 'md5-abc' })),
      ['reviewedIntegrity', 'sha512'],
    )
    assertHasError(
      'reviewed pin fields must come in pairs',
      pluginIssues(v2Plugin({ reviewedVersion: '1.0.0' })),
      ['reviewedVersion and reviewedIntegrity must be declared together'],
    )
    assertNoError(
      'reviewed pin well-formed pair',
      pluginIssues(v2Plugin({ reviewedVersion: '1.0.0', reviewedIntegrity: SRI })),
    )

    const packument = {
      latest: '0.2.0',
      versions: { '0.1.0': SRI, '0.2.0': 'sha512-AAAA' },
    }
    const pinnedDoc = { npm: '@alice/bbebee-plugin-plug', reviewedVersion: '0.1.0', reviewedIntegrity: SRI }

    const okPin = reviewedPinIssues(pinnedDoc, packument)
    if (
      okPin.errors.length === 0 &&
      okPin.targetVersion === '0.1.0' &&
      okPin.warnings.some((w) => w.includes('unreviewed version 0.2.0'))
    ) {
      console.log('  ✓ reviewed pin holds (content target = pinned, latest warns)')
      passed++
    } else {
      console.error(`  ✗ reviewed pin holds FAILED! ${JSON.stringify(okPin)}`)
      failed++
    }

    const tampered = reviewedPinIssues({ ...pinnedDoc, reviewedIntegrity: 'sha512-BBBB' }, packument)
    assertHasError('reviewed pin integrity tampered', tampered.errors, [
      'reviewedIntegrity does not match dist.integrity',
    ])

    const gone = reviewedPinIssues({ ...pinnedDoc, reviewedVersion: '9.9.9' }, packument)
    assertHasError('reviewed pin version unpublished', gone.errors, ['no such version'])

    const unpinned = reviewedPinIssues({ npm: '@alice/bbebee-plugin-plug' }, packument)
    if (unpinned.errors.length === 0 && unpinned.warnings.length === 0 && unpinned.targetVersion === '0.2.0') {
      console.log('  ✓ unpinned entry keeps latest behaviour')
      passed++
    } else {
      console.error(`  ✗ unpinned entry keeps latest behaviour FAILED! ${JSON.stringify(unpinned)}`)
      failed++
    }
  }

  // 41. Content cross-check: entry declarations vs the published manifest
  {
    // The real visualizer pair (shapes copied from the published 0.1.0
    // manifests): entry provides must appear in contributes.services;
    // a manifest without any contributes.services satisfies provides [].
    assertNoError(
      'manifest cross-check: visualizer shape passes',
      manifestConsistencyIssues(
        { provides: ['visualizer'], services: ['audio', 'player', 'settings', 'ui'] },
        { contributes: { services: ['visualizer'] } },
      ),
    )
    assertNoError(
      'manifest cross-check: meters shape passes (no contributes.services)',
      manifestConsistencyIssues(
        { provides: [], services: ['visualizer'] },
        { contributes: { slots: ['now-playing.visualizer'] } },
      ),
    )
    assertHasError(
      'manifest cross-check: provides not registered in the package',
      manifestConsistencyIssues(
        { provides: ['telepathy'], services: [] },
        { contributes: { services: ['visualizer'] } },
      ),
      ['provides "telepathy"', 'does not register it'],
    )
    assertHasError(
      'manifest cross-check: entry services missing from manifest inject',
      manifestConsistencyIssues(
        { provides: [], services: ['player', 'ghost'] },
        { inject: ['player'] },
      ),
      ['services "ghost"', 'inject does not list it'],
    )
    assertHasError(
      'manifest cross-check: manifest injects more than the entry declares',
      manifestConsistencyIssues(
        { provides: [], services: ['player'] },
        { inject: ['player', 'secrets'] },
      ),
      ['injects "secrets"', 'does not declare it in services'],
    )
  }

  // 42. Blocklist: shape validation and per-list hit matching
  {
    const list = parseBlocklist(
      {
        version: 1,
        pluginIds: [{ id: 'mallory-evil', reason: 'malware' }],
        npmPackages: [{ name: '@mallory/evil', reason: 'malware' }],
        githubAccounts: [{ account: 'Mallory', reason: 'repeated impersonation' }],
        repos: [{ repo: 'mallory/evil-repo', reason: 'malware' }],
      },
      'test',
    )
    const hitsOf = (doc) => blocklistHitsForDoc(list, doc).map((h) => h.list)
    const checks = [
      hitsOf({ id: 'mallory-evil' }).includes('pluginIds'),
      hitsOf({ npm: '@mallory/evil' }).includes('npmPackages'),
      hitsOf({ repo: 'https://github.com/mallory/anything' }).includes('githubAccounts'),
      hitsOf({ repo: 'https://github.com/Mallory/Evil-Repo' }).includes('repos'),
      hitsOf({ id: 'alice-plug', npm: '@alice/plug', repo: 'https://github.com/alice/plug' }).length === 0,
    ]
    const throws = (raw) => {
      try {
        parseBlocklist(raw, 'test')
        return false
      } catch {
        return true
      }
    }
    checks.push(
      throws({ pluginIds: [{ id: 'x-y' }] }), // reason is mandatory
      throws({ pluginIds: [{ id: 'Bad ID!', reason: 'r' }] }), // value format
      throws({ unknownList: [] }), // unknown top-level field
      throws({ repos: [{ repo: 'noslash', reason: 'r' }] }), // repo must be owner/name
    )
    if (checks.every(Boolean)) {
      console.log('  ✓ blocklist parsing and hit matching')
      passed++
    } else {
      console.error('  ✗ blocklist parsing and hit matching FAILED!')
      failed++
    }
  }

  // 43. Index consistency: validate itself catches a stale or hand-edited
  //     index (previously only a CI git-diff step did)
  {
    const root = await mkdtemp(join(tmpdir(), 'bbebee-registry-test-'))
    try {
      await mkdir(join(root, 'plugins'), { recursive: true })
      await writeFile(join(root, 'plugins', 'alice-plug.json'), JSON.stringify(v2Plugin()), 'utf8')
      await writeFile(join(root, 'blocklist.json'), '{}\n', 'utf8')

      const { data, problems } = await computePluginIndex(root)
      if (problems.length > 0) throw new Error(`fixture index not computable: ${problems.join('; ')}`)
      await writeFile(join(root, 'plugins', 'index.json'), serializePluginIndex(data), 'utf8')
      const clean = await pluginIndexConsistencyIssue(root)

      // The audit's PoC: hand-inject a fake entry into the index.
      const tampered = JSON.parse(serializePluginIndex(data))
      tampered.entries.push({ id: 'injected-fake', name: 'Fake', npm: '@mallory/fake' })
      await writeFile(join(root, 'plugins', 'index.json'), JSON.stringify(tampered, null, 2) + '\n', 'utf8')
      const caughtFake = await pluginIndexConsistencyIssue(root)

      // Tampering with the blocked channel must also be caught.
      const tampered2 = JSON.parse(serializePluginIndex(data))
      tampered2.blocked = [{ id: 'mallory-evil', reason: 'malware' }]
      await writeFile(join(root, 'plugins', 'index.json'), serializePluginIndex(tampered2), 'utf8')
      const caughtBlocked = await pluginIndexConsistencyIssue(root)

      if (clean === null && caughtFake !== null && caughtBlocked !== null) {
        console.log('  ✓ index consistency catches hand-edited index')
        passed++
      } else {
        console.error(
          `  ✗ index consistency FAILED! clean=${JSON.stringify(clean)} fake=${JSON.stringify(caughtFake)} blocked=${JSON.stringify(caughtBlocked)}`,
        )
        failed++
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 44. Official namespace: repo owner is the only definition of official
  {
    const official = [{ file: 'plugins/bbebeex-visualizer.json', id: 'bbebeex-visualizer', owner: 'BBeBeeX' }]

    // A non-member submitting an official entry is rejected when CI
    // supplies the PR author association.
    assertHasError(
      'official entry from a non-member submitter',
      officialEntryIssues(official, 'CONTRIBUTOR').errors,
      ['author association "CONTRIBUTOR"', 'OWNER or MEMBER'],
    )
    // Org members and owners pass; without context the identity half
    // is skipped (reported by the caller), never silently failed.
    assertNoError('official entry from an org member', officialEntryIssues(official, 'MEMBER').errors)
    const noCtx = officialEntryIssues(official, undefined)
    assertNoError('official entry without PR context skips identity check', noCtx.errors)
    if (noCtx.officialCount === 1 && noCtx.identityChecked === false) {
      console.log('  ✓ official gate reports the skipped identity check')
      passed++
    } else {
      console.error(`  ✗ official gate context reporting FAILED! ${JSON.stringify(noCtx)}`)
      failed++
    }

    // The audit's squatting shape: official prefix, someone else's repo.
    assertHasError(
      'official prefix claimed by a foreign repo',
      officialEntryIssues(
        [{ file: 'plugins/mallory-superplayer.json', id: 'bbebeex-superplayer', owner: 'mallory' }],
        undefined,
      ).errors,
      ['reserved official prefix "bbebeex-"'],
    )
    // An ordinary third-party entry is untouched by the gate.
    assertNoError(
      'third-party entry untouched by the official gate',
      officialEntryIssues(
        [{ file: 'plugins/alice-plug.json', id: 'alice-plug', owner: 'alice' }],
        'CONTRIBUTOR',
      ).errors,
    )
  }

  // 45. Misc gates: engines ranges, id == file name, npm uniqueness
  {
    assertHasError(
      'engines value not a semver range',
      pluginIssues(v2Plugin({ engines: { bbebee: 'whenever' } })),
      ['engines', '"bbebee"', 'valid semver range'],
    )
    assertHasError(
      'engines value not a string',
      pluginIssues(v2Plugin({ engines: { bbebee: 42 } })),
      ['engines', 'valid semver range'],
    )
    assertNoError(
      'engines valid ranges',
      pluginIssues(v2Plugin({ engines: { bbebee: '>=0.1.0 <1.0.0', node: '^20.0.0' } })),
    )

    // Plugin ids live in the plugin namespace, not the GitHub-username
    // namespace: the binding is id == file name (AGENTS.md §3.2).
    assertHasError(
      'plugin id must equal the file name',
      pluginIssues(v2Plugin(), 'alice-other.json'),
      ['must equal the file name'],
    )
    assertNoError(
      'plugin id equal to the file name passes (meters shape)',
      pluginIssues(
        v2Plugin({
          id: 'bbebee-plugin-visualizer-meters',
          npm: '@bbebee/plugin-visualizer-meters',
          repo: 'https://github.com/BBeBeeX/B_Be_Bee-visualizer-meters',
        }),
        'bbebee-plugin-visualizer-meters.json',
      ),
    )

    const dupNpm = new Map([
      ['alice-a', v2Plugin({ id: 'alice-a', npm: '@alice/shared' })],
      ['alice-b', v2Plugin({ id: 'alice-b', npm: '@alice/shared' })],
    ])
    assertHasError(
      'npm package backing two entries',
      validatePluginNpmUniqueness(dupNpm).map((i) => `${i.field}: ${i.message}`),
      ['declared by multiple entries', '@alice/shared'],
    )
    assertNoError(
      'npm packages unique across entries',
      validatePluginNpmUniqueness(
        new Map([
          ['alice-a', v2Plugin({ id: 'alice-a', npm: '@alice/a' })],
          ['alice-b', v2Plugin({ id: 'alice-b', npm: '@alice/b' })],
        ]),
      ).map((i) => `${i.field}: ${i.message}`),
    )
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
