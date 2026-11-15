'use strict'
/*
 * dsh-session-switches — client half.
 *
 * Renders the switchboard button in the sidebar footer and the popover it
 * opens. All truth lives on the host: this file only asks for a snapshot and
 * posts intents, then repaints from the snapshot the host returns, so the
 * sidebar can never drift from what the guard actually enforces.
 *
 * Shipped as a plain CommonJS module wrapped in window.__ModuleLoader__.load by
 * scripts/build-client.mjs (no bundler is available in this profile, and the
 * only runtime import is react).
 */
var React = require('react')
var h = React.createElement
var useState = React.useState
var useEffect = React.useEffect
var useLayoutEffect = React.useLayoutEffect
var useRef = React.useRef
var useCallback = React.useCallback
var useMemo = React.useMemo

var RPC = '/dsh-session-switches/rpc'
var STYLE_ID = 'dsh-session-switches-style'
var ACCENT = 'var(--dsh-color-accent, var(--dsh-accent, #5b8cff))'

var WORDS = {
  zh: {
    button: '插件开关',
    title: '插件开关',
    subtitle: '只影响当前这个对话',
    noSession: '还没有打开的对话。新建或打开一个对话后，就能在这里单独开关插件。',
    mutedBadge: '本对话已关闭的插件',
    tabActive: '本对话',
    tabManage: '全部插件',
    emptyPinned: '还没有固定任何插件。',
    emptyPinnedAction: '去挑选插件',
    emptyAll: '没有发现已安装的插件。',
    on: '开',
    off: '关',
    pin: '固定到侧边栏',
    unpin: '从侧边栏移除',
    tools: '个工具',
    noTools: '没有可拦截的工具',
    loading: '正在读取插件清单…',
    reset: '本对话恢复默认',
    rescan: '重新扫描',
    hint: '关闭后，该插件在本对话里的工具不会被调用。',
    hidden: '另有 {n} 个插件没有可归属的工具（多为内置界面插件），不在列表里。',
    failed: '读取失败',
    retry: '重试',
  },
  en: {
    button: 'Plugin switches',
    title: 'Plugin switches',
    subtitle: 'Applies to this conversation only',
    noSession: 'No conversation is open. Open one to switch plugins for it alone.',
    mutedBadge: 'Plugins switched off in this conversation',
    tabActive: 'This chat',
    tabManage: 'All plugins',
    emptyPinned: 'No plugin pinned yet.',
    emptyPinnedAction: 'Choose plugins',
    emptyAll: 'No installed plugin found.',
    on: 'On',
    off: 'Off',
    pin: 'Pin to sidebar',
    unpin: 'Remove from sidebar',
    tools: 'tools',
    noTools: 'No interceptable tool',
    loading: 'Reading plugin inventory…',
    reset: 'Reset this chat',
    rescan: 'Rescan',
    hint: 'When off, this plugin cannot run its tools in this conversation.',
    hidden: '{n} more plugins expose no attributable tool and are not listed.',
    failed: 'Could not load',
    retry: 'Retry',
  },
}

function pickWords() {
  var tag = ''
  try {
    tag = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || ''
  } catch (error) { tag = '' }
  if (!tag) {
    try { tag = (typeof navigator !== 'undefined' && navigator.language) || '' } catch (error) { tag = '' }
  }
  return /^zh/i.test(tag) ? WORDS.zh : WORDS.en
}

function rpc(op, payload) {
  var body = Object.assign({ op: op }, payload || {})
  return fetch(RPC, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response.json()
  }).then(function (data) {
    if (data && data.ok === false) throw new Error(data.error || 'request failed')
    return data
  })
}

function currentSessionId(state) {
  if (!state || !state.byId) return undefined
  var list = Object.values(state.byId)
  for (var index = 0; index < list.length; index += 1) {
    var entry = list[index]
    if (entry && entry.retainedBy && (entry.retainedBy.mainView || 0) > 0) return entry.id
  }
  return undefined
}

