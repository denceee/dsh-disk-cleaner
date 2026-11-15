/**
 * Panel render test: loads the real browser half, mounts the real component
 * through a minimal hook runtime, and drives the full flow — auto scan, model
 * ranking, checkbox selection, clean — against a stubbed `fetch`.
 *
 * A component that throws blanks the whole slot in the GUI, so this is the
 * cheapest way to prove the panel renders in each of its states.
 *
 *   node test/render.mjs
 */

import { readFileSync } from 'node:fs'
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
      ctx.hooks[i] = { kind: 'effect', deps, run: fn, cleanups: [] }
      ctx.pending.push(ctx.hooks[i])
    }
  },
  // The real component measures layout in a layout effect, because FLIP has to
  // read old and new boxes in the same frame. There is no DOM here, so it is
  // the same bookkeeping as useEffect; the FLIP behaviour is asserted
  // separately with fake nodes.
  useLayoutEffect(fn, deps) {
    React.useEffect(fn, deps)
  },
}

/* ------------------------------------------------------------- load client -- */

let factory = null
const listeners = []

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      factory = definition.factory
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
  },
  addEventListener(type, handler) { listeners.push([type, handler]) },
  removeEventListener() {},
}

const source = readFileSync(CLIENT, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

if (factory === null) {
  console.error('FAIL: the client module never registered a factory')
  process.exit(1)
}

const plugin = factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

/* -------------------------------------------------------------- host stubs -- */

const registrations = new Map()
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  slots: {
    inject: (name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.set(name(options), component)
      return () => {}
    },
  },
  locale: {
    register: () => () => {},
    bind: (ns) => (key) => key,
  },
}

function name(options) {
  return options.name + '#' + (options.id ?? options.key)
}

plugin.apply(ctx)

const Panel = registrations.get('main#disk-cleaner')
const Icon = registrations.get('sidebar.panellist#disk-cleaner')
if (Panel === undefined || Icon === undefined) {
  console.error('FAIL: slots were not registered ->', [...registrations.keys()])
  process.exit(1)
}

/* ------------------------------------------------------------- fetch stub -- */

const scanFixture = {
  id: 'scan-test-1',
  at: Date.now(),
  tookMs: 4200,
  platform: 'win32',
  volumes: [
    { letter: 'C', root: 'C:\\', total: 200 * 1024 ** 3, free: 13 * 1024 ** 3, used: 187 * 1024 ** 3 },
    { letter: 'D', root: 'D:\\', total: 275 * 1024 ** 3, free: 62 * 1024 ** 3, used: 213 * 1024 ** 3 },
  ],
  breakdown: [
    { letter: 'C', rows: [{ name: 'Users', path: 'C:\\Users', bytes: 4.2 * 1024 ** 3, truncated: false }], truncated: false },
  ],
  items: [
    { id: 'temp-user', label: '用户临时文件', detail: '%TEMP%', risk: 'safe', admin: false, reportOnly: false, kind: 'cache', bytes: 512 * 1024 ** 2, files: 30, truncated: false, paths: 2 },
    { id: 'recycle', label: '回收站', detail: '清空各盘回收站', risk: 'caution', admin: false, reportOnly: false, kind: 'recycle', bytes: 1107 * 1024 ** 2, files: 12, truncated: false, paths: 2 },
    { id: 'winsxs', label: '组件存储 WinSxS', detail: 'DISM', risk: 'advanced', admin: false, reportOnly: true, kind: 'cache', bytes: 75 * 1024 ** 2, files: 4, truncated: false, paths: 1 },
  ],
  bigFiles: [],
}

const analyzeFixture = {
  ai: true,
  model: 'qodercn/dfmodel',
  advice: '先清浏览器缓存和回收站。',
  items: [
    { id: 'recycle', reason: '体积最大', priority: 1, recommended: true },
    { id: 'temp-user', reason: '可安全重建', priority: 2, recommended: true },
  ],
}

const cleanFixture = {
  freed: 1107 * 1024 ** 2,
  results: [
    { id: 'recycle', label: '回收站', freed: 1107 * 1024 ** 2, removed: 12, failed: 0, errors: [] },
  ],
}

