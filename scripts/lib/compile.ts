/**
 * COPIED FROM BBeBee main repo `scripts/sources/index.ts` @ ec1ca33 (2026-10-07),
 * trimmed to the single-entry surface a registry entry needs:
 *
 *   - `compileSource` — source.json + optional source.js → self-contained
 *     single-file JSON (music: script → `jsLib`; lyric: script → `script`).
 *   - `unpackSource` — the inverse, for the `--unpack` contributor workflow.
 *
 * 复用而非重写：编译产物的格式（键序、2 空格缩进、末尾换行、内联方式）必须与
 * 主仓 `pnpm build:sources` 逐字节一致——主仓经 submodule 消费本仓目录直接产出
 * fixtures，两边用同一份逻辑才能保证 dist/ 与 fixtures/ 语义等价。主仓编译逻辑
 * 变更时同步本文件并更新顶部提交号（见 CONTRIBUTING.md §校验）。
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { validateLyricSourceDocument, validateSourceDocument } from './source-validator.ts'

export interface CompileSourceOptions {
  /** Directory containing source.json and optional source.js */
  sourceDir: string
  /** Destination file path for compiled JSON. If omitted, file is not written. */
  outFile?: string
  /** Whether to run the validator. Defaults to true. */
  validate?: boolean
}

export interface UnpackSourceOptions {
  /** Path to the single-file source JSON to unpack */
  jsonFile: string
  /** Destination directory for the unpacked files */
  outDir: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Music source documents carry `sourceUrl` (required by their validator);
 * lyric source documents carry `id` + `script`. This is the doc-model split
 * the compiler and the output routing key on.
 */
export function isLyricSourceDoc(doc: Record<string, unknown>): boolean {
  return doc.sourceUrl === undefined
}

/**
 * Compiles a single source folder (source.json + optional source.js) into a
 * self-contained single-file JSON — a music `SourceDocument` (script →
 * `jsLib`) or a lyric `LyricSourceDefinition` (script → `script`).
 */
export async function compileSource(opts: CompileSourceOptions): Promise<string> {
  const dirName = basename(opts.sourceDir)

  // 1. Locate JSON definition: source.json, <dirName>.json, or source.meta.json
  const jsonCandidates = [
    join(opts.sourceDir, 'source.json'),
    join(opts.sourceDir, `${dirName}.json`),
    join(opts.sourceDir, 'source.meta.json'),
  ]

  let jsonPath: string | undefined
  for (const candidate of jsonCandidates) {
    if (await fileExists(candidate)) {
      jsonPath = candidate
      break
    }
  }

  if (!jsonPath) {
    throw new Error(`No source JSON found in ${opts.sourceDir}. Expected one of: source.json, ${dirName}.json`)
  }

  const rawJson = await readFile(jsonPath, 'utf8')
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(
      `Failed to parse JSON in ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  const lyric = isLyricSourceDoc(doc)
  const scriptField = lyric ? 'script' : 'jsLib'

  // 2. Locate optional JavaScript file: source.js or <dirName>.js
  const jsCandidates = [
    join(opts.sourceDir, 'source.js'),
    join(opts.sourceDir, `${dirName}.js`),
  ]

  let jsPath: string | undefined
  for (const candidate of jsCandidates) {
    if (await fileExists(candidate)) {
      jsPath = candidate
      break
    }
  }

  if (jsPath) {
    const jsContent = (await readFile(jsPath, 'utf8')).trim()
    if (jsContent.length > 0) {
      doc[scriptField] = jsContent
    }
  }

  // 3. Validate document with the validator for its doc model
  if (opts.validate !== false) {
    try {
      if (lyric) validateLyricSourceDocument(doc)
      else validateSourceDocument(doc)
    } catch (err) {
      throw new Error(
        `Validation failed for source in ${opts.sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  const outputContent = JSON.stringify(doc, null, 2) + '\n'

  // 4. Write output if requested
  if (opts.outFile) {
    await mkdir(resolve(opts.outFile, '..'), { recursive: true })
    await writeFile(opts.outFile, outputContent, 'utf8')
  }

  return outputContent
}

/**
 * Unpacks a single-file source JSON into source.json and optional source.js in
 * outDir — music documents carry `jsLib`, lyric documents `script`.
 */
export async function unpackSource(opts: UnpackSourceOptions): Promise<{ jsonFile: string; jsFile?: string }> {
  const raw = await readFile(opts.jsonFile, 'utf8')
  const doc = JSON.parse(raw) as Record<string, unknown>

  await mkdir(opts.outDir, { recursive: true })

  let jsFile: string | undefined
  for (const field of ['jsLib', 'script'] as const) {
    if (typeof doc[field] === 'string' && (doc[field] as string).trim().length > 0) {
      jsFile = join(opts.outDir, 'source.js')
      await writeFile(jsFile, (doc[field] as string).trim() + '\n', 'utf8')
      delete doc[field]
      break
    }
  }

  const jsonFile = join(opts.outDir, 'source.json')
  await writeFile(jsonFile, JSON.stringify(doc, null, 2) + '\n', 'utf8')

  return { jsonFile, jsFile }
}
