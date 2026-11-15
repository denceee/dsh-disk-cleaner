/**
 * Keep the README's claims and its generated badges from drifting apart.
 *
 * The badges state facts the repository asserts elsewhere: a test count, a
 * route count, the minimum Node version. Hand-edited badges rot silently the
 * first time someone adds a test, and a stale "204 passed" is worse than no
 * badge at all. This reads the sources of truth and fails when they disagree.
 *
 *   node dev/check-claims.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const problems = []
const note = (message) => problems.push(message)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const readme = readFileSync('README.md', 'utf8')

/**
 * Total assertions, counted the way the suite prints them.
 *
 * Each suite ends with its own success line, and two of them are written in
 * Chinese, so the exit code is the reliable signal; the assertion count comes
 * from the `ok`/`FAIL` lines every suite emits.
 */
const SUITES = ['render', 'models', 'guards', 'safety', 'portable']
let total = 0
for (const suite of SUITES) {
  let out
  try {
    out = execFileSync('node', ['test/' + suite + '.mjs'], { encoding: 'utf8' })
  } catch {
    note(suite + '.mjs exited non-zero')
    continue
  }
  const count = (out.match(/^\s+(ok|FAIL)\s/gm) ?? []).length
  total += count
}

/** The four places the total is published. */
if (!readme.includes('test/render.mjs')) note('README lost the test command list')
const badgeTests = readFileSync('assets/readme/badge-tests.svg', 'utf8')
if (!badgeTests.includes(String(total) + ' passed')) {
  note('badge-tests.svg says something other than ' + total + ' passed; run dev/badges.mjs')
}
// The README prose also states the total twice; both must agree with reality.
for (const match of readme.matchAll(/(\d+)\s*\u9879\u65ad\u8a00/g)) {
  if (Number(match[1]) !== total) note('README \u9879\u65ad\u8a00 says ' + match[1] + ', suites report ' + total)
}
for (const match of readme.matchAll(/tests-(\d+)%20passed/g)) {
  if (Number(match[1]) !== total) note('badge URL says ' + match[1] + ', suites report ' + total)
}

/** Route count: `host` in the 实现 table and the hero metadata line. */
const routes = (readFileSync('index.js', 'utf8').match(/route\('(GET|POST)'/g) ?? []).length
for (const match of readme.matchAll(/(\d+)\s*\u6761\u8def\u7531/g)) {
  if (Number(match[1]) !== routes) note('README says ' + match[1] + ' routes, index.js mounts ' + routes)
}
for (const match of readme.matchAll(/(\d+)\s*host routes/g)) {
  if (Number(match[1]) !== routes) note('hero metadata says ' + match[1] + ' host routes, index.js mounts ' + routes)
}
const hero = readFileSync('assets/readme/hero.svg', 'utf8')
for (const match of hero.matchAll(/(\d+)\s*host routes/g)) {
  if (Number(match[1]) !== routes) note('hero.svg says ' + match[1] + ' host routes, index.js mounts ' + routes)
}
for (const match of hero.matchAll(/(\d+)\s*assertions/g)) {
  if (Number(match[1]) !== total) note('hero.svg says ' + match[1] + ' assertions, suites report ' + total)
}

/**
 * Node floor: one value, in package.json and the badge. The badge renders the
 * comparison operator as its own text run, so compare the version only.
 */
const engine = String(pkg.engines?.node ?? '')
const floor = engine.replace(/[^0-9.]/g, '')
const badgeNode = readFileSync('assets/readme/badge-node.svg', 'utf8')
if (floor !== '' && !badgeNode.includes(' ' + floor + '<')) {
  note('badge-node.svg does not state >= ' + floor + ' (package.json engines)')
}

/**
 * Every storage figure shown in the hero and flow must appear in the README
 * prose, because the images claim to depict a real scan. A number that exists
 * only inside an SVG is fabricated precision: it cannot be checked by anyone
 * reading the page.
 *
 * Alt text is stripped first, on purpose. The alt describes the image, so
 * counting it as a source would let an image certify its own figure: the same
 * wrong number pasted into both would look consistent while remaining wrong.
 */
const SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB)\b/g
const prose = readme.replace(/alt="[^"]*"/g, '')
const readmeSizes = new Set([...prose.matchAll(SIZE)].map((m) => m[1] + ' ' + m[2]))
for (const [name, source] of [['hero.svg', hero], ['flow.svg', readFileSync('assets/readme/flow.svg', 'utf8')]]) {
  for (const match of source.matchAll(SIZE)) {
    const figure = match[1] + ' ' + match[2]
    // Canvas geometry and threshold constants are not scan results.
    if (Number(match[1]) >= 200) continue
    if (!readmeSizes.has(figure)) note(name + ' shows ' + figure + ' but the README never states it')
  }
}

console.log('assertions: ' + total + ' · routes: ' + routes + ' · node: ' + (floor || 'unset'))
if (problems.length === 0) {
  console.log('all published claims match their sources')
} else {
  for (const problem of problems) console.log('MISMATCH ' + problem)
  process.exitCode = 1
}