var CSS_LINES = [
  '.dssw-root{position:relative;display:flex;justify-content:inherit;width:100%}',
  '.dssw-trigger{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;text-align:left;opacity:.78;transition:background .12s ease,opacity .12s ease}',
  '.dssw-trigger:hover{background:color-mix(in srgb,currentColor 8%,transparent);opacity:1}',
  '.dssw-trigger[aria-expanded="true"]{background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}',
  '.dssw-trigger-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:18px;height:18px}',
  '.dssw-trigger-label{flex:1 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.dssw-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:' + ACCENT + ';box-shadow:0 0 0 3px color-mix(in srgb,' + ACCENT + ' 22%,transparent)}',
  '.dssw-pop{position:fixed;z-index:9000;display:flex;flex-direction:column;width:322px;max-height:min(62vh,520px);border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 18px 44px rgba(0,0,0,.22),0 2px 10px rgba(0,0,0,.10);overflow:hidden;font-size:13px}',
  '.dssw-head{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 8px}',
  '.dssw-head-main{flex:1 1 auto;min-width:0}',
  '.dssw-head-title{font-size:13px;font-weight:600;letter-spacing:.01em}',
  '.dssw-head-sub{margin-top:2px;font-size:11px;opacity:.55}',
  '.dssw-icon-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.6}',
  '.dssw-icon-btn:hover{background:color-mix(in srgb,currentColor 10%,transparent);opacity:1}',
  '.dssw-tabs{display:flex;gap:2px;margin:0 12px 8px;padding:2px;border-radius:8px;background:color-mix(in srgb,currentColor 7%,transparent)}',
  '.dssw-tab{flex:1 1 0;padding:5px 0;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;opacity:.6}',
  '.dssw-tab[aria-selected="true"]{background:Canvas;opacity:1;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.14)}',
  '.dssw-list{flex:1 1 auto;min-height:0;padding:0 6px 6px;overflow:auto}',
  '.dssw-row{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px}',
  '.dssw-row:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
  '.dssw-ava{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,currentColor 9%,transparent);font-size:10px;font-weight:600;text-transform:uppercase;opacity:.75}',
  '.dssw-row-main{flex:1 1 auto;min-width:0}',
  '.dssw-row-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12.5px;font-weight:500}',
  '.dssw-row-sub{margin-top:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10.5px;opacity:.5}',
  '.dssw-pin{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.32}',
  '.dssw-pin:hover{background:color-mix(in srgb,currentColor 10%,transparent);opacity:.8}',
  '.dssw-pin[aria-pressed="true"]{opacity:.9;color:' + ACCENT + '}',
  '.dssw-switch{position:relative;flex:0 0 auto;width:32px;height:18px;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,currentColor 18%,transparent);cursor:pointer;transition:background .14s ease}',
  '.dssw-switch .dssw-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:Canvas;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .14s ease}',
  '.dssw-switch.is-on{background:' + ACCENT + '}',
  '.dssw-switch.is-on .dssw-knob{transform:translateX(14px)}',
  '.dssw-switch[disabled]{opacity:.35;cursor:not-allowed}',
  '.dssw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 16px;text-align:center;font-size:12px;opacity:.62}',
  '.dssw-empty button{padding:5px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer}',
  '.dssw-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px 10px;padding:7px 12px 9px;border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);font-size:10.5px;opacity:.55}',
  '.dssw-foot-text{flex:1 1 100%;line-height:1.35}',
  '.dssw-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;font-size:10.5px;text-decoration:underline;cursor:pointer;opacity:.9;white-space:nowrap}',
  '.dssw-error{margin:0 12px 8px;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,#e5484d 14%,transparent);color:#e5484d;font-size:11.5px}',
  '.dssw-note{margin:0 12px 6px;font-size:10.5px;line-height:1.4;opacity:.5}',
  '.dssw-row.is-muted .dssw-row-title{opacity:.5}',
  '.dssw-row.is-muted .dssw-ava{opacity:.4}',
  '.dssw-count{flex:0 0 auto;min-width:16px;padding:0 4px;border-radius:999px;background:color-mix(in srgb,' + ACCENT + ' 22%,transparent);color:' + ACCENT + ';font-size:10px;line-height:16px;text-align:center;font-weight:600}',
]

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  var node = document.createElement('style')
  node.id = STYLE_ID
  node.textContent = CSS_LINES.join('\n')
  document.head.appendChild(node)
}

function SwitchIcon() {
  // Three sliders: reads as "settings for what is on", not as an on/off toggle.
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.45 }),
    h('circle', { cx: 5, cy: 4.5, r: 1.7, fill: 'Canvas', stroke: 'currentColor', strokeWidth: 1.3 }),
    h('circle', { cx: 10.6, cy: 8, r: 1.7, fill: 'Canvas', stroke: 'currentColor', strokeWidth: 1.3 }),
    h('circle', { cx: 6.6, cy: 11.5, r: 1.7, fill: 'Canvas', stroke: 'currentColor', strokeWidth: 1.3 }),
  )
}

