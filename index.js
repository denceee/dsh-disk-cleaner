/**
 * dsh-disk-cleaner — Host half.
 *
 * Mounts the `/api/disk-cleaner` route family: volume inventory for the fixed
 * drives, a scan of known Windows cleanup areas (sizes measured on disk), an
 * optional LLM analysis pass that ranks the findings, and the guarded clean
 * action. The browser half (./client) renders the sidebar entry and the panel.
 *
 * Trust model: every route runs behind the host's own `/api` fence
 * (`ctx.connection.requestRejection`), falling back to a literal loopback
 * check when Connection is not mounted. The client never sends a filesystem
 * path — it sends item ids from a server-owned catalog, so no request can name
 * a path outside the areas this plugin declares below.
 */

import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Route prefix. Exact paths only; no prefix catch-all is registered. */
const API = '/api/disk-cleaner'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'disk-cleaner'

/** The webserver is the only hard dependency; `llm` is read optionally. */
export const inject = ['webServer']

const MB = 1024 * 1024
const GB = 1024 * MB

/* ------------------------------------------------------------------ helpers -- */

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** One JSON error response. */
function writeError(res, status, message) {
  writeJson(res, status, { ok: false, error: String(message) })
}

/** Read a JSON request body, or undefined when it is too large / not JSON. */
async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Literal loopback + same-origin check, used when Connection is absent. */
function loopbackFence(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return 403
  const host = request.headers.host
  if (typeof host !== 'string') return 403
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return 403
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return 403
  if (request.headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = request.headers.origin
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 403
  } catch {
    return 403
  }
}

/** Promise-based `map` with a concurrency cap; failures collapse to `undefined`. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch {
        results[index] = undefined
      }
    }
  })
  await Promise.all(runners)
  return results
}

/** Human-readable size (kept for the model prompt and for logs). */
function fmt(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

/* -------------------------------------------------------------------- disks -- */

/**
 * The Win32 logical-drive bitmap, without a native addon.
 *
 * `fs` has no binding for `GetLogicalDrives`, so this shells out to `wmic`
 * once and parses the fixed-drive list. `wmic` is deprecated on newest builds
 * but still present on Windows 10/11; the PowerShell `CIM` cmdlet is the
 * fallback. Both calls are cheap and cached for the process lifetime, because
 * drive letters do not change while a scan runs.
 */
let fixedDrivesCache

function readFixedDrives() {
  if (fixedDrivesCache !== undefined) return fixedDrivesCache
  const letters = new Set()
  const commands = [
    ['wmic', ['logicaldisk', 'where', 'drivetype=3', 'get', 'deviceid', '/value']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }"]],
  ]
  for (const [command, args] of commands) {
    try {
      const result = execFileSync(command, args, {
        timeout: 15000,
        windowsHide: true,
        encoding: 'utf8',
      })
      for (const match of String(result).matchAll(/([A-Za-z]):/g)) {
        letters.add(match[1].toUpperCase())
      }
      if (letters.size > 0) break
    } catch {
      /* try the next probe */
    }
  }
  fixedDrivesCache = letters
  return letters
}

/** Whether a letter is a fixed local disk (not removable, optical, or network). */
function isFixedDrive(letter) {
  const cached = readFixedDrives()
  // An empty result means both probes failed. Rather than hide every drive,
  // fall back to trusting statfs, which already excluded absent letters.
  if (cached.size === 0) return true
  return cached.has(String(letter).toUpperCase())
}

/** Fixed volumes present on this machine, C first. */

/**
 * Every fixed drive letter Windows currently has mounted.
 *
 * The old version probed a hard-coded `CDEFGHIJK` range. That is wrong in both
 * directions: a machine with only `C:` wasted nine failed probes, and a machine
 * with a drive at `L:` or a subst/network mount outside that range never had it
 * scanned at all. `GetLogicalDrives` is the authoritative bitmap, and
 * `DRIVE_FIXED` filters out removable media, optical drives, and network shares
 * — those are not the user's local disk and must never be cleaned.
 */
function listVolumes() {
  const fixed = readFixedDrives()

  const volumes = []
  const ordered = [...fixed].sort((a, b) => {
    // C: first, then alphabetical: that is the drive users think of as "the
    // system disk" on almost every Windows install.
    if (a === 'C') return -1
    if (b === 'C') return 1
    return a.localeCompare(b)
  })
  for (const letter of ordered) {
    const root = letter + ':\\'
    let stats
    try {
      stats = fs.statfsSync(root)
    } catch {
      continue
    }
    const total = stats.blocks * stats.bsize
    const free = stats.bavail * stats.bsize
    if (!Number.isFinite(total) || total <= 0) continue
    // A network or removable volume can answer statfs; only keep fixed disks.
    if (!isFixedDrive(letter)) continue
    volumes.push({ letter, root, total, free, used: Math.max(0, total - free) })
  }
  return volumes
}

/**
 * Measure one directory tree: total bytes, file count, and (optionally) the
 * files at or above `minFileSize`. Symlinks and junctions are never followed,
 * so a reparse loop cannot spin here. The deadline makes every call bounded.
 */
async function walkTree(root, options = {}) {
  const {
    deadline = Date.now() + 8000,
    maxFolderDepth = Infinity,
    minFileSize = Infinity,
    collect = null,
  } = options

  let bytes = 0
  let files = 0
  let truncated = false
  const stack = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const pending = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 <= maxFolderDepth) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      pending.push(full)
    }

    const stats = await mapLimit(pending, 32, (full) => fsp.stat(full).catch(() => null))
    for (let i = 0; i < pending.length; i += 1) {
      const stat = stats[i]
      if (!stat || !stat.isFile()) continue
      bytes += stat.size
      files += 1
      if (collect !== null && stat.size >= minFileSize) {
        collect.push({ path: pending[i], size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }

  return { bytes, files, truncated }
}

/** Sum a list of paths (files or directories) within one shared budget. */
async function measurePaths(paths, budgetMs, options = {}) {
  const deadline = Date.now() + budgetMs
  let bytes = 0
  let files = 0
  let truncated = false
  for (const target of paths) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    let stat
    try {
      stat = await fsp.lstat(target)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isFile()) {
      bytes += stat.size
      files += 1
      continue
    }
    if (!stat.isDirectory()) continue
    const result = await walkTree(target, { ...options, deadline })
    bytes += result.bytes
    files += result.files
    truncated = truncated || result.truncated
  }
  return { bytes, files, truncated }
}

/**
 * The children a `contents` clean would actually delete.
 *
 * Measurement and deletion both call this, and that is the point: the size the
 * panel shows is then exactly what a clean frees. A live directory caught by
 * the name whitelist, or a file younger than the age gate, is excluded from the
 * number too rather than counted and then quietly kept.
 *
 * A reparse point (symlink or junction) is reported with `link: true` so the
 * caller unlinks the link itself and never walks into its target.
 */
async function listDeletableChildren(dir, item) {
  const minAgeMs = Number.isFinite(item.minAgeMs) ? item.minAgeMs : 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { entries: [], error }
  }
  const out = []
  for (const entry of entries) {
    if (isSkippedTempName(entry.name, item.skipNames)) continue
    const full = path.join(dir, entry.name)
    let stat
    try {
      stat = await fsp.lstat(full)
    } catch {
      continue
    }
    if (minAgeMs > 0 && Date.now() - stat.mtimeMs < minAgeMs) continue
    out.push({ name: entry.name, full, link: stat.isSymbolicLink() })
  }
  return { entries: out }
}

