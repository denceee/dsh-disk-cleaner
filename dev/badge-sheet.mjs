/**
 * Render the badge family at 1:1 into a PNG for visual review.
 *
 * The badges are tiny (20 units tall), so reviewing them inside a full README
 * screenshot would judge them at the wrong size. This builds an HTML contact
 * sheet with every badge at its true pixel size on both GitHub backgrounds, and
 * the caller screenshots it.
 *
 *   node dev/badge-sheet.mjs && chrome --headless --screenshot=...
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const OUT = 'assets/readme'
const names = readdirSync(OUT).filter((name) => name.startsWith('badge-') && name.endsWith('.svg')).sort()

const row = names.map((name) => `<img src="../${OUT}/${name}" alt="${name}">`).join('')
const template = readFileSync('dev/badge-preview-template.html', 'utf8')
writeFileSync('dev/badge-sheet.html', template.replaceAll('__ROW__', row).replace('__MODE__', 'light'), 'utf8')
console.log('wrote dev/badge-sheet.html with', names.length, 'badges')
