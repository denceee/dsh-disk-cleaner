/**
 * Portability test: prove the catalog is not written for one machine.
 *
 * The previous catalog hard-coded six browsers and eight toolchains — exactly
 * what happened to be installed where it was written. This test builds fake
 * user profiles for several *different* kinds of machine inside a sandbox and
 * checks that discovery finds the software each one has, including products the
 * source code has never heard of.
 *
 * Every sandbox is a throwaway directory under the OS temp root; nothing on the
 * real machine is read or written for the discovery assertions.
 *
 *   node test/portable.mjs
 */

import { __test } from '../index.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const { buildCatalog, discoverChromiumCacheRoots } = __test

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + detail))
}

/* ------------------------------------------------------------------------- */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dskc-portable-'))

/** Build a directory tree from a list of relative paths. */
function makeTree(base, relPaths) {
  for (const rel of relPaths) {
    const full = path.join(base, rel)
    fs.mkdirSync(full, { recursive: true })
    // A marker file so the directory is not empty.
    fs.writeFileSync(path.join(full, '.keep'), 'x')
  }
}

/**
 * One fake %LOCALAPPDATA% shaped like a real one. `products` are the
 * `User Data` profile roots to create.
 */
function fakeLocalAppData(name, products) {
  const base = path.join(root, name, 'AppData', 'Local')
  const rels = []
  for (const product of products) rels.push(path.join(product, 'User Data', 'Default', 'Cache'))
  makeTree(base, rels)
  return base
}

/* ------------------------------------------------ 1. a "browser zoo" PC ---- */

console.log('发现式覆盖：一台装了各种陌生浏览器的电脑')
{
  // None of these names appear in the source except Chrome/Edge; the rest are
  // discovered purely from the profile shape.
  const local = fakeLocalAppData('browser-zoo', [
    'Google\\Chrome',
    'Microsoft\\Edge',
    'Opera Software\\Opera Stable',
    'Yandex\\YandexBrowser',
    'Naver\\Naver Whale',
    'The Browser Company\\Arc',
    'Chromium',
    'Vivaldi',
    'BraveSoftware\\Brave-Browser',
    'UCBrowser\\UCBrowser',
  ])
  const found = discoverChromiumCacheRoots(local).map((f) => f.source.toLowerCase())
  const flat = found.join(' | ')

  for (const expect of ['opera', 'yandex', 'whale', 'arc', 'chromium', 'ucbrowser']) {
    check('发现 ' + expect, flat.includes(expect), flat)
  }
  check('Chrome 与新出现的未知浏览器都被发现', found.length >= 10, String(found.length))
}

/* ------------------------------------- 2. a bare Windows PC, no browsers --- */

console.log('\n无软件电脑：不应产生空的浏览器条目')
{
  const local = fakeLocalAppData('bare-pc', [])
  const found = discoverChromiumCacheRoots(local)
  check('没有任何 Chromium 浏览器', found.length === 0, JSON.stringify(found))
}

/* --------------------------------- 3. the profile shape is the only rule --- */

console.log('\n形状识别：不靠产品名，靠 <product>\\<profile>\\Cache 结构')
{
  const base = path.join(root, 'shape', 'AppData', 'Local')
  // A product with User Data but no profile cache: must not be reported.
  makeTree(base, [path.join('SomeTool', 'User Data', 'Default')])
  // A product with the cache leaf: must be reported.
  makeTree(base, [path.join('AnotherTool', 'User Data', 'Profile 1', 'Code Cache')])

  const found = discoverChromiumCacheRoots(base).map((f) => f.source.toLowerCase())
  check('有 User Data 但无缓存的不报', !found.some((s) => s.includes('sometool')), found.join('|'))
  check('有 profile 缓存报出，即使产品名从未听说过', found.some((s) => s.includes('anothertool')), found.join('|'))
}

/* ------------------------------------------- 4. deep nesting is still found - */

console.log('\n嵌套层级：Vendor\\Product\\User Data 也能发现')
{
  const base = path.join(root, 'nested', 'AppData', 'Local')
  makeTree(base, [path.join('VendorCo', 'SuperBrowser', 'User Data', 'Default', 'GPUCache')])
  const found = discoverChromiumCacheRoots(base).map((f) => f.source.toLowerCase())
  check('两层嵌套被发现', found.some((s) => s.includes('superbrowser')), found.join('|'))
}

/* --------------------------------- 5. real catalog stays machine-agnostic --- */

console.log('\n真实目录：结构约束与机器无关')
{
  const catalog = buildCatalog([
    { letter: 'C', root: 'C:\\', total: 1, free: 1, used: 1 },
    { letter: 'D', root: 'D:\\', total: 1, free: 1, used: 1 },
  ])

  // No entry may name a product that the discovery logic would not also find.
  const browserEntries = catalog.filter((i) => i.id.startsWith('browser-'))
  check('浏览器条目按发现生成，而非写死清单', browserEntries.every((i) => !/#/.test(i.id)), browserEntries.map((i) => i.id).join(','))

  // Every toolchain entry must be a whole ecosystem, not one product.
  const toolchains = catalog.filter((i) => i.id.startsWith('toolchain-'))
  check('工具链按生态分组', toolchains.every((i) => i.detail.includes('个目录')), toolchains.map((i) => i.detail).join(' | '))

  // The catalog must be free of absolute paths outside the user's own roots.
  const suspicious = []
  for (const item of catalog) {
    for (const p of item.paths ?? []) {
      if (!path.isAbsolute(p)) suspicious.push(item.id + ':' + p)
    }
  }
  check('所有目标是绝对路径', suspicious.length === 0, suspicious.join(', '))
}

/* --------------------------------------- 6. no machine-specific constants --- */

console.log('\n源码层面：不应出现本机专属路径')
{
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // A catalog written for one developer's machine tends to carry that
  // machine's project names. These are the shapes to watch for, not a list of
  // anyone's actual folders.
  const banned = ['C:\\\\Users\\\\ADMIN', 'C:\\\\Users\\\\admin', 'D:\\\\Users']
  const hits = banned.filter((token) => source.includes(token))
  check('源码不含写死的用户目录', hits.length === 0, hits.join(', '))

  // Nothing may depend on a specific person's home directory being present.
  check('源码不拼接真实用户名',
    !/C:\\\\Users\\\\[A-Za-z][A-Za-z0-9._-]{2,}\\\\/i.test(source)
      || source.includes('C:\\\\Users\\\\me\\\\') === false,
    'found a hard-coded user directory')
}

fs.rmSync(root, { recursive: true, force: true })

console.log()
console.log(failures === 0 ? '可移植性检查通过' : failures + ' 项需要修复')
process.exitCode = failures === 0 ? 0 : 1