/** Measure exactly what {@link listDeletableChildren} would remove. */
async function measureContents(item, budgetMs) {
  const deadline = Date.now() + budgetMs
  let bytes = 0
  let files = 0
  let truncated = false
  // A clean can only reach a directory it may enumerate. Measuring one that
  // answers EACCES/EPERM would advertise bytes that the clean then fails to
  // free — the panel would promise space it cannot deliver.
  const refused = []
  for (const dir of item.paths ?? []) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    const listed = await listDeletableChildren(dir, item)
    if (listed.error !== undefined) {
      refused.push(dir)
      continue
    }
    for (const child of listed.entries) {
      if (Date.now() > deadline) {
        truncated = true
        break
      }
      if (child.link) {
        files += 1
        continue
      }
      const report = await measurePaths([child.full], Math.max(400, deadline - Date.now()))
      bytes += report.bytes
      files += report.files > 0 ? report.files : 1
      truncated = truncated || report.truncated
    }
  }
  return { bytes, files, truncated, refused }
}

/**
 * Names under %TEMP% that must survive a clean even when they are old.
 *
 * The pattern list is deliberately about *identity*, not age: a tool that is
 * still running can hold a directory it created hours ago, and every one of
 * these names belongs to a live work area rather than to throwaway output.
 * `dsh-*` covers this Harness's spill/ACL/scratch directories; the rest are
 * the long-lived scratch areas of tools that keep state across restarts.
 */
const DEFAULT_TEMP_SKIP = [
  'dsh-*',
  'dsh',
  'node-compile-cache',
  'v8-compile-cache',
  'claude-*',
  'codex-*',
  'cursor-*',
  'vscode-*',
  'vscode-typescript*',
  'ts-node*',
  'jest_*',
  'puppeteer_dev_*',
  'playwright*',
  'ms-playwright*',
  'chrome_*',
  'scoped_dir*',
  'npm-*',
  'pnpm-*',
  'yarn-*',
  'pip-*',
  'tmp*.log',
]

/**
 * Whether a temp child must be preserved.
 *
 * Windows file names are case-insensitive, and the patterns are shell-glob
 * shaped, so the comparison lowercases both sides and translates `*`.
 */
function isSkippedTempName(name, patterns) {
  const lowered = String(name).toLowerCase()
  for (const pattern of patterns ?? DEFAULT_TEMP_SKIP) {
    const shape = String(pattern).toLowerCase()
    const star = shape.indexOf('*')
    if (star < 0) {
      if (lowered === shape) return true
      continue
    }
    const head = shape.slice(0, star)
    const tail = shape.slice(star + 1)
    if (lowered.length >= head.length + tail.length && lowered.startsWith(head) && lowered.endsWith(tail)) return true
  }
  return false
}

/** Environment value, or the fallback when unset/empty. */
function envOf(key, fallback) {
  const value = process.env[key]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** Existing entries only. */
function present(list) {
  return list.filter((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })
}

/** Children of `dir` (one level), optionally filtered by a predicate. */
function childrenOf(dir, filter) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (filter === undefined || filter(entry, full)) out.push(full)
  }
  return out
}

/**
 * Cache leaf names inside one Chromium profile directory.
 *
 * These are the directory names Chromium has used across versions; a profile
 * cache lives at `<profile>\<leaf>`. Matching the leaf instead of the product
 * is what lets discovery cover browsers this code has never been told about.
 */
const CHROMIUM_CACHE_LEAVES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker\\CacheStorage',
  'Service Worker\\ScriptCache',
  'GrShaderCache',
  'ShaderCache',
  'Media Cache',
]

/** Chromium-family profile cache directories for one product root. */
function chromiumCaches(productRoot) {
  const out = []
  // Profile directories are `Default`, `Profile 1`, `Profile 2`, ... but some
  // builds also carry `Guest Profile` and custom names, so every subdirectory
  // is considered and the leaf check does the filtering.
  for (const entry of childrenOf(productRoot, (dir) => dir.isDirectory())) {
    for (const leaf of CHROMIUM_CACHE_LEAVES) {
      out.push(path.join(entry, leaf))
    }
  }
  return out
}

/**
 * Discover every Chromium-family browser on this machine instead of listing
 * the products we happen to know.
 *
 * The old catalog named six browsers, which is exactly the set installed on the
 * machine it was written on. A user running Opera, Arc, Chromium, Yandex,
 * Whale, or any Electron app with a browsable profile got nothing. The shape
 * below is the real invariant — a `<product>\<profile>\Cache` directory — so
 * discovery finds products this code has never heard of.
 */
function discoverChromiumCacheRoots(localAppData) {
  const found = []
  const products = childrenOf(localAppData, (entry) => entry.isDirectory())

  const looksLikeProfileRoot = (root) => {
    for (const child of childrenOf(root, (entry) => entry.isDirectory())) {
      for (const leaf of CHROMIUM_CACHE_LEAVES) {
        if (fs.existsSync(path.join(child, leaf))) return true
      }
    }
    return false
  }

  // Depth 1: %LOCALAPPDATA%\<Product>\User Data
  // Depth 2: %LOCALAPPDATA%\<Vendor>\<Product>\User Data  (Brave, 360, ...)
  for (const product of products) {
    const direct = path.join(product, 'User Data')
    if (fs.existsSync(direct) && looksLikeProfileRoot(direct)) {
      found.push({ root: direct, source: path.basename(product) })
      continue
    }
    for (const nested of childrenOf(product, (entry) => entry.isDirectory())) {
      const root = path.join(nested, 'User Data')
      if (fs.existsSync(root) && looksLikeProfileRoot(root)) {
        found.push({ root, source: path.basename(product) + '\\' + path.basename(nested) })
      }
    }
  }
  return found
}

/**
 * Discover Firefox-family profile cache directories.
 *
 * Firefox keeps profiles under `%APPDATA%\Mozilla\Firefox\Profiles`, but
 * forks and portable installs use their own vendor directory, so every
 * `*\Profiles\*` under both AppData roots is a candidate.
 */
function discoverFirefoxCacheRoots(roamingAppData, localAppData) {
  const found = []
  for (const base of [roamingAppData, localAppData]) {
    for (const vendor of childrenOf(base, (entry) => entry.isDirectory())) {
      const profiles = path.join(vendor, 'Profiles')
      if (!fs.existsSync(profiles)) continue
      for (const profile of childrenOf(profiles, (entry) => entry.isDirectory())) {
        const cache = path.join(profile, 'cache2')
        if (fs.existsSync(cache)) found.push({ root: cache, source: path.basename(vendor) })
      }
    }
  }
  return found
}

/**
 * Discover package-manager and toolchain caches by shape.
 *
 * Every ecosystem keeps a content or download cache under a well-known
 * directory name; the list below is a *pattern* table, not a product list, so
 * a tool this code has never seen is found as long as it follows its
 * ecosystem's convention. Each hit is measured before it reaches the panel, so
 * a near-miss costs one failed stat and never a wrong delete.
 */