const calls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  calls.push((init?.method ?? 'GET') + ' ' + target)
  const body = target.includes('/scan')
    ? { ok: true, scan: scanFixture }
    : target.includes('/analyze')
      ? { ok: true, analysis: analyzeFixture }
      : target.includes('/clean')
        ? { ok: true, ...cleanFixture }
        : target.includes('/volumes')
          ? { ok: true, volumes: scanFixture.volumes }
          : { ok: false, error: 'unexpected ' + target }
  return { ok: true, status: 200, json: async () => body }
}

/* --------------------------------------------------------------- renderer -- */

/**
 * Evaluate an element tree: a function type is called (its output replaces the
 * element), a host type is kept. This mirrors what React does, which matters
 * because the `main` slot registers a wrapper element around the panel.
 */
function evaluate(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(evaluate)
  if (typeof node.type === 'function') {
    const produced = node.type({ ...node.props, children: node.children })
    return evaluate(produced)
  }
  return { ...node, children: (node.children ?? []).map(evaluate) }
}

async function renderTree(Component, props, options = {}) {
  if (options.confirmAnswer !== undefined) {
    globalThis.window.confirm = () => options.confirmAnswer
  }
  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  let tree = null
  const settleRounds = options.rounds ?? 40

  for (let round = 0; round < settleRounds; round += 1) {
    instance.index = 0
    instance.pending = []
    instance.dirty = false
    activeCtx = instance
    try {
      tree = evaluate(React.createElement(Component, props))
    } finally {
      activeCtx = null
    }
    for (const slot of instance.pending) {
      const cleanup = slot.run()
      if (typeof cleanup === 'function') instance.cleanups.push(cleanup)
    }
    // Let pending promises settle; a state write during that window marks dirty.
    for (let tick = 0; tick < 40 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }
  return { tree, instance }
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const children = node.children ?? []
  return textOf(children)
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

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + detail))
}

/* ------------------------------------------------------------------ tests -- */

console.log('sidebar icon')
{
  const inactive = Icon({ size: 16, active: false })
  const active = Icon({ size: 16, active: true })
  check('renders without props', Icon({}) !== undefined)
  check('renders inactive', inactive.type === 'svg' && inactive.props.width === 16)
  check('follows the active state', active.props.strokeWidth !== inactive.props.strokeWidth)
}

console.log('panel: empty state before the auto scan lands')
{
  // Render once without letting async work settle.
  const instance = { hooks: [], index: 0, pending: [], dirty: false }
  activeCtx = instance
  const tree = evaluate(React.createElement(Panel, { t: (key) => key }))
  activeCtx = null
  const text = textOf(tree)
  check('renders the title', text.includes('panel.title'), text.slice(0, 120))
  check('renders an empty hint', text.includes('panel.emptyHint'))
  check('the checkbox rows are absent', findAll(tree, (node) => node.props.className === 'dskc_row').length === 0)
}

console.log('panel: full auto-scan flow')
{
  calls.length = 0
  const { tree } = await renderTree(Panel, { t: (key) => key })
  const text = textOf(tree)

  check('scan was called', calls.some((line) => line.includes('/scan')), JSON.stringify(calls))
  check('analyze was called', calls.some((line) => line.includes('/analyze')), JSON.stringify(calls))
  check('volumes were read', calls.some((line) => line.includes('/volumes')), JSON.stringify(calls))

  const rows = findAll(tree, (node) => node.props.className === 'dskc_row')
  check('three rows render', rows.length === 3, String(rows.length))
  check('drive cards render', findAll(tree, (node) => node.props.className === 'dskc_drive').length === 2)
  check('the model advice is shown', text.includes('qodercn/dfmodel') || text.includes('先清浏览器缓存'))

  const checkboxes = findAll(tree, (node) => node.type === 'input')
  check('report-only rows cannot be ticked', checkboxes.length === 3 && checkboxes[2].props.disabled === true)

  // Both recommended ids (recycle + temp-user) must arrive pre-ticked.
  const ticked = checkboxes.filter((box) => box.props.checked === true)
  check('the model recommendation seeds the selection', ticked.length === 2, String(ticked.length))
  check('the selection is summarised', text.includes('已选 2 项'), text.slice(-200))

  const buttons = findAll(tree, (node) => node.type === 'button')
  const cleanButton = buttons.find((button) => button.children.some((child) => child === 'panel.clean'))
  check('the clean button is enabled', cleanButton !== undefined && cleanButton.props.disabled === false)

  // Drive the clean action through the component's own handler.
  calls.length = 0
  const { tree: after } = await runClean(Panel)
  const afterText = textOf(after)
  check('clean was called', calls.some((line) => line.includes('/clean')), JSON.stringify(calls))
  check('the freed total is reported', afterText.includes('+') && afterText.includes('GB'), afterText.slice(0, 240))
  check('the result lists the item', afterText.includes('回收站'))
  check('the item list is cleared after a clean', findAll(after, (node) => node.props.className === 'dskc_row').length === 0)
}

