/**
 * Visual QA harness: renders the real browser half of the panel through a
 * minimal hook runtime, serialises the tree to static HTML, and wraps it in a
 * stand-in of the host shell (sidebar + main) so the panel can be screenshotted
 * outside the GUI.
 *
 *   node dev/preview.mjs
 *   chrome --headless=new --screenshot=out.png --window-size=1440,1000 file:///.../dev/preview-light.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'client.js')

/* ------------------------------------------------- minimal React runtime -- */

let activeCtx = null

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  Fragment: 'Fragment',
  useRef(initial) {
    const ctx = activeCtx
    const slot = (ctx.hooks[ctx.index] ??= { kind: 'ref', value: { current: initial } })
    ctx.index += 1
    return slot.value
  },
  useState(initial) {
    const ctx = activeCtx
    const i = ctx.index
    ctx.index += 1
    if (ctx.hooks[i] === undefined) {
      ctx.hooks[i] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = ctx.hooks[i]
    const set = (next) => {
      const resolved = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(resolved, slot.value)) return
      slot.value = resolved
      ctx.dirty = true
    }
    return [slot.value, set]
  },
  useMemo(factory, deps) {
    const ctx = activeCtx
    const i = ctx.index
    ctx.index += 1
    const slot = ctx.hooks[i]
    if (slot === undefined || !sameDeps(slot.deps, deps)) {
      ctx.hooks[i] = { kind: 'memo', deps, value: factory() }
    }
    return ctx.hooks[i].value
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
  useEffect(fn, deps) {
    const ctx = activeCtx
    const i = ctx.index
    ctx.index += 1
    const slot = ctx.hooks[i]
    if (slot === undefined || !sameDeps(slot.deps, deps)) {
      ctx.hooks[i] = { kind: 'effect', deps, run: fn }
      ctx.pending.push(ctx.hooks[i])
    }
  },
  // The panel measures row boxes in a layout effect. The preview has no layout
  // engine, so it runs as an ordinary effect; the screenshots test appearance,
  // not the FLIP maths (which test/render.mjs asserts directly).
  useLayoutEffect(fn, deps) {
    React.useEffect(fn, deps)
  },
}

/* ------------------------------------------------------------ load client -- */

let factory = null
const styles = []

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      factory = definition.factory
    },
  },
  confirm: () => true,
  // PREVIEW_PICK lets a screenshot start from a stored model choice, which is
  // how the reasoning-effort select gets exercised without a live GUI.
  localStorage: {
    store: new Map(process.env.PREVIEW_PICK ? [['dsh-disk-cleaner:model', process.env.PREVIEW_PICK]] : []),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
  },
}

globalThis.document = {
  baseURI: 'http://127.0.0.1:3019/',
  head: {
    appendChild(node) {
      styles.push(node.textContent)
    },
  },
  documentElement: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
}

