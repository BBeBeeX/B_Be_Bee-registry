/**
 * scripts/lib/theme-contrast.ts
 *
 * Theme schema validation and WCAG AA contrast gate for BBeBee themes.
 * Supports dark and/or light modes under `tokens`.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export function isValidHex(color: string): boolean {
  return typeof color === 'string' && HEX_COLOR.test(color.trim())
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. Alpha is parsed and ignored for contrast. */
export function parseHex(hex: string): Rgb {
  const trimmed = hex.trim()
  if (!HEX_COLOR.test(trimmed)) {
    throw new Error(`not a valid #hex colour: ${JSON.stringify(hex)}`)
  }
  const value = trimmed.replace(/^#/, '')
  const expand = value.length === 3 || value.length === 4
  const pairs = expand
    ? [...value.slice(0, 3)].map((c) => c + c)
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]

  const [r, g, b] = pairs.map((p) => Number.parseInt(p, 16)) as [number, number, number]
  return { r, g, b }
}

/** Relative luminance, per WCAG 2.1. */
export function luminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color
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

export type Scheme = 'light' | 'dark'

export interface ContrastIssue {
  scheme: Scheme
  pair: string
  ratio: number
  required: number
}

export const KNOWN_TOKEN_PATHS = new Set<string>([
  'bg.app', 'bg.primary', 'bg.secondary', 'bg.tertiary',
  'surface.s1', 'surface.s2', 'surface.s3', 'surface.hover', 'surface.active', 'surface.selected',
  'brand.primary', 'brand.primaryActive', 'brand.primaryHover', 'brand.accent', 'brand.accentHover',
  'gradient.brand', 'gradient.progress', 'gradient.blueViolet', 'gradient.ice', 'gradient.spectrum',
  'text.primary', 'text.secondary', 'text.tertiary', 'text.muted', 'text.disabled', 'text.placeholder',
  'border.subtle', 'border.default', 'border.hover', 'border.active', 'border.focus',
  'semantic.success', 'semantic.warning', 'semantic.error', 'semantic.info',
  'music.playing', 'music.lyrics', 'music.lyricsActive', 'music.lyricsHighlight', 'music.waveform', 'music.waveformActive',
  'glow.xs', 'glow.sm', 'glow.md', 'glow.lg',
  'glow.blueXs', 'glow.blueSm', 'glow.blueMd',
  'glow.purpleXs', 'glow.purpleSm', 'glow.purpleMd',
  'glow.brandSm', 'glow.brandMd',
])

const CHECKED_PAIRS: { pair: string; fg: string; bg: string; large?: boolean }[] = [
  { pair: 'text.primary on bg.app', fg: 'text.primary', bg: 'bg.app' },
  { pair: 'text.primary on bg.primary', fg: 'text.primary', bg: 'bg.primary' },
  { pair: 'text.primary on surface.s1', fg: 'text.primary', bg: 'surface.s1' },
  { pair: 'text.primary on surface.s2', fg: 'text.primary', bg: 'surface.s2' },
  { pair: 'text.secondary on bg.primary', fg: 'text.secondary', bg: 'bg.primary' },
  { pair: 'text.secondary on surface.s1', fg: 'text.secondary', bg: 'surface.s1' },
  { pair: 'brand.primary on bg.primary', fg: 'brand.primary', bg: 'bg.primary', large: true },
  { pair: 'semantic.error on bg.primary', fg: 'semantic.error', bg: 'bg.primary' },
  { pair: 'semantic.success on bg.primary', fg: 'semantic.success', bg: 'bg.primary' },
]

export function getTokenValue(tokensObj: Record<string, unknown>, path: string): string | undefined {
  if (path in tokensObj && typeof tokensObj[path] === 'string') {
    return tokensObj[path] as string
  }
  const [group, key] = path.split('.')
  if (group && key && tokensObj[group] && typeof tokensObj[group] === 'object') {
    const sub = (tokensObj[group] as Record<string, unknown>)[key]
    if (typeof sub === 'string') return sub
  }
  return undefined
}

