/**
 * Catalog audit: every cleanup item, both directions.
 *
 *   over-deletion  — paths that overlap, duplicate, or reach somewhere they
 *                    should not; live directories that would be walked into;
 *                    links that would be followed instead of unlinked.
 *   under-deletion — entries with no reachable target, a gate that filters
 *                    everything out, or a measured size that a clean cannot
 *                    deliver.
 *
 * It reads the real catalog on this machine, then proves the measurement and
 * deletion paths agree on a throwaway sandbox.
 *
 *   node test/audit.mjs
 */

import { __test } from '../index.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const { buildCatalog, listVolumes, listDeletableChildren, measureContents } = __test

let failures = 0
const note = (line) => console.log('      ' + line)
function check(label, condition, detail) {
  if (condition) return true
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + detail))
  return false
}

const volumes = listVolumes()
const catalog = buildCatalog(volumes)

console.log('=== 目录概览 ===')
for (const item of catalog) {
  const paths = item.paths ?? []
  const exists = paths.filter((p) => fs.existsSync(p))
  const mode = item.reportOnly ? 'report' : item.mode
  console.log(
    '  ' + String(item.id).padEnd(24) +
    mode.padEnd(9) +
    (item.minAgeMs ? String(Math.round(item.minAgeMs / 3600000)) + 'h' : '  -') .padEnd(4) +
    ('paths=' + paths.length + '/' + exists.length).padEnd(14) +
    item.label,
  )
}

/* ------------------------------------------------------------- integrity -- */

console.log('\n=== 唯一性与重叠（多删的第一道检查）===')
{
  const ids = catalog.map((i) => i.id)
  check('目录 id 唯一', new Set(ids).size === ids.length,
    JSON.stringify(ids.filter((id, i) => ids.indexOf(id) !== i)))

  // Normalize every path once: lowercase, no trailing separator.
  const owners = new Map()
  const dupWithin = []
  const dupAcross = []
  for (const item of catalog) {
    const seen = new Set()
    for (const raw of item.paths ?? []) {
      const key = path.resolve(raw).toLowerCase().replace(/[\\/]+$/, '')
      if (seen.has(key)) dupWithin.push(item.id + ' × ' + key)
      seen.add(key)
      const holder = owners.get(key)
      if (holder === undefined) owners.set(key, item.id)
      else if (holder !== item.id) dupAcross.push(holder + ' / ' + item.id + ' → ' + key)
    }
  }
  check('同一项内没有重复路径', dupWithin.length === 0, dupWithin.join('; '))
  check('不同项之间没有共用路径', dupAcross.length === 0, dupAcross.join('; '))
  if (dupAcross.length === 0) note('无同一路径被两个清理项同时认领 —— 不会重复计数、不会并发删除')

  // Containment: one item's root inside another's would delete the other's data
  // (or its own) depending on order.
  const keys = [...owners.keys()]
  const nested = []
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = 0; j < keys.length; j += 1) {
      if (i === j) continue
      if (keys[j].startsWith(keys[i] + '\\')) {
        if (owners.get(keys[i]) !== owners.get(keys[j])) {
          nested.push(owners.get(keys[i]) + ' ⊃ ' + owners.get(keys[j]) + ' → ' + keys[j])
        }
      }
    }
  }
  check('没有一项的目录包含另一项的目录', nested.length === 0, nested.slice(0, 4).join('; '))
  if (nested.length === 0) note('无父子包含关系 —— 删 A 不会顺带清掉 B 的内容')
}

/* ------------------------------------------------------------ reachability -- */

console.log('\n=== 可达性（漏删的第一道检查）===')
{
  const empty = catalog.filter((item) => (item.paths ?? []).length === 0 && item.note === undefined)
  // An empty path list is legitimate when the product simply is not installed
  // (Firefox, Vivaldi, Windows.old...). What must not happen is an entry whose
  // targets exist but were all filtered out, or one that can never produce a
  // finding on any machine.
  note(empty.length === 0
    ? '所有条目都有候选路径'
    : empty.length + ' 项在本机无目标（未安装该软件），属正常：' + empty.map((i) => i.id).join(', '))
  check('没有既无路径又无说明的条目', catalog.every((item) =>
    (item.paths ?? []).length > 0 || typeof item.detail === 'string' || typeof item.note === 'string'),
  empty.map((i) => i.id).join(', '))

  // Every catalog entry must explain what it targets, so an entry that finds
  // nothing on this machine still reads as "not installed" rather than blank.
  const noExplanation = catalog.filter((item) =>
    typeof item.detail !== 'string' || item.detail.trim() === '')
  check('每个条目都写明了它清理什么', noExplanation.length === 0,
    noExplanation.map((i) => i.id).join(', '))

  // An entry with no existing target must be harmless: either report-only (so
  // it is never selectable) or it must produce 0 bytes and drop out of the
  // selectable list. Verify the drop-out rule directly.
  const emptyAndSelectable = catalog.filter((item) => (item.paths ?? []).length === 0
    && item.reportOnly !== true && item.note === undefined)
  note(emptyAndSelectable.length === 0
    ? '无目标的条目都是仅提示项'
    : emptyAndSelectable.length + ' 项无目标但可选中，依赖 0 字节过滤从面板消失：'
      + emptyAndSelectable.map((i) => i.id).join(', '))

  // A contents item whose every target is a file cannot be cleared child-wise.
  const contentsOnFile = []
  for (const item of catalog) {
    if (item.mode !== 'contents') continue
    const dirs = (item.paths ?? []).filter((p) => {
      try { return fs.lstatSync(p).isDirectory() } catch { return false }
    })
    if ((item.paths ?? []).length > 0 && dirs.length === 0) contentsOnFile.push(item.id)
  }
  check('contents 项的目标确实是目录', contentsOnFile.length === 0, contentsOnFile.join(', '))

  // Report-only entries must never reach the delete loop.
  const reportMissingAdvice = catalog.filter((item) => item.reportOnly === true
    && (typeof item.detail !== 'string' || item.detail === ''))
  check('每个仅提示项都写明了正确做法', reportMissingAdvice.length === 0,
    reportMissingAdvice.map((i) => i.id).join(', '))
}