const source = readFileSync(CLIENT, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

const plugin = factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

/* --------------------------------------------------------------- fixtures -- */

const GB = 1024 ** 3
const MB = 1024 ** 2

const volumes = [
  { letter: 'C', root: 'C:\\', total: 476 * GB, free: 34.6 * GB, used: 441.4 * GB },
  { letter: 'D', root: 'D:\\', total: 931 * GB, free: 618.7 * GB, used: 312.3 * GB },
]

const scanFixture = {
  id: 'scan-preview',
  at: Date.now(),
  tookMs: 12400,
  platform: 'win32',
  volumes,
  breakdown: [
    {
      letter: 'C',
      rows: [
        { name: 'Users', path: 'C:\\Users', bytes: 152.4 * GB, truncated: false },
        { name: 'Windows', path: 'C:\\Windows', bytes: 121.8 * GB, truncated: false },
        { name: 'Program Files', path: 'C:\\Program Files', bytes: 78.2 * GB, truncated: false },
        { name: 'ProgramData', path: 'C:\\ProgramData', bytes: 41.6 * GB, truncated: false },
        { name: '其它', path: 'C:\\Other', bytes: 18.1 * GB, truncated: false },
      ],
      truncated: false,
    },
    {
      letter: 'D',
      rows: [
        { name: 'Projects', path: 'D:\\Projects', bytes: 186.3 * GB, truncated: false },
        { name: 'SteamLibrary', path: 'D:\\SteamLibrary', bytes: 94.7 * GB, truncated: true },
        { name: 'Models', path: 'D:\\Models', bytes: 26.4 * GB, truncated: false },
      ],
      truncated: true,
    },
  ],
  items: [
    { id: 'temp-user', label: '用户临时文件', detail: '%TEMP% · 1 个目录', risk: 'safe', admin: false, reportOnly: false, kind: 'cache', bytes: 3.4 * GB, files: 2841, truncated: false, paths: 1 },
    { id: 'browser-cache', label: '浏览器缓存', detail: 'Chrome / Edge 缓存目录', risk: 'safe', admin: false, reportOnly: false, kind: 'cache', bytes: 2.1 * GB, files: 6120, truncated: false, paths: 4 },
    { id: 'recycle', label: '回收站', detail: '清空各盘回收站', risk: 'caution', admin: false, reportOnly: false, kind: 'recycle', bytes: 11.8 * GB, files: 412, truncated: false, paths: 3 },
    { id: 'winget-cache', label: 'Windows 更新缓存', detail: 'C:\\Windows\\SoftwareDistribution\\Download', risk: 'caution', admin: true, reportOnly: false, kind: 'cache', bytes: 6.2 * GB, files: 934, truncated: false, paths: 1 },
    { id: 'big-iso', label: 'D:\\Downloads\\ubuntu-24.04-desktop-amd64.iso', detail: '单文件超过 1 GB', risk: 'caution', admin: false, reportOnly: false, kind: 'file', bytes: 5.7 * GB, files: 1, truncated: false, paths: 1 },
    { id: 'prefetch', label: 'Prefetch', detail: 'C:\\Windows\\Prefetch', risk: 'caution', admin: true, reportOnly: false, kind: 'cache', bytes: 0, files: 0, truncated: false, blocked: true, paths: 1 },
    { id: 'winsxs', label: '组件存储 WinSxS', detail: '需要 DISM 分析后才能清理', risk: 'advanced', admin: false, reportOnly: true, kind: 'cache', bytes: 75 * MB, files: 4, truncated: false, paths: 1 },
  ],
  bigFiles: [],
}

const analyzeFixture = {
  ai: true,
  model: 'qodercn/dfmodel',
  advice: '先清回收站与浏览器缓存，共约 13.9 GB；Windows 更新缓存需要管理员权限，建议随后单独处理。大文件 ubuntu ISO 若已装完系统可以直接删除。',
  items: [
    { id: 'recycle', reason: '单个体积最大，回收站清空可立即释放', priority: 1, recommended: true },
    { id: 'browser-cache', reason: '可安全重建，风险最低', priority: 2, recommended: true },
    { id: 'temp-user', reason: '程序运行中会占用部分文件，删除后无影响', priority: 3, recommended: true },
    { id: 'winget-cache', reason: '需要管理员权限，清理后更新会重新下载', priority: 4, recommended: false },
    { id: 'big-iso', reason: '确认系统安装完成后可删', priority: 5, recommended: false },
    { id: 'prefetch', reason: '当前进程无权限读取，跳过', priority: 6, recommended: false },
  ],
}

const cleanFixture = {
  freed: 12.4 * GB,
  results: [
    { id: 'recycle', label: '回收站', freed: 11.8 * GB, removed: 412, failed: 0, errors: [] },
    { id: 'browser-cache', label: '浏览器缓存', freed: 0.6 * GB, removed: 5120, failed: 2, errors: ['C:\\Users\\...\\Cache\\f_00012a: EBUSY'] },
    { id: 'temp-user', label: '用户临时文件', freed: 0, removed: 0, failed: 0, errors: [] },
  ],
}

/** Two providers, one model with reasoning efforts, one with a badge. */
const modelCatalog = {
  available: true,
  default: { provider: 'qodercn', model: 'dfmodel' },
  failures: [],
  groups: [
    {
      id: 'qodercn',
      name: 'QoderCN',
      models: [
        { id: 'dfmodel', name: 'DF Model', badge: '默认' },
        {
          id: 'dfmodel-pro',
          name: 'DF Model Pro',
          reasoning: {
            efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }],
            defaultEffort: 'medium',
          },
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    },
  ],
}

const STATE = process.argv[2] ?? 'ready'

globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/scan') && STATE === 'scanning') {
    // A scan that never comes back: the panel must still render its progress.
    await new Promise(() => {})
  }
  if (target.includes('/scan') && STATE === 'error') {
    return {
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: '无法访问磁盘 C:（拒绝访问）' }),
    }
  }
  const body = target.includes('/models')
    ? { ok: true, models: modelCatalog }
    : target.includes('/scan')
      ? { ok: true, scan: scanFixture }
      : target.includes('/analyze')
        ? { ok: true, analysis: analyzeFixture }
        : target.includes('/clean')
          ? { ok: true, ...cleanFixture }
          : target.includes('/volumes')
            ? { ok: true, volumes }
            : { ok: false, error: 'unexpected ' + target }
  return { ok: true, status: 200, json: async () => body }
}

