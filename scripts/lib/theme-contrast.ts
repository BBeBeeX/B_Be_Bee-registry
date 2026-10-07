/**
 * COPIED FROM BBeBee main repo `packages/ui/ui-tokens/src/color.ts` and
 * `packages/ui/ui-tokens/src/index.ts` (`themeContrastIssues`) @ ec1ca33 (2026-10-07),
 * plus a structural validator for `ThemeDefinition` written for this registry.
 *
 * 复用而非重写：第三方主题在应用里由同一个 `themeContrastIssues` 把关（WCAG AA
 * 是主仓 CI 的门禁），注册表必须在**同一把尺子**下拒绝过不了门禁的主题，否则
 * "装一个注册表主题"就会变成"绕过应用的可读性底线"。主仓 ui-tokens 变更时同步
 * 本文件并更新顶部提交号（见 CONTRIBUTING.md §校验）。
 *
 * 类型导入为 type-only，运行时整体擦除，本文件零依赖。
 */

/* ── colour maths (copied verbatim from ui-tokens/src/color.ts) ─────────── */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. Alpha is parsed and ignored for contrast. */
export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, '')
  const expand = value.length === 3 || value.length === 4
  const pairs = expand
    ? [...value.slice(0, 3)].map((c) => c + c)
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]

  if (pairs.some((p) => !/^[0-9a-f]{2}$/i.test(p))) {
    throw new Error(`not a hex colour: ${JSON.stringify(hex)}`)
  }
  const [r, g, b] = pairs.map((p) => Number.parseInt(p, 16)) as [number, number, number]
  return { r, g, b }
}

/** Parses #hex or rgb/rgba string into Rgb. */
export function parseColor(color: string): Rgb {
  const trimmed = color.trim()
  if (trimmed.startsWith('#')) return parseHex(trimmed)
  const match = trimmed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (match) {
    return {
      r: Number.parseInt(match[1]!, 10),
      g: Number.parseInt(match[2]!, 10),
      b: Number.parseInt(match[3]!, 10),
    }
  }
  return parseHex(trimmed)
}

/** Relative luminance, per WCAG 2.1. */
export function luminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseColor(color) : color
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/** WCAG AA: 4.5 for body text, 3 for large text and UI boundaries. */
export const AA_TEXT = 4.5
export const AA_LARGE = 3

/* ── theme shape (registry-side structural check of ThemeDefinition) ────── */

export type Scheme = 'light' | 'dark'

export interface ContrastIssue {
  scheme: Scheme
  pair: string
  ratio: number
  required: number
}

/**
 * Every required leaf of the app's `ColorTokens` (packages/protocol
 * src/services/theme.ts). Optional leaves (gradient.spectrum, glow.blue*, …)
 * may be absent; whatever IS present must be a colour string.
 */
const TOKEN_PATHS: { path: string; required: boolean }[] = [
  ...['app', 'primary', 'secondary', 'tertiary'].map((k) => ({ path: `bg.${k}`, required: true })),
  ...['s1', 's2', 's3', 'hover', 'active', 'selected'].map((k) => ({ path: `surface.${k}`, required: true })),
  ...['primary', 'primaryActive', 'primaryHover', 'accent', 'accentHover'].map((k) => ({ path: `brand.${k}`, required: true })),
  ...['brand', 'progress'].map((k) => ({ path: `gradient.${k}`, required: true })),
  ...['primary', 'secondary', 'tertiary', 'muted', 'disabled', 'placeholder'].map((k) => ({ path: `text.${k}`, required: true })),
  ...['subtle', 'default', 'hover', 'active', 'focus'].map((k) => ({ path: `border.${k}`, required: true })),
  ...['success', 'warning', 'error', 'info'].map((k) => ({ path: `semantic.${k}`, required: true })),
  ...['playing', 'lyrics', 'waveform', 'waveformActive'].map((k) => ({ path: `music.${k}`, required: true })),
  { path: 'music.lyricsActive', required: false },
  { path: 'music.lyricsHighlight', required: false },
  ...['xs', 'sm', 'md', 'lg'].map((k) => ({ path: `glow.${k}`, required: true })),
  { path: 'glow.blueXs', required: false },
  { path: 'glow.blueSm', required: false },
  { path: 'glow.blueMd', required: false },
  { path: 'glow.purpleXs', required: false },
  { path: 'glow.purpleSm', required: false },
  { path: 'glow.purpleMd', required: false },
  { path: 'glow.brandSm', required: false },
  { path: 'glow.brandMd', required: false },
]

