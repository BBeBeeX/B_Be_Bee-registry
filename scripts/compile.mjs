#!/usr/bin/env node
/**
 * scripts/compile.mjs — 把 music-sources/ 与 lyric-sources/ 的每个条目编译为
 * dist/ 下的单文件 JSON：music 文档把 source.js 内联为 `jsLib`，lyric 文档内联
 * 为 `script`。输出 = JSON.stringify(doc, null, 2) + '\n'，与主仓
 * `pnpm build:sources` 产物逐字节一致（编译逻辑复用 lib/compile.ts）。
 *
 *   node scripts/compile.mjs                          # 全量编译 → dist/
 *   node scripts/compile.mjs --unpack <jsonFile> [destDir]
 *       # 把单文件产物反解回 source.json + source.js（默认 destDir =
 *       # music-sources/unpacked；建议解到仓库根 unpacked/，已被 .gitignore 忽略，
 *       # 否则 unpacked 目录会被当成一个条目目录而被 validate.mjs 拒绝）
 *
 * 零 npm 依赖；用 plain node 运行（.ts 经类型擦除直接加载）。
 */
import { readdir, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource, unpackSource } from './lib/compile.ts'
import { KINDS, scanEntryDirs } from './lib/registry-model.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => relative(repoRoot, p) || '.'

function usage() {
  console.error('usage: node scripts/compile.mjs [--unpack <jsonFile> [destDir]]')
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv[0] === '--unpack') {
    const jsonFile = argv[1]
    if (!jsonFile || argv.length > 3) {
      usage()
      process.exitCode = 1
      return
    }
    const outDir = resolve(repoRoot, argv[2] ?? 'music-sources/unpacked')
    const result = await unpackSource({ jsonFile: resolve(repoRoot, jsonFile), outDir })
    console.log(`unpacked ${rel(resolve(repoRoot, jsonFile))}`)
    console.log(`  -> ${rel(result.jsonFile)}`)
    if (result.jsFile) console.log(`  -> ${rel(result.jsFile)}`)
    return
  }

  if (argv.length > 0) {
    usage()
    process.exitCode = 1
    return
  }

  let failures = 0
  for (const spec of KINDS) {
    if (!spec.distDir) continue
    const names = await scanEntryDirs(join(repoRoot, spec.dir))
    for (const name of names) {
      const outFile = join(repoRoot, spec.distDir, `${name}.json`)
      try {
        await compileSource({
          sourceDir: join(repoRoot, spec.dir, name),
          outFile,
          validate: true,
        })
        console.log(`compiled ${spec.dir}/${name} -> ${spec.distDir}/${name}.json`)
      } catch (err) {
        failures++
        console.error(`FAILED ${spec.dir}/${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 条目目录被删除后 dist/ 里会留下孤儿产物；CI 的 git diff 与 validate.mjs 的
  // 字节比对都要求 dist 与条目一一对应，这里顺手清掉。
  for (const spec of KINDS) {
    if (!spec.distDir) continue
    const distDir = join(repoRoot, spec.distDir)
    const names = new Set(await scanEntryDirs(join(repoRoot, spec.dir)))
    const files = await readdir(distDir, { withFileTypes: true }).catch(() => [])
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue
      if (!names.has(f.name.slice(0, -'.json'.length))) {
        await rm(join(distDir, f.name))
        console.log(`pruned stale ${spec.distDir}/${f.name}`)
      }
    }
  }

  if (failures > 0) {
    console.error(`${failures} entry(ies) failed to compile`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