const TOOLCHAIN_CACHE_PATTERNS = [
  // Node / JS
  { root: (p) => path.join(p.localAppData, 'npm-cache'), label: 'npm 缓存', group: 'node' },
  { root: (p) => path.join(p.roamingAppData, 'npm-cache'), label: 'npm 缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'Yarn', 'Cache'), label: 'Yarn 缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'Yarn', 'Berry', 'cache'), label: 'Yarn 缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'pnpm-cache'), label: 'pnpm 元数据缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'pnpm', 'cache'), label: 'pnpm 元数据缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'deno', 'cache'), label: 'Deno 缓存', group: 'node' },
  { root: (p) => path.join(p.localAppData, 'bun', 'install', 'cache'), label: 'Bun 缓存', group: 'node' },
  // Python
  { root: (p) => path.join(p.localAppData, 'pip', 'Cache'), label: 'pip 缓存', group: 'python' },
  { root: (p) => path.join(p.userProfile, '.cache', 'pip'), label: 'pip 缓存', group: 'python' },
  { root: (p) => path.join(p.userProfile, '.cache', 'uv'), label: 'uv 缓存', group: 'python' },
  { root: (p) => path.join(p.localAppData, 'uv', 'cache'), label: 'uv 缓存', group: 'python' },
  { root: (p) => path.join(p.userProfile, '.conda', 'pkgs'), label: 'Conda 包缓存', group: 'python' },
  { root: (p) => path.join(p.localAppData, 'conda', 'conda', 'pkgs'), label: 'Conda 包缓存', group: 'python' },
  { root: (p) => path.join(p.roamingAppData, 'Python'), label: 'Python 安装缓存', group: 'python' },
  // Rust / JVM / .NET / Go
  { root: (p) => path.join(p.userProfile, '.cargo', 'registry', 'cache'), label: 'Cargo 缓存', group: 'rust' },
  { root: (p) => path.join(p.userProfile, '.cargo', 'registry', 'src'), label: 'Cargo 索引', group: 'rust' },
  { root: (p) => path.join(p.userProfile, '.gradle', 'caches'), label: 'Gradle 缓存', group: 'jvm' },
  { root: (p) => path.join(p.userProfile, '.gradle', 'wrapper', 'dists'), label: 'Gradle 发行版', group: 'jvm' },
  { root: (p) => path.join(p.userProfile, '.m2', 'repository'), label: 'Maven 本地仓库', group: 'jvm' },
  { root: (p) => path.join(p.userProfile, '.nuget', 'packages'), label: 'NuGet 包缓存', group: 'dotnet' },
  { root: (p) => path.join(p.localAppData, 'NuGet', 'v3-cache'), label: 'NuGet HTTP 缓存', group: 'dotnet' },
  { root: (p) => path.join(p.localAppData, 'go-build'), label: 'Go 构建缓存', group: 'go' },
  { root: (p) => path.join(p.userProfile, 'go', 'pkg', 'mod', 'cache', 'download'), label: 'Go 模块下载缓存', group: 'go' },
  // Mobile / cross-platform
  { root: (p) => path.join(p.userProfile, '.pub-cache', 'hosted'), label: 'Dart/Flutter 包缓存', group: 'mobile' },
  { root: (p) => path.join(p.userProfile, 'AppData', 'Local', 'Pub', 'Cache'), label: 'Dart/Flutter 包缓存', group: 'mobile' },
  { root: (p) => path.join(p.userProfile, '.gem', 'cache'), label: 'RubyGems 缓存', group: 'ruby' },
  { root: (p) => path.join(p.localAppData, 'Composer', 'cache'), label: 'Composer 缓存', group: 'php' },
  { root: (p) => path.join(p.localAppData, 'Temp', 'chocolatey'), label: 'Chocolatey 缓存', group: 'win' },
  // Editors and IDEs keep a large per-version cache tree
  { root: (p) => path.join(p.roamingAppData, 'Code', 'Cache'), label: 'VS Code 缓存', group: 'ide' },
  { root: (p) => path.join(p.roamingAppData, 'Code', 'CachedData'), label: 'VS Code 缓存', group: 'ide' },
  { root: (p) => path.join(p.roamingAppData, 'Code', 'logs'), label: 'VS Code 日志', group: 'ide' },
  { root: (p) => path.join(p.localAppData, 'JetBrains', 'caches'), label: 'JetBrains 缓存', group: 'ide' },
  { root: (p) => path.join(p.localAppData, 'JetBrains', 'log'), label: 'JetBrains 日志', group: 'ide' },
  // GPU driver shader caches, covering all three vendors
  { root: (p) => path.join(p.localAppData, 'NVIDIA', 'DXCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'NVIDIA', 'GLCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'NVIDIA', 'ComputeCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'NVIDIA Corporation', 'NV_Cache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'AMD', 'DxCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'AMD', 'DxcCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'AMD', 'GLCache'), label: '显卡着色器缓存', group: 'gpu' },
  { root: (p) => path.join(p.localAppData, 'D3DSCache'), label: '显卡着色器缓存', group: 'gpu' },
  // System-level report and log stores
  { root: (p) => path.join(p.localAppData, 'CrashDumps'), label: '崩溃转储文件', group: 'system' },
  { root: (p) => path.join(p.localAppData, 'Microsoft', 'Windows', 'WER'), label: '错误报告与诊断', group: 'system' },
  { root: (p) => path.join(p.programData, 'Microsoft', 'Windows', 'WER'), label: '错误报告与诊断', group: 'system' },
]

/**
 * The cleanup catalog. Every entry names concrete directories or files that
 * this plugin owns; `mode` decides what the clean action does with them.
 *
 *  - `contents` clear the children of each path, keeping the directory itself
 *    (temporary folders and caches the OS expects to exist).
 *  - `paths` delete the paths themselves.
 *  - `recycle` empties the recycle bin of the listed drives.
 *
 * `risk` is informational (rendered as a badge); `reportOnly` entries carry
 * advice and are never deleted automatically.
 */
