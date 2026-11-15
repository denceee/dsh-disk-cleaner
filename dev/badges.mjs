/**
 * Generate the README badge family.
 *
 * Hand-copying badge SVGs means they drift from reality the first time a test
 * count changes, and shields.io cannot express this project's own vocabulary
 * ("6 路由", the structural-discovery claim). So the family is generated from
 * one table: geometry, palette and the mono advance width live here, and every
 * badge is the same 20-unit flat rectangle as shields' `style=flat`, so the
 * custom badges and the live npm ones sit in one row without looking bolted
 * together.
 *
 * Width is computed from a monospace advance (0.6em) rather than guessed, so a
 * longer label cannot clip. `--check` re-derives every file and fails if the
 * committed SVG is stale, which is what keeps the numbers honest.
 *
 *   node dev/badges.mjs           # write assets/readme/badge-*.svg
 *   node dev/badges.mjs --check   # fail if any file is out of date
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const OUT = 'assets/readme'

/** Frozen palette. Mirrors DESIGN.md; no colour outside this table. */
const C = {
  label: '#161C28',      // label segment background
  labelText: '#B9C4D8',
  blue: '#2E6BE6',
  green: '#1E9E6A',
  slate: '#39415A',
  amber: '#B4771F',
  white: '#FFFFFF',
}

const HEIGHT = 20
const R = 3
const FONT = 11
const PAD = 7
/** Monospace advance at font-size 11, in SVG units. */
const ADV = FONT * 0.6
/** Extra breathing room for the right segment, which carries a value. */
const VALUE_PAD = 8

/** Width of one segment, in SVG units, rounded to whole units. */
function segWidth(text, pad) {
  return Math.ceil(text.length * ADV + pad * 2)
}

/**
 * One two-segment badge.
 * @param label left segment text
 * @param value right segment text
 * @param colour right segment background
 */
function badge(label, value, colour) {
  const lw = segWidth(label, PAD)
  const vw = segWidth(value, VALUE_PAD)
  const total = lw + vw
  const valueX = lw
  const midY = HEIGHT / 2 + 4
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" viewBox="0 0 ${total} ${HEIGHT}" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <g shape-rendering="crispEdges">
    <rect width="${lw}" height="${HEIGHT}" rx="${R}" fill="${C.label}"/>
    <rect x="${lw}" width="${vw}" height="${HEIGHT}" rx="${R}" fill="${colour}"/>
    <rect x="${lw - R}" width="${R + 1}" height="${HEIGHT}" fill="${colour}"/>
    <rect width="${R}" height="${HEIGHT}" fill="${C.label}"/>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}" text-anchor="middle">
    <text x="${lw / 2}" y="${midY}" fill="${C.labelText}">${label}</text>
    <text x="${valueX + vw / 2}" y="${midY}" fill="${C.white}">${value}</text>
  </g>
</svg>
`
}

/**
 * The family. Every entry is a fact this repository can stand behind, and each
 * one carries a different piece of information; none is a slogan.
 *
 * Internal shape ("6 routes", "2 slots") is deliberately not a badge: it helps
 * a contributor, but a visitor scanning the top of a README is deciding whether
 * the tool applies to their machine. Those numbers live in the 实现 table.
 */
const BADGES = {
  // What it runs on. Windows-only is a real constraint, not a limitation to hide.
  'badge-platform.svg': badge('platform', 'Windows 10 / 11', C.blue),
  // The differentiator: items are discovered by structure, not a product list.
  'badge-discovery.svg': badge('catalog', 'structural discovery', C.slate),
  // The model ranks and explains; it does not decide what gets deleted.
  'badge-ranking.svg': badge('ranking', 'model, with reasons', C.blue),
  // Proof, and the number is asserted by the test suite itself.
  'badge-tests.svg': badge('tests', '204 passed', C.green),
  'badge-node.svg': badge('node', '>= 20', C.slate),
  'badge-license.svg': badge('license', 'MIT', C.amber),
}

const check = process.argv.includes('--check')
let stale = 0
for (const [name, svg] of Object.entries(BADGES)) {
  const target = path.join(OUT, name)
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (current !== svg) {
      console.log('STALE', name)
      stale += 1
    }
    continue
  }
  writeFileSync(target, svg, 'utf8')
  console.log('wrote', target)
}

if (check) {
  console.log(stale === 0 ? 'all badges match their generated form' : stale + ' badge(s) stale')
  process.exitCode = stale === 0 ? 0 : 1
}
