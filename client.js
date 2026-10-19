/**
 * utm-resmon — Client half.
 *
 * Status-bar telemetry chip in the `conversation.composer.dock` slot,
 * polling GET /dsh-resmon every 5s. Structure mirrors dsh-plugin-sysmon
 * (same __ModuleLoader__ bundle, same slots/timer/locale services, same
 * click-to-refresh), but the content is resource attribution: host RSS +
 * top MCP child process + top in-process plugin.
 *
 * Visual: a bespoke memory-bars icon + host RSS in the dock; hovering
 * opens an inline HoverCard preview (shared DSH primitive — a contained
 * 300px card, clamped into the viewport with an above/below flip) with the
 * full per-consumer breakdown — host rows, every MCP process, every plugin
 * group. If the primitives module is unavailable in the client graph, the
 * chip degrades to the sysmon-style text marker with a sectioned `title`
 * tooltip.
 *
 * Design notes (deliberate choices, not defaults):
 * - The anchor blends into the dock row: 12px, theme vars only. The marker
 *   is a bespoke inline SVG (three ascending bars); the gauge icon already
 *   means "token speed" elsewhere in this UI and is never used here.
 * - Panel is information, not decoration: names ellipsize on one line,
 *   numbers sit in a fixed right column with tabular figures, three
 *   sections (host / MCP / plugins), footer with staleness + hint.
 * - Failed refresh keeps last-known data with a staleness note instead of
 *   flashing into an error state; error view appears only with no data yet.
 */
