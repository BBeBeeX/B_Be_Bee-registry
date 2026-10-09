/**
 * COPIED FROM BBeBee main repo `scripts/sources/validator.ts` @ ec1ca33 (2026-10-07).
 *
 * 复用而非重写（这是本注册表仓的硬性决定，见 CONTRIBUTING.md §校验）：音乐源与
 * 歌词源的 schema 权威在主仓，这里必须与主仓同一套规则，否则注册表放行的文档
 * 应用会拒收，或者反过来。主仓更新 validator 时，请同步复制本文件并在上面的
 * 提交号处更新——CI 不做跨仓比对（两个仓库独立发版），由审核人在 PR 里把关。
 *
 * 类型导入是 type-only 的，node 运行时（--experimental-strip-types）会整体擦除，
 * 因此本文件在注册表仓零依赖可直接运行。
 */
import type { LyricSourceDefinition, SourceDocument, StreamQuality } from '@BBeBee/protocol'

const STREAM_QUALITIES: readonly StreamQuality[] = ['low', 'normal', 'high', 'lossless', 'hi-res']

const LIST_FIELDS = [
  'trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork',
  'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind',
] as const

const RULE_FIELDS: Record<string, readonly string[]> = {
  ruleSearch: LIST_FIELDS,
  ruleSearchArtist: LIST_FIELDS,
  ruleExplore: LIST_FIELDS,
  ruleTrackList: LIST_FIELDS,
  ruleAlbum: ['title', 'artist', 'artwork', 'year', 'description', 'trackCount', 'trackListUrl', 'childUrl'],
  ruleStream: ['url', 'headers', 'mimeType', 'codec', 'bitrateKbps', 'sampleRate', 'byteLength',
    'seekable', 'expiresAt', 'quality', 'qualities'],
  ruleLyric: ['lyric', 'format', 'offsetMs'],
  ruleLibrary: ['list', 'setSaved', 'createPlaylist', 'addToPlaylist', 'removeFromPlaylist',
    'deletePlaylist'],
  ruleArtist: ['artist', 'name', 'bio', 'artwork', 'albums', 'topTracks'],
  rulePlaylist: ['playlist', 'name', 'description', 'artwork', 'trackList', 'trackId', 'title', 'artist', 'durationMs'],
}

const TOP_LEVEL_RULES = ['header', 'searchUrl', 'searchArtistUrl', 'exploreUrl'] as const

/**
 * Validates a SourceDocument object.
 * Returns the document if valid, or throws an Error listing all detected issues.
 */