function buildCatalog(volumes) {
  const localAppData = envOf('LOCALAPPDATA', path.join(os.homedir(), 'AppData', 'Local'))
  const roamingAppData = envOf('APPDATA', path.join(os.homedir(), 'AppData', 'Roaming'))
  const userProfile = envOf('USERPROFILE', os.homedir())
  const windir = envOf('WINDIR', 'C:\\Windows')
  const programData = envOf('ProgramData', 'C:\\ProgramData')

  const items = []
  const add = (item) => {
    // An entry with no target on this machine (the software is not installed)
    // is kept out of the panel explicitly. Relying on the "0 bytes is dropped"
    // rule downstream made the behaviour an implicit side effect; this makes it
    // a property of the entry itself.
    const hasTarget = (item.paths ?? []).length > 0
      || (item.extraFiles ?? []).length > 0
      || item.reportOnly === true
    if (!hasTarget) return
    items.push(item)
  }

  /* ---- temporary files ------------------------------------------------- */

  /**
   * Temp cleanup needs three guards that a plain "older than an hour" rule does
   * not give:
   *
   *  1. the running app's own working directories live in %TEMP% (this Harness
   *     keeps its tool-output spill there), and deleting one breaks a live
   *     session;
   *  2. a file another process still holds open must be skipped, not fought
   *     over;
   *  3. a session that started 40 minutes ago can still own a two-hour-old
   *     directory, so age alone is not evidence of abandonment.
   *
   * `skipNames` matches the directory or file name; `keepRecentMs` is the
   * mtime gate. Both are enforced again at clean time.
   */
  add({
    id: 'temp-user',
    label: '用户临时文件',
    detail: '%TEMP% 下超过 1 小时且不属于正在运行程序的临时项',
    risk: 'safe',
    mode: 'contents',
    minAgeMs: 6 * 60 * 60 * 1000,
    skipNames: DEFAULT_TEMP_SKIP,
    paths: present([envOf('TEMP', os.tmpdir()), path.join(localAppData, 'Temp')])
      .filter((value, index, all) => all.indexOf(value) === index),
  })

  add({
    id: 'temp-windows',
    label: 'Windows 临时文件',
    detail: 'C:\\Windows\\Temp 下的临时文件（需要管理员权限）',
    risk: 'safe',
    admin: true,
    mode: 'contents',
    minAgeMs: 6 * 60 * 60 * 1000,
    skipNames: DEFAULT_TEMP_SKIP,
    paths: present([path.join(windir, 'Temp')]),
  })

  /* ---- recycle bin ----------------------------------------------------- */

  const recycleDrives = volumes
    .filter((volume) => present([path.join(volume.root, '$RECYCLE.BIN')]).length > 0)
    .map((volume) => volume.letter)
  add({
    id: 'recycle',
    label: '回收站',
    detail: '清空各盘回收站（' + (recycleDrives.length > 0 ? recycleDrives.join('、') + ' 盘' : '无可用磁盘') + '）',
    risk: 'caution',
    mode: 'recycle',
    drives: recycleDrives,
    paths: recycleDrives.map((letter) => path.join(letter + ':\\', '$RECYCLE.BIN')),
  })

  /* ---- windows update / servicing -------------------------------------- */

  add({
    id: 'wu-download',
    label: 'Windows 更新缓存',
    detail: 'SoftwareDistribution\\Download 中已下载的更新包（需要管理员权限）',
    risk: 'caution',
    admin: true,
    mode: 'contents',
    paths: present([path.join(windir, 'SoftwareDistribution', 'Download')]),
  })

  add({
    id: 'windows-old',
    label: '旧系统备份 Windows.old',
    detail: '升级前的旧系统副本，删除后无法回滚到上一版本',
    risk: 'advanced',
    admin: true,
    mode: 'paths',
    paths: present([path.join(windir + '.old'), 'C:\\$WINDOWS.~BT', 'C:\\$WINDOWS.~WS']),
  })

  add({
    id: 'windows-logs',
    label: 'Windows 日志与诊断包',
    detail: 'C:\\Windows\\Logs、Panther、Minidump、MEMORY.DMP（需要管理员权限）',
    risk: 'caution',
    admin: true,
    mode: 'contents',
    paths: present([
      path.join(windir, 'Logs'),
      path.join(windir, 'Panther'),
      path.join(windir, 'Minidump'),
      path.join(windir, 'LiveKernelReports'),
    ]),
    extraFiles: present([path.join(windir, 'MEMORY.DMP')]),
  })

  add({
    id: 'prefetch',
    label: '预读取文件 Prefetch',
    detail: '启动加速缓存，删除后前期开机会略慢，系统会自动重建',
    risk: 'caution',
    admin: true,
    mode: 'contents',
    paths: present([path.join(windir, 'Prefetch')]),
  })

  add({
    id: 'delivery-optimization',
    label: '传递优化缓存',
    detail: 'Windows 更新点对点分发的临时副本（需要管理员权限）',
    risk: 'safe',
    admin: true,
    mode: 'contents',
    paths: present([
      path.join(windir, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'),
      path.join(programData, 'Microsoft', 'Network', 'Downloader'),
    ]),
  })

  add({
    id: 'font-cache',
    label: '字体缓存',
    detail: 'C:\\Windows\\ServiceProfiles 下的字体缓存文件（需要管理员权限）',
    risk: 'safe',
    admin: true,
    mode: 'contents',
    paths: present([
      path.join(windir, 'ServiceProfiles', 'LocalService', 'AppData', 'Local', 'FontCache'),
    ]),
  })

  /* ---- thumbnails / dumps ---------------------------------------------- */

  add({
    id: 'thumbnails',
    label: '缩略图与图标缓存',
    detail: 'Explorer 的 thumbcache / iconcache 数据库，删除后会自动重建',
    risk: 'safe',
    mode: 'paths',
    paths: present(childrenOf(
      path.join(localAppData, 'Microsoft', 'Windows', 'Explorer'),
      (entry) => entry.isFile() && /^(thumbcache_|iconcache_)/i.test(entry.name),
    )),
  })

  /* ---- system report stores -------------------------------------------- */

  add({
    id: 'crash-dumps',
    label: '崩溃转储文件',
    detail: '应用崩溃时写入的 .dmp 文件',
    risk: 'safe',
    mode: 'contents',
    paths: present([path.join(localAppData, 'CrashDumps')]),
  })

  add({
    id: 'wer-reports',
    label: '错误报告与诊断',
    detail: 'Windows 错误报告（WER）与系统诊断留下的崩溃记录',
    risk: 'safe',
    mode: 'contents',
    paths: present([
      path.join(localAppData, 'Microsoft', 'Windows', 'WER'),
      path.join(programData, 'Microsoft', 'Windows', 'WER'),
    ]),
  })

  /* ---- browsers: discovered, not enumerated ---------------------------- */

  // One entry per detected browser so the user sees which product they are
  // clearing, instead of one opaque "other browsers" bucket. Discovery walks
  // the profile shape, so Opera / Arc / Chromium / Yandex / Whale and any
  // future Chromium fork are covered without this file knowing their names.
  const chromiumRoots = discoverChromiumCacheRoots(localAppData)
  const chromiumSeen = new Set()
  for (const found of chromiumRoots) {
    const key = found.source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (chromiumSeen.has(key)) continue
    chromiumSeen.add(key)
    const caches = present(chromiumCaches(found.root))
    if (caches.length === 0) continue
    add({
      id: 'browser-' + key,
      label: found.source + ' 缓存',
      detail: '检测到的 Chromium 内核浏览器配置缓存（' + caches.length + ' 个缓存目录）',
      risk: 'safe',
      mode: 'contents',
      paths: caches,
    })
  }

  const firefoxRoots = discoverFirefoxCacheRoots(roamingAppData, localAppData)
  if (firefoxRoots.length > 0) {
    add({
      id: 'browser-firefox',
      label: 'Firefox 缓存',
      detail: '检测到的 Firefox 系浏览器 cache2 目录（' + firefoxRoots.length + ' 个配置）',
      risk: 'safe',
      mode: 'contents',
      paths: present(firefoxRoots.map((found) => found.root)),
    })
  }

  /* ---- GPU shader caches: all vendors, discovered ----------------------- */

  const gpuPaths = present(
    TOOLCHAIN_CACHE_PATTERNS.filter((entry) => entry.group === 'gpu')
      .map((entry) => entry.root({ localAppData, roamingAppData, userProfile, windir, programData })),
  )
  if (gpuPaths.length > 0) {
    add({
      id: 'gpu-shader-cache',
      label: '显卡着色器缓存',
      detail: '显卡驱动的着色器编译缓存，删除后游戏首次加载会稍慢，驱动会自动重建',
      risk: 'safe',
      mode: 'contents',
      paths: gpuPaths,
    })
  }

  /* ---- toolchain caches: grouped by ecosystem -------------------------- */

  // Grouped by ecosystem rather than by product: a user with two Python tools
  // sees one "Python 缓存" row, and a tool added to the pattern table appears
  // in its group without a new catalog entry.
  const groups = new Map()
  for (const entry of TOOLCHAIN_CACHE_PATTERNS) {
    if (entry.group === 'gpu' || entry.group === 'system') continue
    const target = entry.root({ localAppData, roamingAppData, userProfile, windir, programData })
    if (!fs.existsSync(target)) continue
    const bucket = groups.get(entry.group) ?? { labels: new Set(), paths: [], groups: new Set() }
    bucket.labels.add(entry.label)
    bucket.paths.push(target)
    bucket.groups.add(entry.group)
    groups.set(entry.group, bucket)
  }

  const GROUP_META = {
    node: { id: 'toolchain-node', label: 'Node 生态缓存', risk: 'caution' },
    python: { id: 'toolchain-python', label: 'Python 生态缓存', risk: 'safe' },
    rust: { id: 'toolchain-rust', label: 'Rust 缓存', risk: 'safe' },
    jvm: { id: 'toolchain-jvm', label: 'JVM 构建缓存', risk: 'caution' },
    dotnet: { id: 'toolchain-dotnet', label: '.NET 包缓存', risk: 'caution' },
    go: { id: 'toolchain-go', label: 'Go 构建与模块缓存', risk: 'safe' },
    mobile: { id: 'toolchain-mobile', label: 'Dart / Flutter 包缓存', risk: 'caution' },
    ruby: { id: 'toolchain-ruby', label: 'RubyGems 缓存', risk: 'safe' },
    php: { id: 'toolchain-php', label: 'Composer 缓存', risk: 'safe' },
    win: { id: 'toolchain-win', label: 'Windows 包管理器缓存', risk: 'safe' },
    ide: { id: 'toolchain-ide', label: '编辑器 / IDE 缓存与日志', risk: 'safe' },
  }

  for (const [group, bucket] of groups) {
    const meta = GROUP_META[group]
    if (meta === undefined) continue
    add({
      id: meta.id,
      label: meta.label,
      detail: [...bucket.labels].join('、') + '（共 ' + bucket.paths.length + ' 个目录；已装包不受影响，只影响下次下载速度）',
      risk: meta.risk,
      mode: 'contents',
      paths: bucket.paths,
    })
  }

  // The pnpm **content store** is deliberately not deletable here.
  //
  // pnpm's store-dir on Windows is %LOCALAPPDATA%\pnpm\store. An installed
  // tree can point into it by hardlink, and even with the hoisted linker used
  // by a dsh profile, wiping it forces every later `pnpm install` to
  // re-download the whole graph. When one dependency's tarball is gone
  // upstream (a real case in a plugin profile), that install fails *after*
  // pnpm has pruned, which leaves node_modules incomplete and every plugin in
  // the profile broken. The safe operation is pnpm's own `store prune`, which
  // only drops packages nothing references.
  add({
    id: 'pnpm-store',
    label: 'pnpm 存储（pnpm store）',
    detail: '不要直接删除：pnpm store 与已装包的文件是同一份数据。正确清理是执行 pnpm store prune',
    risk: 'advanced',
    reportOnly: true,
    mode: 'contents',
    paths: present([
      path.join(localAppData, 'pnpm', 'store'),
      path.join(localAppData, 'pnpm-store'),
      path.join(localAppData, 'pnpm', 'cache'),
    ]),
    note: '在终端执行 pnpm store prune 只删除无引用的包；直接删目录会让下次安装全量重下，若上游包已失效会导致依赖树残缺',
  })

  /* ---- other per-drive leftovers --------------------------------------- */

  // `temp-windows` above already owns C:\Windows\Temp on the system drive; a
  // second entry clearing the same directory would count its bytes twice and
  // delete concurrently.
  const claimedTemp = new Set(
    present([path.join(windir, 'Temp')]).map((value) => path.resolve(value).toLowerCase()),
  )

  for (const volume of volumes) {
    const root = volume.root
    const candidates = present([
      path.join(root, 'Temp'),
      path.join(root, 'temp'),
      path.join(root, 'tmp'),
      path.join(root, 'Windows', 'Temp'),
    ]).filter((value) => !claimedTemp.has(path.resolve(value).toLowerCase()))
    if (candidates.length === 0) continue
    for (const value of candidates) claimedTemp.add(path.resolve(value).toLowerCase())
    add({
      id: 'drive-temp-' + volume.letter.toLowerCase(),
      label: volume.letter + ' 盘临时目录',
      detail: candidates.join('；'),
      risk: 'safe',
      mode: 'contents',
      // Same gate as the other temp entries: a short-lived app can own a
      // directory it created hours ago, so age alone is not abandonment.
      minAgeMs: 6 * 60 * 60 * 1000,
      skipNames: DEFAULT_TEMP_SKIP,
      paths: candidates,
    })
  }

  /* ---- report-only findings ------------------------------------------- */

  add({
    id: 'hiberfil',
    label: '休眠文件 hiberfil.sys',
    detail: '与内存等大的休眠镜像。如需释放，请以管理员身份执行 powercfg /h off',
    risk: 'advanced',
    reportOnly: true,
    mode: 'paths',
    paths: present([path.join(envOf('SystemDrive', 'C:') + '\\', 'hiberfil.sys')]),
  })

  add({
    id: 'pagefile',
    label: '虚拟内存 pagefile.sys',
    detail: '系统页面文件，应在“系统属性 → 高级 → 性能”里调整，不建议直接删除',
    risk: 'advanced',
    reportOnly: true,
    mode: 'paths',
    paths: present(volumes.map((volume) => path.join(volume.root, 'pagefile.sys'))),
  })

  add({
    id: 'winsxs',
    label: '组件存储 WinSxS',
    detail: '系统组件仓库。正确的清理方式是管理员执行 DISM /Online /Cleanup-Image /StartComponentCleanup',
    risk: 'advanced',
    reportOnly: true,
    mode: 'contents',
    paths: present([path.join(windir, 'WinSxS', 'Temp')]),
  })

  add({
    id: 'restore-points',
    label: '系统还原点',
    detail: '在“系统保护”里删除旧还原点，或用 vssadmin delete shadows /for=C: 清理',
    risk: 'advanced',
    reportOnly: true,
    mode: 'contents',
    paths: [],
    note: '需要手动操作，插件不会自动删除还原点',
  })

  return items
}

/* ------------------------------------------------------------- guard rails -- */

/** Directories that must never be cleared wholesale, even by a catalog entry. */
const PROTECTED = new Set([
  'c:\\windows',
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\users',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\',
  'c:\\$recycle.bin',
].map((value) => value.toLowerCase()))

/**
 * Refuse anything that could remove a protected root wholesale.
 *
 * The catalog is static and reviewed, so this is a second line of defence: it
 * only matters if a future entry is written wrong. Short paths such as
 * `C:\Temp` are legitimate temp roots and must stay allowed, so the checks are
 * about *what* the path is, not how long its text is.
 */
function assertSafeTarget(target) {
  // Check the *argument* first: `path.resolve` turns a relative path into an
  // absolute one against the working directory, so testing absoluteness after
  // resolving would accept every relative path and silently retarget it.
  if (!path.isAbsolute(String(target))) throw new Error('拒绝删除相对路径: ' + target)
  const resolved = path.resolve(target)
  const trimmed = resolved.replace(/[\\/]+$/, '')
  const lowered = trimmed.toLowerCase()
  if (/^[a-z]:$/i.test(trimmed)) throw new Error('拒绝删除磁盘根目录: ' + target)
  if (path.basename(trimmed) === '') throw new Error('拒绝删除空路径: ' + target)
  if (PROTECTED.has(lowered)) throw new Error('拒绝删除受保护的系统目录: ' + target)
  const profile = path.resolve(envOf('USERPROFILE', os.homedir())).toLowerCase()
  if (lowered === profile) throw new Error('拒绝删除用户主目录: ' + target)
  return trimmed
}

/* -------------------------------------------------------------- scan model -- */

/** In-memory cache of the last scans (bounded, short-lived). */
const scanCache = new Map()
const SCAN_TTL_MS = 15 * 60 * 1000
const SCAN_MAX = 4

/** Store one scan and return its id. */
function rememberScan(scan) {
  const now = Date.now()
  for (const [id, entry] of scanCache) {
    if (now - entry.at > SCAN_TTL_MS) scanCache.delete(id)
  }
  while (scanCache.size >= SCAN_MAX) {
    const oldest = scanCache.keys().next().value
    scanCache.delete(oldest)
  }
  scanCache.set(scan.id, { at: now, scan })
  return scan.id
}

/** Read one cached scan. */
function recallScan(id) {
  const entry = typeof id === 'string' ? scanCache.get(id) : undefined
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > SCAN_TTL_MS) {
    scanCache.delete(id)
    return undefined
  }
  return entry.scan
}

