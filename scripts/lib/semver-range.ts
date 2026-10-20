/**
 * scripts/lib/semver-range.ts
 *
 * Minimal hand-written semver range parser — zero npm dependencies
 * (registry scripts must run on pure Node builtins; see validate.mjs header).
 *
 * Supported range grammar (a strict subset of npm semver):
 *   "*"                       any version
 *   "1.2.3" | "=1.2.3"        exact version
 *   "^1.2.3"                  compatible (>=1.2.3, <2.0.0; ^0.x.y rules apply)
 *   "~1.2.3"                  tilde (>=1.2.3, <1.3.0)
 *   ">=1.2.3" "<2.0.0"        comparators, space-separated = AND
 *   ">=1.0.0 <2.0.0"          compound AND
 *   ">=1.0.0 <2.0.0 || >=3.0.0"  OR groups
 *
 * NOT supported (rejected as invalid): hyphen ranges ("1.2.3 - 2.0.0"),
 * partial wildcards ("1.2.x"), "v" prefixes, prerelease tags in ranges.
 * Versions themselves must be full "major.minor.patch" (build metadata is
 * stripped before comparison; prerelease versions never satisfy a range
 * unless the range itself mentions a prerelease — same as npm).
 */

export type SemverTuple = [number, number, number]

interface Comparator {
  op: '>=' | '<=' | '>' | '<' | '='
  version: SemverTuple
  /** True when the comparator text carried a prerelease tag. */
  hasPrerelease: boolean
}

export type SemverRange = Comparator[][] // OR of AND-groups

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses "1.2.3[-prerelease][+build]" → tuple + prerelease flag, or null. */
export function parseVersion(text: string): { tuple: SemverTuple; prerelease: string | null } | null {
  const m = text.trim().match(VERSION)
  if (!m) return null
  return {
    tuple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? null,
  }
}

function compareTuples(a: SemverTuple, b: SemverTuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

/** Expands one comparator token ("^1.2.3", ">=1.0.0", "1.2.3", …) or null. */
function parseToken(token: string): Comparator[] | null {
  if (token === '' || token === '*') return [] // matches everything

  const m = token.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/)
  if (!m) return null
  const op = m[1] ?? ''
  const parsed = parseVersion(m[2]!)
  if (!parsed) return null
  const { tuple, prerelease } = parsed
  const hasPrerelease = prerelease !== null

  switch (op) {
    case '':
    case '=':
      return [{ op: '=', version: tuple, hasPrerelease }]
    case '^': {
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0 ; ^0.0.3 := =0.0.3
      const upper: SemverTuple =
        tuple[0]! > 0
          ? [tuple[0]! + 1, 0, 0]
          : tuple[1]! > 0
            ? [0, tuple[1]! + 1, 0]
            : [0, 0, tuple[2]! + 1]
      return [
        { op: '>=', version: tuple, hasPrerelease },
        { op: '<', version: upper, hasPrerelease: false },
      ]
    }
    case '~':
      return [
        { op: '>=', version: tuple, hasPrerelease },
        { op: '<', version: [tuple[0]!, tuple[1]! + 1, 0], hasPrerelease: false },
      ]
    case '>=':
    case '<=':
    case '>':
    case '<':
      return [{ op, version: tuple, hasPrerelease }]
    default:
      return null
  }
}

/**
 * Parses a range string. Returns null when the range is not in the
 * supported grammar. An empty/whitespace range is invalid (use "*").
 */
export function parseRange(range: string): SemverRange | null {
  if (typeof range !== 'string') return null
  const orGroups = range.split('||').map((g) => g.trim())
  if (orGroups.some((g) => g === '')) return null

  const parsed: SemverRange = []
  for (const group of orGroups) {
    const tokens = group.split(/\s+/).filter((t) => t.length > 0)
    const comparators: Comparator[] = []
    for (const token of tokens) {
      const cs = parseToken(token)
      if (cs === null) return null
      comparators.push(...cs)
    }
    parsed.push(comparators)
  }
  return parsed.length > 0 ? parsed : null
}

/** True when `range` is syntactically valid in the supported grammar. */
export function isValidRange(range: string): boolean {
  return parseRange(range) !== null
}

/**
 * True when `version` satisfies the parsed range. Versions with a
 * prerelease tag only satisfy ranges that themselves mention a prerelease
 * (npm semantics).
 */
export function satisfiesRange(version: string, range: SemverRange): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const { tuple, prerelease } = parsed

  return range.some((group) => {
    if (prerelease !== null && !group.some((c) => c.hasPrerelease)) return false
    return group.every((c) => {
      const cmp = compareTuples(tuple, c.version)
      switch (c.op) {
        case '=':
          return cmp === 0
        case '>=':
          return cmp >= 0
        case '<=':
          return cmp <= 0
        case '>':
          return cmp > 0
        case '<':
          return cmp < 0
      }
    })
  })
}

/** Convenience: parse + test in one call; false on invalid input. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseRange(range)
  return parsed !== null && satisfiesRange(version, parsed)
}