/** Render, then invoke the clean handler of the settled tree. */
async function runClean(Component, options = {}) {
  if (options.confirmAnswer !== undefined) {
    globalThis.window.confirm = () => options.confirmAnswer
  }
  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  let tree = null
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Component, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }

  for (let round = 0; round < 40; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 40 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  const buttons = findAll(tree, (node) => node.type === 'button')
  const cleanButton = buttons.find((button) => button.children.includes('panel.clean'))
  if (cleanButton === undefined) {
    console.log('  note: no clean button in this render')
    return { tree }
  }
  cleanButton.props.onClick()
  for (let tick = 0; tick < 80 && instance.dirty === false; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  // One more render to pick the new state up, then let its effects settle.
  for (let round = 0; round < 10; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 20 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }
  return { tree }
}

/* -------------------------------- regression: selectable while analysing -- */

/**
 * The reported bug: on another machine the model call was slow, and the list
 * stayed tick-proof the whole time. Analysis must never gate the checkboxes.
 */
console.log('\npanel: the list is selectable while the model is still thinking')
{
  // A model call that never settles within this test's window.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/analyze')) await new Promise(() => {})
    return realFetch(url, init)
  }

  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }

  let tree = null
  for (let round = 0; round < 12; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  const boxes = findAll(tree, (node) => node.type === 'input')
  check('rows are on screen before the ranking lands', boxes.length === 3, String(boxes.length))
  check('the selectable rows are not disabled', boxes[0].props.disabled === false)
  check('the report-only row is still disabled', boxes[2].props.disabled === true)

  // Rows sort by size, so find the one the rule preset ticked rather than
  // assuming an index: only `safe` non-report items are preselected.
  const tickedIndex = boxes.findIndex((box) => box.props.checked === true)
  check('the rule preset ticked a safe row', tickedIndex >= 0, JSON.stringify(boxes.map((b) => b.props.checked)))

  // Ticking must work while analysis is in flight: untick the ticked row and
  // confirm the state actually changed.
  boxes[tickedIndex].props.onChange()
  for (let tick = 0; tick < 30; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const repainted = paint()
  const after = findAll(repainted, (node) => node.type === 'input')
  check(
    'a click during analysis toggles the row',
    after[tickedIndex].props.checked === false,
    JSON.stringify(after.map((b) => b.props.checked)),
  )

  globalThis.fetch = realFetch
}

/* --------------------------- regression: user choice survives the ranking - */

console.log('\npanel: a late ranking does not overwrite a manual choice')
{
  const realFetch = globalThis.fetch
  let releaseAnalyze
  const gate = new Promise((resolve) => { releaseAnalyze = resolve })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/analyze')) {
      await gate
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          analysis: {
            ai: true,
            model: 'x/y',
            advice: '清理回收站',
            items: [{ id: 'recycle', reason: '体积最大', priority: 1, recommended: true }],
          },
        }),
      }
    }
    return realFetch(url, init)
  }

  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }

  let tree = null
  for (let round = 0; round < 12; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  // The user clears everything, then ticks exactly one row by hand.
  const boxes = findAll(tree, (node) => node.type === 'input')
  const fresh = paint()
  const inputs = findAll(fresh, (node) => node.type === 'input')
  // Untick the preset, then tick only the second row.
  for (const box of inputs) {
    if (box.props.checked === true) box.props.onChange()
  }
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const cleared = findAll(paint(), (node) => node.type === 'input')
  cleared[1].props.onChange()
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))

  // Now let the model answer, which recommends a different row.
  releaseAnalyze()
  for (let tick = 0; tick < 40; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))

  const final = findAll(paint(), (node) => node.type === 'input')
  check(
    'the manual choice is preserved',
    final[1].props.checked === true && final[0].props.checked === false,
    JSON.stringify(final.map((b) => b.props.checked)),
  )

  globalThis.fetch = realFetch
}

