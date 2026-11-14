window.__ModuleLoader__.load({
  id: 'dsh-disk-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'diskCleaner'
    const API = '/api/disk-cleaner'
    const PANEL_ID = 'disk-cleaner'

    /* ------------------------------------------------------------- utilities -- */

    /**
     * Resolve one route path against the page's base so a reverse proxy that
     * owns a path prefix keeps it. The host's own carrier does the same. The
     * leading slash is dropped on purpose: `new URL('api/...', baseURI)` keeps
     * a base path prefix while `/api/...` would drop it.
     */
    function apiUrl(suffix) {
      const full = API + suffix
      if (typeof document === 'undefined') return full
      try {
        return new URL(full.replace(/^\//, ''), document.baseURI).href
      } catch {
        return full
      }
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
      if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
      return Math.round(bytes) + ' B'
    }

    async function request(path, init, timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 180000)
      try {
        const response = await fetch(apiUrl(path), { ...init, signal: controller.signal })
        let body
        try {
          body = await response.json()
        } catch {
          throw new Error('HTTP ' + response.status + '：响应不是 JSON')
        }
        if (!response.ok || body.ok === false) {
          throw new Error(body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status)
        }
        return body
      } finally {
        clearTimeout(timer)
      }
    }

    const RISK_STYLE = {
      safe: { label: '安全', color: 'var(--dsw-alias-state-success-primary)' },
      caution: { label: '谨慎', color: 'var(--dsw-alias-state-warn-primary)' },
      advanced: { label: '高级', color: 'var(--dsw-alias-state-error-primary)' },
    }

    /* ---------------------------------------------------------------- styles -- */

    const CSS = `
.dskc_root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dskc_scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:24px clamp(20px,4vw,44px) 40px}
.dskc_inner{width:100%;max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.dskc_head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dskc_title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:.2px}
.dskc_sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dskc_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dskc_btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s}
.dskc_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.dskc_btn:disabled{opacity:.5;cursor:not-allowed}
.dskc_btn_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dskc_btn_primary:hover:not(:disabled){filter:brightness(1.05);background:var(--dsw-alias-brand-primary)}
.dskc_btn_danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.dskc_btn_danger:hover:not(:disabled){filter:brightness(1.05);background:var(--dsw-alias-state-error-primary)}
.dskc_drives{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.dskc_drive{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.dskc_drive_top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dskc_drive_name{font-size:15px;font-weight:600}
.dskc_drive_num{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dskc_bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dskc_bar_fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .4s ease}
.dskc_card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dskc_card_head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dskc_card_title{font-size:13px;font-weight:600}
.dskc_advice{margin:0;padding:12px 16px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap}
.dskc_row{display:flex;align-items:flex-start;gap:12px;padding:11px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dskc_row:last-child{border-bottom:none}
.dskc_row:hover{background:var(--dsw-alias-bg-layer-2)}
.dskc_check{appearance:none;flex:0 0 auto;width:16px;height:16px;margin-top:2px;border:1.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-base);cursor:pointer;position:relative;transition:background .12s,border-color .12s}
.dskc_check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dskc_check:checked::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}
.dskc_check:disabled{opacity:.4;cursor:not-allowed}
.dskc_row_main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.dskc_row_title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:19px;font-weight:500}
.dskc_row_path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.dskc_row_desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dskc_row_reason{font-size:12px;line-height:18px;color:var(--dsw-alias-brand-primary)}
.dskc_tag{flex:0 0 auto;font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.9}
.dskc_size{flex:0 0 auto;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.dskc_muted{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dskc_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dskc_ok{color:var(--dsw-alias-state-success-primary);font-size:13px}
.dskc_empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;display:flex;flex-direction:column;gap:10px;align-items:center}
.dskc_spinner{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dskc_spin .8s linear infinite}
@keyframes dskc_spin{to{transform:rotate(360deg)}}
.dskc_foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dskc_result{margin:0;padding:12px 16px;font-size:12px;line-height:19px;border-top:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;font-family:inherit}
.dskc_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;padding:12px 16px}
.dskc_mini{display:flex;flex-direction:column;gap:4px}
.dskc_mini_name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dskc_mini_bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dskc_mini_fill{height:100%;background:var(--dsw-alias-brand-primary);opacity:.7}
`

    function ensureStyle() {
      const ID = 'dsh-disk-cleaner-style'
      if (typeof document === 'undefined') return () => {}
      let node = document.getElementById(ID)
      if (node === null) {
        node = document.createElement('style')
        node.id = ID
        node.textContent = CSS
        ;(document.head ?? document.documentElement).appendChild(node)
      }
      return () => {
        const current = document.getElementById(ID)
        if (current !== null) current.remove()
      }
    }

    /* -------------------------------------------------------------- sidebar -- */

    function DiskIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = props !== null && props !== undefined && props.active === true
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.7,
        strokeLinecap: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 12, cy: 12, r: 8.4 }),
        h('circle', {
          cx: 12,
          cy: 12,
          r: 1.6,
          fill: 'currentColor',
          stroke: 'none',
        }),
        h('path', { d: 'M12 3.6a8.4 8.4 0 0 1 7.2 4.2', opacity: active ? 0.8 : 0.45 }),
      )
    }

    /* ----------------------------------------------------------------- panel -- */

    function Panel(props) {
      const t = props.t
      const [volumes, setVolumes] = React.useState([])
      const [scan, setScan] = React.useState(null)
      const [analysis, setAnalysis] = React.useState(null)
      const [selected, setSelected] = React.useState(() => new Set())
      const [phase, setPhase] = React.useState('idle')     // idle | scanning | analyzing | cleaning | done
      const [error, setError] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const alive = React.useRef(true)
      const autoStarted = React.useRef(false)
      // Re-arm on every mount, not just the first one: React's StrictMode
      // unmounts and remounts effects, and a ref left at `false` would make
      // every later result look like it arrived after unmount.
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const refreshVolumes = React.useCallback(async () => {
        try {
          const body = await request('/volumes', undefined, 20000)
          if (alive.current) setVolumes(Array.isArray(body.volumes) ? body.volumes : [])
        } catch {
          /* header stays empty; the scan reports the real failure */
        }
      }, [])

      React.useEffect(() => { void refreshVolumes() }, [refreshVolumes])

      const runScan = React.useCallback(async () => {
        setPhase('scanning')
        setError(null)
        setResult(null)
        setAnalysis(null)
        setSelected(new Set())
        try {
          const body = await request('/scan', undefined, 300000)
          if (!alive.current) return
          const next = body.scan
          setScan(next)
          setVolumes(Array.isArray(next.volumes) ? next.volumes : [])
          setPhase('analyzing')

          // Preselect the safe, non-report items while the model works.
          const preset = new Set()
          for (const item of next.items) {
            if (item.reportOnly !== true && item.risk === 'safe' && item.bytes > 0) preset.add(item.id)
          }
          if (alive.current) setSelected(preset)

          const analyzed = await request('/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scanId: next.id }),
          }, 180000)
          if (!alive.current) return
          setAnalysis(analyzed.analysis ?? null)
          setPhase('idle')

          // The model's own recommendation replaces the rule-based preset.
          const ranking = analyzed.analysis
          if (ranking !== null && ranking !== undefined && ranking.ai === true && Array.isArray(ranking.items)) {
            const next2 = new Set()
            for (const row of ranking.items) {
              if (row.recommended === true) next2.add(row.id)
            }
            setSelected(next2.size > 0 ? next2 : preset)
          }
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('idle')
        }
      }, [])

      // Opening the sidebar entry is the request: scan and analyse right away.
      // The ref keeps a second mount (StrictMode, a slot remount) from
      // launching another scan while the first one is still in flight. The
      // panel instance is discarded when the user leaves the page, so the ref
      // resets naturally on the next visit.
      React.useEffect(() => {
        if (autoStarted.current) return
        autoStarted.current = true
        void runScan()
      }, [runScan])

      const itemIndex = React.useMemo(() => {
        if (scan === null) return []
        const rank = new Map()
        const reason = new Map()
        const advice = analysis
        if (advice !== null && advice !== undefined && Array.isArray(advice.items)) {
          for (const row of advice.items) {
            if (typeof row.id !== 'string') continue
            rank.set(row.id, Number.isFinite(row.priority) ? row.priority : 50)
            if (typeof row.reason === 'string' && row.reason !== '') reason.set(row.id, row.reason)
          }
        }
        return scan.items
          .filter((item) => item.bytes > 0 || item.reportOnly === true)
          .map((item) => ({ item, priority: rank.has(item.id) ? rank.get(item.id) : 50, reason: reason.get(item.id) }))
          .sort((a, b) => {
            if (a.item.reportOnly !== b.item.reportOnly) return a.item.reportOnly ? 1 : -1
            if (a.priority !== b.priority) return a.priority - b.priority
            return b.item.bytes - a.item.bytes
          })
      }, [scan, analysis])

      const selectable = React.useMemo(
        () => itemIndex.filter((row) => row.item.reportOnly !== true),
        [itemIndex],
      )

      const selectedBytes = React.useMemo(() => {
        let sum = 0
        for (const row of selectable) {
          if (selected.has(row.item.id)) sum += row.item.bytes
        }
        return sum
      }, [selectable, selected])

      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const toggleAll = (on) => {
        setSelected(() => (on ? new Set(selectable.map((row) => row.item.id)) : new Set()))
      }

      const clean = React.useCallback(async () => {
        if (scan === null) return
        const ids = [...selected]
        if (ids.length === 0) return
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(
              '即将删除 ' + ids.length + ' 个清理项（预计释放 ' + formatBytes(selectedBytes) + '）。\n' +
              '回收站清空、旧系统备份、大文件删除都无法撤销。要继续吗？',
            )
          : true
        if (!confirmed) return
        setPhase('cleaning')
        setError(null)
        setResult(null)
        try {
          const body = await request('/clean', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scanId: scan.id, ids }),
          }, 600000)
          if (!alive.current) return
          setResult(body)
          setPhase('done')
          setScan(null)
          setAnalysis(null)
          setSelected(new Set())
          await refreshVolumes()
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('idle')
        }
      }, [scan, selected, selectedBytes, refreshVolumes])

      const busy = phase === 'scanning' || phase === 'analyzing' || phase === 'cleaning'
      const advice = analysis !== null && analysis !== undefined ? analysis : null
      const notice = advice !== null && advice.ai !== true && typeof advice.note === 'string' ? advice.note : null

      /* ------------------------------------------------------------ render -- */

      const driveCards = volumes.map((volume) => {
        const usedPct = volume.total > 0 ? (volume.used / volume.total) * 100 : 0
        const critical = usedPct >= 90
        return h('div', { key: volume.letter, className: 'dskc_drive' },
          h('div', { className: 'dskc_drive_top' },
            h('span', { className: 'dskc_drive_name' }, volume.letter + ': 盘'),
            h('span', { className: 'dskc_drive_num' }, formatBytes(volume.free) + ' 可用 / ' + formatBytes(volume.total)),
          ),
          h('div', { className: 'dskc_bar' },
            h('div', {
              className: 'dskc_bar_fill',
              style: { width: Math.max(1, Math.min(100, usedPct)).toFixed(1) + '%', background: critical ? 'var(--dsw-alias-state-error-primary)' : undefined },
            }),
          ),
          h('span', { className: 'dskc_muted' }, '已用 ' + usedPct.toFixed(1) + '% · 共 ' + formatBytes(volume.used)),
        )
      })

      const rows = itemIndex.map(({ item, reason }) => {
        const risk = RISK_STYLE[item.risk] ?? RISK_STYLE.caution
        const isSelected = selected.has(item.id)
        const disabled = item.reportOnly === true || busy
        return h('div', { key: item.id, className: 'dskc_row' },
          h('input', {
            type: 'checkbox',
            className: 'dskc_check',
            checked: isSelected,
            disabled,
            'aria-label': item.label,
            onChange: () => toggle(item.id),
          }),
          h('div', { className: 'dskc_row_main' },
            h('div', { className: 'dskc_row_title' },
              h('span', {
                className: item.kind === 'file' ? 'dskc_row_path' : undefined,
                title: item.label,
              }, item.label),
              h('span', { className: 'dskc_tag', style: { color: risk.color } }, risk.label),
              item.admin && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-label-secondary)' } }, '需管理员'),
              item.blocked && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '当前无权限读取'),
              item.reportOnly && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-label-secondary)' } }, '仅提示'),
              item.truncated && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '未完整统计'),
            ),
            item.detail !== undefined && item.detail !== '' && h('div', { className: 'dskc_row_desc' }, item.detail),
            reason !== undefined && h('div', { className: 'dskc_row_reason' }, 'AI：' + reason),
          ),
          h('span', { className: 'dskc_size' }, formatBytes(item.bytes)),
        )
      })

      const breakdownCards = scan === null ? null : scan.breakdown.map((entry) => {
        const max = entry.rows.reduce((acc, row) => Math.max(acc, row.bytes), 0) || 1
        return h('div', { key: 'bd-' + entry.letter, className: 'dskc_card' },
          h('div', { className: 'dskc_card_head' },
            h('span', { className: 'dskc_card_title' }, entry.letter + ': 盘占用分布'),
            entry.truncated && h('span', { className: 'dskc_muted' }, '部分目录未完整统计'),
          ),
          h('div', { className: 'dskc_grid' },
            entry.rows.map((row) => h('div', { key: row.path, className: 'dskc_mini' },
              h('span', { className: 'dskc_mini_name', title: row.path }, row.name),
              h('div', { className: 'dskc_mini_bar' },
                h('div', { className: 'dskc_mini_fill', style: { width: Math.max(2, (row.bytes / max) * 100).toFixed(1) + '%' } }),
              ),
              h('span', { className: 'dskc_muted' }, formatBytes(row.bytes)),
            )),
          ),
        )
      })

      return h('div', { className: 'dskc_root' },
        h('div', { className: 'dskc_scroll' },
          h('div', { className: 'dskc_inner' },
            h('div', { className: 'dskc_head' },
              h('div', null,
                h('h1', { className: 'dskc_title' }, t('panel.title')),
                h('p', { className: 'dskc_sub' },
                  scan === null
                    ? t('panel.subtitle')
                    : t('panel.scanned') + ' · 用时 ' + (scan.tookMs / 1000).toFixed(1) + ' 秒' +
                      (advice !== null && advice.ai === true ? ' · 分析模型 ' + advice.model : ''),
                ),
              ),
              h('div', { className: 'dskc_actions' },
                h('button', {
                  type: 'button',
                  className: 'dskc_btn',
                  onClick: () => void runScan(),
                  disabled: busy,
                }, scan === null ? t('panel.scan') : t('panel.rescan')),
              ),
            ),

            driveCards.length > 0 && h('div', { className: 'dskc_drives' }, driveCards),

            error !== null && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, t('panel.error')),
              ),
              h('p', { className: 'dskc_err', style: { padding: '12px 16px', margin: 0 } }, error),
            ),

            result !== null && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, t('panel.cleaned')),
                h('span', { className: 'dskc_ok' }, '+' + formatBytes(result.freed)),
              ),
              h('pre', { className: 'dskc_result' },
                (result.results ?? []).map((row) => {
                  const head = (row.freed > 0 ? '✓ ' : '· ') + row.label + ' — ' + formatBytes(row.freed)
                  const errs = (row.errors ?? []).slice(0, 3).map((line) => '    ! ' + line)
                  return [head, ...errs].join('\n')
                }).join('\n') || t('panel.nothingCleaned'),
              ),
            ),

            (phase === 'scanning' || phase === 'analyzing') && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_empty' },
                h('div', { className: 'dskc_spinner' }),
                h('span', null, phase === 'scanning' ? t('panel.scanning') : t('panel.analyzing')),
                h('span', { className: 'dskc_muted' }, t('panel.scanHint')),
              ),
            ),

            phase === 'cleaning' && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_empty' },
                h('div', { className: 'dskc_spinner' }),
                h('span', null, t('panel.cleaning')),
              ),
            ),

            scan !== null && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, t('panel.items')),
                h('div', { className: 'dskc_actions' },
                  h('button', {
                    type: 'button', className: 'dskc_btn',
                    onClick: () => toggleAll(true), disabled: busy,
                  }, t('panel.selectAll')),
                  h('button', {
                    type: 'button', className: 'dskc_btn',
                    onClick: () => toggleAll(false), disabled: busy,
                  }, t('panel.selectNone')),
                ),
              ),
              advice !== null && advice.ai === true && typeof advice.advice === 'string' && advice.advice !== ''
                ? h('p', { className: 'dskc_advice' }, 'AI 建议：' + advice.advice)
                : notice !== null ? h('p', { className: 'dskc_advice' }, notice) : null,
              rows.length > 0 ? rows : h('div', { className: 'dskc_empty' }, t('panel.noItems')),
              h('div', { className: 'dskc_foot' },
                h('span', { className: 'dskc_muted' },
                  '已选 ' + selected.size + ' 项 · 预计释放 ' + formatBytes(selectedBytes)),
                h('div', { className: 'dskc_actions' },
                  h('button', {
                    type: 'button', className: 'dskc_btn dskc_btn_danger',
                    onClick: () => void clean(),
                    disabled: busy || selected.size === 0,
                  }, t('panel.clean')),
                ),
              ),
            ),

            ...(breakdownCards ?? []),

            scan === null && phase === 'idle' && result === null && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_empty' },
                h('span', null, t('panel.emptyHint')),
              ),
            ),
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- install -- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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
        }
        const EN = {
          'panel.title': 'Disk cleanup',
          'panel.subtitle': 'Scan C / D space usage; the model ranks what to clean',
          'panel.scanned': 'Scan complete',
          'panel.scan': 'Start scan',
          'panel.rescan': 'Rescan',
          'panel.scanning': 'Scanning drives…',
          'panel.analyzing': 'Asking the model to rank the findings…',
          'panel.scanHint': 'The first scan walks directories, so it can take a while.',
          'panel.cleaning': 'Cleaning…',
          'panel.items': 'Cleanup items',
          'panel.selectAll': 'Select all',
          'panel.selectNone': 'Clear',
          'panel.clean': 'Clean selected',
          'panel.error': 'Something failed',
          'panel.cleaned': 'Result',
          'panel.noItems': 'Nothing cleanable was found',
          'panel.nothingCleaned': 'Nothing was actually removed',
          'panel.emptyHint': 'Run a scan to see what occupies the drives',
        }

        ctx.effect(() => ensureStyle(), 'disk-cleaner: styles')
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'disk-cleaner: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'disk-cleaner: en dictionary')

        const t = ctx.locale !== undefined && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => key

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel.title'),
          locale: NS,
        }, DiskIcon)), 'disk-cleaner: sidebar entry')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, (props) => h(Panel, { ...props, t }))), 'disk-cleaner: main panel')
      },
    }
  },
})