/** Build and measure one full scan. */
async function runScan() {
  const startedAt = Date.now()
  const volumes = listVolumes()
  const catalog = buildCatalog(volumes)

  // The three measurement passes are independent, so they run concurrently and
  // the wall clock is the slowest one instead of their sum.
  const breakdownTask = mapLimit(volumes, 2, async (volume) => {
    const deadline = Date.now() + 4000
    const roots = childrenOf(volume.root, (entry) => entry.isDirectory())
    const rows = []
    for (const dir of roots) {
      if (Date.now() > deadline) break
      const size = await walkTree(dir, { deadline: Math.min(deadline, Date.now() + 2200), maxFolderDepth: 2 })
      rows.push({ name: path.basename(dir), path: dir, bytes: size.bytes, truncated: size.truncated })
    }
    rows.sort((a, b) => b.bytes - a.bytes)
    return { letter: volume.letter, rows: rows.slice(0, 10), truncated: rows.some((row) => row.truncated) }
  })

  const bigFilesTask = (async () => {
    const collected = { files: [] }
    await mapLimit(volumes, 2, async (volume) => {
      const found = []
      await walkTree(volume.root, {
        deadline: Date.now() + 7000,
        maxFolderDepth: 4,
        minFileSize: 300 * MB,
        collect: found,
      })
      for (const file of found) {
        // Installed programs are not user data. Deleting an executable, a
        // shared library, or an archive that *is* an application bundle
        // (app.asar) breaks an app rather than reclaiming garbage, so those
        // files never reach the selectable list.
        if (isProgramArtifact(file.path)) continue
        collected.files.push({ drive: volume.letter, path: file.path, size: file.size, mtimeMs: file.mtimeMs })
      }
    })
    collected.files.sort((a, b) => b.size - a.size)
    return collected.files
  })()

  const catalogTask = mapLimit(catalog, 4, async (item) => {
    const budget = item.reportOnly ? 2500 : item.mode === 'recycle' ? 3000 : 6000
    // A `contents` entry is measured through the same child filter its clean
    // uses, so the number shown is the number that will actually be freed.
    const report = item.mode === 'contents'
      ? await measureContents(item, budget)
      : await measurePaths(item.paths ?? [], budget, item.mode === 'recycle' ? { maxFolderDepth: 2 } : {})
    let bytes = report.bytes
    let files = report.files
    let truncated = report.truncated
    if (Array.isArray(item.extraFiles) && item.extraFiles.length > 0) {
      const extra = await measurePaths(item.extraFiles, 1500)
      bytes += extra.bytes
      files += extra.files
      truncated = truncated || extra.truncated
    }
    return { item, bytes, files, truncated, refused: report.refused ?? [] }
  })

  const [breakdown, bigFiles, measured] = await Promise.all([breakdownTask, bigFilesTask, catalogTask])

  const items = []
  for (const row of measured) {
    if (row === undefined) continue
    const item = row.item
    // A directory the process may not enumerate keeps its entry: reporting
    // "need administrator rights" is useful, hiding it is not.
    const blocked = row.refused.length > 0
    if (!item.reportOnly && row.bytes <= 0 && !blocked) continue
    if (item.reportOnly && row.bytes <= 0 && item.paths.length === 0 && item.note === undefined) continue
    items.push({
      id: item.id,
      label: item.label,
      detail: item.detail,
      risk: item.risk,
      admin: item.admin === true || blocked,
      reportOnly: item.reportOnly === true,
      note: item.note,
      kind: item.mode === 'recycle' ? 'recycle' : 'cache',
      bytes: row.bytes,
      files: row.files,
      truncated: row.truncated,
      blocked,
      paths: (item.paths ?? []).length,
    })
  }

  // 4) Large files become individually selectable rows, capped so the panel
  //    stays readable.
  const bigItems = bigFiles.slice(0, 15).map((file, index) => ({
    id: 'big-' + index,
    label: file.path,
    detail: fmt(file.size) + ' · ' + file.drive + ' 盘大文件 · ' + new Date(file.mtimeMs).toLocaleDateString('zh-CN'),
    risk: 'caution',
    admin: false,
    reportOnly: false,
    kind: 'file',
    bytes: file.size,
    files: 1,
    truncated: false,
    paths: 1,
  }))

  const scan = {
    id: 'scan-' + startedAt.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    at: startedAt,
    tookMs: Date.now() - startedAt,
    platform: process.platform,
    volumes: volumes.map((volume) => ({
      letter: volume.letter,
      root: volume.root,
      total: volume.total,
      free: volume.free,
      used: volume.used,
    })),
    breakdown: breakdown.filter(Boolean),
    items: [...items, ...bigItems],
    bigFiles: bigFiles.slice(0, 15),
  }
  return scan
}

