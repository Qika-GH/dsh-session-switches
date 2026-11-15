/**
 * dsh-session-switches — host half.
 *
 * One switchboard in the sidebar turns installed plugins on and off per
 * conversation. The host keeps the truth: which plugin owns which tools, which
 * conversation muted which plugin, and the enforcement that makes a mute real.
 *
 * Two enforcement layers, deliberately different:
 *  - `ctx.tools.restrict()` on the Agent's scoped context hides the tools from
 *    the model's declaration list. It only reaches tools the Agent inherits,
 *    which is exactly where third-party plugin tools live.
 *  - `ctx.tools.guard()` denies the call itself. It is the backstop for tools a
 *    preset registered inside its own scope (restrict cannot touch those) and
 *    for any call whose name maps to a muted plugin.
 *
 * @module dsh-session-switches
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'dsh-session-switches'
/** Services this plugin needs before `apply` runs. */
export const inject = ['tools', 'loader']

/** RPC mount point; the client posts here. */
export const RPC_CHANNEL = '/dsh-session-switches/rpc'

const SELF_NAME = 'dsh-session-switches'
const STATE_VERSION = 1
const MAX_SESSIONS = 400
const CATALOG_TTL_MS = 15000
const SCAN_FILE_LIMIT = 240
const SCAN_BYTE_LIMIT = 1600000
const SCAN_SUBDIRS = ['lib', 'dist', 'src', 'build', 'es']
const BODY_LIMIT = 64 * 1024

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = process.env.DSS_STATE_FILE || join(DSH_HOME, 'session-plugin-switches.json')

/* ------------------------------------------------------------------ state */

/** @returns {{ version: number, pinned: string[], sessions: Record<string, { muted: string[], at: number }>, updatedAt: number }} */
function emptyState() {
  return { version: STATE_VERSION, pinned: [], sessions: {}, updatedAt: 0 }
}

function normalizeState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  if (Array.isArray(raw.pinned)) {
    state.pinned = [...new Set(raw.pinned.filter(value => typeof value === 'string' && value))]
  }
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sessionId, record] of Object.entries(raw.sessions)) {
      if (!sessionId || !record || typeof record !== 'object') continue
      const muted = Array.isArray(record.muted)
        ? [...new Set(record.muted.filter(value => typeof value === 'string' && value))]
        : []
      if (!muted.length) continue
      const at = typeof record.at === 'number' ? record.at : 0
      state.sessions[sessionId] = { muted, at }
    }
  }
  state.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  return state
}

let cachedState

/** Read the persisted switchboard state once, then serve it from memory. */
function loadState() {
  if (cachedState) return cachedState
  try {
    cachedState = normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    cachedState = emptyState()
  }
  return cachedState
}

function saveState(next) {
  next.version = STATE_VERSION
  next.updatedAt = Date.now()
  const sessionIds = Object.keys(next.sessions)
  if (sessionIds.length > MAX_SESSIONS) {
    sessionIds
      .sort((left, right) => (next.sessions[left].at || 0) - (next.sessions[right].at || 0))
      .slice(0, sessionIds.length - MAX_SESSIONS)
      .forEach(sessionId => { delete next.sessions[sessionId] })
  }
  cachedState = next
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    const temporary = STATE_FILE + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n')
    renameSync(temporary, STATE_FILE)
    return true
  } catch {
    return false
  }
}

function mutedIds(state, sessionId) {
  if (!sessionId) return new Set()
  const record = state.sessions[sessionId]
  return new Set(record ? record.muted : [])
}

function setMuted(sessionId, entryId, muted) {
  if (!sessionId || !entryId) throw new Error('missing sessionId or plugin id')
  const state = loadState()
  const record = state.sessions[sessionId] || { muted: [], at: 0 }
  const muted2 = new Set(record.muted)
  if (muted) muted2.add(entryId)
  else muted2.delete(entryId)
  state.sessions[sessionId] = { muted: [...muted2], at: Date.now() }
  saveState(state)
}

function setPinned(entryId, pinned) {
  if (!entryId) throw new Error('missing plugin id')
  const state = loadState()
  const pinnedSet = new Set(state.pinned)
  if (pinned) pinnedSet.add(entryId)
  else pinnedSet.delete(entryId)
  state.pinned = [...pinnedSet]
  saveState(state)
}