function PinIcon() {
  return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M9.2 1.8 14 6.6l-1.7 1.7-1.1-.4-3.2 3.2.3 2.1-1.4 1.4-3-3-3 2.6-.9-.9 2.6-3-3-3L3 6l2.1.3 3.2-3.2-.4-1.1L9.2 1.8Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
  )
}

function ToolRow(props) {
  var entry = props.entry
  var words = props.words
  var showPin = props.showPin
  var initial = (entry.title || entry.name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || '?'
  var sub = entry.tools.length
    ? entry.tools.length + ' ' + words.tools + (entry.tools.length <= 3 ? ' · ' + entry.tools.join(' · ') : '')
    : words.noTools
  return h('div', { className: 'dssw-row' + (entry.muted ? ' is-muted' : '') },
    h('span', { className: 'dssw-ava', 'aria-hidden': 'true' }, initial),
    h('div', { className: 'dssw-row-main' },
      h('div', { className: 'dssw-row-title', title: entry.description || entry.name }, entry.title),
      h('div', { className: 'dssw-row-sub', title: entry.tools.join(', ') }, sub),
    ),
    showPin ? h('button', {
      type: 'button',
      className: 'dssw-pin',
      'aria-pressed': entry.pinned ? 'true' : 'false',
      title: entry.pinned ? words.unpin : words.pin,
      'aria-label': entry.pinned ? words.unpin : words.pin,
      onClick: function () { props.onPin(entry) },
    }, h(PinIcon)) : null,
    h('button', {
      type: 'button',
      className: 'dssw-switch' + (entry.muted ? '' : ' is-on'),
      role: 'switch',
      'aria-checked': entry.muted ? 'false' : 'true',
      'aria-label': entry.title + ' ' + (entry.muted ? words.off : words.on),
      disabled: !entry.tools.length,
      title: entry.tools.length ? '' : words.noTools,
      onClick: function () { if (entry.tools.length) props.onToggle(entry) },
    }, h('span', { className: 'dssw-knob' })),
  )
}

function SessionSwitches(props) {
  var words = pickWords()
  var wide = props && props.wide
  var useSessions = (props && props.useSessions) || function () { return undefined }
  var sessionId = useSessions(currentSessionId)

  var openState = useState(false)
  var open = openState[0]
  var setOpen = openState[1]
  var tabState = useState('active')
  var tab = tabState[0]
  var setTab = tabState[1]
  var dataState = useState(null)
  var data = dataState[0]
  var setData = dataState[1]
  var errorState = useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var loadingState = useState(false)
  var loading = loadingState[0]
  var setLoading = loadingState[1]
  var anchorState = useState(null)
  var anchor = anchorState[0]
  var setAnchor = anchorState[1]

  var rootRef = useRef(null)
  var buttonRef = useRef(null)

  var refresh = useCallback(function () {
    if (!sessionId) { setLoading(false); setData(null); return }
    setLoading(true)
    rpc('state', { sessionId: sessionId }).then(function (next) {
      setData(next)
      setError(null)
    }).catch(function (failure) {
      setError(failure && failure.message ? failure.message : String(failure))
    }).then(function () { setLoading(false) })
  }, [sessionId])

  useEffect(function () {
    ensureStyle()
  }, [])

  useEffect(function () {
    if (open) refresh()
  }, [open, refresh])

  useLayoutEffect(function () {
    if (!open) return undefined
    // Sit beside the rail when the window has room, otherwise above the button:
    // the sidebar is the most crowded strip on screen and the panel should not
    // bury the conversation list it is meant to be used alongside.
    var place = function () {
      var node = buttonRef.current
      if (!node) return
      var box = node.getBoundingClientRect()
      var width = 322
      var right = box.right + 10
      var left = right + width <= window.innerWidth - 8
        ? right
        : Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
      var bottom = Math.max(8, window.innerHeight - box.bottom - 4)
      setAnchor({ left: Math.round(left), bottom: Math.round(bottom) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return function () {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(function () {
    if (!open) return undefined
    var onDown = function (event) {
      var node = rootRef.current
      if (node && !node.contains(event.target)) setOpen(false)
    }
    var onKey = function (event) { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return function () {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(function () { setOpen(false) }, [sessionId])

  var applyResult = function (next) { setData(next); setError(null) }
  var fail = function (failure) {
    setError(failure && failure.message ? failure.message : String(failure))
    if (sessionId) rpc('state', { sessionId: sessionId }).then(setData).catch(function () {})
  }

  var onToggle = useCallback(function (entry) {
    if (!sessionId) return
    var enabled = Boolean(entry.muted)
    setData(function (previous) {
      if (!previous) return previous
      var items = previous.items.map(function (item) {
        return item.id === entry.id ? Object.assign({}, item, { muted: !enabled }) : item
      })
      return Object.assign({}, previous, { items: items })
    })
    rpc('toggle', { sessionId: sessionId, id: entry.id, enabled: enabled }).then(applyResult).catch(fail)
  }, [sessionId])

  var onPin = useCallback(function (entry) {
    rpc('pin', { id: entry.id, pinned: !entry.pinned }).then(applyResult).catch(fail)
  }, [])

  var items = (data && data.items) || []
  var pinnedItems = items.filter(function (item) { return item.pinned })
  var visible = tab === 'manage' ? items : pinnedItems
  var mutedCount = items.filter(function (item) { return item.muted }).length

  var body = null
  if (!sessionId) {
    body = h('div', { className: 'dssw-empty' }, words.noSession)
  } else if (loading && !data) {
    body = h('div', { className: 'dssw-empty' }, words.loading)
  } else if (tab === 'active' && !pinnedItems.length) {
    body = h('div', { className: 'dssw-empty' },
      h('span', null, words.emptyPinned),
      h('button', { type: 'button', onClick: function () { setTab('manage') } }, words.emptyPinnedAction),
    )
  } else if (!visible.length) {
    body = h('div', { className: 'dssw-empty' }, words.emptyAll)
  } else {
    body = h('div', { className: 'dssw-list' }, visible.map(function (entry) {
      return h(ToolRow, {
        key: entry.id,
        entry: entry,
        words: words,
        showPin: tab === 'manage',
        onToggle: onToggle,
        onPin: onPin,
      })
    }))
  }

  var popover = open && anchor ? h('div', {
    className: 'dssw-pop',
    role: 'dialog',
    'aria-label': words.title,
    style: { left: anchor.left + 'px', bottom: anchor.bottom + 'px' },
  },
    h('div', { className: 'dssw-head' },
      h('div', { className: 'dssw-head-main' },
        h('div', { className: 'dssw-head-title' }, words.title),
        h('div', { className: 'dssw-head-sub' }, words.subtitle),
      ),
      h('button', {
        type: 'button',
        className: 'dssw-icon-btn',
        'aria-label': 'Close',
        onClick: function () { setOpen(false) },
      }, h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 2.5l7 7M9.5 2.5l-7 7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )),
    ),
    h('div', { className: 'dssw-tabs', role: 'tablist' },
      h('button', { type: 'button', className: 'dssw-tab', role: 'tab', 'aria-selected': tab === 'active' ? 'true' : 'false', onClick: function () { setTab('active') } }, words.tabActive),
      h('button', { type: 'button', className: 'dssw-tab', role: 'tab', 'aria-selected': tab === 'manage' ? 'true' : 'false', onClick: function () { setTab('manage') } }, words.tabManage),
    ),
    error ? h('div', { className: 'dssw-error', role: 'alert' }, words.failed + ': ' + error) : null,
    data && data.hiddenCount ? h('div', { className: 'dssw-note' }, words.hidden.replace('{n}', String(data.hiddenCount))) : null,
    body,
    h('div', { className: 'dssw-foot' },
      h('span', { className: 'dssw-foot-text' }, words.hint),
      h('button', { type: 'button', className: 'dssw-link', onClick: function () { rpc('rescan', { sessionId: sessionId }).then(applyResult).catch(fail) } }, words.rescan),
      h('button', { type: 'button', className: 'dssw-link', onClick: function () { rpc('reset', { sessionId: sessionId }).then(applyResult).catch(fail) } }, words.reset),
    ),
  ) : null

  return h('div', { className: 'dssw-root', ref: rootRef },
    h('button', {
      type: 'button',
      className: 'dssw-trigger',
      ref: buttonRef,
      'aria-haspopup': 'dialog',
      'aria-expanded': open ? 'true' : 'false',
      title: words.button,
      onClick: function () { setOpen(!open) },
    },
      h('span', { className: 'dssw-trigger-icon' }, h(SwitchIcon)),
      wide ? h('span', { className: 'dssw-trigger-label' }, words.button) : null,
      mutedCount ? h('span', { className: 'dssw-count', title: words.mutedBadge }, String(mutedCount)) : null,
    ),
    popover,
  )
}

ensureStyle()

module.exports.inject = ['slots']
module.exports.apply = function apply(ctx) {
  ensureStyle()
  ctx.slots.inject('sidebar.footer.action', function () {
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'session-switches',
      order: 40,
    }, SessionSwitches)
  })
}