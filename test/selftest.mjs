/*
 * selftest.mjs — exercise the host half and the client bundle without a live
 * DSH instance.
 *
 * The host is driven through a fake Cordis context: a fake loader hands it two
 * package entries, a fake tools service answers schemas(), and the temp DSH
 * home holds a real on-disk package so the source scanner has something to
 * find. The client bundle is loaded through a fake __ModuleLoader__, which
 * proves the wrapping is right and that apply() registers the sidebar slot.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) return
  failures.push(label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)))
}

function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/* ---- a throwaway DSH home with one real package on disk ---- */

const home = mkdtempSync(join(tmpdir(), 'dss-home-'))
const profileDir = join(home, 'profiles', 'desktop')
const pkgDir = join(profileDir, 'node_modules', 'fake-alpha')
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
  name: 'fake-alpha',
  version: '1.0.0',
  description: 'Pretend plugin used by the self-test',
  main: 'lib/index.js',
}, null, 2))
writeFileSync(join(pkgDir, 'lib', 'index.js'), [
  'export function apply(ctx) {',
  '  ctx.tools.register({ name: "fake_alpha_tool", run: () => "ok" })',
  '  ctx.tools.register({ name: "fake_alpha_second", run: () => "ok" })',
  '}',
].join('\n'))

// A package whose tool ids go through a helper: the registration call carries no
// literal name, only a tool-shaped argument. That is the weak-evidence path.
const helperDir = join(profileDir, 'node_modules', 'fake-beta')
mkdirSync(join(helperDir, 'lib'), { recursive: true })
writeFileSync(join(helperDir, 'package.json'), JSON.stringify({
  name: 'fake-beta',
  version: '1.0.0',
  main: 'lib/index.js',
}, null, 2))
writeFileSync(join(helperDir, 'lib', 'index.js'), [
  'const make = (id) => ({ name: id, run: () => "ok" })',
  'const NOT_A_TOOL = "bystander_identifier"',
  'export function apply(ctx) {',
  '  ctx.tools.register(make("fake_beta_helper"))',
  '}',
].join('\n'))

const stateFile = join(home, 'session-plugin-switches.json')
process.env.DSH_HOME = home
process.env.DSS_STATE_FILE = stateFile
process.env.DSH_PROFILE = 'desktop'

const plugin = await import(pathToFileURL(join(process.cwd(), 'src', 'index.js')).href)
const internals = plugin._internals

/* ---- fake cordis context ---- */

const registeredGuards = []
const registeredRoutes = []
const eventHandlers = new Map()
const liveToolNamesList = ['fake_alpha_tool', 'fake_alpha_second', 'fake_beta_helper', 'unrelated_tool']

const entries = [
  { id: 'fake-alpha', options: { name: 'fake-alpha' }, parent: { tree: { ctx: { baseUrl: profileDir } } } },
  { id: 'fake-beta', options: { name: 'fake-beta' }, parent: { tree: { ctx: { baseUrl: profileDir } } } },
  { id: 'group-one', options: { group: true } },
  // No resolvable package dir -> no attributable tool -> must stay out of the list.
  { id: 'ghost-plugin', options: { name: 'ghost-plugin' }, parent: { tree: { ctx: { baseUrl: profileDir } } } },
]

const toolsService = {
  schemas() { return liveToolNamesList.map(name => ({ name })) },
  guard(fn) { registeredGuards.push(fn); return () => { registeredGuards.pop() } },
  restrict() { return () => {} },
}

const ctx = {
  tools: toolsService,
  get(service) {
    if (service === 'tools') return toolsService
    // Cordis hands out an iterator from a generator; the plugin must not assume an array.
    if (service === 'loader') return { entries: function* () { yield* entries } }
    if (service === 'pluginPackages') return { metaOf: () => undefined }
    if (service === 'connection') return { requestRejection: () => undefined }
    if (service === 'webServer') return { register(route) { registeredRoutes.push(route); return () => {} } }
    return undefined
  },
  effect(fn) { return fn() },
  on(event, handler) { if (!eventHandlers.has(event)) eventHandlers.set(event, []); eventHandlers.get(event).push(handler); return () => {} },
  inject(_deps, callback) { callback(ctx) },
}

