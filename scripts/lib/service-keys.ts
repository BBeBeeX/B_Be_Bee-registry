/**
 * scripts/lib/service-keys.ts
 *
 * Allowlist of CORE Cordis service keys a plugin may declare in its registry
 * entry `services` field (the services the plugin `inject`s at runtime).
 * This is only the core half of the valid set: a key is also valid when
 * another registry entry declares it in `provides` — that cross-entry union
 * is resolved in scripts/lib/schemas.ts (collectProvidedServiceKeys).
 *
 * ── Single source of truth ─────────────────────────────────────────────
 * The key set is NOT maintained in this repository. It is generated in the
 * BBeBee repo from the app's own plugin manifests (the union of
 * `contributes.services` over every `BBeBee.plugin.json`, plus the shell's
 * `SHELL_MANIFEST` declaration) and committed there as
 * `packages/protocol/service-keys.json`. This module reads a vendored copy
 * of that artifact (`scripts/lib/service-keys.generated.json`, next to
 * this file) — do not edit the vendored file by hand either.
 *
 *   Refresh the vendored copy:  node scripts/sync-service-keys.mjs
 *     (or offline:               node scripts/sync-service-keys.mjs --from <path-to-BBeBee>/packages/protocol/service-keys.json)
 *
 * `validate.mjs` additionally checks freshness when it can reach the
 * network: a vendored copy that provably differs from the upstream
 * artifact is an error; an upstream that answers 404 is also an error
 * (the generated file was moved or deleted — the source of truth is
 * gone, which must never pass silently); only a genuinely unreachable
 * network degrades to a warning.
 *
 * The artifact also carries `criticalKeys`: the subset of core keys
 * whose providers are security-critical (credentials, code execution,
 * the data layer, the plugin system itself…). Registry entries may
 * never claim a critical key in `provides` — see the provides gate in
 * scripts/lib/schemas.ts (validatePluginProvidesGate).
 *
 * ── Verified finding (2026-10-20), still load-bearing ──────────────────
 * The allowlist is intentionally NOT derived from
 * `packages/protocol/src/services/*.ts` filenames: filenames do not match
 * real keys (`storage.ts` provides `store`/`db`/`secrets`;
 * `registry.ts` provides `contentRegistry`). Ground truth is what
 * providers declare in their manifests, which is what the generator
 * reads. Keys with no provider anywhere (e.g. protocol-declared but
 * unimplemented `notify`, `shell`, `ws`, `crypto`) are absent from the
 * generated set and stay invalid — a plugin cannot depend on a service
 * that has no provider.
 */

import { readFileSync } from 'node:fs'

/** Canonical upstream artifact (BBeBee repo, main branch). Overridable for mirrors/tests. */
export const SERVICE_KEYS_UPSTREAM_URL =
  process.env.BBEBEE_SERVICE_KEYS_URL ??
  'https://raw.githubusercontent.com/BBeBeeX/BBeBee/main/packages/protocol/service-keys.json'

export interface ServiceKeysArtifact {
  serviceKeys: string[]
  criticalKeys: string[]
  providers: Record<string, string[]>
}

/** Shape of a Cordis service key (letter first, then letters/digits/hyphens). */
const SERVICE_KEY_FORMAT = /^[A-Za-z][A-Za-z0-9-]*$/

/**
 * Validates one key list of an artifact: must be an array of well-formed
 * service keys. Duplicates are dropped (order preserved); anything else
 * throws — a malformed allowlist must fail loudly, never silently
 * validate everything or nothing.
 */
function parseKeyList(value: unknown, field: string, origin: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`service-keys artifact from ${origin} has no valid "${field}" array`)
  }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const k of value) {
    if (typeof k !== 'string' || !SERVICE_KEY_FORMAT.test(k)) {
      throw new Error(
        `service-keys artifact from ${origin} has an invalid "${field}" entry ${JSON.stringify(k)}`,
      )
    }
    if (!seen.has(k)) {
      seen.add(k)
      keys.push(k)
    }
  }
  return keys
}

/**
 * Validates an unknown value as a service-keys artifact (the shape the
 * BBeBee generator emits and the vendored copy stores). Throws with the
 * origin named when the shape is wrong — a malformed allowlist must fail
 * loudly, never silently validate everything or nothing.
 */
export function parseServiceKeysArtifact(raw: unknown, origin: string): ServiceKeysArtifact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`service-keys artifact from ${origin} is not an object`)
  }
  const doc = raw as { serviceKeys?: unknown; criticalKeys?: unknown; providers?: unknown }
  const serviceKeys = parseKeyList(doc.serviceKeys, 'serviceKeys', origin)
  if (serviceKeys.length === 0) {
    throw new Error(`service-keys artifact from ${origin} has an empty "serviceKeys" list`)
  }
  // criticalKeys is optional for backward compatibility with artifacts
  // generated before it existed, but when present every critical key
  // must also be a member of the full key set.
  const criticalKeys =
    doc.criticalKeys === undefined ? [] : parseKeyList(doc.criticalKeys, 'criticalKeys', origin)
  const keySet = new Set(serviceKeys)
  for (const k of criticalKeys) {
    if (!keySet.has(k)) {
      throw new Error(
        `service-keys artifact from ${origin} lists critical key "${k}" that is not in "serviceKeys"`,
      )
    }
  }
  const providers: Record<string, string[]> = {}
  if (doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers)) {
    for (const [key, ids] of Object.entries(doc.providers as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        providers[key] = ids.filter((id): id is string => typeof id === 'string')
      }
    }
  }
  return { serviceKeys, criticalKeys, providers }
}

