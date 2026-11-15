/**
 * Model-selection test: mounts the plugin against a stub host whose `llm`
 * service advertises two healthy providers and one broken one, then drives
 * `/models` and `/analyze` with explicit, stale and malformed selections.
 *
 * The scan is synthetic (injected through the `__test` seam), so this runs
 * without touching a disk.
 *
 *   node test/models.mjs
 */

import { apply, __test } from '../index.js'

const routes = new Map()
const streamCalls = []

/** One Claude-style stream: a fixed ranking reply. */
function makeStream(reply) {
  return (options) => {
    streamCalls.push(options)
    return (async function* stream() {
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const ranking = JSON.stringify({
  advice: '先清回收站，再清临时文件。',
  items: [
    { id: 'recycle', reason: '体积最大', priority: 1, recommended: true },
    { id: 'temp-user', reason: '可安全重建', priority: 2, recommended: true },
  ],
})

const catalog = {
  qodercn: [
    { provider: 'qodercn', id: 'dfmodel', name: 'DF Model', badge: { text: '默认', tone: 'neutral' } },
    { provider: 'qodercn', id: 'dfmodel-pro', name: 'DF Model Pro' },
  ],
  deepseek: [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
}

const services = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'qodercn', model: 'dfmodel' }) },
  llm: {
    listProviders: () => [
      { id: 'qodercn', name: 'QoderCN' },
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'broken', name: 'Broken' },
    ],
    async listModels(provider) {
      if (provider === 'broken') throw new Error('adapter offline')
      const models = catalog[provider]
      if (models === undefined) throw new Error('unknown provider ' + provider)
      return models.map((model) => ({ ...model }))
    },
    async resolveModelInfo(provider, model) {
      if (model === 'dfmodel-pro') {
        return {
          provider,
          id: model,
          name: 'DF Model Pro',
          reasoning: {
            efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
            defaultEffort: 'low',
          },
        }
      }
      return { provider, id: model, name: model }
    },
    stream: makeStream(ranking),
  },
}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => { const dispose = fn(); return () => dispose?.() },
  get: (key) => services[key],
  webServer: {
    register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) },
  },
}

apply(ctx)

/* --------------------------------------------------------------- harness -- */