const COLOR_LIKE = /^#[0-9a-fA-F]{3,8}$|^rgba?\s*\(/

/** Structural issues of one token set (missing required leaves, non-colour values). */
function tokenSetIssues(tokens: unknown, label: string): string[] {
  const issues: string[] = []
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return [`${label}: must be an object`]
  }
  for (const { path, required } of TOKEN_PATHS) {
    const [group, key] = path.split('.')
    const value = (tokens as Record<string, Record<string, unknown>>)[group!]?.[key!]
    if (value === undefined) {
      if (required) issues.push(`${label}.${path}: missing required colour token`)
      continue
    }
    if (typeof value !== 'string' || !COLOR_LIKE.test(value.trim())) {
      issues.push(`${label}.${path}: must be a colour string (#hex or rgb/rgba)`)
    }
  }
  return issues
}

/**
 * Structural issues of a theme.json document (registry flavour: it must carry
 * the fields the app's ThemeDefinition needs, plus registry metadata).
 */
export function themeShapeIssues(value: unknown): string[] {
  const issues: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['theme.json: must be a JSON object']
  }
  const theme = value as Record<string, unknown>

  if (typeof theme.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(theme.id)) {
    issues.push('id: required, lowercase letters/digits separated by single hyphens')
  }
  if (typeof theme.name !== 'string' || !theme.name.trim()) issues.push('name: required')
  if (typeof theme.isDark !== 'boolean') issues.push('isDark: required boolean')
  if (theme.description !== undefined && typeof theme.description !== 'string') {
    issues.push('description: must be a string')
  }
  if (theme.version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(theme.version))) {
    issues.push('version: must be a semver string (e.g. "1.0.0")')
  }
  if (theme.author !== undefined && typeof theme.author !== 'string') {
    issues.push('author: must be a string')
  }
  for (const key of ['cssVariables', 'lightCssVariables'] as const) {
    const v = theme[key]
    if (v === undefined) continue
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      issues.push(`${key}: must be an object of CSS custom property overrides`)
    } else if (!Object.values(v).every((x) => typeof x === 'string')) {
      issues.push(`${key}: every override must be a string`)
    }
  }
  issues.push(...tokenSetIssues(theme.tokens, 'tokens'))
  if (theme.lightTokens !== undefined) {
    issues.push(...tokenSetIssues(theme.lightTokens, 'lightTokens'))
  }
  return issues
}

/* ── contrast gate (copied verbatim from ui-tokens themeContrastIssues) ─── */

/**
 * Validates WCAG AA contrast for key UI pairs in a ThemeDefinition under a specific scheme.
 */
export function themeContrastIssues(
  theme: Record<string, unknown> & { id: string },
  scheme: Scheme = 'dark',
): ContrastIssue[] {
  const lightTokens = theme.lightTokens as Record<string, Record<string, string>> | undefined
  const tokens = (scheme === 'light' && lightTokens ? lightTokens : theme.tokens) as Record<
    string,
    Record<string, string>
  >
  const issues: ContrastIssue[] = []
  const pairs: { pair: string; fg: string; bg: string; large?: boolean }[] = [
    { pair: 'text.primary on bg.app', fg: tokens.text!.primary!, bg: tokens.bg!.app! },
    { pair: 'text.primary on bg.primary', fg: tokens.text!.primary!, bg: tokens.bg!.primary! },
    { pair: 'text.primary on surface.s1', fg: tokens.text!.primary!, bg: tokens.surface!.s1! },
    { pair: 'text.primary on surface.s2', fg: tokens.text!.primary!, bg: tokens.surface!.s2! },
    { pair: 'text.secondary on bg.primary', fg: tokens.text!.secondary!, bg: tokens.bg!.primary! },
    { pair: 'text.secondary on surface.s1', fg: tokens.text!.secondary!, bg: tokens.surface!.s1! },
    { pair: 'brand.primary on bg.primary', fg: tokens.brand!.primary!, bg: tokens.bg!.primary!, large: true },
    { pair: 'semantic.error on bg.primary', fg: tokens.semantic!.error!, bg: tokens.bg!.primary! },
    { pair: 'semantic.success on bg.primary', fg: tokens.semantic!.success!, bg: tokens.bg!.primary! },
  ]
  for (const check of pairs) {
    const ratio = contrastRatio(check.fg, check.bg)
    const required = check.large ? AA_LARGE : AA_TEXT
    if (Math.round(ratio * 100) / 100 < required) {
      issues.push({ scheme, pair: `${theme.id} ${check.pair}`, ratio: Math.round(ratio * 100) / 100, required })
    }
  }
  return issues
}