/* --------------------------------------------------------------- host stub -- */

const registrations = new Map()
const ctx = {
  effect: (fn) => { const dispose = fn(); return () => dispose?.() },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (options, component) => {
      registrations.set(options.name + '#' + (options.id ?? options.key), component)
      return () => {}
    },
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => ZH[key] ?? key,
  },
}

const ZH = {
  'panel.title': '磁盘清理',
  'panel.subtitle': '扫描 C / D 盘的空间占用，AI 给出清理建议',
  'panel.scanned': '扫描完成',
  'panel.scan': '开始扫描',
  'panel.rescan': '重新扫描',
  'panel.scanning': '正在扫描磁盘…',
  'panel.analyzing': '正在让 AI 分析清理项…',
  'panel.scanHint': '首次扫描需要遍历目录，可能需要十几秒；完成后可逐个勾选清理项。',
  'panel.cleaning': '正在清理…',
  'panel.items': '清理项',
  'panel.selectAll': '全选',
  'panel.selectNone': '清空',
  'panel.clean': '清理选中项',
  'panel.error': '出错了',
  'panel.cleaned': '清理结果',
  'panel.noItems': '没有发现可清理的项目',
  'panel.nothingCleaned': '没有实际删除任何内容',
  'panel.emptyHint': '点击「开始扫描」分析磁盘占用',
  'panel.model': '模型',
  'panel.modelDefault': '默认模型',
  'panel.effort': '推理强度',
  'panel.effortShort': '强度',
  'panel.switched': '所选模型当前不可用，本次由 %s 排序。',
}

plugin.apply(ctx)
const Panel = registrations.get('main#disk-cleaner')

/* -------------------------------------------------------------- rendering -- */

function evaluate(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(evaluate)
  if (typeof node.type === 'function') return evaluate(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(evaluate) }
}

function paint(instance) {
  instance.index = 0
  instance.pending = []
  activeCtx = instance
  try {
    return evaluate(React.createElement(Panel, { t: (key) => ZH[key] ?? key }))
  } finally {
    activeCtx = null
  }
}

async function settle(instance, rounds = 60) {
  let tree = null
  for (let round = 0; round < rounds; round += 1) {
    instance.dirty = false
    tree = paint(instance)
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 40 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }
  return tree
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children ?? [], predicate, out)
  return out
}

async function render() {
  const instance = { hooks: [], index: 0, pending: [], dirty: false }
  // The empty state only exists before the auto-scan effect has run, so it is
  // the very first paint rather than a settled one.
  if (STATE === 'empty') return paint(instance)
  let tree = await settle(instance)
  if (STATE === 'result') {
    const cleanButton = findAll(tree, (node) => node.type === 'button')
      .find((button) => (button.children ?? []).includes('清理选中项'))
    if (cleanButton !== undefined) {
      cleanButton.props.onClick()
      tree = await settle(instance, 20)
    }
  }
  return tree
}

/* ------------------------------------------------------------ serialising -- */

const VOID = new Set(['input', 'img', 'br', 'hr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'stop'])
const BOOL = new Set(['checked', 'disabled', 'readonly', 'selected', 'multiple'])

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
}

function attribute(name, value) {
  if (value === null || value === undefined || value === false) return ''
  const key = name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name
  if (key === 'style') {
    if (value === null || typeof value !== 'object') return ''
    const css = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => k + ':' + v)
      .join(';')
    return css === '' ? '' : ' style="' + escapeHtml(css) + '"'
  }
  if (BOOL.has(key)) return value === true ? ' ' + key : ''
  if (typeof value === 'function') return ''
  return ' ' + key + '="' + escapeHtml(value) + '"'
}

function serialize(node, selectedValue) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map((child) => serialize(child, selectedValue)).join('')
  const tag = node.type
  const props = node.props ?? {}

  // A static page has no React state to drive <select>, so the chosen option is
  // marked explicitly; otherwise every screenshot would show the first entry.
  if (tag === 'select') {
    const value = props.value === undefined || props.value === null ? '' : String(props.value)
    const rest = Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'value'))
    const attrs = Object.entries(rest).map(([k, v]) => attribute(k, v)).join('')
    return '<select' + attrs + '>' + serialize(node.children ?? [], value) + '</select>'
  }
  if ((tag === 'option' || tag === 'optgroup') && selectedValue !== undefined) {
    const chosen = tag === 'option' && props.value !== undefined && String(props.value) === selectedValue
    const merged = chosen ? { ...props, selected: true } : props
    const attrs = Object.entries(merged).map(([k, v]) => attribute(k, v)).join('')
    return '<' + tag + attrs + '>' + serialize(node.children ?? [], selectedValue) + '</' + tag + '>'
  }

  const attrs = Object.entries(props).map(([k, v]) => attribute(k, v)).join('')
  // Self-close void elements. Inside <svg> the HTML parser only honours the
  // `<x />` form, so an unclosed <rect> would swallow its sibling paths.
  if (VOID.has(tag)) return '<' + tag + attrs + ' />'
  return '<' + tag + attrs + '>' + serialize(node.children ?? [], selectedValue) + '</' + tag + '>'
}