function clearSession(sessionId) {
  if (!sessionId) return
  const state = loadState()
  delete state.sessions[sessionId]
  saveState(state)
}

/* ---------------------------------------------------------------- catalog */

const packageDirCache = new Map()
const toolScanCache = new Map()

function candidateBases(baseUrl) {
  const bases = []
  if (typeof baseUrl === 'string' && baseUrl) {
    if (baseUrl.startsWith('file:')) {
      try { bases.push(fileURLToPath(baseUrl)) } catch { /* not a file URL */ }
    } else {
      bases.push(baseUrl)
    }
  }
  const profile = process.env.DSH_PROFILE || 'desktop'
  bases.push(join(DSH_HOME, 'profiles', profile))
  try { bases.push(dirname(fileURLToPath(import.meta.url))) } catch { /* not a file URL */ }
  return bases
}

function nearestPackageDir(start) {
  let current = start
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** Declared package name of a directory, or undefined when unreadable. */
function packageNameOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}

let runtimeRootsCache

/**
 * Node-modules roots of the runtime that hosts DSH itself. Bundled plugins live
 * inside the runtime archive, which no profile-relative resolver can reach, so
 * they are looked up here instead.
 */
function runtimeModuleRoots() {
  if (runtimeRootsCache) return runtimeRootsCache
  const roots = []
  const pushRoot = value => {
    if (!value || roots.includes(value)) return
    try {
      if (!statSync(value).isDirectory()) return
    } catch {
      return
    }
    roots.push(value)
  }
  const ascendToNodeModules = start => {
    let current = start
    for (let step = 0; step < 10; step += 1) {
      if (basename(current) === 'node_modules') { pushRoot(current); return }
      const parent = dirname(current)
      if (parent === current) return
      current = parent
    }
  }
  if (process.argv[1]) ascendToNodeModules(dirname(process.argv[1]))
  if (process.execPath) {
    const appRoot = dirname(process.execPath)
    pushRoot(join(appRoot, 'resources', 'app.asar', 'dsh', 'node_modules'))
    pushRoot(join(appRoot, 'resources', 'app.asar', 'node_modules'))
    pushRoot(join(appRoot, 'resources', 'app', 'dsh', 'node_modules'))
    pushRoot(join(appRoot, 'node_modules'))
  }
  if (process.env.DSH_RUNTIME_ROOT) {
    pushRoot(join(process.env.DSH_RUNTIME_ROOT, 'node_modules'))
    pushRoot(process.env.DSH_RUNTIME_ROOT)
  }
  runtimeRootsCache = roots
  return roots
}

function resolvePackageDir(packageName, baseUrl) {
  const cacheKey = packageName + '|' + String(baseUrl || '')
  if (packageDirCache.has(cacheKey)) return packageDirCache.get(cacheKey)
  let found
  // A directory only counts when its manifest claims the name we asked for:
  // a resolver that silently lands somewhere else would mis-attribute tools.
  const claim = dir => (dir && packageNameOf(dir) === packageName ? dir : undefined)
  for (const root of runtimeModuleRoots()) {
    found = claim(join(root, packageName))
    if (found) break
  }
  for (const base of found ? [] : candidateBases(baseUrl)) {
    const direct = claim(join(base, 'node_modules', packageName))
    if (direct) { found = direct; break }
    try {
      const requireFrom = createRequire(join(base, '__dsh_resolve__.cjs'))
      const entryFile = requireFrom.resolve(packageName)
      const resolved = nearestPackageDir(dirname(entryFile))
      if (resolved && packageNameOf(resolved) === packageName) { found = resolved; break }
    } catch { /* fall through to the next base */ }
  }
  packageDirCache.set(cacheKey, found)
  return found
}

function collectSourceFiles(dir, out) {
  if (out.length >= SCAN_FILE_LIMIT) return
  let items
  try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const item of items) {
    if (out.length >= SCAN_FILE_LIMIT) return
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue
      collectSourceFiles(join(dir, item.name), out)
      continue
    }
    if (!item.isFile()) continue
    if (!/\.(?:js|mjs|cjs|ts)$/.test(item.name)) continue
    if (item.name.endsWith('.d.ts') || item.name.endsWith('.map')) continue
    out.push(join(dir, item.name))
  }
}