/* ------------------- regression: a fully blocked machine is not empty ----- */

console.log('\npanel: a machine where everything needs elevation still reads')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/scan')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          scan: {
            id: 'scan-blocked',
            at: Date.now(),
            tookMs: 1200,
            platform: 'win32',
            volumes: [{ letter: 'C', root: 'C:\\', total: 200 * 1024 ** 3, free: 5 * 1024 ** 3, used: 195 * 1024 ** 3 }],
            breakdown: [],
            items: [
              { id: 'prefetch', label: 'Prefetch', detail: 'C:\\Windows\\Prefetch', risk: 'caution', admin: true, reportOnly: false, kind: 'cache', bytes: 0, files: 0, truncated: false, blocked: true, paths: 1 },
              { id: 'temp-user', label: '用户临时文件', detail: '%TEMP%', risk: 'safe', admin: false, reportOnly: false, kind: 'cache', bytes: 2048, files: 1, truncated: false, paths: 1 },
            ],
            bigFiles: [],
          },
        }),
      }
    }
    return realFetch(url, init)
  }

  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }
  let tree = null
  for (let round = 0; round < 12; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  const boxes = findAll(tree, (node) => node.type === 'input')
  const text = textOf(tree)
  check('the blocked entry is still listed', boxes.length >= 2, String(boxes.length))
  check('it explains why it cannot be cleaned', text.includes('当前无权限读取'))
  check('the blocked row cannot be ticked', boxes.some((b) => b.props.disabled === true && b.props.checked !== true))

  globalThis.fetch = realFetch
}

/* ------------------------- regression: selection survives a slow analysis - */

console.log('\npanel: a declined confirmation cancels the clean')
{
  calls.length = 0
  const { tree } = await runClean(Panel, { confirmAnswer: false })
  check('no clean request was made', !calls.some((line) => line.includes('/clean')), JSON.stringify(calls))
  check('the item list is still on screen', findAll(tree, (node) => node.props.className === 'dskc_row').length === 3)
  delete globalThis.window.confirm
}

/* ------------------------------- regression: the picker re-ranks only ------ */