/* ------------------------------------------------------------------ shell -- */

const THEMES = {
  light: `
    --dsw-alias-bg-base:#f4f6fb;
    --dsw-alias-bg-layer-1:#ffffff;
    --dsw-alias-bg-layer-2:#eef1f8;
    --dsw-alias-label-primary:#101322;
    --dsw-alias-label-secondary:#5d6577;
    --dsw-alias-border-l1:#e2e6ef;
    --dsw-alias-border-l2:#cfd6e3;
    --dsw-alias-brand-primary:#4d6bfe;
    --dsw-alias-state-success-primary:#0f9d58;
    --dsw-alias-state-warn-primary:#c2760a;
    --dsw-alias-state-error-primary:#d21c3c;
    --shell-bg:#e8ecf5;
    --shell-text:#101322;
    --shell-sub:#6a7280;
  `,
  dark: `
    --dsw-alias-bg-base:#12141a;
    --dsw-alias-bg-layer-1:#1e222b;
    --dsw-alias-bg-layer-2:#262b36;
    --dsw-alias-label-primary:#e9ecf3;
    --dsw-alias-label-secondary:#98a1b2;
    --dsw-alias-border-l1:#2c313c;
    --dsw-alias-border-l2:#3b4250;
    --dsw-alias-brand-primary:#6b8afd;
    --dsw-alias-state-success-primary:#3ddc84;
    --dsw-alias-state-warn-primary:#f0a94c;
    --dsw-alias-state-error-primary:#ff5f7a;
    --shell-bg:#0c0e13;
    --shell-text:#e9ecf3;
    --shell-sub:#8b94a5;
  `,
}

const CSS = styles.join('\n')

function page(theme, panelHtml) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-disk-cleaner · ${theme}</title>
<style>
:root{${THEMES[theme]}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--shell-bg);color:var(--shell-text);font-family:"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;overflow:hidden}
.shell{display:grid;grid-template-columns:260px minmax(0,1fr);height:100vh}
.rail{border-right:1px solid var(--dsw-alias-border-l1);padding:18px 12px;display:flex;flex-direction:column;gap:6px;background:var(--shell-bg)}
.rail_brand{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--shell-sub);padding:0 8px 12px}
.rail_item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;color:var(--shell-sub);font-size:12.5px}
.rail_item.on{background:var(--dsw-alias-bg-layer-1);color:var(--shell-text);box-shadow:0 8px 18px -14px rgba(9,14,38,.6)}
.rail_dot{width:14px;height:14px;border-radius:5px;border:1.5px solid currentColor;opacity:.7}
.main{min-width:0;display:flex;flex-direction:column;height:100vh}
${CSS}
</style></head>
<body>
<div class="shell">
  <aside class="rail">
    <div class="rail_brand">DEEPSEEK HARNESS</div>
    <div class="rail_item"><span class="rail_dot"></span>会话</div>
    <div class="rail_item"><span class="rail_dot"></span>任务</div>
    <div class="rail_item on"><span class="rail_dot"></span>磁盘清理</div>
    <div class="rail_item"><span class="rail_dot"></span>技能</div>
    <div class="rail_item"><span class="rail_dot"></span>插件</div>
  </aside>
  <main class="main">${panelHtml}</main>
</div>
</body></html>`
}

const tree = await render()
const panelHtml = serialize(tree)
mkdirSync(here, { recursive: true })
const suffix = STATE === 'ready' ? '' : '-' + STATE
for (const theme of Object.keys(THEMES)) {
  const target = path.join(here, 'preview-' + theme + suffix + '.html')
  writeFileSync(target, page(theme, panelHtml), 'utf8')
  console.log('wrote ' + target)
}
console.log('state: ' + STATE + ' · panel bytes: ' + panelHtml.length)
// The scanning fixture keeps a request in flight on purpose; nothing else is
// pending, so the harness exits instead of waiting on it.
process.exit(0)