/** Only a registration call actually *declares* a tool id. */
const TOOL_CALL_SITE = /(?:defineTool|tools\.register|\.tools\.register)\s*\(/g
/** In a registration window only an explicit `name` key declares a tool. */
const TOOL_NAME_NEARBY = /name\s*:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+){0,4})['"]/g
/** How far past a registration call its declarative object may reach. */
const TOOL_WINDOW = 600
/** Any tool-shaped literal in a file that does register tools (helper-built ids). */
const TOOL_LITERAL_ANY = /['"]([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})['"]/g

/**
 * What a package's own source says about the tools it registers.
 *
 * `strong` comes from `defineTool({ name })` / `tools.register({ name })`
 * windows and is trustworthy on its own. `weak` covers helpers that take the
 * id as an argument (`routeTool('map_driving_route', …)`), so it is every
 * tool-shaped literal in a file that registers tools — too noisy to trust, but
 * safe once intersected with the live tool registry that actually mounted them.
 */
function detectToolLiterals(dir) {
  const stamp = (() => {
    try { return statSync(dir).mtimeMs } catch { return 0 }
  })()
  const cached = toolScanCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.found
  const files = []
  for (const sub of SCAN_SUBDIRS) {
    const path = join(dir, sub)
    try { if (statSync(path).isDirectory()) collectSourceFiles(path, files) } catch { /* absent subdir */ }
  }
  const strong = new Set()
  const weak = new Set()
  let bytes = 0
  for (const file of files) {
    if (bytes > SCAN_BYTE_LIMIT) break
    let source
    try { source = readFileSync(file, 'utf8') } catch { continue }
    bytes += source.length
    let registers = false
    for (const site of source.matchAll(TOOL_CALL_SITE)) {
      registers = true
      const window = source.slice(site.index, site.index + TOOL_WINDOW)
      for (const match of window.matchAll(TOOL_NAME_NEARBY)) {
        if (match[1].length <= 48) strong.add(match[1])
      }
    }
    if (!registers) continue
    for (const match of source.matchAll(TOOL_LITERAL_ANY)) {
      if (match[1].length <= 48) weak.add(match[1])
    }
  }
  const found = { strong, weak }
  toolScanCache.set(dir, { stamp, found })
  return found
}

function readPackageDescription(dir) {
  if (!dir) return ''
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest.description === 'string' ? manifest.description : ''
  } catch {
    return ''
  }
}

const TITLE_MAP = {
  fs: 'Files',
  'fs-search': 'File Search',
  bash: 'Shell',
  pwsh: 'PowerShell',
  jobs: 'Jobs',
  goal: 'Goals',
  web: 'Web',
  todo: 'Todos',
  skill: 'Skills',
  'working-directory': 'Working Directory',
  subagent: 'Subagents',
  'subagent-fork': 'Subagent Fork',
  'subagent-control': 'Subagent Control',
  'agent-team': 'Agent Team',
  'mcp-resources': 'MCP Resources',
  'plugin-manager': 'Plugin Manager',
  'workspace-dependencies': 'Workspace Dependencies',
  cordis: 'Cordis',
  'executor-ptc': 'PTC Executor',
}

const WORD_MAP = {
  mcp: 'MCP', api: 'API', ui: 'UI', ptc: 'PTC', cli: 'CLI', id: 'ID', im: 'IM',
  url: 'URL', fs: 'FS', ws: 'WS', cwd: 'CWD', dsh: 'DSH', com: 'COM',
}

function humanize(packageName) {
  const tail = packageName.split('/').pop() || packageName
  return tail
    .replace(/^dsh[-_]/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || packageName
}

/**
 * Display name for one loaded entry.
 *
 * Entry ids are usually more specific than the package they load (one package
 * can be mounted twice, as dsh-tool-subagent is), so the id wins whenever it
 * extends the package name. "tool-" is dropped and well-known names are spelled
 * the way the feature is spoken about, because "Tool Fs" helps nobody.
 */
function titleFor(packageName, entryId) {
  const pkgTail = (String(packageName).split('/').pop() || String(packageName)).replace(/^dsh[-_]/, '')
  const idTail = String(entryId === undefined ? '' : entryId)
    .replace(/^[a-zA-Z-]+:/, '')
    .replace(/^dsh[-_]/, '')
  const tail = idTail && (idTail === pkgTail || idTail.startsWith(pkgTail + '-')) ? idTail : pkgTail
  const stripped = tail.replace(/^tool[-_]/, '')
  if (TITLE_MAP[stripped]) return TITLE_MAP[stripped]
  const words = stripped.split(/[-_]/).filter(Boolean)
  const mapped = words.map(word => {
    const lower = word.toLowerCase()
    return WORD_MAP[lower] || lower.charAt(0).toUpperCase() + lower.slice(1)
  })
  return mapped.join(' ') || String(packageName)
}

function packageMeta(ctx, packageName, baseUrl, dir) {
  const pluginPackages = typeof ctx.get === 'function' ? ctx.get('pluginPackages') : undefined
  if (pluginPackages && typeof pluginPackages.metaOf === 'function') {
    try {
      const meta = pluginPackages.metaOf(packageName, baseUrl)
      if (meta && (meta.title || meta.description)) {
        return {
          title: typeof meta.title === 'string' && meta.title ? meta.title : humanize(packageName),
          description: typeof meta.description === 'string' ? meta.description : readPackageDescription(dir),
        }
      }
    } catch { /* the inventory service is optional */ }
  }
  return { title: humanize(packageName), description: readPackageDescription(dir) }
}

/** Cordis tags scoped contexts with this well-known symbol. */
const SCOPE_KEY = Symbol.for('dsh.scope')

/** Collect the names one tool-registry view exposes, ignoring viewless failures. */
function collectToolNames(tools, scope) {
  const names = new Set()
  for (const method of ['schemas', 'list', 'names']) {
    if (typeof tools[method] !== 'function') continue
    try {
      const value = tools[method].call(tools, scope)
      if (Array.isArray(value)) {
        for (const item of value) {
          const itemName = typeof item === 'string' ? item : item && item.name
          if (typeof itemName === 'string' && itemName) names.add(itemName)
        }
      } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) names.add(key)
      }
    } catch { /* some methods demand a scope */ }
    if (names.size) break
  }
  return names
}

