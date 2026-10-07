#!/usr/bin/env node
/**
 * scripts/generate-index.mjs — 扫描四类条目目录，生成仓库根的 registry.json
 * （应用消费的唯一入口）与 README.md（介绍 + 自动条目索引）。
 *
 * 既可以作为库被 validate.mjs 复用（导出 buildIndex / buildReadme /
 * collectEntries / duplicateIssues / scanPluginMetaFiles），也可以直接运行：
 *
 *   node scripts/generate-index.mjs
 *
 * 零 npm 依赖；用 plain node 运行（.ts 经类型擦除直接加载）。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KINDS, gitLastCommitDate, rawBaseUrl, registryRepository, scanEntryDirs } from './lib/registry-model.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** README 索引段里每一类的中文标题。 */
const KIND_TITLES = {
  'music-source': '音乐源（Music Sources）',
  'lyric-source': '歌词源（Lyric Sources）',
  theme: '界面主题（Themes）',
  plugin: '插件（Plugins）',
}

/** generatedAt 的兜底值：仓库还没有任何 git 时间时使用（恒定，保证可复现）。 */
const EPOCH = '1970-01-01T00:00:00.000Z'

/* ── 扫描 ──────────────────────────────────────────────────────────────── */

/**
 * plugins/ 的条目是单个文件（<id>.json），不是子目录——scanEntryDirs 只返回
 * 目录，这里单独列出 *.json 元数据文件。
 */
export async function scanPluginMetaFiles(kindRoot) {
  const entries = await readdir(kindRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()
}

function requireVersion(doc, where) {
  if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(doc.version)) {
    throw new Error(
      `${where}: missing or invalid required "version" (semver, e.g. "1.0.0") — ` +
        'every registry entry must declare a version (the app compares it for updates)',
    )
  }
}

function requireString(doc, field, where) {
  if (typeof doc[field] !== 'string' || !doc[field].trim()) {
    throw new Error(`${where}: missing required "${field}"`)
  }
}

function updatedAtOf(entryPath) {
  return gitLastCommitDate([entryPath])
}

/* ── 每类条目的 registry.json 条目构造 ─────────────────────────────────── */