plugin.apply(ctx)

/* ---- catalog ---- */

const sessionA = 'session-a'
const sessionB = 'session-b'

const first = internals.snapshot(sessionA, ctx)
check('snapshot is ok', first.ok === true)
const alpha = first.items.find(item => item.id === 'fake-alpha')
check('catalog found the package', Boolean(alpha), first.items.map(item => item.id))
equal('group entries are skipped', first.items.length, 2)
equal('tool-less plugins are hidden and counted', first.hiddenCount, 1)
equal('probed flag is false when schemas() answers', first.probed, false)
equal('tools intersect the live registry', alpha && alpha.tools, ['fake_alpha_second', 'fake_alpha_tool'])
const beta = first.items.find(item => item.id === 'fake-beta')
equal('helper-registered tools are attributed via the live registry', beta && beta.tools, ['fake_beta_helper'])
equal('title falls back to a humanized name', alpha && alpha.title, 'Fake Alpha')
check('description comes from package.json', alpha && alpha.description === 'Pretend plugin used by the self-test')
equal('nothing is muted or pinned yet', [first.mutedCount, first.pinnedCount], [0, 0])

let ghostThrew = false
try { internals.dispatch(ctx, { op: 'toggle', sessionId: sessionA, id: 'ghost-plugin', enabled: false }) } catch { ghostThrew = true }
check('toggling an unknown plugin is refused', ghostThrew)

/* ---- pin ---- */

const pinned = internals.dispatch(ctx, { op: 'pin', sessionId: sessionA, id: 'fake-alpha', pinned: true })
equal('pin shows up in the snapshot', pinned.items[0].pinned, true)
equal('pin persisted to disk', JSON.parse(readFileSync(stateFile, 'utf8')).pinned, ['fake-alpha'])

/* ---- toggle off ---- */

check('a guard was registered', registeredGuards.length === 1)
const guard = registeredGuards[0]
equal('guard allows while enabled', guard({ name: 'fake_alpha_tool', agent: { id: sessionA } }), undefined)

const muted = internals.dispatch(ctx, { op: 'toggle', sessionId: sessionA, id: 'fake-alpha', enabled: false })
equal('toggle marks the plugin muted', muted.items[0].muted, true)
equal('mutedCount is reported', muted.mutedCount, 1)
equal('toggle did not leak into the other conversation', internals.snapshot(sessionB, ctx).mutedCount, 0)

const denied = guard({ name: 'fake_alpha_tool', agent: { id: sessionA } })
check('guard denies the muted plugin tool', typeof denied === 'string' && denied.includes('fake-alpha') === false, denied)
check('guard message names the plugin title', typeof denied === 'string' && denied.includes('Alpha'), denied)
equal('guard ignores other conversations', guard({ name: 'fake_alpha_tool', agent: { id: sessionB } }), undefined)
equal('guard ignores unrelated tools', guard({ name: 'unrelated_tool', agent: { id: sessionA } }), undefined)
equal('guard tolerates a missing agent', guard({ name: 'fake_alpha_tool' }), undefined)

/* ---- files on disk ---- */

const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
equal('mute persisted per session', persisted.sessions[sessionA].muted, ['fake-alpha'])
check('an at timestamp was stamped', typeof persisted.sessions[sessionA].at === 'number')

/* ---- toggle back on ---- */

internals.dispatch(ctx, { op: 'toggle', sessionId: sessionA, id: 'fake-alpha', enabled: true })
equal('re-enabling clears the guard', guard({ name: 'fake_alpha_tool', agent: { id: sessionA } }), undefined)

/* ---- reset ---- */

internals.dispatch(ctx, { op: 'toggle', sessionId: sessionA, id: 'fake-alpha', enabled: false })
internals.dispatch(ctx, { op: 'toggle', sessionId: sessionB, id: 'fake-alpha', enabled: false })
const reset = internals.dispatch(ctx, { op: 'reset', sessionId: sessionA })
equal('reset clears only its own conversation', [reset.mutedCount, internals.snapshot(sessionB, ctx).mutedCount], [0, 1])