function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { host: '127.0.0.1:5055' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

function makeRes() {
  const out = { status: 0, payload: '' }
  return {
    writeHead(status) { out.status = status },
    end(payload) { out.payload = payload ?? '' },
    get result() { return out },
  }
}

async function call(path, method = 'GET', body) {
  const route = routes.get('/api/disk-cleaner' + path)
  if (route === undefined) throw new Error('no route ' + path)
  const res = makeRes()
  await route.handler(makeReq(method, body), res)
  const raw = res.result
  let json
  try { json = JSON.parse(raw.payload) } catch { json = undefined }
  return { status: raw.status, json }
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

/* ---------------------------------------------------------------- /models -- */

console.log('/models')
{
  const { status, json } = await call('/models')
  check('route answers 200', status === 200, String(status))
  check('the catalog is reported available', json?.models?.available === true)
  const groups = json?.models?.groups ?? []
  check('two healthy providers are grouped', groups.length === 2, JSON.stringify(groups.map((g) => g.id)))
  check('the broken provider is reported, not dropped', json?.models?.failures?.length === 1
    && json.models.failures[0].id === 'broken', JSON.stringify(json?.models?.failures))
  const qoder = groups.find((group) => group.id === 'qodercn')
  check('provider names come from the host', qoder?.name === 'QoderCN', String(qoder?.name))
  check('model display names survive', qoder?.models?.[0]?.name === 'DF Model')
  check('the model badge is passed through', qoder?.models?.[0]?.badge === '默认', JSON.stringify(qoder?.models?.[0]?.badge))
  const pro = qoder?.models?.find((model) => model.id === 'dfmodel-pro')
  check('reasoning efforts are exposed when there are real choices',
    pro?.reasoning?.efforts?.length === 2 && pro.reasoning.defaultEffort === 'low',
    JSON.stringify(pro?.reasoning))
  check('a model without efforts carries none', qoder?.models?.[0]?.reasoning === undefined)
  check('the deployment default is included', json?.models?.default?.provider === 'qodercn'
    && json.models.default.model === 'dfmodel', JSON.stringify(json?.models?.default))
}

/* --------------------------------------------------------------- /analyze -- */

__test.rememberScan({
  id: 'scan-models',
  at: Date.now(),
  tookMs: 1200,
  platform: 'win32',
  volumes: [{ letter: 'C', root: 'C:\\', total: 500, free: 100, used: 400 }],
  breakdown: [],
  items: [
    { id: 'temp-user', label: '用户临时文件', detail: '%TEMP%', risk: 'safe', admin: false, reportOnly: false, kind: 'cache', bytes: 1024, files: 2, truncated: false, paths: 1 },
    { id: 'recycle', label: '回收站', detail: '清空各盘回收站', risk: 'caution', admin: false, reportOnly: false, kind: 'recycle', bytes: 2048, files: 3, truncated: false, paths: 1 },
  ],
  bigFiles: [],
})

console.log('\n/analyze with an explicit selection')
{
  streamCalls.length = 0
  const { status, json } = await call('/analyze', 'POST', {
    scanId: 'scan-models',
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  check('route answers 200', status === 200, String(status))
  check('the requested provider/model reaches the model call',
    streamCalls.length === 1 && streamCalls[0].provider === 'deepseek' && streamCalls[0].model === 'deepseek-chat',
    JSON.stringify(streamCalls.map((c) => c.provider + '/' + c.model)))
  check('the reply names the model that ran', json?.analysis?.model === 'deepseek/deepseek-chat', String(json?.analysis?.model))
  check('no fallback is reported', json?.analysis?.switchedFrom === undefined)
  check('the ranking is accepted', json?.analysis?.ai === true && json.analysis.items.length === 2)
}

console.log('\n/analyze passes reasoning effort through')
{
  streamCalls.length = 0
  const { json } = await call('/analyze', 'POST', {
    scanId: 'scan-models',
    provider: 'qodercn',
    model: 'dfmodel-pro',
    reasoningEffort: 'high',
  })
  check('the effort reaches the model call', streamCalls[0]?.reasoningEffort === 'high', JSON.stringify(streamCalls[0]?.reasoningEffort))
  check('the reply names the effort model', json?.analysis?.model === 'qodercn/dfmodel-pro', String(json?.analysis?.model))
}

console.log('\n/analyze falls back when the pick is no longer advertised')
{
  streamCalls.length = 0
  const { json } = await call('/analyze', 'POST', {
    scanId: 'scan-models',
    provider: 'deepseek',
    model: 'retired-model',
  })
  check('the deployment default runs instead',
    streamCalls[0]?.provider === 'qodercn' && streamCalls[0]?.model === 'dfmodel',
    JSON.stringify(streamCalls.map((c) => c.provider + '/' + c.model)))
  check('the stale pick is reported back', json?.analysis?.switchedFrom === 'deepseek/retired-model', String(json?.analysis?.switchedFrom))
  check('the ranking still lands', json?.analysis?.ai === true)
}

console.log('\n/analyze ignores a malformed selection')
{
  streamCalls.length = 0
  const { json } = await call('/analyze', 'POST', {
    scanId: 'scan-models',
    provider: 42,
    model: null,
  })
  check('the default model runs', streamCalls[0]?.model === 'dfmodel', JSON.stringify(streamCalls[0]?.model))
  check('nothing is reported as switched', json?.analysis?.switchedFrom === undefined)
}

console.log('\n/analyze without a selection keeps the old behaviour')
{
  streamCalls.length = 0
  const { json } = await call('/analyze', 'POST', { scanId: 'scan-models' })
  check('the default model runs', streamCalls[0]?.provider === 'qodercn', JSON.stringify(streamCalls[0]?.provider))
  check('the reply is a normal ranking', json?.analysis?.ai === true)
}

/* --------------------------------------------------- deployment without llm -- */

console.log('\n/models without an llm service')
{
  const saved = services.llm
  delete services.llm
  const { status, json } = await call('/models')
  services.llm = saved
  check('route still answers 200', status === 200, String(status))
  check('availability is reported as false', json?.models?.available === false)
  check('no groups are invented', Array.isArray(json?.models?.groups) && json.models.groups.length === 0)
  check('no default is claimed', json?.models?.default === null)
}

console.log()
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