window.__ModuleLoader__.load({
  id: 'utm-resmon',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    // Shared UI primitive: HoverCard for the breakdown panel. Guarded —
    // the client module graph may not provide it, in which case the chip
    // falls back to a title tooltip (sysmon-style).
    // NOTE: no icon is taken from primitives — the gauge icon already means
    // "token speed" elsewhere in this UI, so the marker is a bespoke inline
    // SVG (three ascending memory bars), impossible to confuse.
    let ui = null
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {}
    const HoverCard = ui && ui.HoverCard

    /** Dock marker: three ascending bars (memory usage). currentColor. */
    function MemIcon() {
      return react.createElement('svg',
        { width: 13, height: 13, viewBox: '0 0 12 12', fill: 'currentColor', 'aria-hidden': 'true' },
        react.createElement('rect', { x: 1, y: 7, width: 2.6, height: 4, rx: 0.8 }),
        react.createElement('rect', { x: 4.7, y: 4.6, width: 2.6, height: 6.4, rx: 0.8 }),
        react.createElement('rect', { x: 8.3, y: 2, width: 2.6, height: 9, rx: 0.8 }))
    }

    const NS = 'resmon'
    const ROUTE_PATH = '/dsh-resmon'
    const POLL_MS = 5000
    const inject = ['slots', 'timer', 'locale']
    const WARN_SYS_MEM = 80
    const PANEL_ROWS = 6

    // NOTE: no global composer layout overrides here. The chip renders in
    // the `conversation.composer.dock` slot, so it must not touch
    // [data-composer-card] or its parents (a former
    // `div:has(> [data-composer-card]){flex-direction:row!important;...}`
    // rule broke the composer card layout when combined with other
    // input-slot chips such as the quota ring). Dock-slot CSS only.

    const zh = {
      label: '资源',
      loading: '资源信息加载中…',
      error: '加载失败',
      title: '资源消耗',
      total: '共计',
      host: 'Хост (dsh)',
      rss: '内存',
      heap: '堆',
      peak: 'пик',
      kernel: 'ядро',
      sysmem: '系统',
      mcp: 'MCP',
      plugin: '插件',
      top: '最高',
      none: '无',
      onDisk: 'на диске',
      inHeap: 'делит кучу хоста',
      files: 'файлов',
      stale: '（更新失败，显示上次数据）',
      clickRefresh: '点击立即刷新',
    }
    const en = {
      label: 'Res',
      loading: 'Loading resource info…',
      error: 'Failed to load',
      title: 'Resource usage',
      total: 'cgroup total',
      host: 'Host (dsh)',
      rss: 'RSS',
      heap: 'heap',
      peak: 'peak',
      kernel: 'kernel',
      sysmem: 'sys',
      mcp: 'MCP',
      plugin: 'Plugin',
      top: 'top',
      none: 'none',
      onDisk: 'on disk',
      inHeap: 'shares host heap',
      files: 'files',
      stale: '(refresh failed, showing last data)',
      clickRefresh: 'Click to refresh now',
    }

    const wrapStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 12,
      lineHeight: 1,
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    }
    const chipStyle = {
      background: 'transparent',
      border: 0,
      padding: 0,
      margin: 0,
      font: 'inherit',
      color: 'inherit',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
    }
    const primaryStyle = { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }
    const warnStyle = { color: 'var(--dsw-alias-state-warn-primary)', fontWeight: 600 }
    const errStyle = { color: 'var(--dsw-alias-state-error-primary)' }
    const numStyle = { flex: 'none', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }

    function bytes(v) {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
      if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
      if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB'
      return (n / 1024).toFixed(0) + ' KB'
    }
    function shortCmd(cmd, maxLen) {
      const s = String(cmd || '')
      const base = s.split(' ').filter(Boolean).join(' ')
      const max = maxLen || 40
      return base.length > max ? base.slice(0, max - 1) + '…' : base
    }
    function routeUrl() {
      const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : ''
      return origin + ROUTE_PATH
    }
    async function fetchMetrics() {
      const response = await fetch(routeUrl(), { cache: 'no-store' })
      return response.json()
    }

    /** Multi-line plain-language summary (fallback `title` tooltip). */
    function summaryLines(tt, d) {
      const lines = []
      const h = d.host || {}
      if (d.cgroup && d.cgroup.totalBytes != null) lines.push(tt('total') + ' ' + bytes(d.cgroup.totalBytes))
      lines.push(
        tt('rss') + ' ' + bytes(h.rss) +
        ' · ' + tt('heap') + ' ' + bytes(h.heapUsed) + '/' + bytes(h.heapTotal) +
        ' · ' + tt('sysmem') + ' ' + Math.round(h.system?.percent ?? 0) + '%',
      )
      const topMcp = d.mcp && d.mcp[0]
      lines.push(topMcp
        ? tt('mcp') + ' ' + tt('top') + ': ' + shortCmd(topMcp.cmd) + ' #' + topMcp.pid + ' · ' + bytes(topMcp.rssBytes)
        : tt('mcp') + ': ' + tt('none'))
      const topPlugin = d.plugins && d.plugins[0]
      lines.push(topPlugin
        ? tt('plugin') + ' ' + tt('top') + ': ' + topPlugin.prefix + ' · ' + bytes(topPlugin.bytes)
        : tt('plugin') + ': ' + tt('none'))
      return lines
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'resmon: dictionaries')
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : ((key) => (zh[key] ?? key))

    const GLYPH_OPEN = '▾'
    const GLYPH_CLOSED = '▸'

    /** Plain detail line inside an expanded node (wraps; secondary tone). */
    function DetailLine(text) {
      return react.createElement('div', { style: { overflowWrap: 'break-word' } }, text)
    }

    /**
     * One compact attribution row: disclosure arrow + name (ellipsized) +
     * fixed tabular number. Clicking the arrow expands the per-block detail.
     */
    function PanelNode(id, left, right, detail, expanded, onToggle) {
      const open = !!expanded[id]
      return react.createElement('div', { key: id },
        react.createElement('button',
          {
            type: 'button',
            onClick: () => onToggle(id),
            style: {
              display: 'flex', alignItems: 'baseline', gap: 6, width: '100%',
              background: 'transparent', border: 0, padding: '2px 0', margin: 0,
              font: 'inherit', color: 'inherit', cursor: 'pointer',
              textAlign: 'left', minWidth: 0,
            },
          },
          react.createElement('span',
            { style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 10 } },
            open ? GLYPH_OPEN : GLYPH_CLOSED),
          react.createElement('span',
            { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            left),
          react.createElement('span', { style: numStyle }, right)),
        open && detail
          ? react.createElement('div',
            { style: { margin: '0 0 4px 16px', color: 'var(--dsw-alias-label-secondary)' } },
            detail)
          : null)
    }

      function PanelSection(title, rows) {
        return react.createElement('div', { style: { marginTop: 8 } },
          react.createElement('div',
            { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } }, title),
          rows)
      }

    /** Full attribution tree for the HoverCard: family total + expandable blocks. */
    function BreakdownPanel(tt, state, expanded, onToggle) {
      // No width here: the inline-preview card is fixed at 300px by the
      // primitive itself (INLINE_PREVIEW_WIDTH); this block just fills it.
      const bodyStyle = { fontSize: 12, lineHeight: 1.55 }
      const d = state.phase === 'ready' ? state.data : null
      const cg = (d && d.cgroup) || null
      const headTotal = cg && cg.totalBytes != null
        ? bytes(cg.totalBytes)
        : d && d.host ? bytes(d.host.rss) : null
      const head = react.createElement('div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 } },
        react.createElement('span', { style: { fontWeight: 600 } }, tt('title')),
        headTotal !== null ? react.createElement('span', { style: numStyle }, headTotal) : null)
      if (d === null) {
        return react.createElement('div', { style: bodyStyle }, head,
          react.createElement('div', { style: { marginTop: 6 } },
            state.phase === 'error' ? (state.error || tt('error')) : tt('loading')))
      }
      const h = d.host || {}
      const hostDetail = [
        DetailLine(tt('heap') + ' ' + bytes(h.heapUsed) + ' / ' + bytes(h.heapTotal)),
        h.external != null ? DetailLine('ext ' + bytes(h.external)) : null,
        cg && cg.peakBytes != null ? DetailLine(tt('peak') + ' ' + bytes(cg.peakBytes)) : null,
        cg && cg.kernelBytes != null ? DetailLine(tt('kernel') + ' ' + bytes(cg.kernelBytes)) : null,
      ]
      const mcps = (d.mcp || []).slice(0, PANEL_ROWS)
      const plugins = (d.plugins || []).slice(0, PANEL_ROWS)
      return react.createElement('div', { style: bodyStyle }, head,
        PanelSection(tt('host'),
          PanelNode('host', tt('host') + ' · ' + tt('rss'), bytes(h.rss), hostDetail, expanded, onToggle)),
        PanelSection(tt('sysmem') + ' ' + Math.round(h.system?.percent ?? 0) + '%', null),
        PanelSection(tt('mcp') + (mcps.length > 0 ? ' · ' + mcps.length : ''),
          mcps.length > 0
            ? mcps.map((m) => PanelNode('mcp-' + m.pid,
              shortCmd(m.cmd) + ' #' + m.pid, bytes(m.rssBytes),
              [DetailLine('#' + m.pid), DetailLine(String(m.cmd || ''))],
              expanded, onToggle))
            : tt('none')),
        PanelSection(tt('plugin') + (plugins.length > 0 ? ' · ' + plugins.length : ''),
          plugins.length > 0
            ? plugins.map((g) => PanelNode('plug-' + g.prefix,
              g.prefix, bytes(g.bytes) + ' · ' + tt('onDisk'),
              [DetailLine(g.files + ' ' + tt('files') + ' · ' + tt('onDisk')),
               DetailLine(tt('inHeap'))],
              expanded, onToggle))
            : tt('none')),
        react.createElement('div',
          { style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary)' } },
          state.stale ? tt('stale') : tt('clickRefresh')))
    }

      function ResView(props) {
        const tt = props && typeof props.t === 'function' ? props.t : t
        const [state, setState] = react.useState({ phase: 'loading', data: null, error: null, stale: false })
        const [expanded, setExpanded] = react.useState({})
        const onToggle = (id) => setExpanded((s) => ({ ...s, [id]: !s[id] }))

        react.useEffect(() => {
          let alive = true
          const refresh = async () => {
            try {
              const res = await fetchMetrics()
              if (!alive) return
              if (res && res.ok === true) setState({ phase: 'ready', data: res, error: null, stale: false })
              else setState((s) => s.data
                ? { ...s, stale: true }
                : { phase: 'error', data: null, error: (res && res.error) || tt('error'), stale: false })
            } catch (err) {
              if (!alive) return
              setState((s) => s.data
                ? { ...s, stale: true }
                : { phase: 'error', data: null, error: String((err && err.message) || err), stale: false })
            }
          }
          refresh()
          const stop = ctx.interval(refresh, POLL_MS)
          return () => { alive = false; stop() }
        }, [])

        const onClick = () => {
          setState((s) => ({ phase: 'loading', data: s.data, error: null, stale: false }))
          fetchMetrics().then((res) => {
            if (res && res.ok === true) setState({ phase: 'ready', data: res, error: null, stale: false })
            else setState((s) => s.data
              ? { ...s, stale: true }
              : { phase: 'error', data: null, error: (res && res.error) || tt('error'), stale: false })
          }).catch((err) => {
            setState((s) => s.data
              ? { ...s, stale: true }
              : { phase: 'error', data: null, error: String((err && err.message) || err), stale: false })
          })
        }

        let inner
        let title = ''
        if (state.phase === 'ready' && state.data !== null) {
          const d = state.data
          if (!HoverCard) {
            const lines = summaryLines(tt, d)
            if (state.stale) lines.push(tt('stale'))
            title = lines.join('\n')
          }
          const sysHot = (d.host && d.host.system && d.host.system.percent >= WARN_SYS_MEM) || state.stale
          // The chip shows the family total (same number as the panel head),
          // falling back to host RSS where cgroup accounting is absent.
          const chipTotal = d.cgroup && d.cgroup.totalBytes != null
            ? d.cgroup.totalBytes
            : d.host && d.host.rss
          inner = react.createElement('span', { style: sysHot ? warnStyle : undefined },
            react.createElement('span', { style: primaryStyle }, bytes(chipTotal)))
        } else if (state.phase === 'loading' && state.data === null) {
          title = tt('loading')
          inner = react.createElement('span', null, tt('loading'))
        } else {
          title = state.error || tt('error')
          inner = react.createElement('span', { style: errStyle }, '--')
        }

        const icon = react.createElement(MemIcon, {})
        const anchor = react.createElement('button',
          { type: 'button', style: chipStyle, title: HoverCard ? undefined : title, onClick: onClick },
          icon, inner)

        // inline preview: a contained 300px card pinned inside the viewport
        // (horizontal clamp + above/below flip). NOT variant="preview" — its
        // width is derived from the anchor width (lib: bounds.width - 48),
        // which collapses a dock-chip anchor into a ~2px strip; and NOT
        // plain compact — it always opens right of the anchor and runs
        // off-window from a dock-edge anchor.
        const chip = HoverCard
          ? react.createElement(HoverCard, {
            anchor: anchor,
            content: BreakdownPanel(tt, state, expanded, onToggle),
            openDelayMs: 400,
            inline: true,
          })
          : anchor

        return react.createElement('div', { style: wrapStyle }, chip)
      }

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'utm-resmon',
        order: 4,
        locale: NS,
        label: () => 'RM ' + t('label'),
      }, ResView))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
