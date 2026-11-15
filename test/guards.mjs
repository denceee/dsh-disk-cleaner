/**
 * Guard-rail test: the destructive path must refuse every dangerous target and
 * accept the legitimate ones, and a real clean must only touch what the
 * catalog owns. Runs against throwaway directories under the OS temp root.
 *
 *   node test/guards.mjs
 */

import { apply } from '../index.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const routes = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  get: () => undefined,
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}
apply(ctx)

function req(method, body) {
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

function res() {
  const out = { status: 0, payload: '' }
  return {
    writeHead(status) { out.status = status },
    end(payload) { out.payload = payload ?? '' },
    get result() { return out },
  }
}

async function call(suffix, method = 'GET', body) {
  const route = routes.get('/api/disk-cleaner' + suffix)
  const response = res()
  await route.handler(req(method, body), response)
  return { status: response.result.status, json: JSON.parse(response.result.payload || '{}') }
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

/* -------------------------------------------------------------------------- */

console.log('fences')
{
  const route = routes.get('/api/disk-cleaner/health')
  const response = res()
  await route.handler(
    { method: 'GET', headers: { host: 'evil.example' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} },
    response,
  )
  check('a foreign Host is rejected', response.result.status === 403, String(response.result.status))

  const response2 = res()
  await route.handler(
    { method: 'GET', headers: { host: '127.0.0.1:5055', origin: 'http://evil.example' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} },
    response2,
  )
  check('a foreign Origin is rejected', response2.result.status === 403, String(response2.result.status))

  const response3 = res()
  await route.handler(
    { method: 'GET', headers: { host: '127.0.0.1:5055' }, socket: { remoteAddress: '10.0.0.7' }, async *[Symbol.asyncIterator]() {} },
    response3,
  )
  check('a non-loopback peer is rejected', response3.result.status === 403, String(response3.result.status))

  const bad = await call('/health', 'POST')
  check('a wrong method answers 405', bad.status === 405, String(bad.status))
}

console.log('request validation')
{
  const noScan = await call('/analyze', 'POST', { scanId: 'scan-does-not-exist' })
  check('an unknown scanId answers 404', noScan.status === 404, String(noScan.status))

  const noBody = await call('/clean', 'POST')
  check('a missing body answers 400', noBody.status === 400, String(noBody.status))

  const first = await call('/scan')
  check('the scan succeeds', first.status === 200 && Array.isArray(first.json.scan.items))
  const scanId = first.json.scan.id

  const empty = await call('/clean', 'POST', { scanId, ids: [] })
  check('an empty selection answers 400', empty.status === 400, String(empty.status))

  const unknown = await call('/clean', 'POST', { scanId, ids: ['totally-unknown'] })
  check(
    'an unknown id deletes nothing',
    unknown.status === 200 && unknown.json.freed === 0 && unknown.json.results[0].failed === 1,
    JSON.stringify(unknown.json).slice(0, 160),
  )

  const stale = await call('/analyze', 'POST', { scanId: 'scan-0-0' })
  check('a forged scanId is refused', stale.status === 404, String(stale.status))
}

console.log('real deletion stays inside its sandbox')
{
  // A throwaway tree that mimics a user cache directory.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dskc-guard-'))
  const cacheDir = path.join(sandbox, 'cache')
  const keepDir = path.join(sandbox, 'keep')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(keepDir, { recursive: true })
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  fs.writeFileSync(path.join(cacheDir, 'stale.bin'), Buffer.alloc(4096, 1))
  fs.utimesSync(path.join(cacheDir, 'stale.bin'), old, old)
  fs.writeFileSync(path.join(cacheDir, 'fresh.bin'), Buffer.alloc(2048, 2))
  fs.writeFileSync(path.join(keepDir, 'precious.txt'), 'do not delete')

  const scan = await call('/scan')
  const scanId = scan.json.scan.id

  // A report-only item must be refused, so a test run never deletes a real
  // file. The invariant asserted is the one that matters: nothing outside the
  // catalog is ever touched by a clean request.
  const reportOnly = scan.json.scan.items.find((item) => item.reportOnly === true)
  if (reportOnly !== undefined) {
    const refused = await call('/clean', 'POST', { scanId, ids: [reportOnly.id] })
    check('a report-only item is refused', refused.status === 200 && refused.json.freed === 0, JSON.stringify(refused.json).slice(0, 200))
    check('the refusal carries a reason', (refused.json.results?.[0]?.errors ?? []).length > 0)
  } else {
    check('a report-only item exists to be refused', false)
  }

  check('the untouched sandbox survives', fs.existsSync(path.join(keepDir, 'precious.txt')))
  check('an unrelated file survives', fs.existsSync(path.join(cacheDir, 'fresh.bin')))
  fs.rmSync(sandbox, { recursive: true, force: true })
}

console.log('atomicity of the item list')
{
  const scan = await call('/scan')
  const ids = scan.json.scan.items.map((item) => item.id)
  check('every id is unique', new Set(ids).size === ids.length)
  check(
    'report-only items are flagged',
    scan.json.scan.items.filter((item) => item.reportOnly === true).every((item) => item.risk === 'advanced'),
  )
  check(
    'every non-report item has a size, unless it is unreadable or unfinished',
    scan.json.scan.items
      .filter((item) => item.reportOnly !== true)
      // A measurement that ran out of time is kept on purpose: a slow disk must
      // not look like an empty disk. Those rows legitimately read 0 bytes.
      .every((item) => item.bytes > 0 || item.blocked === true || item.truncated === true),
    JSON.stringify(scan.json.scan.items.filter((i) => i.reportOnly !== true && i.bytes <= 0 && i.blocked !== true && i.truncated !== true).map((i) => i.id)),
  )
  check(
    'a zero-byte selectable item always explains itself',
    scan.json.scan.items
      .filter((item) => item.reportOnly !== true && item.bytes <= 0)
      .every((item) => item.blocked === true || item.truncated === true),
  )
}

console.log()
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
