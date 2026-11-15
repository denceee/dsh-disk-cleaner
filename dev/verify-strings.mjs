/**
 * Diff the current client.js against the committed version, character by
 * character, and report only what actually changed.
 *
 * A repair that "runs" can still have silently altered a UI string, which is
 * exactly the failure this file exists to rule out after the encoding
 * incident. The committed version is read from git, so this compares against
 * the last known-good text rather than against my memory of it.
 *
 *   node dev/verify-strings.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const committed = execFileSync('git', ['show', 'HEAD:client.js'], { encoding: 'utf8' })
const current = readFileSync('client.js', 'utf8')

/** Every CJK-bearing string literal or JSX text run, in source order. */
function cjkRuns(text) {
  const runs = []
  for (const match of text.matchAll(/[\u3000-\u9fff\uff00-\uffef\u2026\u2192\u00b7]{2,}/g)) {
    runs.push(match[0])
  }
  return runs
}

const before = cjkRuns(committed)
const after = cjkRuns(current)

const beforeSet = new Map()
for (const run of before) beforeSet.set(run, (beforeSet.get(run) ?? 0) + 1)
const afterSet = new Map()
for (const run of after) afterSet.set(run, (afterSet.get(run) ?? 0) + 1)

const removed = []
const added = []
for (const [run, count] of beforeSet) {
  const now = afterSet.get(run) ?? 0
  if (now < count) removed.push(run + (count - now > 1 ? ' x' + (count - now) : ''))
}
for (const [run, count] of afterSet) {
  const was = beforeSet.get(run) ?? 0
  if (was < count) added.push(run + (count - was > 1 ? ' x' + (count - was) : ''))
}

console.log('CJK runs committed:', before.length, ' current:', after.length)
console.log('\nremoved or reduced (' + removed.length + '):')
for (const run of removed) console.log('  -', run)
console.log('\nadded or increased (' + added.length + '):')
for (const run of added) console.log('  +', run)

// A repaired file must not contain a replacement character anywhere.
if (current.includes('\uFFFD')) {
  console.log('\nFAIL: replacement characters remain')
  process.exitCode = 1
}

/**
 * The strings whose wording must be untouched by the encoding repair. Any of
 * these missing is a real regression, not an intended edit.
 */
const MUST_KEEP = [
  '\u78c1\u76d8\u6e05\u7406',           // 磁盘清理
  '\u5f00\u59cb\u626b\u63cf',           // 开始扫描
  '\u91cd\u65b0\u626b\u63cf',           // 重新扫描
  '\u6b63\u5728\u626b\u63cf\u78c1\u76d8\u2026',
  '\u6b63\u5728\u8ba9 AI \u5206\u6790\u6e05\u7406\u9879\u2026',
  '\u6b63\u5728\u6e05\u7406\u2026',
  '\u6e05\u7406\u9879',
  '\u5168\u9009',
  '\u6e05\u7406\u9009\u4e2d\u9879',
  '\u51fa\u9519\u4e86',
  '\u5f53\u524d\u65e0\u6743\u9650\u8bfb\u53d6',
  '\u672a\u5b8c\u6574\u7edf\u8ba1',
  '\u9700\u7ba1\u7406\u5458',
  '\u4ec5\u63d0\u793a',
  '\u5df2\u9009 ',
  '\u9884\u8ba1\u91ca\u653e ',
  '\u7528\u65f6 ',
]
const missing = MUST_KEEP.filter((snippet) => !current.includes(snippet))
if (missing.length > 0) {
  console.log('\nFAIL: lost required text:')
  for (const snippet of missing) console.log('  ', JSON.stringify(snippet))
  process.exitCode = 1
} else {
  console.log('\nall ' + MUST_KEEP.length + ' required strings present')
}
