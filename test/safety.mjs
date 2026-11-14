/**
 * Regression tests for the safety guards, after the report that a pnpm clean
 * can break installed dsh plugins.
 *
 * These test the *decision* functions directly, so a run never deletes a real
 * file. A separate live probe at the end only reads.
 *
 *   node test/safety.mjs
 */

import { apply, __test } from '../index.js'

const { isSkippedTempName, isProgramArtifact, assertSafeTarget, DEFAULT_TEMP_SKIP } = __test

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + detail))
}

/* ------------------------------------------- 1. temp-name skip predicate ---- */

console.log('temp cleanup: which names survive')
{
  const keep = [
    'dsh-spill-JOngyS',
    'dsh-acl-skill-rWgiIR',
    'dsh',
    'dsh-purge-desktop.log',
    'node-compile-cache',
    'v8-compile-cache',
    'claude-shell-snapshot',
    'codex-session-42',
    'cursor-1a2b',
    'vscode-typescript1000',
    'jest_workers',
    'playwright_chromiumdev_profile-abc',
    'ms-playwright',
    'chrome_BITS_1234',
    'scoped_dir9876',
    'npm-1234-abcd',
    'pnpm-5678',
    'yarn--1700000000',
    'pip-build-env-xyz',
    'tmp123.log',
  ]
  for (const name of keep) {
    check('keeps ' + name, isSkippedTempName(name, DEFAULT_TEMP_SKIP) === true)
  }

  const drop = [
    '~DF3A1B.tmp',
    'wct1A2B.tmp',
    'some-installer-leftover',
    'CrashpadMetrics-abc',
    '4f2a1cbe-1111-2222-3333-444455556666',
    'unins000.exe.tmp',
  ]
  for (const name of drop) {
    check('may delete ' + name, isSkippedTempName(name, DEFAULT_TEMP_SKIP) === false)
  }

  check('matching is case-insensitive', isSkippedTempName('DSH-SPILL-ABC', DEFAULT_TEMP_SKIP) === true)
  check('an empty name is not skipped', isSkippedTempName('', DEFAULT_TEMP_SKIP) === false)
  check('an empty pattern list skips nothing', isSkippedTempName('dsh-spill', []) === false)
}

/* --------------------------------------- 2. program-artifact predicate ------ */

console.log('large files: what is never offered')
{
  const program = [
    'D:\\app\\resources\\app.asar',
    'D:\\Doubao\\Doubao_update\\Doubao.dll',
    'C:\\Program Files\\Foo\\foo.exe',
    'C:\\Program Files (x86)\\Bar\\bar.exe',
    'C:\\Windows\\System32\\drivers\\x.sys',
    'D:\\proj\\node_modules\\sharp\\build\\Release\\sharp.node',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Code\\Code.exe',
    'D:\\Weixin\\4.2.0.13\\RadiumWMPF.bin',
    'C:\\ProgramData\\Vendor\\data.dat',
    'D:\\app\\resources\\app\\main.js',
    'D:\\repo\\.git\\objects\\pack\\big.pack',
    'C:\\Users\\me\\.dsh\\profiles\\desktop\\store.json',
    'D:\\x\\lib.wasm',
    'D:\\x\\cache.sqlite',
    'D:\\x\\tool.jar',
  ]
  for (const file of program) {
    check('protects ' + file, isProgramArtifact(file) === true)
  }

  const user = [
    'D:\\backup\\project-source-backup.zip',
    'D:\\downloads\\movie.mkv',
    'D:\\data\\dump.sql',
    'C:\\Users\\me\\Videos\\clip.mp4',
    'D:\\backup\\photo-archive.7z',
    'D:\\data\\report.xlsx',
    'D:\\iso\\win11.iso',
    'D:\\workspace\\app\\dist\\bundle.js',
  ]
  for (const file of user) {
    check('still offers ' + file, isProgramArtifact(file) === false)
  }

  check('a dot in a directory name is not an extension', isProgramArtifact('D:\\my.folder\\notes') === false)
}

/* ---------------------------------------------- 3. delete-boundary targets -- */

console.log('delete boundary')
{
  const refused = [
    'C:\\',
    'D:\\',
    'C:\\Windows',
    'C:\\Windows\\System32',
    'C:\\Users',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\$RECYCLE.BIN',
    'relative\\path',
    '.\\here',
  ]
  for (const target of refused) {
    let threw = false
    try {
      assertSafeTarget(target)
    } catch {
      threw = true
    }
    check('refuses ' + JSON.stringify(target), threw)
  }

  const allowed = [
    'C:\\Windows\\Temp',
    'C:\\tmp',
    'C:\\Users\\me\\AppData\\Local\\Temp',
    'D:\\dump',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
  ]
  for (const target of allowed) {
    let ok = true
    let message = ''
    try {
      assertSafeTarget(target)
    } catch (error) {
      ok = false
      message = error instanceof Error ? error.message : String(error)
    }
    check('allows ' + target, ok, message)
  }

  check('the user home itself is refused', (() => {
    const home = process.env.USERPROFILE
    if (home === undefined) return true
    try {
      assertSafeTarget(home)
      return false
    } catch {
      return true
    }
  })())
}

/* ------------------------------------- 4. live catalog carries the fix ------ */

console.log('live catalog')
{
  const routes = new Map()
  apply({
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { const d = fn(); return () => d?.() },
    get: () => undefined,
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  })

  const out = { status: 0, payload: '' }
  const route = routes.get('/api/disk-cleaner/scan')
  await route.handler(
    {
      method: 'GET',
      headers: { host: '127.0.0.1:5055' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {},
    },
    { writeHead: (s) => { out.status = s }, end: (p) => { out.payload = p ?? '' } },
  )
  const scan = JSON.parse(out.payload).scan
  const byId = new Map(scan.items.map((item) => [item.id, item]))

  const store = byId.get('pnpm-store')
  check('pnpm store is present as advice', store !== undefined)
  check('pnpm store is report-only', store?.reportOnly === true)
  check('pnpm store names the safe command', /pnpm store prune/.test(store?.detail ?? ''))
  // The pnpm metadata cache is now part of the discovered Node toolchain group
  // rather than a hand-written entry, so check that it is still deletable there.
  const nodeGroup = byId.get('toolchain-node')
  check('the pnpm metadata cache stays deletable inside the Node group',
    nodeGroup !== undefined && nodeGroup.reportOnly !== true,
    JSON.stringify(nodeGroup?.label))

  const programFiles = scan.items.filter(
    (item) => item.kind === 'file' && /\.(exe|dll|asar|node|wasm|sys|pak|bin)$/i.test(item.label),
  )
  check('no program file is offered as deletable', programFiles.length === 0, JSON.stringify(programFiles.map((i) => i.label)))

  const ids = scan.items.map((item) => item.id)
  check('ids stay unique', new Set(ids).size === ids.length)
  check('every report-only item explains itself', scan.items.filter((i) => i.reportOnly).every((i) => typeof i.detail === 'string' && i.detail.length > 0))
}

console.log()
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
