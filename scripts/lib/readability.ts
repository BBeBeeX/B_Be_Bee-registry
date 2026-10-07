/**
 * Source-code readability gate for registry entries (music-sources/ and
 * lyric-sources/).
 *
 * 注册表的硬性规则（CONTRIBUTING.md §源码可读性）：提交的 `source.js` 必须是
 * 非加密、非混淆、人可读的源码。审核人只看源码；应用只消费 CI 编译出的 dist/。
 * 这里的检查是 CI 的第一道闸，不是替代人工审核——它的目标是用机器拦下明显
 * 不合格的提交（压缩 blob、字符串数组混淆、Node 都解析不了的脚本）。
 */

import vm from 'node:vm'

export interface ReadabilityIssue {
  rule: string
  message: string
}

const PACKER_SIGNATURES: { rule: string; re: RegExp; message: string }[] = [
  {
    rule: 'packer',
    re: /eval\(function\(p,\s*a,\s*c,\s*k,\s*e/,
    message: 'matches the classic "eval(function(p,a,c,k,e,...))" packer signature',
  },
  {
    rule: 'hex-identifiers',
    re: /_0x[0-9a-fA-F]{4,}/,
    message: 'contains `_0x…` hex identifiers typical of obfuscators',
  },
  {
    rule: 'eval-atob',
    re: /eval\s*\(\s*atob|atob\s*\(\s*eval|Function\s*\(\s*atob/,
    message: 'decodes a base64 payload and executes it (eval/atob/Function(atob))',
  },
  {
    rule: 'string-array-obfuscation',
    re: /var\s+(_0x\w+|\w+)\s*=\s*\[[^\]]{500,}\]\s*;\s*\(function\s*\(\s*\1\s*,/,
    message: 'looks like the string-array obfuscation pattern (big literal array + IIFE decoder)',
  },
]

/**
 * Checks one `source.js` payload. Returns every detected issue; an empty list
 * means the gate passed.
 */
export function readabilityIssues(js: string, filename = 'source.js'): ReadabilityIssue[] {
  const issues: ReadabilityIssue[] = []
  const at = (rule: string, message: string) => issues.push({ rule, message })

  const source = js.trim()
  if (!source) {
    at('empty', `${filename} is empty`)
    return issues
  }

  // 1. Node must be able to parse it at all. (vm.Script compiles without
  //    executing — a syntax error here means the sandbox will refuse it too.)
  try {
    new vm.Script(source, { filename })
  } catch (err) {
    at('parse', `${filename} is not parsable JavaScript: ${err instanceof Error ? err.message : String(err)}`)
    return issues
  }

  // 2. Obfuscation signatures.
  for (const { rule, re, message } of PACKER_SIGNATURES) {
    if (re.test(source)) at(rule, `${filename} ${message}`)
  }

  // 3. Minified-blob heuristics — only applied when the file is big enough
  //    for "compact" to mean "machine-written" rather than "short".
  const lines = source.split('\n')
  const codeLines = lines.filter((l) => l.trim().length > 0)
  const totalLength = source.length

  if (totalLength > 400) {
    if (codeLines.length < 3) {
      at('single-line-blob', `${filename} is ${totalLength} chars on ${codeLines.length} code line(s) — a minified blob, not readable source`)
    }
    const avgLineLength = Math.round(totalLength / Math.max(codeLines.length, 1))
    if (avgLineLength > 240) {
      at('avg-line-length', `${filename} averages ${avgLineLength} chars per line over ${codeLines.length} lines — looks minified (limit 240)`)
    }
    const longLines = codeLines.filter((l) => l.length > 1200).length
    if (longLines > Math.max(1, codeLines.length * 0.05)) {
      at('long-lines', `${filename} has ${longLines} lines over 1200 chars — looks machine-generated (limit ~5% of lines)`)
    }
  }

  // 4. Heavy \xNN escaping — obfuscators encode most strings this way.
  const escapeCount = (source.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length
  if (escapeCount > 30 && escapeCount > codeLines.length * 2) {
    at('hex-escapes', `${filename} contains ${escapeCount} \\xNN escapes — string-encoding obfuscation`)
  }

  // 5. Comments are required: the readable-source contract is that a human
  //    reviewer can follow intent, not just structure.
  if (!/(^|\n)\s*(\/\/|\/\*|\*)/.test(source)) {
    at('comments', `${filename} contains no comments — every registry entry must carry explanatory comments`)
  }

  return issues
}
