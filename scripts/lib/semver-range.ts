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
 * partial wildcards ("1.2.x"), "v" prefixes.
 * Versions themselves must be full "major.minor.patch" (build metadata
 * is stripped before comparison). Prerelease tags ARE supported, in
 * versions and in range comparators, with semver ordering: a release
 * outranks its own prereleases ("1.2.3-alpha" < "1.2.3"), and two
 * prereleases on the same tuple compare identifier by identifier.
 * Admission gate (npm's prerelease rule): a prerelease version only
 * satisfies a comparator group that contains a comparator on the same
 * [major, minor, patch] tuple — so "1.2.3-alpha" satisfies "<1.2.3"
 * and ">=1.2.3-alpha", but not "^1.0.0".
 */

export type SemverTuple = [number, number, number]

interface Comparator {
  op: '>=' | '<=' | '>' | '<' | '='
  version: SemverTuple
  /** The comparator's prerelease tag, or null for a plain release. */
  prerelease: string | null
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

const NUMERIC_ID = /^\d+$/

/**
 * Compares two prerelease tags per semver §11: a plain release (null)
 * outranks every prerelease; otherwise identifiers compare dot-by-dot —
 * numeric identifiers numerically and below alphanumeric ones, and a
 * shorter identifier list ranks below a longer one it prefixes.
 */
function comparePrereleases(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (i >= as.length) return -1
    if (i >= bs.length) return 1
    const x = as[i]!
    const y = bs[i]!
    if (x === y) continue
    const xNum = NUMERIC_ID.test(x)
    const yNum = NUMERIC_ID.test(y)
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Full version comparison: tuple first, then prerelease ordering. */
function compareVersions(
  a: { tuple: SemverTuple; prerelease: string | null },
  b: { tuple: SemverTuple; prerelease: string | null },
): number {
  const t = compareTuples(a.tuple, b.tuple)
  return t !== 0 ? t : comparePrereleases(a.prerelease, b.prerelease)
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

  switch (op) {
    case '':
    case '=':
      return [{ op: '=', version: tuple, prerelease }]
    case '^': {
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0 ; ^0.0.3 := =0.0.3
      const upper: SemverTuple =
        tuple[0]! > 0
          ? [tuple[0]! + 1, 0, 0]
          : tuple[1]! > 0
            ? [0, tuple[1]! + 1, 0]
            : [0, 0, tuple[2]! + 1]
      return [
        { op: '>=', version: tuple, prerelease },
        { op: '<', version: upper, prerelease: null },
      ]
    }
    case '~':
      return [
        { op: '>=', version: tuple, prerelease },
        { op: '<', version: [tuple[0]!, tuple[1]! + 1, 0], prerelease: null },
      ]
    case '>=':
    case '<=':
    case '>':
    case '<':
      return [{ op, version: tuple, prerelease }]
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
 * True when `version` satisfies the parsed range. Prerelease versions
 * are admitted only into a comparator group that contains a comparator
 * on the same [major, minor, patch] tuple (npm's prerelease rule), and
 * comparisons use full semver ordering, prerelease tags included.
 */
export function satisfiesRange(version: string, range: SemverRange): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return range.some((group) => {
    if (
      parsed.prerelease !== null &&
      !group.some((c) => compareTuples(c.version, parsed.tuple) === 0)
    ) {
      return false
    }
    return group.every((c) => {
      const cmp = compareVersions(parsed, { tuple: c.version, prerelease: c.prerelease })
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
