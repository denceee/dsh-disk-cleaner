/**
 * Render README visual modules at their real GitHub content width.
 *
 * Judging an SVG by opening the file directly is misleading: a 1200-unit asset
 * shown in GitHub's ~900px column is scaled to 75%, and type that looked fine
 * at 1:1 becomes too small. This wraps each asset in a page at 900 CSS pixels
 * (and optionally 360 for the mobile check) so the screenshot shows what a
 * reader actually sees.
 *
 *   node dev/readme-preview.mjs [--width 900] [--asset hero]
 */

import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const widthArg = argv.indexOf('--width')
const width = widthArg >= 0 ? Number(argv[widthArg + 1]) : 900
const assetArg = argv.indexOf('--asset')
const only = assetArg >= 0 ? argv[assetArg + 1] : undefined

const ASSETS = [
  ['hero', 'assets/readme/hero.svg', '项目名与真实面板'],
  ['badges', 'assets/readme/hero.svg', 'placeholder'],
  ['flow', 'assets/readme/flow.svg', '四步流程'],
  ['safety', 'assets/readme/safety.svg', '五道护栏'],
]

const list = only === undefined
  ? ASSETS.filter(([, , label]) => label !== 'placeholder')
  : ASSETS.filter(([name]) => name === only)

const body = list.map(([name, src]) => `
  <section>
    <p class="cap">${name} · rendered at ${width}px</p>
    <img src="../${src}" width="${width}" alt="">
  </section>`).join('\n')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>readme @${width}</title>
<style>
  /* GitHub's own page colours, so contrast is judged against the real surface. */
  body{margin:0;padding:16px;background:#0d1117;font-family:"Segoe UI","PingFang SC",system-ui,sans-serif}
  section{margin-bottom:20px}
  .cap{font:600 11px ui-monospace,monospace;letter-spacing:.08em;color:#8b949e;margin:0 0 8px;text-transform:uppercase}
  img{display:block;height:auto}
</style></head>
<body>${body}
</body></html>`

writeFileSync('dev/readme-preview.html', html, 'utf8')
console.log('wrote dev/readme-preview.html (' + list.length + ' module(s) at ' + width + 'px)')
