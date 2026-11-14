/**
 * Local smoke test: mount the plugin against a stub host context, then drive
 * the real route handlers with synthetic request/response objects. Exercises
 * the true scan path on this machine without the GUI.
 *
 *   node test/smoke.mjs
 */

import { apply, name, inject } from '../index.js'

const routes = new Map()

/** A stand-in for the host's `llm` service: streams one fixed JSON reply. */
function makeLlmStub(reply) {
  return {
    stream(options) {
      if (typeof options.provider !== 'string' || typeof options.model !== 'string') {
        throw new Error('stub: provider/model required')
      }
      const text = typeof reply === 'function' ? reply(options) : reply
      return (async function* stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of String(text).match(/[\s\S]{1,12}/g) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: String(text) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const services = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'qodercn', model: 'dfmodel' }) },
}

const ctx = {
  logger: { info: (message) => console.log('[log]', message), warn: (m, e) => console.warn('[warn]', m, e ?? '') },
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  get: (key) => services[key],
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx)

console.log('plugin:', name, 'inject:', inject)
console.log('routes:', [...routes.keys()].join(', '))

/** One synthetic request whose socket is loopback. */
function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { host: '127.0.0.1:5055' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** One synthetic response capturing status + body. */
function makeRes() {
  const out = { status: 0, headers: null, payload: '' }
  return {
    ...out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.payload = payload ?? ''
    },
    get result() {
      return out
    },
  }
}

async function call(path, method = 'GET', body) {
  const route = routes.get('/api/disk-cleaner' + path)
  if (route === undefined) throw new Error('no route ' + path)
  const res = makeRes()
  await route.handler(makeReq(method, body), res)
  const raw = res.result
  let json
  try {
    json = JSON.parse(raw.payload)
  } catch {
    json = undefined
  }
  return { status: raw.status, json, raw: raw.payload }
}

const started = Date.now()

const health = await call('/health')
console.log('\n/health', health.status, JSON.stringify(health.json))

const volumes = await call('/volumes')
console.log('\n/volumes', volumes.status)
for (const volume of volumes.json.volumes) {
  console.log('  ', volume.letter + ':', (volume.used / 1024 ** 3).toFixed(1) + 'G used /', (volume.total / 1024 ** 3).toFixed(1) + 'G', '(', ((volume.used / volume.total) * 100).toFixed(1) + '% )')
}

const scan = await call('/scan')
console.log('\n/scan', scan.status, 'in', Date.now() - started, 'ms')
if (scan.json === undefined) {
  console.log(scan.raw.slice(0, 2000))
  process.exit(1)
}
const s = scan.json.scan
console.log('  scanId:', s.id, 'tookMs:', s.tookMs)
console.log('  breakdown drives:', s.breakdown.map((b) => b.letter).join(','))
for (const entry of s.breakdown) {
  console.log('   ', entry.letter + ':', entry.rows.slice(0, 5).map((r) => r.name + '=' + (r.bytes / 1024 ** 3).toFixed(2) + 'G').join('  '))
}
console.log('  items:', s.items.length)
for (const item of s.items.slice(0, 40)) {
  console.log('   ', item.id.padEnd(22), (item.bytes / 1024 ** 2).toFixed(0).padStart(8) + ' MB', item.risk.padEnd(9), item.reportOnly ? 'report' : '', '|', item.label.slice(0, 70))
}

const analyzed = await call('/analyze', 'POST', { scanId: s.id })
console.log('\n/analyze (no llm)', analyzed.status, JSON.stringify(analyzed.json).slice(0, 300))

// Now mount the llm stub and confirm the ranking path actually parses a reply.
const fakeRanking = {
  advice: '先清浏览器缓存与更新缓存，回收站体积最大也最安全。',
  items: s.items
    .filter((item) => item.reportOnly !== true)
    .slice(0, 4)
    .map((item, index) => ({
      id: item.id,
      reason: '体积 ' + Math.round(item.bytes / 1024 ** 2) + ' MB，可安全重建',
      priority: index + 1,
      recommended: index < 3,
    })),
}
services.llm = makeLlmStub(JSON.stringify(fakeRanking))
const ranked = await call('/analyze', 'POST', { scanId: s.id })
console.log('\n/analyze (stub llm)', ranked.status, JSON.stringify(ranked.json).slice(0, 500))
if (ranked.json.analysis?.ai !== true) {
  console.error('FAIL: the stub model reply was not accepted')
  process.exitCode = 1
}

// A model reply wrapped in a Markdown fence must still parse.
services.llm = makeLlmStub('```json\n' + JSON.stringify(fakeRanking) + '\n```')
const fenced = await call('/analyze', 'POST', { scanId: s.id })
console.log('\n/analyze (fenced)', fenced.status, 'ai=' + fenced.json.analysis?.ai)

// A garbage reply must degrade instead of throwing.
services.llm = makeLlmStub('I think you should clean your temp files!')
const garbage = await call('/analyze', 'POST', { scanId: s.id })
console.log('/analyze (garbage)', garbage.status, JSON.stringify(garbage.json.analysis).slice(0, 200))
if (garbage.json.analysis?.ai !== false) {
  console.error('FAIL: a non-JSON reply should fall back to rule ordering')
  process.exitCode = 1
}

// Refuse a bogus selection rather than deleting anything.
const bogus = await call('/clean', 'POST', { scanId: s.id, ids: ['no-such-item'] })
console.log('\n/clean (bogus)', bogus.status, JSON.stringify(bogus.json))

// A real clean of the safest, smallest item only: one empty-ish temp clear.
const emptyish = s.items.filter((item) => item.risk === 'safe' && !item.reportOnly && item.bytes > 0).slice(0, 1)
if (emptyish.length > 0) {
  console.log('\n(clean dry-run skipped; would target)', emptyish.map((i) => i.id).join(','))
}
console.log('\ntotal elapsed', Date.now() - started, 'ms')