export const THEME_ALLOWED_FIELDS = ['id', 'name', 'version', 'author', 'description', 'tokens'] as const
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function themeValidationIssues(value: unknown): string[] {
  const issues: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['theme.json: must be a JSON object']
  }
  const theme = value as Record<string, unknown>

  // Unknown fields check
  for (const key of Object.keys(theme)) {
    if (!(THEME_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      issues.push(`theme.json: unknown field "${key}"`)
    }
  }

  // Required fields
  if (typeof theme.id !== 'string' || !theme.id.trim()) {
    issues.push('id: required')
  } else if (!SLUG.test(theme.id)) {
    issues.push('id: must be lowercase letters/digits separated by single hyphens')
  }

  if (typeof theme.name !== 'string' || !theme.name.trim()) issues.push('name: required')
  if (typeof theme.version !== 'string' || !SEMVER.test(theme.version)) {
    issues.push('version: required, semver (e.g. "1.0.0")')
  }
  if (typeof theme.author !== 'string' || !theme.author.trim()) issues.push('author: required')
  if (typeof theme.description !== 'string' || !theme.description.trim()) issues.push('description: required')

  if (theme.tokens === null || typeof theme.tokens !== 'object' || Array.isArray(theme.tokens)) {
    issues.push('tokens: required object containing dark and/or light tokens')
    return issues
  }

  const tokens = theme.tokens as Record<string, unknown>
  for (const k of Object.keys(tokens)) {
    if (k !== 'dark' && k !== 'light') {
      issues.push(`tokens: unknown field "${k}" (only dark and/or light allowed)`)
    }
  }

  const hasDark = tokens.dark !== undefined
  const hasLight = tokens.light !== undefined
  if (!hasDark && !hasLight) {
    issues.push('tokens: must contain at least one mode ("dark" and/or "light")')
    return issues
  }

  for (const scheme of ['dark', 'light'] as const) {
    if (tokens[scheme] === undefined) continue
    const modeVal = tokens[scheme]
    if (modeVal === null || typeof modeVal !== 'object' || Array.isArray(modeVal)) {
      issues.push(`tokens.${scheme}: must be an object of color mappings`)
      continue
    }

    const modeObj = modeVal as Record<string, unknown>
    // Validate all color leaves are valid #hex and check for unknown tokens
    const validateEntries = (obj: Record<string, unknown>, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          validateEntries(v as Record<string, unknown>, fullKey)
        } else if (typeof v === 'string') {
          if (!KNOWN_TOKEN_PATHS.has(fullKey)) {
            issues.push(`tokens.${scheme}.${fullKey}: unknown token path`)
          }
          if (!isValidHex(v)) {
            issues.push(`tokens.${scheme}.${fullKey}: must be a valid #hex colour (#rrggbb, #rrggbbaa, or #rgb), got ${JSON.stringify(v)}`)
          }
        } else {
          issues.push(`tokens.${scheme}.${fullKey}: value must be a #hex colour string`)
        }
      }
    }
    validateEntries(modeObj)

    // Contrast checking for this scheme
    for (const check of CHECKED_PAIRS) {
      const fg = getTokenValue(modeObj, check.fg)
      const bg = getTokenValue(modeObj, check.bg)
      if (!fg) {
        issues.push(`tokens.${scheme}: missing required token "${check.fg}" for contrast check`)
        continue
      }
      if (!bg) {
        issues.push(`tokens.${scheme}: missing required token "${check.bg}" for contrast check`)
        continue
      }
      if (!isValidHex(fg) || !isValidHex(bg)) continue
      try {
        const ratio = contrastRatio(fg, bg)
        const required = check.large ? AA_LARGE : AA_TEXT
        const rounded = Math.round(ratio * 100) / 100
        if (rounded < required) {
          issues.push(`contrast (${scheme}) ${check.pair} — ${rounded} < ${required} (WCAG AA)`)
        }
      } catch (err) {
        issues.push(`contrast (${scheme}) ${check.pair}: error calculating contrast — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return issues
}