/* ------------------------------------------------------------------- LLM -- */

/** Pull the assistant text out of a chunk stream. */
async function collectText(iterable, onDelta) {
  let text = ''
  let finish
  for await (const chunk of iterable) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      if (onDelta !== undefined) onDelta(text)
      continue
    }
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish !== undefined && finish.kind === 'error') {
    throw new Error('模型调用失败: ' + (finish.failure?.message ?? 'unknown'))
  }
  if (finish !== undefined && finish.kind === 'aborted') {
    throw new Error('模型调用被取消')
  }
  return text
}

/** Extract the first JSON object from a model reply. */
function parseJsonObject(text) {
  if (typeof text !== 'string' || text === '') return undefined
  let candidate = text.trim()
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) candidate = fence[1].trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the session's default model to rank the findings. Resolves with
 * `{ai:false, note}` whenever the call is unavailable or unusable — the panel
 * then keeps the deterministic ordering.
 */
async function analyzeWithLlm(ctx, scan) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ai: false, note: '本机没有挂载 llm 服务，使用规则排序。' }
  }

  let selection
  try {
    selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  } catch {
    selection = undefined
  }
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    return { ai: false, note: '没有可用的默认模型，使用规则排序。' }
  }

  const payload = {
    drives: scan.volumes.map((volume) => ({
      drive: volume.letter + ':',
      totalGB: +(volume.total / GB).toFixed(1),
      freeGB: +(volume.free / GB).toFixed(1),
      usedPct: +((volume.used / volume.total) * 100).toFixed(1),
    })),
    topFolders: scan.breakdown.map((entry) => ({
      drive: entry.letter + ':',
      folders: entry.rows.slice(0, 6).map((row) => ({ name: row.name, sizeMB: Math.round(row.bytes / MB) })),
    })),
    candidates: scan.items.map((item) => ({
      id: item.id,
      label: item.label,
      risk: item.risk,
      kind: item.kind,
      reportOnly: item.reportOnly,
      admin: item.admin,
      sizeMB: Math.round(item.bytes / MB),
    })),
  }

  const system = [
    '你是 Windows 磁盘空间清理顾问。用户给你一台真实机器的磁盘占用扫描结果。',
    '请判断哪些项目值得清理，并给出中文排序建议。',
    '规则：',
    '1. 只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。',
    '2. 结构：{"advice":"一到三句总体建议","items":[{"id":"候选id","reason":"为什么值得清理，不超过 40 字","priority":1,"recommended":true}]}',
    '3. priority 是 1..99 的整数，越小越优先；只对 candidates 里出现过的 id 给出条目。',
    '4. recommended 表示默认应当勾选；reportOnly 为 true 的项目一律 recommended=false。',
    '5. 体积大且安全（浏览器缓存、临时文件、更新缓存、回收站）优先；旧系统备份、休眠文件、组件存储这类只给提示。',
    '6. 如果某些项目体积很小，可以不给它们条目。',
  ].join('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
      maxTokens: 1600,
      temperature: 0.2,
      signal: controller.signal,
    })
    const text = await collectText(stream)
    const parsed = parseJsonObject(text)
    if (parsed === undefined) {
      return { ai: false, note: '模型没有返回可解析的 JSON，使用规则排序。' }
    }

    const known = new Set(scan.items.map((item) => item.id))
    const rows = []
    if (Array.isArray(parsed.items)) {
      for (const row of parsed.items) {
        if (row === null || typeof row !== 'object') continue
        const id = typeof row.id === 'string' ? row.id : ''
        if (!known.has(id)) continue
        const reason = typeof row.reason === 'string' ? row.reason.slice(0, 120) : ''
        const priority = Number.isFinite(row.priority) ? Math.max(1, Math.min(99, Math.round(row.priority))) : 50
        const recommended = row.recommended === true
        rows.push({ id, reason, priority, recommended })
      }
    }
    if (rows.length === 0) {
      return { ai: false, note: '模型没有给出可用建议，使用规则排序。' }
    }
    const advice = typeof parsed.advice === 'string' ? parsed.advice.slice(0, 400) : ''
    return {
      ai: true,
      model: selection.provider + '/' + selection.model,
      advice,
      items: rows,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ai: false, note: '模型分析失败（' + message + '），使用规则排序。' }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ clean -- */