/**
 * Live tool names the host currently knows about, or null when unknowable.
 *
 * The global registry view only holds deployment-wide tools; preset tools are
 * registered inside each agent's scope, so every live agent is asked as well.
 * That union is what the model of a running conversation can actually call.
 */
function liveToolNames(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (!tools) return null
  const names = collectToolNames(tools, undefined)
  for (const agent of liveAgents) {
    const scope = agent && agent.ctx ? agent.ctx[SCOPE_KEY] : undefined
    if (scope === undefined) continue
    for (const name of collectToolNames(tools, scope)) names.add(name)
  }
  return names.size ? names : null
}

let catalogCache

/** Cordis hands out the entry list as an iterator, not an array. */
function loaderEntries(ctx) {
  const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
  const raw = loader && typeof loader.entries === 'function' ? loader.entries() : []
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw[Symbol.iterator] === 'function') {
    try { return [...raw] } catch { return [] }
  }
  return []
}

function catalogFor(ctx) {
  const now = Date.now()
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS && catalogCache.ctx === ctx) return catalogCache
  const known = liveToolNames(ctx)
  const entries = []
  const owners = new Map()
  const debug = []
  let hidden = 0
  for (const entry of loaderEntries(ctx)) {
    const options = (entry && entry.options) || {}
    if (options.group) continue
    const packageName = typeof options.name === 'string' ? options.name : ''
    if (!packageName || packageName === SELF_NAME) continue
    const baseUrl = entry && entry.parent && entry.parent.tree && entry.parent.tree.ctx
      ? entry.parent.tree.ctx.baseUrl
      : undefined
    const dir = resolvePackageDir(packageName, baseUrl)
    const meta = packageMeta(ctx, packageName, baseUrl, dir)
    // Some packages carry their own name as the title ("dsh-map-tools"), which
    // reads like a manifest key, not like a feature: spell those out instead.
    const rawTitle = meta.title && meta.title !== humanize(packageName) ? meta.title : ''
    const packageish = !rawTitle || rawTitle === packageName || rawTitle.includes('/') || /^[a-z0-9][a-z0-9._-]*$/.test(rawTitle)
    const title = packageish ? titleFor(packageName, entry.id) : rawTitle
    const scanned = dir ? detectToolLiterals(dir) : { strong: new Set(), weak: new Set() }
    const literals = scanned.strong
    const candidates = new Set(literals)
    if (known) for (const toolName of scanned.weak) if (known.has(toolName)) candidates.add(toolName)
    const confirmed = known ? [...candidates].filter(toolName => known.has(toolName)).sort() : []
    // Detected-but-not-mounted names still belong to the plugin: a preset can
    // mount them later, and the guard denies by name either way.
    const tools = confirmed.length ? confirmed : [...candidates].sort()
    const assumed = !confirmed.length
    debug.push({ id: String(entry.id), name: packageName, dir: dir || null, literals: [...literals].slice(0, 12), tools, assumed })
    // A plugin that declares no tool at all has nothing to switch here.
    if (!tools.length) { hidden += 1; continue }
    const record = {
      id: String(entry.id === undefined ? packageName : entry.id),
      name: packageName,
      title,
      description: meta.description,
      tools,
      installed: !entry.disabled,
      dir: dir || null,
    }
    entries.push(record)
    for (const toolName of tools) {
      const bucket = owners.get(toolName)
      if (bucket) bucket.add(record.id)
      else owners.set(toolName, new Set([record.id]))
    }
  }
  entries.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
  // One package can be mounted twice (dsh-tool-subagent is), so two rows can
  // carry the same display name; the duplicate names its entry cell.
  const titleCounts = new Map()
  for (const entry of entries) titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1)
  for (const entry of entries) {
    if (titleCounts.get(entry.title) < 2) continue
    const cell = String(entry.id).replace(/^[a-zA-Z-]+:/, '').replace(/^tool[-_]/, '')
    entry.title = entry.title + ' · ' + titleFor(cell, cell)
  }
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  catalogCache = { at: now, ctx, entries, byId, owners, hidden, probed: known === null, debug }
  return catalogCache
}