/* ---- unpin + junk pruning ---- */

const unpinned = internals.dispatch(ctx, { op: 'pin', sessionId: sessionA, id: 'fake-alpha', pinned: false })
equal('unpin is reflected', unpinned.items[0].pinned, false)

internals.dispatch(ctx, { op: 'pin', id: 'ghost-plugin', pinned: true })
const prunedSnapshot = internals.snapshot(sessionA, ctx)
equal('a pinned id with no installed plugin is pruned', prunedSnapshot.items[0].pinned, false)
equal('pruning rewrites the file too', JSON.parse(readFileSync(stateFile, 'utf8')).pinned, [])

/* ---- bad input ---- */

let threw = false
try { internals.dispatch(ctx, { op: 'nope', sessionId: sessionA }) } catch { threw = true }
check('unknown op throws', threw)
threw = false
try { internals.dispatch(ctx, { op: 'toggle', id: 'fake-alpha', enabled: false }) } catch { threw = true }
check('toggle without a session throws', threw)

/* ---- rpc route ---- */

check('rpc route registered', registeredRoutes.length === 1)
const route = registeredRoutes[0]
equal('route is a prefix mount', route.kind, 'prefix')
equal('route path', route.path, internals.RPC_CHANNEL)

function fakeResponse() {
  const box = { status: 0, headers: {}, body: '' }
  return {
    box,
    writeHead(status, headers) { box.status = status; box.headers = headers || {} },
    end(body) { box.body = body || '' },
  }
}

async function call(body, options = {}) {
  const response = fakeResponse()
  const request = {
    method: options.method || 'POST',
    headers: { 'content-type': options.contentType === undefined ? 'application/json' : options.contentType },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  await route.handler(request, response)
  return response.box
}

const stateReply = await call({ op: 'state', sessionId: sessionA })
equal('rpc state answers 200', stateReply.status, 200)
check('rpc state is json', String(stateReply.headers['content-type']).includes('application/json'))
check('rpc state body parses', JSON.parse(stateReply.body).ok === true)

const getReply = await call({}, { method: 'GET' })
equal('non-POST is rejected', getReply.status, 405)

const formReply = await call({}, { contentType: 'text/plain' })
equal('non-json content type is rejected', formReply.status, 415)

const badReply = await call({ op: 'toggle', sessionId: sessionA })
check('bad toggle answers 400 with a message', badReply.status === 400 && JSON.parse(badReply.body).ok === false)

/* ---- client bundle ---- */

const bundleSource = readFileSync(join(process.cwd(), 'lib', 'client', 'index.js'), 'utf8')
let loaded = null
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
new Function('window', bundleSource)(globalThis.window)
check('bundle calls __ModuleLoader__.load', Boolean(loaded))
equal('bundle id is the package name', loaded && loaded.id, 'dsh-session-switches')

const reactStub = {
  createElement() { return {} },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useLayoutEffect() {},
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}
const clientModule = loaded.factory(name => {
  if (name === 'react') return reactStub
  throw new Error('unexpected import: ' + name)
})
equal('client inject list', clientModule.inject, ['slots'])
check('client exports apply', typeof clientModule.apply === 'function')

const slots = []
const clientCtx = {
  slots: {
    inject(name, callback) { callback() },
    register(spec, component) { slots.push({ spec, component }); return () => {} },
  },
}
clientModule.apply(clientCtx)
equal('one slot registered', slots.length, 1)
equal('slot target', slots[0] && slots[0].spec.name, 'sidebar.footer.action')
equal('slot id', slots[0] && slots[0].spec.id, 'session-switches')
check('slot component is a function', typeof slots[0].component === 'function')

/* ---- report ---- */

if (failures.length) {
  console.error('FAILED ' + failures.length + '/' + checks)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('ok: ' + checks + ' checks passed')