/**
 * Empty one drive's recycle bin.
 *
 * Per-drive rather than batched so a volume that refuses (an administrative
 * share without rights, a drive that vanished) does not hide the outcome of the
 * ones that succeeded — the caller credits freed bytes per drive.
 */
async function clearRecycleBin(letter) {
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Clear-RecycleBin -DriveLetter ' + letter + " -Force -ErrorAction Stop",
    ], { timeout: 60_000, windowsHide: true })
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: detail.split('\n')[0] }
  }
}

/**
 * Whether a large file is part of an installed program rather than user data.
 *
 * Large-file discovery is meant to surface forgotten archives and downloads.
 * An `.exe`, `.dll`, `.asar`, `.node`, or a file inside a program directory is
 * part of something the user installed and runs; offering it as a checkbox is
 * a footgun, not a cleanup.
 */
const PROGRAM_EXTENSIONS = new Set([
  '.exe', '.dll', '.sys', '.drv', '.ocx', '.cpl', '.scr', '.msi', '.msp',
  '.asar', '.node', '.wasm', '.pak', '.bin', '.dat', '.db', '.sqlite',
  '.pyz', '.pyc', '.jar', '.class',
])

/** Directory segments that mark an installed-program location. */
const PROGRAM_SEGMENTS = [
  '\\program files\\',
  '\\program files (x86)\\',
  '\\programdata\\',
  '\\windows\\',
  '\\appdata\\local\\programs\\',
  '\\appdata\\roaming\\',
  '\\node_modules\\',
  '\\resources\\app',
  '\\.git\\',
  '\\.dsh\\profiles\\',
]

function isProgramArtifact(filePath) {
  const lowered = String(filePath).toLowerCase()
  const dot = lowered.lastIndexOf('.')
  const slash = Math.max(lowered.lastIndexOf('\\'), lowered.lastIndexOf('/'))
  if (dot > slash) {
    const extension = lowered.slice(dot)
    if (PROGRAM_EXTENSIONS.has(extension)) return true
  }
  const wrapped = '\\' + lowered.replace(/^[a-z]:\\/, '')
  for (const segment of PROGRAM_SEGMENTS) {
    if (wrapped.includes(segment)) return true
  }
  return false
}

/**
 * Whether a path cannot be deleted right now because something holds it open.
 *
 * Windows reports a sharing violation through any exclusive-open attempt. This
 * probes with `r+` on files and a directory handle for directories, then maps
 * EBUSY/EPERM/EACCES onto `true`. A missing path answers `false`: it is already
 * gone, which is a success, not a lock.
 */
async function isLocked(target) {
  const handles = []
  try {
    const stat = await fsp.lstat(target)
    if (stat.isDirectory()) {
      handles.push(await fsp.opendir(target))
    } else {
      const handle = await fsp.open(target, 'r+')
      handles.push(handle)
    }
    return false
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') return false
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
  } finally {
    for (const handle of handles) {
      try {
        if (typeof handle.close === 'function') await handle.close()
        else if (typeof handle[Symbol.asyncDispose] === 'function') await handle[Symbol.asyncDispose]()
      } catch {
        /* the probe already answered; a failed close changes nothing */
      }
    }
  }
}