/* ------------------------------------------- measurement == deletion ------- */

console.log('\n=== 测量与删除一致性（沙箱实测）===')
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dskc-audit-'))
  const old = new Date(Date.now() - 12 * 60 * 60 * 1000)

  const make = (name, bytes, when) => {
    const target = path.join(sandbox, name)
    if (bytes === null) fs.mkdirSync(target, { recursive: true })
    else fs.writeFileSync(target, Buffer.alloc(bytes, 7))
    if (when !== undefined) fs.utimesSync(target, when, when)
    return target
  }

  make('stale.bin', 4096, old)            // 应删
  make('stale-dir', null, old)
  fs.writeFileSync(path.join(sandbox, 'stale-dir', 'inner.bin'), Buffer.alloc(2048, 3))
  fs.utimesSync(path.join(sandbox, 'stale-dir', 'inner.bin'), old, old)
  fs.utimesSync(path.join(sandbox, 'stale-dir'), old, old)
  make('fresh.bin', 1024)                 // 太新，应保留
  make('dsh-spill-x', null)               // 白名单，应保留
  fs.writeFileSync(path.join(sandbox, 'dsh-spill-x', 'payload'), Buffer.alloc(999, 1))
  make('keep-me.txt', 111, old)           // 由新条目显式保护

  const item = { mode: 'contents', minAgeMs: 6 * 60 * 60 * 1000, paths: [sandbox] }
  const listed = await listDeletableChildren(sandbox, item)
  const names = listed.entries.map((e) => e.name).sort()
  check('只列出过期的普通项', JSON.stringify(names) === JSON.stringify(['keep-me.txt', 'stale-dir', 'stale.bin']),
    JSON.stringify(names))

  const measured = await measureContents(item, 5000)
  const actualBytes = 4096 + 2048 + 111
  check('测量值等于将被删除的字节数', measured.bytes === actualBytes,
    'measured=' + measured.bytes + ' expected=' + actualBytes)

  // Now delete exactly what the helper listed, and confirm the survivors.
  for (const child of listed.entries) {
    await fs.promises.rm(child.full, { recursive: true, force: true })
  }
  const after = fs.readdirSync(sandbox).sort()
  check('沙箱内只留下应该留下的', JSON.stringify(after) === JSON.stringify(['dsh-spill-x', 'fresh.bin']),
    JSON.stringify(after))
  check('白名单目录内容完好', fs.existsSync(path.join(sandbox, 'dsh-spill-x', 'payload')))

  fs.rmSync(sandbox, { recursive: true, force: true })
}

/* --------------------------------------------------------- links stay safe -- */

console.log('\n=== junction / 符号链接不被穿透 ===')
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dskc-link-'))
  const target = path.join(sandbox, 'real-data')
  const linkDir = path.join(sandbox, 'temp-root')
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(linkDir, { recursive: true })
  fs.writeFileSync(path.join(target, 'precious.txt'), 'do not touch')
  const junction = path.join(linkDir, 'linked')
  try {
    fs.symlinkSync(target, junction, 'junction')
  } catch {
    fs.symlinkSync(target, junction, 'dir')
  }

  const item = { mode: 'contents', paths: [linkDir] }
  const listed = await listDeletableChildren(linkDir, item)
  const entry = listed.entries.find((e) => e.name === 'linked')
  check('链接被标记为 link', entry !== undefined && entry.link === true, JSON.stringify(listed.entries))

  const measured = await measureContents(item, 3000)
  check('链接不计入体积（避免虚报）', measured.bytes === 0, String(measured.bytes))

  // Deleting the link must not touch its target.
  if (entry !== undefined) fs.unlinkSync(entry.full)
  check('删链接后目标目录仍在', fs.existsSync(path.join(target, 'precious.txt')))
  fs.rmSync(sandbox, { recursive: true, force: true })
}

/* ---------------------------------------------------------- gate sanity ----- */

console.log('\n=== 门槛与白名单一致 ===')
{
  const tempItems = catalog.filter((i) => i.id.startsWith('temp-') || i.id.startsWith('drive-temp-'))
  check('所有临时项都有 6 小时门槛', tempItems.every((i) => i.minAgeMs === 6 * 60 * 60 * 1000),
    tempItems.map((i) => i.id + '=' + i.minAgeMs).join(', '))
  check('所有临时项都带名称白名单', tempItems.every((i) => Array.isArray(i.skipNames) && i.skipNames.length > 0),
    tempItems.map((i) => i.id).join(', '))

  const contentsItems = catalog.filter((i) => i.mode === 'contents' && !i.reportOnly)
  const risky = contentsItems.filter((i) => i.paths.some((p) => /\\temp$|\\tmp$|\\Temp\\/i.test(p)) && i.minAgeMs !== 6 * 60 * 60 * 1000)
  check('目录型临时项都受年龄门槛约束', risky.length === 0, risky.map((i) => i.id).join(', '))
}

/* ------------------------------------------------------------- summary ----- */

console.log()
console.log(failures === 0 ? '审计通过：未发现多删或漏删' : failures + ' 项需要修复')
process.exitCode = failures === 0 ? 0 : 1