export function validateSourceDocument(value: unknown): SourceDocument {
  const issues: string[] = []
  const at = (path: string, message: string) => issues.push(`${path}: ${message}`)

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Source document must be a JSON object')
  }

  const doc = value as Record<string, unknown>

  // 1. Identity
  if (typeof doc.sourceUrl !== 'string' || !doc.sourceUrl.trim()) {
    at('sourceUrl', 'required backend URL')
  } else if (doc.sourceUrl !== doc.sourceUrl.trim()) {
    at('sourceUrl', 'must not have leading or trailing whitespace')
  }

  if (typeof doc.sourceName !== 'string' || !doc.sourceName.trim()) {
    at('sourceName', 'required')
  }

  // 1.5 Registry metadata — version must be semver when present (registry extension).
  if (doc.version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(doc.version))) {
    at('version', 'must be a semver string (e.g. "1.0.0")')
  }
  if (doc.minAppVersion !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(doc.minAppVersion))) {
    at('minAppVersion', 'must be a semver string (e.g. "1.0.0")')
  }

  // 2. Scalars
  for (const key of ['sourceGroup', 'sourceIcon', 'sourceComment', 'variableComment', 'jsLib',
    'concurrentRate', 'loginUrl', 'loginCheckJs', 'loginQrJs', 'loginPollJs', 'loginRefreshJs'] as const) {
    if (doc[key] !== undefined && typeof doc[key] !== 'string') {
      at(key, 'must be a string')
    }
  }

  // 3. Top-level rule strings
  for (const key of TOP_LEVEL_RULES) {
    if (doc[key] === undefined) continue
    if (typeof doc[key] !== 'string') {
      at(key, 'must be a rule string')
    } else if (!doc[key].trim()) {
      at(key, 'must not be empty')
    }
  }

  // 4. Allowed hosts
  if (doc.allowedHosts !== undefined) {
    if (!Array.isArray(doc.allowedHosts) || !doc.allowedHosts.every((h) => typeof h === 'string')) {
      at('allowedHosts', 'must be an array of hostnames')
    }
  }

  // 5. Qualities (root level)
  if (doc.qualities !== undefined) {
    if (
      !Array.isArray(doc.qualities) ||
      !doc.qualities.every((q) => typeof q === 'string' && STREAM_QUALITIES.includes(q as StreamQuality))
    ) {
      at('qualities', `must be an array of valid stream qualities (${STREAM_QUALITIES.join(', ')})`)
    }
  }

  // 6. Rule blocks
  for (const [block, fields] of Object.entries(RULE_FIELDS)) {
    const rules = doc[block]
    if (rules === undefined) continue
    if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
      at(block, 'must be an object')
      continue
    }

    for (const [field, rule] of Object.entries(rules as Record<string, unknown>)) {
      if (!fields.includes(field)) {
        at(`${block}.${field}`, 'unknown field')
        continue
      }
      if (block === 'ruleStream' && field === 'qualities') {
        if (
          !Array.isArray(rule) ||
          !rule.every((q) => typeof q === 'string' && STREAM_QUALITIES.includes(q as StreamQuality))
        ) {
          at('ruleStream.qualities', `must be an array of valid stream qualities (${STREAM_QUALITIES.join(', ')})`)
        }
        continue
      }
      if (typeof rule !== 'string') {
        at(`${block}.${field}`, 'must be a rule string')
      }
    }
  }

  // 7. Required ruleStream
  const stream = doc.ruleStream
  if (stream === undefined) {
    at('ruleStream', 'required — a source that cannot produce a stream URL cannot play anything')
  } else if (stream === null || typeof stream !== 'object' || Array.isArray(stream)) {
    at('ruleStream', 'must be an object')
  } else {
    const url = (stream as Record<string, unknown>).url
    if (typeof url !== 'string') at('ruleStream.url', 'required')
    else if (!url.trim()) at('ruleStream.url', 'must not be empty')
  }

  if (issues.length > 0) {
    const name = typeof doc.sourceName === 'string' ? doc.sourceName : 'Source document'
    throw new Error(`${name} validation failed: ${issues.join('; ')}`)
  }

  return doc as unknown as SourceDocument
}

/**
 * Validates a lyric source document (`LyricSourceDefinition`) — the doc model
 * used for lyric platforms: metadata plus one sandbox script.
 * Returns the document if valid, or throws an Error listing all detected issues.
 */
export function validateLyricSourceDocument(value: unknown): LyricSourceDefinition {
  const issues: string[] = []
  const at = (path: string, message: string) => issues.push(`${path}: ${message}`)

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lyric source document must be a JSON object')
  }

  const doc = value as Record<string, unknown>

  if (typeof doc.id !== 'string' || !doc.id.trim()) {
    at('id', 'required')
  }
  if (typeof doc.name !== 'string' || !doc.name.trim()) {
    at('name', 'required')
  }
  if (typeof doc.script !== 'string' || !doc.script.trim()) {
    at('script', 'required — expected source.js to be inlined by the compiler')
  }

  for (const key of ['description', 'version', 'author'] as const) {
    if (doc[key] !== undefined && typeof doc[key] !== 'string') {
      at(key, 'must be a string')
    }
  }
  if (doc.version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(doc.version))) {
    at('version', 'must be a semver string (e.g. "1.0.0")')
  }
  if (doc.minAppVersion !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(doc.minAppVersion))) {
    at('minAppVersion', 'must be a semver string (e.g. "1.0.0")')
  }
  if (doc.enabled !== undefined && typeof doc.enabled !== 'boolean') {
    at('enabled', 'must be a boolean')
  }
  if (doc.sortOrder !== undefined && typeof doc.sortOrder !== 'number') {
    at('sortOrder', 'must be a number')
  }
  if (doc.allowedHosts !== undefined) {
    if (!Array.isArray(doc.allowedHosts) || !doc.allowedHosts.every((h) => typeof h === 'string')) {
      at('allowedHosts', 'must be an array of hostnames')
    }
  }

  if (issues.length > 0) {
    const name = typeof doc.name === 'string' ? doc.name : 'Lyric source document'
    throw new Error(`${name} validation failed: ${issues.join('; ')}`)
  }

  return doc as unknown as LyricSourceDefinition
}