async function readJson(file, what) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new Error(`${relative(repoRoot, file) || what} not found — run scripts/compile.mjs first`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${relative(repoRoot, file)}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** music-source：id = 目录名，元数据来自编译后的 dist 文档。 */
async function musicEntry(spec, dirName) {
  const where = `${spec.dir}/${dirName}`
  const doc = await readJson(join(repoRoot, spec.distDir, `${dirName}.json`), where)
  requireString(doc, 'sourceName', where)
  requireVersion(doc, where)
  const entry = { id: dirName, kind: spec.kind, name: doc.sourceName, version: doc.version }
  if (doc.author !== undefined) entry.author = doc.author
  if (doc.sourceComment !== undefined) entry.description = doc.sourceComment
  const updatedAt = updatedAtOf(join(repoRoot, spec.dir, dirName))
  if (updatedAt) entry.updatedAt = updatedAt
  entry.downloadUrl = `${rawBaseUrl()}/${spec.distDir}/${dirName}.json`
  if (doc.sourceUrl !== undefined) entry.sourceUrl = doc.sourceUrl
  return entry
}

/** lyric-source：id = 文档 id（如 builtin-lrclib），不是目录名。 */
async function lyricEntry(spec, dirName) {
  const where = `${spec.dir}/${dirName}`
  const doc = await readJson(join(repoRoot, spec.distDir, `${dirName}.json`), where)
  requireString(doc, 'id', where)
  requireString(doc, 'name', where)
  requireVersion(doc, where)
  const entry = { id: doc.id, kind: spec.kind, name: doc.name, version: doc.version }
  if (doc.author !== undefined) entry.author = doc.author
  if (doc.description !== undefined) entry.description = doc.description
  const updatedAt = updatedAtOf(join(repoRoot, spec.dir, dirName))
  if (updatedAt) entry.updatedAt = updatedAt
  entry.downloadUrl = `${rawBaseUrl()}/${spec.distDir}/${dirName}.json`
  return entry
}

/** theme：直接读源文件 themes/<dir>/theme.json（主题没有编译步骤）。 */
async function themeEntry(spec, dirName) {
  const where = `${spec.dir}/${dirName}`
  const doc = await readJson(join(repoRoot, spec.dir, dirName, 'theme.json'), where)
  requireString(doc, 'id', where)
  requireString(doc, 'name', where)
  requireVersion(doc, where)
  const entry = { id: doc.id, kind: spec.kind, name: doc.name, version: doc.version }
  if (doc.author !== undefined) entry.author = doc.author
  if (doc.description !== undefined) entry.description = doc.description
  const updatedAt = updatedAtOf(join(repoRoot, spec.dir, dirName))
  if (updatedAt) entry.updatedAt = updatedAt
  entry.downloadUrl = `${rawBaseUrl()}/themes/${dirName}/theme.json`
  if (existsSync(join(repoRoot, spec.dir, dirName, 'preview.png'))) {
    entry.previewUrl = `${rawBaseUrl()}/themes/${dirName}/preview.png`
  }
  return entry
}

/** plugin：元数据指针，downloadUrl 指向作者自己的 Release（不是本仓 raw）。 */
async function pluginEntry(spec, fileName) {
  const where = `${spec.dir}/${fileName}`
  const meta = await readJson(join(repoRoot, spec.dir, fileName), where)
  requireString(meta, 'id', where)
  requireString(meta, 'name', where)
  requireVersion(meta, where)
  requireString(meta, 'downloadUrl', where)
  const entry = {
    id: meta.id,
    kind: spec.kind,
    name: meta.name,
    version: meta.version,
  }
  if (meta.author !== undefined) entry.author = meta.author
  if (meta.description !== undefined) entry.description = meta.description
  const updatedAt = updatedAtOf(join(repoRoot, spec.dir, fileName))
  if (updatedAt) entry.updatedAt = updatedAt
  entry.downloadUrl = meta.downloadUrl
  entry.repo = meta.repo
  entry.sha256 = meta.sha256
  if (meta.minAppVersion !== undefined) entry.minAppVersion = meta.minAppVersion
  if (meta.capabilities !== undefined) entry.capabilities = meta.capabilities
  if (existsSync(join(repoRoot, spec.dir, `${meta.id}.preview.png`))) {
    entry.previewUrl = `${rawBaseUrl()}/plugins/${meta.id}.preview.png`
  }
  return entry
}

/**
 * 扫描全部四类目录。返回 `{ spec, dirName, entry }` 列表——dirName 单独携带，
 * 因为条目 id（lyric/theme 用文档 id）可能与目录名不同，README 链接需要目录名。
 * 条目按 KINDS 顺序、同类内按 id 排序。
 */
export async function collectEntries(root = repoRoot) {
  const collected = []
  for (const spec of KINDS) {
    if (spec.kind === 'plugin') {
      for (const fileName of await scanPluginMetaFiles(join(root, spec.dir))) {
        collected.push({ spec, dirName: fileName, entry: await pluginEntry(spec, fileName) })
      }
      continue
    }
    for (const dirName of await scanEntryDirs(join(root, spec.dir))) {
      const entry =
        spec.kind === 'theme'
          ? await themeEntry(spec, dirName)
          : spec.kind === 'lyric-source'
            ? await lyricEntry(spec, dirName)
            : await musicEntry(spec, dirName)
      collected.push({ spec, dirName, entry })
    }
  }
  const kindOrder = (kind) => KINDS.findIndex((k) => k.kind === kind)
  collected.sort(
    (a, b) =>
      kindOrder(a.spec.kind) - kindOrder(b.spec.kind) ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  )
  return collected
}

/* ── 重复检测（validate.mjs 复用同一份逻辑） ──────────────────────────── */

/** 同类内 id 重复、音乐条目 sourceUrl 重复 → registry.json 无法唯一定位条目。 */
export function duplicateIssues(entries) {
  const issues = []
  const idsByKind = new Map()
  const sourceUrls = new Map()
  for (const e of entries) {
    if (!idsByKind.has(e.kind)) idsByKind.set(e.kind, new Map())
    const ids = idsByKind.get(e.kind)
    ids.set(e.id, [...(ids.get(e.id) ?? []), e.id])
    if (e.kind === 'music-source' && typeof e.sourceUrl === 'string' && e.sourceUrl) {
      sourceUrls.set(e.sourceUrl, [...(sourceUrls.get(e.sourceUrl) ?? []), e.id])
    }
  }
  for (const [kind, ids] of idsByKind) {
    for (const [id, seen] of ids) {
      if (seen.length > 1) issues.push(`duplicate ${kind} id "${id}" (${seen.length} entries)`)
    }
  }
  for (const [url, owners] of sourceUrls) {
    if (owners.length > 1) issues.push(`duplicate music sourceUrl "${url}" across entries: ${owners.join(', ')}`)
  }
  return issues
}

/* ── index / README 组装 ───────────────────────────────────────────────── */

/**
 * generatedAt 必须可复现：CI 会重新生成并与已提交文件做 git diff --exit-code，
 * 墙钟时间会让每次生成都不同。因此取所有条目 updatedAt 的最大值（都是 git
 * 最后提交时间）；无条目或都无时间时退回 HEAD 提交时间；连 git 都没有时退回
 * 恒定纪元。详见 CONTRIBUTING.md §生成文件警告。
 */
function generatedAt(entries) {
  const dates = entries.map((e) => e.updatedAt).filter((d) => typeof d === 'string')
  if (dates.length > 0) {
    return dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
  }
  return gitLastCommitDate(['.']) ?? EPOCH
}

/** registry.json：{ generatedAt, repository, entries }，2 空格缩进 + 末尾换行。 */
export async function buildIndex(root = repoRoot) {
  const collected = await collectEntries(root)
  const entries = collected.map((c) => c.entry)
  const dupes = duplicateIssues(entries)
  if (dupes.length > 0) throw new Error(dupes.join('\n'))
  return { generatedAt: generatedAt(entries), repository: registryRepository(), entries }
}

function mdCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/**
 * README.md = README.intro.md（手工维护的介绍）+ 每类一节的条目索引表。
 * 表格：条目（id，链到该条目 README——仅 music/lyric/theme 且 README 存在时）
 * | 版本 | 作者 | 更新时间 | 说明。条目 id 与目录名可能不同（lyric/theme），
 * 因此重新 collectEntries 一次拿 dirName 映射。
 */
export async function buildReadme(root = repoRoot, index) {
  const intro = await readFile(join(root, 'README.intro.md'), 'utf8')
  const collected = await collectEntries(root)
  const dirById = new Map(collected.map((c) => [`${c.spec.kind}:${c.entry.id}`, c.dirName]))

  const lines = [intro.trimEnd(), '', '---', '', '# 条目索引', '']
  lines.push('> 本节由 `scripts/generate-index.mjs` 生成，请勿手改；内容变更后重新运行该脚本。', '')

  for (const spec of KINDS) {
    const entries = index.entries.filter((e) => e.kind === spec.kind)
    lines.push(`## ${KIND_TITLES[spec.kind]}`, '')
    if (entries.length === 0) {
      lines.push('（暂无条目）', '')
      continue
    }
    lines.push('| 条目 | 版本 | 作者 | 更新时间 | 说明 |', '| --- | --- | --- | --- | --- |')
    for (const e of entries) {
      const dirName = dirById.get(`${e.kind}:${e.id}`) ?? e.id
      const readmeCandidates = {
        'music-source': join(spec.dir, dirName, 'README.md'),
        'lyric-source': join(spec.dir, dirName, 'README.md'),
        theme: join(spec.dir, dirName, 'README.md'),
        plugin: null,
      }
      const readmeRel = readmeCandidates[e.kind]
      const idCell =
        readmeRel && existsSync(join(root, readmeRel))
          ? `[${mdCell(e.id)}](${readmeRel.replaceAll('\\', '/')})`
          : mdCell(e.id)
      const updated = e.updatedAt ? e.updatedAt.slice(0, 10) : '—'
      lines.push(`| ${idCell} | ${mdCell(e.version)} | ${mdCell(e.author)} | ${updated} | ${mdCell(e.description)} |`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

async function main() {
  const index = await buildIndex(repoRoot)
  await writeFile(join(repoRoot, 'registry.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log(`wrote registry.json (${index.entries.length} entries, repository ${index.repository})`)
  const readme = await buildReadme(repoRoot, index)
  await writeFile(join(repoRoot, 'README.md'), readme, 'utf8')
  console.log('wrote README.md')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