console.log('\npanel: switching model re-ranks without rescanning')
{
  const realFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (init?.body !== undefined) {
      try { bodies.push(JSON.parse(String(init.body))) } catch { bodies.push(undefined) }
    }
    if (target.includes('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          models: {
            available: true,
            default: { provider: 'qodercn', model: 'dfmodel' },
            failures: [],
            groups: [
              {
                id: 'qodercn',
                name: 'QoderCN',
                models: [
                  { id: 'dfmodel', name: 'DF Model' },
                  {
                    id: 'dfmodel-pro',
                    name: 'DF Model Pro',
                    reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
                  },
                ],
              },
            ],
          },
        }),
      }
    }
    return realFetch(url, init)
  }

  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }
  let tree = null
  for (let round = 0; round < 20; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  const selects = findAll(tree, (node) => node.type === 'select')
  check('the model picker renders', selects.length === 1, String(selects.length))
  check('it starts on the deployment default', selects[0]?.props.value === 'qodercn/dfmodel', String(selects[0]?.props.value))

  calls.length = 0
  bodies.length = 0
  selects[0].props.onChange({ target: { value: 'qodercn/dfmodel-pro' } })
  for (let round = 0; round < 10; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  check('a model change does not rescan', !calls.some((line) => line.includes('/scan')), JSON.stringify(calls))
  check('it re-runs the ranking', calls.some((line) => line.includes('/analyze')), JSON.stringify(calls))
  check('the picked provider/model is sent',
    bodies.some((body) => body?.provider === 'qodercn' && body?.model === 'dfmodel-pro'),
    JSON.stringify(bodies))

  const after = findAll(tree, (node) => node.type === 'select')
  check('the model with efforts gains an effort control', after.length === 2, String(after.length))
  check('the effort starts on the model default', after[1]?.props.value === 'low', String(after[1]?.props.value))

  calls.length = 0
  bodies.length = 0
  after[1].props.onChange({ target: { value: 'high' } })
  for (let round = 0; round < 10; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }
  check('an effort change carries reasoningEffort',
    bodies.some((body) => body?.reasoningEffort === 'high' && body?.model === 'dfmodel-pro'),
    JSON.stringify(bodies))

  globalThis.fetch = realFetch
}

/* -------------------- regression: a slow reply cannot overwrite a newer one - */

console.log('\npanel: a slow earlier ranking cannot overwrite a newer one')
{
  const realFetch = globalThis.fetch
  const gates = []
  let analyzeCount = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          models: {
            available: true,
            default: { provider: 'qodercn', model: 'dfmodel' },
            failures: [],
            groups: [
              {
                id: 'qodercn',
                name: 'QoderCN',
                models: [
                  { id: 'dfmodel', name: 'DF Model' },
                  { id: 'dfmodel-pro', name: 'DF Model Pro' },
                ],
              },
              { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
            ],
          },
        }),
      }
    }
    if (target.includes('/analyze')) {
      analyzeCount += 1
      const index = analyzeCount
      // Every analysis waits on its own gate so the test controls the order.
      let release
      const promise = new Promise((resolve) => { release = resolve })
      gates.push({ release: () => release(), promise })
      await promise
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          analysis: {
            ai: true,
            model: 'model-' + index,
            advice: '来自第 ' + index + ' 次请求',
            items: [{ id: 'recycle', reason: 'r' + index, priority: 1, recommended: true }],
          },
        }),
      }
    }
    return realFetch(url, init)
  }

  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }
  const settleOnce = async (rounds = 6) => {
    let tree = null
    for (let round = 0; round < rounds; round += 1) {
      instance.dirty = false
      tree = paint()
      for (const slot of instance.pending) slot.run()
      for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (instance.dirty === false) break
    }
    return tree
  }

  let tree = await settleOnce()
  const selects = findAll(tree, (node) => node.type === 'select')
  check('the picker is available before the first ranking returns', selects.length === 1, String(selects.length))

  // Switch twice without releasing either reply.
  selects[0].props.onChange({ target: { value: 'qodercn/dfmodel-pro' } })
  tree = await settleOnce(3)
  const again = findAll(tree, (node) => node.type === 'select')
  again[0].props.onChange({ target: { value: 'deepseek/deepseek-chat' } })
  tree = await settleOnce(3)

  // Release the newest reply first, then the two stale ones. If the guard is
  // missing, the last release wins and the panel shows an older ranking.
  const newest = gates[gates.length - 1]
  newest?.release()
  tree = await settleOnce(4)
  for (let i = gates.length - 2; i >= 0; i -= 1) gates[i].release()
  tree = await settleOnce(6)

  const text = textOf(tree)
  check('the newest reply is the one on screen', text.includes('来自第 ' + analyzeCount + ' 次请求'), text.slice(-260))

  globalThis.fetch = realFetch
}