function snapshot(sessionId, ctx) {
  const catalog = catalogFor(ctx)
  const state = loadState()
  const pinned = new Set(state.pinned)
  const muted = mutedIds(state, sessionId)
  let pruned = false
  for (const id of [...pinned]) {
    if (!catalog.byId.has(id)) { pinned.delete(id); pruned = true }
  }
  if (pruned) { state.pinned = [...pinned]; saveState(state) }
  const items = catalog.entries.map(entry => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    tools: entry.tools,
    assumed: entry.assumed === true,
    dir: entry.dir,
    installed: entry.installed,
    pinned: pinned.has(entry.id),
    muted: muted.has(entry.id),
  }))
  return {
    ok: true,
    sessionId,
    probed: catalog.probed,
    hiddenCount: catalog.hidden,
    mutedCount: items.filter(item => item.muted).length,
    pinnedCount: items.filter(item => item.pinned).length,
    items,
  }
}

/* ----------------------------------------------------------- enforcement */

const restrictions = new Map()
const liveAgents = new Set()

function sessionIdOf(agent) {
  const id = agent && agent.id
  return typeof id === 'string' ? id : ''
}

function mutedToolNames(ctx, sessionId) {
  const muted = mutedIds(loadState(), sessionId)
  if (!muted.size) return new Set()
  const catalog = catalogFor(ctx)
  const names = new Set()
  for (const id of muted) {
    const entry = catalog.byId.get(id)
    if (entry) for (const toolName of entry.tools) names.add(toolName)
  }
  return names
}

function resyncRestriction(ctx, agent) {
  const previous = restrictions.get(agent)
  if (previous) {
    restrictions.delete(agent)
    try { previous() } catch { /* already disposed */ }
  }
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  const deny = mutedToolNames(ctx, sessionId)
  if (!deny.size) return
  const scoped = agent && agent.ctx && agent.ctx.tools
  if (!scoped || typeof scoped.restrict !== 'function') return
  const known = liveToolNames(ctx)
  const names = known ? [...deny].filter(toolName => known.has(toolName)) : [...deny]
  if (!names.length) return
  try {
    const dispose = scoped.restrict({ deny: names })
    if (typeof dispose === 'function') restrictions.set(agent, dispose)
  } catch { /* an unknown scoped name rejects the whole filter; the guard still denies */ }
}

