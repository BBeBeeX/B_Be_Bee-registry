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
 * artifact is an error; an unreachable or unpublished upstream degrades
 * to a warning, exactly like the other connectivity checks.
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
  providers: Record<string, string[]>
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
  const doc = raw as { serviceKeys?: unknown; providers?: unknown }
  if (
    !Array.isArray(doc.serviceKeys) ||
    doc.serviceKeys.some((k) => typeof k !== 'string' || !k)
  ) {
    throw new Error(`service-keys artifact from ${origin} has no valid "serviceKeys" string array`)
  }
  const providers: Record<string, string[]> = {}
  if (doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers)) {
    for (const [key, ids] of Object.entries(doc.providers as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        providers[key] = ids.filter((id): id is string => typeof id === 'string')
      }
    }
  }
  return { serviceKeys: [...(doc.serviceKeys as string[])], providers }
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

export type ServiceKeysFreshness =
  | { status: 'fresh' }
  | { status: 'stale'; added: string[]; removed: string[] }
  | { status: 'unverifiable'; reason: string }

/**
 * Compares the vendored key set against the upstream artifact in the
 * BBeBee repo. Only a positively-known difference is `stale`: an
 * unreachable network, an unpublished/moved upstream file (HTTP error),
 * or a malformed upstream body all degrade to `unverifiable`, mirroring
 * how validate.mjs treats connectivity failures elsewhere.
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
  if (added.length > 0 || removed.length > 0) return { status: 'stale', added, removed }
  return { status: 'fresh' }
}
