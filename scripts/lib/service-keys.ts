/**
 * scripts/lib/service-keys.ts
 *
 * Allowlist of CORE Cordis service keys a plugin may declare in its registry
 * entry `services` field (the services the plugin `inject`s at runtime).
 * This is only the core half of the valid set: a key is also valid when
 * another registry entry declares it in `provides` — that cross-entry union
 * is resolved in scripts/lib/schemas.ts (collectProvidedServiceKeys).
 *
 * ── How to sync this list ──────────────────────────────────────────────
 * 1. In the BBeBee repo, list every key passed to `super(ctx, '<key>')` in
 *    Service subclasses (that string IS the injectable service key):
 *
 *      cd ~/workspace/BBeBeeX/BBeBee
 *      grep -rhoP "super[(]ctx,[[:space:]]*'[A-Za-z0-9_-]+'" \
 *        packages --include="*.ts" -r | grep -oP "'[A-Za-z0-9_-]+'$" \
 *        | tr -d "'" | sort -u
 *
 * 2. Add any new key to SERVICE_KEYS below (alphabetical order).
 * 3. Run `node scripts/validate.mjs --test` — it must stay green.
 *
 * ── Verified finding (2026-10-20) ──────────────────────────────────────
 * The allowlist is intentionally NOT derived from
 * `packages/protocol/src/services/*.ts` filenames. Verification against the
 * BBeBee source showed filenames do not match real keys:
 *   - `storage.ts` provides `store`, `db`, `secrets` (no `storage` key);
 *   - `registry.ts` provides `contentRegistry` (not `registry`);
 *   - `player`, `store`, `i18n`, `codec`, … have no protocol file at all;
 *   - real keys mix kebab-case (`plugin-manager`) and camelCase (`nowPlaying`),
 *     exactly as passed to `super(ctx, …)` — both spellings are kept verbatim.
 * A filename-derived list would have rejected the schema's own documented
 * example (`services: ["player", "store", "settings"]`), so ground truth is
 * the `super(ctx, '<key>')` grep above. Re-run it whenever BBeBee gains or
 * renames a service; protocol-declared-but-unimplemented keys (e.g. `share`,
 * `notify`, `shell`, `ws`, `crypto`) are deliberately excluded — a plugin
 * cannot depend on a service that has no provider.
 */

/** Injectable Cordis service keys, verified against BBeBee 2026-10-20. */
export const SERVICE_KEYS = [
  'audio',
  'audioConverter',
  'background',
  'cache',
  'codec',
  'contentRegistry',
  'db',
  'desktopLyrics',
  'device',
  'downloads',
  'dsp',
  'fs',
  'http',
  'i18n',
  'inspector',
  'js',
  'library',
  'logBuffer',
  'lyricSources',
  'lyrics',
  'mediaSession',
  'miniPlayer',
  'nowPlaying',
  'paths',
  'player',
  'plugin-manager',
  'registryMetadata',
  'scanner',
  'secrets',
  'securityAudit',
  'settings',
  'sleepTimer',
  'sourceLocal',
  'sources',
  'store',
  'theme',
  'ui',
  'visualizer',
] as const

const KEY_SET = new Set<string>(SERVICE_KEYS)

/** Returns true when `key` is a known injectable Cordis service key. */
export function isKnownServiceKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_SET.has(key)
}