/** The vendored artifact this repository validates against. */
export function loadVendoredServiceKeysArtifact(): ServiceKeysArtifact {
  const url = new URL('./service-keys.generated.json', import.meta.url)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(url, 'utf8'))
  } catch (e) {
    throw new Error(
      `cannot read vendored service-keys artifact (scripts/lib/service-keys.generated.json): ${
        e instanceof Error ? e.message : String(e)
      } — run: node scripts/sync-service-keys.mjs`,
    )
  }
  return parseServiceKeysArtifact(parsed, 'scripts/lib/service-keys.generated.json')
}

/*
 * The vendored artifact is loaded at module scope, but a load failure is
 * deferred until first use: `sync-service-keys.mjs` imports this module
 * for its helpers precisely when the vendored file may not exist yet
 * (bootstrap), while validation must fail loudly — with the sync hint —
 * rather than silently treat every key as unknown.
 */
let vendoredArtifact: ServiceKeysArtifact | undefined
let vendoredLoadError: Error | undefined
try {
  vendoredArtifact = loadVendoredServiceKeysArtifact()
} catch (e) {
  vendoredLoadError = e instanceof Error ? e : new Error(String(e))
}

function requireVendoredArtifact(): ServiceKeysArtifact {
  if (!vendoredArtifact) {
    throw vendoredLoadError ?? new Error('vendored service-keys artifact unavailable')
  }
  return vendoredArtifact
}

/** Injectable Cordis service keys, generated in the BBeBee repo (see header). */
export const SERVICE_KEYS: readonly string[] = vendoredArtifact?.serviceKeys ?? []

const KEY_SET = new Set<string>(SERVICE_KEYS)

/** Returns true when `key` is a known injectable Cordis service key. */
export function isKnownServiceKey(key: unknown): key is string {
  requireVendoredArtifact()
  return typeof key === 'string' && KEY_SET.has(key)
}

/**
 * The critical subset of core keys (credentials, code execution, data
 * layer, plugin system…). Registry entries may never provide these;
 * their providers are builtin and locked on (see the provides gate).
 */
export const CRITICAL_SERVICE_KEYS: readonly string[] = vendoredArtifact?.criticalKeys ?? []

const CRITICAL_KEY_SET = new Set<string>(CRITICAL_SERVICE_KEYS)

/** Returns true when `key` is a critical core service key. */
export function isCriticalServiceKey(key: unknown): key is string {
  requireVendoredArtifact()
  return typeof key === 'string' && CRITICAL_KEY_SET.has(key)
}

export type ServiceKeysFreshness =
  | { status: 'fresh' }
  | {
      status: 'stale'
      added: string[]
      removed: string[]
      criticalAdded: string[]
      criticalRemoved: string[]
    }
  | { status: 'missing'; reason: string }
  | { status: 'unverifiable'; reason: string }

/**
 * Compares the vendored key sets (serviceKeys and criticalKeys) against
 * the upstream artifact in the BBeBee repo. Only a positively-known
 * difference is `stale`. An upstream 404 is reported separately as
 * `missing`: the generated source of truth was moved or deleted, which
 * callers must treat as an error rather than let the vendored copy age
 * in silence. A genuinely unreachable network or a malformed upstream
 * body degrades to `unverifiable`.
 */
export async function checkServiceKeysFreshness(): Promise<ServiceKeysFreshness> {
  requireVendoredArtifact()
  let res: Response
  try {
    res = await fetch(SERVICE_KEYS_UPSTREAM_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    const err = e as { name?: string; code?: string; cause?: { code?: string }; message?: string }
    const reason =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'timeout after 8s'
        : (err?.cause?.code ?? err?.code ?? err?.message ?? 'network error')
    return { status: 'unverifiable', reason: String(reason) }
  }
  if (res.status === 404) {
    return {
      status: 'missing',
      reason: `HTTP 404 from ${SERVICE_KEYS_UPSTREAM_URL} — the generated artifact is gone upstream`,
    }
  }
  if (!res.ok) {
    return { status: 'unverifiable', reason: `HTTP ${res.status} from ${SERVICE_KEYS_UPSTREAM_URL}` }
  }
  let upstream: ServiceKeysArtifact
  try {
    upstream = parseServiceKeysArtifact(await res.json(), SERVICE_KEYS_UPSTREAM_URL)
  } catch (e) {
    return {
      status: 'unverifiable',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
  const upstreamSet = new Set(upstream.serviceKeys)
  const added = upstream.serviceKeys.filter((k) => !KEY_SET.has(k))
  const removed = SERVICE_KEYS.filter((k) => !upstreamSet.has(k))
  const upstreamCritical = new Set(upstream.criticalKeys)
  const criticalAdded = upstream.criticalKeys.filter((k) => !CRITICAL_KEY_SET.has(k))
  const criticalRemoved = CRITICAL_SERVICE_KEYS.filter((k) => !upstreamCritical.has(k))
  if (added.length > 0 || removed.length > 0 || criticalAdded.length > 0 || criticalRemoved.length > 0) {
    return { status: 'stale', added, removed, criticalAdded, criticalRemoved }
  }
  return { status: 'fresh' }
}