function resyncSession(ctx, sessionId) {
  for (const agent of liveAgents) {
    if (sessionIdOf(agent) === sessionId) resyncRestriction(ctx, agent)
  }
}

/* ------------------------------------------------------------------- RPC */

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

function dispatch(ctx, request) {
  const op = request && request.op
  const sessionId = request && typeof request.sessionId === 'string' ? request.sessionId : ''
  switch (op) {
    case 'state':
      return snapshot(sessionId, ctx)
    case 'toggle': {
      if (!sessionId) throw new Error('missing sessionId')
      const entryId = String(request.id || '')
      if (!catalogFor(ctx).byId.has(entryId)) throw new Error('unknown plugin id: ' + entryId)
      setMuted(sessionId, entryId, request.enabled === false)
      resyncSession(ctx, sessionId)
      return snapshot(sessionId, ctx)
    }
    case 'pin': {
      setPinned(String(request.id || ''), request.pinned !== false)
      return snapshot(sessionId, ctx)
    }
    case 'reset': {
      clearSession(sessionId)
      resyncSession(ctx, sessionId)
      return snapshot(sessionId, ctx)
    }
    case 'probe': {
      const catalog = catalogFor(ctx)
      return { ok: true, knownCount: liveToolNames(ctx)?.size ?? null, rows: catalog.debug }
    }
    case 'rescan': {
      catalogCache = undefined
      toolScanCache.clear()
      packageDirCache.clear()
      return snapshot(sessionId, ctx)
    }
    default:
      throw new Error('unknown op: ' + String(op))
  }
}

/**
 * Mount the sidebar switchboard: enforcement plus the JSON endpoint the client
 * popover talks to.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(execution => {
    try {
      const sessionId = sessionIdOf(execution && execution.agent)
      if (!sessionId) return undefined
      const muted = mutedIds(loadState(), sessionId)
      if (!muted.size) return undefined
      const catalog = catalogFor(ctx)
      const owners = catalog.owners.get(execution.name)
      if (!owners || !owners.size) return undefined
      for (const entryId of owners) {
        if (!muted.has(entryId)) continue
        const entry = catalog.byId.get(entryId)
        const label = entry ? entry.title : entryId
        return '插件「' + label + '」在本对话已关闭。可在侧边栏底部的「插件开关」中重新开启。'
      }
      return undefined
    } catch {
      return undefined
    }
  }), 'session-switches.guard')

  ctx.on('agent/created', payload => {
    const agent = payload && payload.agent
    if (!agent) return
    liveAgents.add(agent)
    resyncRestriction(ctx, agent)
  })

  ctx.on('agent/disposed', payload => {
    const agent = payload && payload.agent
    if (!agent) return
    liveAgents.delete(agent)
    const dispose = restrictions.get(agent)
    if (dispose) {
      restrictions.delete(agent)
      try { dispose() } catch { /* already disposed */ }
    }
  })

  ctx.inject(['connection', 'webServer'], routeCtx => {
    const connection = routeCtx.get('connection')
    const webServer = routeCtx.get('webServer')
    if (!connection || !webServer) return
    routeCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: async (request, response) => {
        const rejection = connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection)
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405)
          response.end('method not allowed')
          return
        }
        const contentType = String(request.headers['content-type'] || '')
        if (!contentType.includes('application/json')) {
          response.writeHead(415)
          response.end('unsupported media type')
          return
        }
        try {
          const body = await readJsonBody(request)
          const result = dispatch(ctx, body)
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }))
        }
      },
    }), 'session-switches.rpc')
  })
}

/** Internals exposed for the self-test only. */
export const _internals = {
  STATE_FILE,
  RPC_CHANNEL,
  loadState,
  saveState,
  snapshot,
  dispatch,
  detectToolLiterals,
  resolvePackageDir,
  renderMessages: null,
}