console.log()
console.log('motion: the FLIP diff drives the list reordering')
{
  const { measureRowShifts } = plugin.__test
  const nodeAt = (top) => ({ getBoundingClientRect: () => ({ top }) })

  // A row that moved up: it now sits 92px higher than last layout, so it has to
  // start 92px lower and travel back to zero.
  const up = nodeAt(100)
  const first = measureRowShifts(new Map([['recycle', up]]), new Map([['recycle', 192]]))
  check('a row that moved up is offset back to its old slot',
    first.moves.length === 1 && first.moves[0][1] === 92, JSON.stringify(first.moves.map((m) => m[1])))
  check('the node itself is the animation target', first.moves[0]?.[0] === up)
  check('the new position is remembered', first.tops.get('recycle') === 100)

  // A row that did not move must not animate: a still list would otherwise
  // shimmer on every unrelated re-render.
  const still = measureRowShifts(new Map([['a', nodeAt(40)], ['b', nodeAt(86)]]), new Map([['a', 40], ['b', 86]]))
  check('rows that did not move produce no animation', still.moves.length === 0, JSON.stringify(still.moves.length))

  // Sub-pixel drift is rounding, not a reordering.
  const noise = measureRowShifts(new Map([['a', nodeAt(40.4)]]), new Map([['a', 40]]))
  check('sub-pixel drift is ignored', noise.moves.length === 0, JSON.stringify(noise.moves))

  // A new row has no old slot to travel from, so it appears in place.
  const added = measureRowShifts(new Map([['fresh', nodeAt(10)]]), new Map())
  check('a row seen for the first time does not slide', added.moves.length === 0)
  check('a new row still registers its position', added.tops.get('fresh') === 10)

  // A removed row must not linger, or it would animate from a stale slot if it
  // came back later.
  const removed = measureRowShifts(new Map([['kept', nodeAt(20)]]), new Map([['kept', 20], ['gone', 200]]))
  check('a removed row leaves the position map', !removed.tops.has('gone'))
  check('removing a row is not a move', removed.moves.length === 0)

  // A node without measurable geometry (a detached or replaced element) is
  // skipped instead of producing NaN transforms.
  const broken = measureRowShifts(new Map([['x', { getBoundingClientRect: () => ({ top: NaN }) }]]), new Map([['x', 10]]))
  check('an unmeasurable node is skipped', broken.moves.length === 0 && !broken.tops.has('x'))
}

console.log()
console.log('motion: the entry animation runs on the first paint only')
{
  // Drive one instance across the entry window. `renderTree` builds a fresh
  // hook list per call, so a second call would just seed `entered` back to true;
  // the settled state has to be observed on the same instance.
  const instance = { hooks: [], index: 0, pending: [], dirty: false, cleanups: [] }
  const paint = () => {
    instance.index = 0
    instance.pending = []
    activeCtx = instance
    try {
      return evaluate(React.createElement(Panel, { t: (key) => key }))
    } finally {
      activeCtx = null
    }
  }
  const innerOf = (node) => findAll(node, (n) => typeof n.props.className === 'string'
    && n.props.className.includes('dskc_inner'))

  let tree = null
  for (let round = 0; round < 12; round += 1) {
    instance.dirty = false
    tree = paint()
    for (const slot of instance.pending) slot.run()
    for (let tick = 0; tick < 30 && instance.dirty === false; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (instance.dirty === false) break
  }

  const first = innerOf(tree)
  check('the panel root exists', first.length === 1, String(first.length))
  check('the entry class is applied on first paint',
    first[0] !== undefined && first[0].props.className.includes('dskc_enter'),
    first[0]?.props.className)

  // Past the 520 ms window the effect fires setEntered(false); repainting the
  // same instance then reflects whether the flag was actually consumed.
  await new Promise((resolve) => setTimeout(resolve, 700))
  instance.dirty = false
  const settled = paint()
  for (const slot of instance.pending) slot.run()
  const after = innerOf(settled)

  check('the entry class is gone once settled',
    after[0] !== undefined && !after[0].props.className.includes('dskc_enter'),
    after[0]?.props.className)
}

console.log()
console.log('motion: the freed total settles on the exact value')
{
  calls.length = 0
  const { tree } = await runClean(Panel)
  const text = textOf(tree)
  const ok = findAll(tree, (node) => node.props.className === 'dskc_ok')
  check('the result total is rendered', ok.length === 1, String(ok.length))
  check('the counter lands on the reported total, not an intermediate frame',
    ok[0] !== undefined && ok[0].children.some((child) => String(child).includes('+')),
    JSON.stringify(ok[0]?.children))
  check('the counted value matches the clean result', text.includes('+1.08 GB'), text.slice(0, 200))
}

console.log()
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