/** Delete one catalog item. Returns a per-item result. */
async function cleanOneItem(entry, item) {
  const result = { id: entry.id, label: entry.label, freed: 0, removed: 0, failed: 0, errors: [] }
  if (entry.reportOnly === true) {
    result.errors.push('该项目仅供提示，不执行自动删除')
    return result
  }

  if (item.mode === 'recycle') {
    // Per drive, so one refused volume does not erase the credit for the ones
    // that were actually emptied.
    for (const letter of item.drives ?? []) {
      const bin = path.join(letter + ':\\', '$RECYCLE.BIN')
      const before = await measurePaths(present([bin]), 2500, { maxFolderDepth: 2 })
      const outcome = await clearRecycleBin(letter)
      if (outcome.ok) {
        result.freed += before.bytes
        result.removed += before.files
      } else {
        result.failed += 1
        result.errors.push(letter + ' 盘: ' + outcome.error)
      }
    }
    return result
  }

  if (item.mode === 'paths') {
    const targets = [...(item.paths ?? []), ...(item.extraFiles ?? [])]
    for (const target of targets) {
      let safe
      try {
        safe = assertSafeTarget(target)
      } catch (error) {
        result.failed += 1
        result.errors.push(error instanceof Error ? error.message : String(error))
        continue
      }
      const size = await measurePaths([safe], 4000)
      try {
        await fsp.rm(safe, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
        result.freed += size.bytes
        result.removed += size.files > 0 ? size.files : 1
      } catch (error) {
        result.failed += 1
        const detail = error instanceof Error ? error.message : String(error)
        result.errors.push(path.basename(safe) + ': ' + detail.split('\n')[0])
      }
    }
    return result
  }

  // mode === 'contents': clear the children, keep the directory itself. The
  // child list comes from the same helper the scan measured with, so what the
  // panel promised is what this loop walks over.
  for (const target of item.paths ?? []) {
    let safe
    try {
      safe = assertSafeTarget(target)
    } catch (error) {
      result.failed += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    const listed = await listDeletableChildren(safe, item)
    if (listed.error !== undefined) {
      const detail = listed.error instanceof Error ? listed.error.message : String(listed.error)
      result.failed += 1
      result.errors.push(path.basename(safe) + ': ' + detail.split('\n')[0])
      continue
    }
    for (const child of listed.entries) {
      // A junction or symlink is unlinked as a link. Deleting it recursively is
      // how a cleaner ends up destroying the directory a link points at.
      if (child.link) {
        try {
          await fsp.unlink(child.full)
          result.removed += 1
        } catch (error) {
          result.failed += 1
          const detail = error instanceof Error ? error.message : String(error)
          if (result.errors.length < 12) result.errors.push(child.name + ': ' + detail.split('\n')[0])
        }
        continue
      }
      // A file another process holds open cannot be deleted on Windows; the
      // `rm` below would fail anyway, but probing first turns a scary error
      // into an accurate "in use" count.
      if (await isLocked(child.full)) {
        result.locked = (result.locked ?? 0) + 1
        continue
      }
      const size = await measurePaths([child.full], 3000)
      try {
        await fsp.rm(child.full, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
        result.freed += size.bytes
        result.removed += size.files > 0 ? size.files : 1
      } catch (error) {
        result.failed += 1
        const detail = error instanceof Error ? error.message : String(error)
        if (result.errors.length < 12) result.errors.push(child.name + ': ' + detail.split('\n')[0])
      }
    }
  }

  // Extra standalone files (MEMORY.DMP and friends) belong to 'contents' items
  // that also carry whole-file targets.
  for (const target of item.extraFiles ?? []) {
    try {
      const safe = assertSafeTarget(target)
      const size = await measurePaths([safe], 2000)
      await fsp.rm(safe, { force: true, maxRetries: 2 })
      result.freed += size.bytes
      result.removed += 1
    } catch (error) {
      result.failed += 1
      const detail = error instanceof Error ? error.message : String(error)
      if (result.errors.length < 12) result.errors.push(path.basename(target) + ': ' + detail.split('\n')[0])
    }
  }

  return result
}

/* ------------------------------------------------------------------- mount -- */

/**
 * Mount the route family.
 * @param ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  /** The host's own `/api` trust fence, read per request. */
  const fenceOf = (request) => {
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        return connection.requestRejection(request)
      } catch {
        return 403
      }
    }
    return loopbackFence(request)
  }

  /** One route: fence → method → handler. */
  const route = (method, suffix, handler) => ({
    kind: 'exact',
    path: API + suffix,
    handler: async (req, res) => {
      const rejection = fenceOf(req)
      if (rejection !== undefined) {
        writeError(res, rejection, rejection === 401 ? '需要浏览器会话认证' : '来源不可信')
        return
      }
      if (req.method !== method) {
        writeError(res, 405, '不支持的请求方法: ' + (req.method ?? ''))
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        writeError(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  })

  const routes = [
    // Health probe: cheap, and the first thing to check when the panel is empty.
    // It also reports the model route the analyze step would use, so a
    // fallback to rule-based ordering is diagnosable without reading logs.
    route('GET', '/health', async (req, res) => {
      const llm = ctx.get('llm')
      let selection
      try {
        selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        selection = undefined
      }
      writeJson(res, 200, {
        ok: true,
        platform: process.platform,
        node: process.version,
        homes: { temp: envOf('TEMP', os.tmpdir()), userProfile: envOf('USERPROFILE', os.homedir()) },
        ai: {
          llm: llm !== undefined && typeof llm.stream === 'function',
          route: selection !== undefined && typeof selection.model === 'string'
            ? selection.provider + '/' + selection.model
            : null,
        },
      })
    }),

    // Volume inventory only (fast; used by the header before a full scan).
    route('GET', '/volumes', async (req, res) => {
      const volumes = listVolumes()
      writeJson(res, 200, {
        ok: true,
        volumes: volumes.map((volume) => ({
          letter: volume.letter,
          root: volume.root,
          total: volume.total,
          free: volume.free,
          used: volume.used,
        })),
      })
    }),

    // Full scan: volumes + per-drive breakdown + cleanup catalog + big files.
    route('GET', '/scan', async (req, res) => {
      const scan = await runScan()
      rememberScan(scan)
      writeJson(res, 200, { ok: true, scan })
    }),

    // AI ranking of the scan's findings.
    route('POST', '/analyze', async (req, res) => {
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeError(res, 400, '请求体不是合法 JSON')
        return
      }
      const scan = recallScan(body.scanId)
      if (scan === undefined) {
        writeError(res, 404, '扫描结果已过期，请重新扫描')
        return
      }
      const analysis = await analyzeWithLlm(ctx, scan)
      writeJson(res, 200, { ok: true, analysis })
    }),

    // Clean the selected ids. Paths never cross the wire.
    route('POST', '/clean', async (req, res) => {
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeError(res, 400, '请求体不是合法 JSON')
        return
      }
      const scan = recallScan(body.scanId)
      if (scan === undefined) {
        writeError(res, 404, '扫描结果已过期，请重新扫描')
        return
      }
      const ids = Array.isArray(body.ids) ? body.ids.filter((value) => typeof value === 'string') : []
      if (ids.length === 0) {
        writeError(res, 400, '没有选择任何清理项')
        return
      }

      const volumes = listVolumes()
      const catalog = buildCatalog(volumes)
      const byId = new Map(catalog.map((item) => [item.id, item]))
      const bigFiles = Array.isArray(scan.bigFiles) ? scan.bigFiles : []

      const results = []
      let freed = 0
      for (const id of ids) {
        if (id.startsWith('big-')) {
          const index = Number.parseInt(id.slice(4), 10)
          const file = Number.isInteger(index) ? bigFiles[index] : undefined
          if (file === undefined) {
            results.push({ id, label: id, freed: 0, removed: 0, failed: 1, errors: ['大文件记录已过期，请重新扫描'] })
            continue
          }
          const entry = { id, label: file.path, bytes: file.size, reportOnly: false }
          // Re-check at the delete boundary: the scan filtered program
          // artifacts out, and a forged or stale id must not slip past that.
          if (isProgramArtifact(file.path)) {
            results.push({
              id, label: file.path, freed: 0, removed: 0, failed: 1,
              errors: ['这是已安装程序的文件，不允许删除'],
            })
            continue
          }
          const item = { mode: 'paths', paths: [file.path] }
          const result = await cleanOneItem(entry, item)
          freed += result.freed
          results.push(result)
          continue
        }
        const item = byId.get(id)
        const entry = scan.items.find((row) => row.id === id)
        if (item === undefined || entry === undefined) {
          results.push({ id, label: id, freed: 0, removed: 0, failed: 1, errors: ['未知的清理项（扫描已过期？）'] })
          continue
        }
        const result = await cleanOneItem(entry, item)
        freed += result.freed
        results.push(result)
      }

      // The measurements behind this scan are stale after a clean.
      scanCache.delete(scan.id)
      writeJson(res, 200, { ok: true, freed, results })
    }),
  ]

  ctx.effect(() => {
    const disposers = routes.map((entry) => ctx.webServer.register(entry))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'disk-cleaner: routes')

  ctx.logger.info('[dsh-disk-cleaner] mounted ' + routes.length + ' routes under ' + API)
}

/**
 * Pure decision helpers, exposed for the test suite only.
 *
 * They are the guards that decide what may be deleted, so they are worth
 * testing directly instead of through a clean that would touch real files.
 * Nothing here performs I/O.
 */
export const __test = {
  isSkippedTempName,
  isProgramArtifact,
  assertSafeTarget,
  listDeletableChildren,
  measureContents,
  buildCatalog,
  listVolumes,
  discoverChromiumCacheRoots,
  discoverFirefoxCacheRoots,
  chromiumCaches,
  TOOLCHAIN_CACHE_PATTERNS,
  CHROMIUM_CACHE_LEAVES,
  DEFAULT_TEMP_SKIP,
  PROGRAM_EXTENSIONS,
  PROTECTED,
}
