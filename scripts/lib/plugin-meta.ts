/**
 * Schema check for plugins/<author>-<plugin-name>.json — the DMS-style
 * metadata-only entries: the registry stores a *pointer* to the author's
 * release, never the plugin code itself.
 *
 * 实现说明（CONTRIBUTING.md §校验）：这里没有引入 ajv/zod，而是一份手写的
 * 显式字段校验——注册表仓保持零依赖，CI 只要一个 Node；字段少（约 12 个），
 * 一张显式的字段表比一个依赖树更经得起社区贡献者阅读。字段语义见
 * CONTRIBUTING.md §插件。
 */

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const PLUGIN_META_FIELDS = [
  'id', 'name', 'version', 'author', 'description',
  'repo', 'downloadUrl', 'sha256', 'minAppVersion',
  'capabilities', 'engines', 'homepage',
] as const

export interface PluginMetaCheckIssue {
  path: string
  message: string
}

export function pluginMetaIssues(value: unknown, fileName: string): PluginMetaCheckIssue[] {
  const issues: PluginMetaCheckIssue[] = []
  const at = (path: string, message: string) => issues.push({ path, message })

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    at('', `${fileName} must be a JSON object`)
    return issues
  }
  const meta = value as Record<string, unknown>

  // Unknown fields are rejected on purpose: a typo'd `sha356` must not slip
  // through as "some extra field nobody checks".
  for (const key of Object.keys(meta)) {
    if (!(PLUGIN_META_FIELDS as readonly string[]).includes(key)) {
      at(key, 'unknown field (see CONTRIBUTING.md §插件 for the schema)')
    }
  }

  if (typeof meta.id !== 'string' || !meta.id.trim()) at('id', 'required')
  else if (!SLUG.test(meta.id)) at('id', 'must be lowercase letters/digits separated by single hyphens')

  const expectedFile = `${meta.id}.json`
  if (typeof meta.id === 'string' && fileName !== expectedFile) {
    at('id', `file name must be "<id>.json" — rename to "${expectedFile}"`)
  }

  if (typeof meta.name !== 'string' || !meta.name.trim()) at('name', 'required')
  if (typeof meta.version !== 'string' || !SEMVER.test(meta.version)) at('version', 'required, semver (e.g. "1.0.0")')
  if (typeof meta.author !== 'string' || !meta.author.trim()) at('author', 'required')
  if (typeof meta.description !== 'string' || !meta.description.trim()) at('description', 'required')

  for (const key of ['repo', 'downloadUrl'] as const) {
    const v = meta[key]
    if (typeof v !== 'string' || !v.trim()) {
      at(key, 'required')
    } else if (!/^https:\/\//.test(v)) {
      at(key, 'must be an https:// URL')
    }
  }

  if (typeof meta.sha256 !== 'string' || !SHA256.test(meta.sha256)) {
    at('sha256', 'required — lowercase hex sha256 of the file at downloadUrl')
  }

  if (meta.minAppVersion !== undefined) {
    if (typeof meta.minAppVersion !== 'string' || !SEMVER.test(meta.minAppVersion)) {
      at('minAppVersion', 'must be a semver string when present')
    }
  }

  if (meta.capabilities !== undefined) {
    if (!Array.isArray(meta.capabilities) || !meta.capabilities.every((c) => typeof c === 'string')) {
      at('capabilities', 'must be an array of capability strings')
    }
  }

  if (meta.engines !== undefined) {
    if (meta.engines === null || typeof meta.engines !== 'object' || Array.isArray(meta.engines)) {
      at('engines', 'must be an object like { "bbebee": ">=0.1.0" }')
    }
  }

  if (meta.homepage !== undefined && (typeof meta.homepage !== 'string' || !/^https:\/\//.test(meta.homepage))) {
    at('homepage', 'must be an https:// URL when present')
  }

  return issues
}
