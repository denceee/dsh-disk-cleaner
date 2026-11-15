window.__ModuleLoader__.load({
  // Must equal the package name exactly: the loader keys the module table by
  // it, and a mismatch leaves the client half unregistered with no error.
  id: '@dencee/dsh-disk-cleaner',
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
      safe: { label: '安全', color: 'var(--dsw-alias-state-success-primary,#07CA6B)' },
      caution: { label: '谨慎', color: 'var(--dsw-alias-state-warn-primary,#E89558)' },
      advanced: { label: '高级', color: 'var(--dsw-alias-state-error-primary,#EA2143)' },
    }

    /* ---------------------------------------------------------------- styles -- */

    /**
     * Visual contract: one accent, two surface tiers, one glass moment.
     *   - Neutral host surfaces carry the content. Cards are near-opaque and
     *     separated by hairlines, not by translucency: a cleanup tool is read
     *     for numbers, and see-through panels cost contrast.
     *   - The header alone is real frosted glass, sitting over a single soft
     *     wash of the accent. That is the one place blur earns its keep.
     *   - #1856FF is the only accent. Status colour comes from the host state
     *     aliases, so red/amber always mean something.
     *
     * Motion is limited to four events that each carry meaning, never ambience:
     * panel entry (arrival), scan progress (a measurement has no known length,
     * so the track is indeterminate), ranking arrival (the rows take a new
     * order and the reasons appear), and clean completion (the freed total
     * counts up once). Everything is transform/opacity; a `prefers-reduced-
     * motion` block collapses all of it to a plain fade.
     */
    const CSS = `
.dskc_root{
  --dskc-accent:#1856FF;
  --dskc-ink:var(--dsw-alias-label-primary,#141414);
  --dskc-ink-2:var(--dsw-alias-label-secondary,#5b6474);
  --dskc-surface:var(--dsw-alias-bg-layer-1,#fff);
  --dskc-line:color-mix(in oklab,var(--dskc-ink) 13%,transparent);
  --dskc-line-soft:color-mix(in oklab,var(--dskc-ink) 8%,transparent);
  --dskc-radius:16px;
  --dskc-shadow:0 18px 40px -34px rgba(9,14,38,.7),0 1px 2px -1px rgba(9,14,38,.25);
  position:relative;isolation:isolate;overflow:hidden;box-sizing:border-box;
  height:100%;min-height:0;display:flex;flex-direction:column;
  background-color:var(--dsw-alias-bg-base);
  background-image:linear-gradient(180deg,color-mix(in oklab,var(--dskc-accent) 7%,transparent),transparent 34%);
  color:var(--dskc-ink);
  -webkit-font-smoothing:antialiased;
}
.dskc_root *,.dskc_root *::before,.dskc_root *::after{box-sizing:border-box}
.dskc_root::before{
  content:"";position:absolute;inset:-22% -14% -10%;z-index:-1;pointer-events:none;
  background:
    radial-gradient(46% 40% at 10% -8%,color-mix(in oklab,var(--dskc-accent) 26%,transparent),transparent 64%),
    radial-gradient(52% 46% at 94% 4%,color-mix(in oklab,var(--dskc-accent) 14%,transparent),transparent 68%);
  filter:blur(56px);opacity:.85;
}
.dskc_scroll{position:relative;z-index:1;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px clamp(16px,3.2vw,38px) 34px;scrollbar-gutter:stable}
.dskc_scroll::-webkit-scrollbar{width:10px;height:10px}
.dskc_scroll::-webkit-scrollbar-track{background:transparent}
.dskc_scroll::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--dskc-ink) 18%,transparent);border-radius:999px;border:3px solid transparent;background-clip:content-box}
.dskc_scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in oklab,var(--dskc-ink) 32%,transparent);background-clip:content-box}
.dskc_inner{width:100%;max-width:1060px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
/* Panel entry: the panel is the destination the user just asked for, so its
   blocks arrive once, in reading order, and then stay still. The delay is per
   block and capped low so nothing is still appearing after a third of a second.
   The class is applied only on the first paint of a mount. */
.dskc_enter > *{animation:dskc_enter .34s cubic-bezier(.22,.68,.24,1) both}
.dskc_enter > *:nth-child(1){animation-delay:0ms}
.dskc_enter > *:nth-child(2){animation-delay:45ms}
.dskc_enter > *:nth-child(3){animation-delay:90ms}
.dskc_enter > *:nth-child(4){animation-delay:120ms}
.dskc_enter > *:nth-child(n+5){animation-delay:150ms}
@keyframes dskc_enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

/* Tier 1: the content surface. Near-opaque so numbers stay true to contrast. */
.dskc_card,.dskc_drive{
  position:relative;border-radius:var(--dskc-radius);
  background-color:color-mix(in oklab,var(--dskc-surface) 96%,transparent);
  border:1px solid var(--dskc-line);
  box-shadow:var(--dskc-shadow);
}
/* Tier 2: the header. Real frosted glass, one instance only. */
.dskc_head{
  position:relative;border-radius:var(--dskc-radius);
  background-color:color-mix(in oklab,var(--dskc-surface) 62%,transparent);
  background-image:linear-gradient(160deg,color-mix(in oklab,#fff 14%,transparent),transparent 52%);
  -webkit-backdrop-filter:blur(20px) saturate(1.6);
  backdrop-filter:blur(20px) saturate(1.6);
  border:1px solid var(--dskc-line);
  box-shadow:var(--dskc-shadow);
}
@supports ((mask-composite:exclude) or (-webkit-mask-composite:xor)){
  .dskc_head::before{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;opacity:.75;
    background:linear-gradient(150deg,color-mix(in oklab,#fff 52%,transparent),transparent 46%,color-mix(in oklab,var(--dskc-accent) 30%,transparent));
    -webkit-mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);
    -webkit-mask-composite:xor;
    mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);
    mask-composite:exclude;
  }
}
@supports not ((-webkit-backdrop-filter:blur(2px)) or (backdrop-filter:blur(2px))){
  .dskc_head{background-color:var(--dskc-surface)}
}
/* Blur is a preference, not a decoration: honour it, then fall back to solid. */
@media (prefers-reduced-transparency:reduce){
  .dskc_head{background-color:var(--dskc-surface);-webkit-backdrop-filter:none;backdrop-filter:none}
}

.dskc_head{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:18px 20px}
.dskc_head_main{display:flex;align-items:center;gap:14px;min-width:0}
.dskc_badge{
  flex:0 0 auto;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;color:#fff;
  background-color:var(--dskc-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 1px 2px rgba(9,14,38,.28);
}
.dskc_title{margin:0;font-size:20px;line-height:27px;font-weight:640;letter-spacing:.01em}
.dskc_sub{margin:5px 0 0;font-size:12px;line-height:18px;color:var(--dskc-ink-2);font-variant-numeric:tabular-nums}
.dskc_sub_row{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.dskc_sub_meta{position:relative;padding-left:11px}
.dskc_sub_meta::before{content:"";position:absolute;left:0;top:50%;width:1px;height:11px;margin-top:-5.5px;background:var(--dskc-line)}
.dskc_model{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;padding:1px 6px;border-radius:6px;
  color:var(--dskc-ink-2);background-color:color-mix(in oklab,var(--dskc-ink) 5%,transparent);border:1px solid var(--dskc-line-soft);
}
.dskc_head_side{display:flex;align-items:center;justify-content:flex-end;gap:18px;flex-wrap:wrap;margin-left:auto}
.dskc_metric{display:flex;flex-direction:column;align-items:flex-end;gap:3px;line-height:1;text-align:right}
.dskc_metric_num{font-size:22px;line-height:25px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--dskc-ink)}
.dskc_metric_label{font-size:11px;letter-spacing:.06em;color:var(--dskc-ink-2)}
.dskc_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* Model picker: a native select, restyled. The list popup stays native on
   purpose: it keeps keyboard, screen-reader and OS behaviour intact. */
.dskc_pick{display:inline-flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.dskc_pick_label{font-size:11.5px;color:var(--dskc-ink-2);white-space:nowrap}
.dskc_selectwrap{position:relative;display:inline-flex;min-width:0}
.dskc_selectwrap::after{
  content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;
  border-right:1.5px solid var(--dskc-ink-2);border-bottom:1.5px solid var(--dskc-ink-2);
  transform:translateY(-70%) rotate(45deg);pointer-events:none;
}
.dskc_select{
  appearance:none;-webkit-appearance:none;margin:0;
  font:inherit;font-size:12px;line-height:18px;color:var(--dskc-ink);
  background-color:var(--dskc-surface);
  border:1px solid var(--dskc-line);border-radius:11px;
  padding:7px 27px 7px 10px;max-width:210px;cursor:pointer;
  text-overflow:ellipsis;white-space:nowrap;
  transition:border-color .16s,background-color .16s,opacity .16s;
}
.dskc_select:hover:not(:disabled){border-color:color-mix(in oklab,var(--dskc-ink) 26%,transparent)}
.dskc_select:focus-visible{outline:2px solid color-mix(in oklab,var(--dskc-accent) 62%,transparent);outline-offset:2px}
.dskc_select:disabled{opacity:.5;cursor:not-allowed}
.dskc_select_effort{max-width:126px}
.dskc_select option,.dskc_select optgroup{background-color:var(--dskc-surface);color:var(--dskc-ink)}

.dskc_btn{
  appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  border:1px solid var(--dskc-line);border-radius:11px;
  background-color:var(--dskc-surface);
  color:var(--dskc-ink);font:inherit;font-size:12.5px;line-height:18px;font-weight:540;padding:8px 13px;cursor:pointer;
  box-shadow:0 1px 2px -1px rgba(9,14,38,.35);
  transition:background-color .16s,border-color .16s,color .16s,box-shadow .16s,opacity .16s,transform .12s;
}
.dskc_btn svg{flex:0 0 auto;opacity:.8}
.dskc_btn:hover:not(:disabled){background-color:color-mix(in oklab,var(--dskc-surface) 90%,var(--dskc-ink))}
.dskc_btn:active:not(:disabled){transform:scale(.985)}
.dskc_btn:focus-visible{outline:2px solid color-mix(in oklab,var(--dskc-accent) 62%,transparent);outline-offset:2px}
.dskc_btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;transform:none}
.dskc_btn_quiet{
  background-color:transparent;border-color:var(--dskc-line-soft);box-shadow:none;
  padding:5px 10px;font-size:12px;color:var(--dskc-ink-2);
}
.dskc_btn_quiet:hover:not(:disabled){background-color:color-mix(in oklab,var(--dskc-ink) 6%,transparent);border-color:var(--dskc-line);color:var(--dskc-ink)}
.dskc_btn_primary{
  color:#fff;border-color:color-mix(in oklab,var(--dskc-accent) 74%,#000);
  background-color:var(--dskc-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 1px 2px rgba(9,14,38,.32);
}
.dskc_btn_primary svg{opacity:.95}
.dskc_btn_primary:hover:not(:disabled){background-color:color-mix(in oklab,var(--dskc-accent) 88%,#000)}
.dskc_btn_primary:disabled{
  background-color:color-mix(in oklab,var(--dskc-ink) 12%,transparent);
  border-color:transparent;color:var(--dskc-ink-2);opacity:.8;
}

.dskc_drives{display:grid;grid-template-columns:repeat(auto-fit,minmax(256px,1fr));gap:14px}
.dskc_drive{display:flex;align-items:center;gap:14px;padding:15px 16px}
.dskc_ring{
  --pct:0;--ring:var(--dskc-accent);
  position:relative;flex:0 0 auto;width:50px;height:50px;border-radius:50%;display:grid;place-items:center;
  background:conic-gradient(from -90deg,var(--ring) calc(var(--pct) * 1%),color-mix(in oklab,var(--dskc-ink) 11%,transparent) calc(var(--pct) * 1%) 100%);
}
.dskc_ring::after{content:"";position:absolute;inset:6px;border-radius:50%;background-color:var(--dskc-surface)}
.dskc_ring_letter{position:relative;z-index:1;font-size:13px;font-weight:640;letter-spacing:.04em;color:var(--dskc-ink)}
.dskc_drive_body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.dskc_drive_top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dskc_drive_name{font-size:14px;font-weight:640;letter-spacing:.01em}
.dskc_drive_num{font-size:11.5px;color:var(--dskc-ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}

.dskc_card{overflow:hidden}
.dskc_card_head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--dskc-line-soft)}
.dskc_card_title{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:620;letter-spacing:.01em}
.dskc_count{
  display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:19px;padding:0 6px;border-radius:999px;
  font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dskc-ink-2);background-color:color-mix(in oklab,var(--dskc-ink) 7%,transparent);
}
.dskc_pulse{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dskc-ink-2)}
.dskc_pulse_dot{width:6px;height:6px;border-radius:50%;background:var(--dskc-accent);box-shadow:0 0 0 0 color-mix(in oklab,var(--dskc-accent) 55%,transparent);animation:dskc_pulse 1.8s ease-out infinite}
@keyframes dskc_pulse{0%{box-shadow:0 0 0 0 color-mix(in oklab,var(--dskc-accent) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}

.dskc_advice_wrap{
  display:flex;align-items:flex-start;gap:10px;margin:10px 12px 2px;padding:11px 13px;border-radius:12px;
  background-color:color-mix(in oklab,var(--dskc-ink) 4%,transparent);
  border:1px solid var(--dskc-line-soft);
}
.dskc_advice_badge{
  flex:0 0 auto;display:inline-flex;align-items:center;padding-top:1px;
  font-size:11px;font-weight:640;letter-spacing:.02em;white-space:nowrap;color:var(--dskc-ink-2);
}
.dskc_advice{margin:0;max-width:86ch;font-size:12.5px;line-height:20px;color:var(--dskc-ink);white-space:pre-wrap;word-break:break-word}
.dskc_advice_body{min-width:0}
.dskc_advice_note{margin:5px 0 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#E89558)}

.dskc_list{display:flex;flex-direction:column;gap:2px;padding:6px}
.dskc_row{
  display:flex;align-items:flex-start;gap:12px;padding:11px 12px;border-radius:12px;border:1px solid transparent;
  transition:background-color .18s,border-color .18s;
}
.dskc_row:hover{background-color:color-mix(in oklab,var(--dskc-ink) 4.5%,transparent)}
.dskc_row[data-selected="true"]{background-color:color-mix(in oklab,var(--dskc-accent) 8%,transparent);border-color:color-mix(in oklab,var(--dskc-accent) 26%,transparent)}
.dskc_row[data-selected="true"]:hover{background-color:color-mix(in oklab,var(--dskc-accent) 12%,transparent)}
.dskc_check{
  appearance:none;flex:0 0 auto;width:18px;height:18px;margin-top:1px;position:relative;cursor:pointer;
  border:1.5px solid color-mix(in oklab,var(--dskc-ink) 28%,transparent);border-radius:6px;
  background-color:var(--dskc-surface);
  transition:background-color .16s,border-color .16s,box-shadow .16s;
}
.dskc_check:hover:not(:disabled){border-color:color-mix(in oklab,var(--dskc-accent) 62%,transparent)}
.dskc_check:focus-visible{outline:2px solid color-mix(in oklab,var(--dskc-accent) 58%,transparent);outline-offset:2px}
.dskc_check:checked{
  background-color:var(--dskc-accent);
  border-color:color-mix(in oklab,var(--dskc-accent) 88%,#000);
}
.dskc_check:checked::after{content:"";position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}
.dskc_check:disabled{opacity:.35;cursor:not-allowed}
.dskc_row_main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.dskc_row_title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:19px;font-weight:550}
.dskc_row_name{word-break:break-word}
.dskc_row_path{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:18px;
  padding:1px 6px;border-radius:6px;word-break:break-all;
  background:color-mix(in oklab,var(--dskc-ink) 7%,transparent);
}
.dskc_row_desc{font-size:12px;line-height:18px;color:var(--dskc-ink-2);word-break:break-word;word-spacing:.02em}
.dskc_row_reason{font-size:12px;line-height:18px;word-break:break-word;color:var(--dskc-ink-2)}
/* A reason line is created only when a ranking lands, so its own arrival is the
   event: an accent tick grows in and the text follows it. Because the element
   does not exist before the ranking, the animation runs exactly once. */
.dskc_row_reason{animation:dskc_reason_in .34s cubic-bezier(.22,.68,.24,1) both}
.dskc_row_reason::before{
  content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
  margin:0 6px 2px 0;vertical-align:middle;background-color:var(--dskc-accent);
  animation:dskc_reason_tick .3s cubic-bezier(.22,.68,.24,1) both;
}
@keyframes dskc_reason_in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
@keyframes dskc_reason_tick{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
.dskc_tag{
  flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;
  border:1px solid color-mix(in oklab,currentColor 30%,transparent);
  background:color-mix(in oklab,currentColor 10%,transparent);
}
.dskc_size{flex:0 0 auto;font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;padding-top:1px}
.dskc_muted{font-size:11.5px;line-height:17px;color:var(--dskc-ink-2);font-variant-numeric:tabular-nums}
.dskc_err{color:var(--dsw-alias-state-error-primary,#EA2143);font-size:12.5px;line-height:20px;margin:0;word-break:break-word}
.dskc_ok{font-size:13px;font-weight:660;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-success-primary,#07CA6B)}

.dskc_foot{
  display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;
  border-top:1px solid var(--dskc-line-soft);
  background-image:linear-gradient(180deg,transparent,color-mix(in oklab,var(--dskc-ink) 4%,transparent));
}
.dskc_foot_info{display:flex;flex-direction:column;gap:7px;flex:0 1 320px;min-width:190px}
.dskc_meter{height:3px;border-radius:999px;background-color:color-mix(in oklab,var(--dskc-ink) 10%,transparent);overflow:hidden}
.dskc_meter_fill{height:100%;border-radius:999px;background-color:var(--dskc-accent);transition:width .3s ease}
.dskc_foot_value{font-weight:680;color:var(--dskc-ink);font-size:12.5px;font-variant-numeric:tabular-nums}

.dskc_result_list{display:flex;flex-direction:column;padding:6px 8px 10px}
/* The result card is the one place a card arrives rather than being present:
   it replaces a list the user was working in, so it settles in from slightly
   below with its content, once. */
.dskc_card_settle{animation:dskc_card_in .3s cubic-bezier(.22,.68,.24,1) both}
@keyframes dskc_card_in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.dskc_result_row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 8px;border-radius:10px}
.dskc_result_row+.dskc_result_row{box-shadow:inset 0 1px 0 var(--dskc-line-soft)}
.dskc_result_dot{width:8px;height:8px;border-radius:50%;background:color-mix(in oklab,var(--dskc-ink) 24%,transparent)}
.dskc_result_dot[data-ok="true"]{background:var(--dsw-alias-state-success-primary,#07CA6B);box-shadow:0 0 0 3px color-mix(in oklab,var(--dsw-alias-state-success-primary,#07CA6B) 18%,transparent)}
.dskc_result_label{font-size:12.5px;color:var(--dskc-ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dskc_result_freed{font-size:12.5px;font-weight:640;font-variant-numeric:tabular-nums;color:var(--dskc-ink)}
.dskc_result_err{
  grid-column:2 / 4;font-size:11.5px;line-height:17px;word-break:break-all;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dsw-alias-state-error-primary,#EA2143);
}

.dskc_empty{display:flex;flex-direction:column;align-items:center;gap:11px;padding:36px 20px;text-align:center;color:var(--dskc-ink-2);font-size:13px}
.dskc_empty_glyph{
  display:grid;place-items:center;width:54px;height:54px;border-radius:14px;
  color:var(--dskc-ink-2);background-color:color-mix(in oklab,var(--dskc-ink) 5%,transparent);
  border:1px solid var(--dskc-line-soft);
}
.dskc_empty_title{font-size:13.5px;font-weight:560;color:var(--dskc-ink)}
.dskc_card_empty{
  border-style:dashed;border-color:var(--dskc-line);
  background-color:transparent;box-shadow:none;
}
.dskc_card_tone_err{background-image:linear-gradient(152deg,color-mix(in oklab,var(--dsw-alias-state-error-primary,#EA2143) 10%,transparent),transparent 58%)}
.dskc_err_body{display:flex;align-items:flex-start;gap:11px;padding:14px 16px}
.dskc_err_badge{
  flex:0 0 auto;display:grid;place-items:center;width:28px;height:28px;border-radius:9px;
  color:var(--dsw-alias-state-error-primary,#EA2143);
  background:color-mix(in oklab,var(--dsw-alias-state-error-primary,#EA2143) 14%,transparent);
  border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary,#EA2143) 28%,transparent);
}
/* Scan progress. A directory walk has no known length, so the indicator is
   indeterminate on purpose: a rotating arc says "still measuring" without
   inventing a percentage. It is the single indicator for both scan and clean;
   a second bar would only repeat the same fact. */
.dskc_spinner{
  width:32px;height:32px;border-radius:50%;
  background:conic-gradient(from 0deg,transparent 0turn 0.58turn,var(--dskc-accent) 1turn);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3.5px),#000 calc(100% - 3.5px));
  mask:radial-gradient(farthest-side,transparent calc(100% - 3.5px),#000 calc(100% - 3.5px));
  animation:dskc_spin .9s linear infinite;
}
@keyframes dskc_spin{to{transform:rotate(360deg)}}

.dskc_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:13px 16px 16px}
.dskc_mini{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-radius:10px;transition:background-color .18s}
.dskc_mini:hover{background-color:color-mix(in oklab,var(--dskc-ink) 4%,transparent)}
.dskc_mini_head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.dskc_mini_name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dskc-ink)}
.dskc_mini_bar{height:5px;border-radius:999px;background:color-mix(in oklab,var(--dskc-ink) 8%,transparent);overflow:hidden}
.dskc_mini_fill{height:100%;border-radius:999px;background-color:var(--dskc-accent)}
.dskc_mini_num{flex:0 0 auto;font-size:11px;color:var(--dskc-ink-2);font-variant-numeric:tabular-nums;letter-spacing:-.01em}

@media (prefers-reduced-motion:reduce){
  /* Reduced motion keeps the state changes and drops the movement: entrances
     become instant, the indeterminate track holds still, and the counting value
     is applied directly instead of stepping. */
  .dskc_root *,.dskc_root *::before,.dskc_root *::after{
    animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;
  }
  .dskc_row_reason::before{display:none}
}
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

    /* ----------------------------------------------------------------- icons -- */

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
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        // Drive face: body, slot line, activity dot. Reads as a disk at 16px
        // without the ring-and-hub shape that turns into a donut at 24px.
        h('rect', { x: 3, y: 5.4, width: 18, height: 13.2, rx: 2.8 }),
        h('path', { d: 'M3.2 12.8h17.6' }),
        h('circle', { cx: 17.4, cy: 15.8, r: 0.95, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M6.4 9.1h6.2', opacity: active ? 0.85 : 0.5 }),
      )
    }

    function RefreshIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M20 11.2A8 8 0 1 0 17.6 17' }),
        h('path', { d: 'M20 4.6v6.6h-6.6' }),
      )
    }

    function TrashIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4 7.2h16' }),
        h('path', { d: 'M9.6 7.2V5.8A1.8 1.8 0 0 1 11.4 4h1.2a1.8 1.8 0 0 1 1.8 1.8v1.4' }),
        h('path', { d: 'M6.6 7.2l.85 11.1A2 2 0 0 0 9.44 20h5.12a2 2 0 0 0 1.99-1.7L17.4 7.2' }),
      )
    }

    function CheckIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M5 12.8 9.6 17.4 19 8' }),
      )
    }

    function AlertIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M12 4.4 21 19.6H3L12 4.4Z' }),
        h('path', { d: 'M12 10v4.2' }),
        h('path', { d: 'M12 17.2h.01' }),
      )
    }

    /* ---------------------------------------------------------------- models -- */

    const MODEL_STORE = 'dsh-disk-cleaner:model'

    /** Remember the picked model across panel remounts, when storage exists. */
    function readStoredPick() {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return null
        const raw = window.localStorage.getItem(MODEL_STORE)
        if (typeof raw !== 'string' || raw === '') return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    function writeStoredPick(pick) {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return
        window.localStorage.setItem(MODEL_STORE, JSON.stringify(pick))
      } catch {
        /* storage is a convenience; a locked-down host just forgets the choice */
      }
    }

    /** Resolve a stored {provider, model, effort} against the live catalog. */
    function matchPick(catalog, value) {
      if (catalog === null || catalog === undefined) return null
      if (value === null || typeof value !== 'object') return null
      if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null
      for (const group of Array.isArray(catalog.groups) ? catalog.groups : []) {
        if (group === null || typeof group !== 'object' || group.id !== value.provider) continue
        for (const model of Array.isArray(group.models) ? group.models : []) {
          if (model === null || typeof model !== 'object' || model.id !== value.model) continue
          const efforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []
          const wanted = [value.effort, value.reasoningEffort]
          const effort = wanted.find((candidate) => typeof candidate === 'string' && efforts.some((entry) => entry.id === candidate))
            ?? (typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : undefined)
          return { provider: group.id, model: model.id, ...(effort === undefined ? {} : { effort }) }
        }
      }
      return null
    }

    /** One model's catalog entry, used for its reasoning efforts. */
    function findModel(catalog, pick) {
      if (catalog === null || pick === null) return null
      for (const group of Array.isArray(catalog.groups) ? catalog.groups : []) {
        if (group === null || group.id !== pick.provider) continue
        for (const model of Array.isArray(group.models) ? group.models : []) {
          if (model !== null && model.id === pick.model) return model
        }
      }
      return null
    }

    /**
     * Diff the list's row positions against the previous layout.
     *
     * Kept as a pure function of (nodes, previousTops) so the FLIP maths can be
     * tested without a DOM: it reads one number per node and returns the moves
     * that need animating plus the positions to compare against next time.
     *
     * @param nodes - Map of row id to its DOM node.
     * @param previousTops - Map of row id to the top it had last layout.
     * @returns `{tops, moves}` where moves are `[node, deltaY]` pairs, deltaY
     * being the distance back to the row's old position.
     */
    function measureRowShifts(nodes, previousTops) {
      const tops = new Map()
      const moves = []
      for (const [id, node] of nodes) {
        if (node === null || typeof node !== 'object' || typeof node.getBoundingClientRect !== 'function') continue
        const top = node.getBoundingClientRect().top
        if (!Number.isFinite(top)) continue
        tops.set(id, top)
        const before = previousTops.get(id)
        // A row with no history is new: it has no old slot to travel from.
        if (before === undefined) continue
        const delta = before - top
        // Sub-pixel drift is rounding noise, not a reordering.
        if (Math.abs(delta) < 1) continue
        moves.push([node, delta])
      }
      return { tops, moves }
    }

    /* ----------------------------------------------------------------- panel -- */

    function Panel(props) {
      const t = props.t
      const [volumes, setVolumes] = React.useState([])
      const [scan, setScan] = React.useState(null)
      const [analysis, setAnalysis] = React.useState(null)
      const [selected, setSelected] = React.useState(() => new Set())
      const [phase, setPhase] = React.useState('idle')     // idle | scanning | cleaning | done
      // Analysis runs beside the list rather than in front of it, so it is its
      // own flag: `phase` decides whether the list is blocked, `analyzing` only
      // decides what the progress line says.
      const [analyzing, setAnalyzing] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [result, setResult] = React.useState(null)
      // The model picker: `catalog` is the host's provider/model list, `pick` is
      // the pair this panel sends with each ranking. A null catalog means the
      // host has no llm service, which is a normal deployment and simply hides
      // the controls.
      const [catalog, setCatalog] = React.useState(null)
      const [pick, setPick] = React.useState(null)
      const alive = React.useRef(true)
      const autoStarted = React.useRef(false)
      // The entry animation belongs to a mount, not to every render: the flag
      // is consumed on the first paint and the class never comes back.
      const [entered, setEntered] = React.useState(true)
      React.useEffect(() => {
        if (!entered) return
        const timer = setTimeout(() => setEntered(false), 520)
        return () => clearTimeout(timer)
      }, [entered])
      const catalogRequest = React.useRef(null)
      const catalogRef = React.useRef(null)
      const pickRef = React.useRef(null)
      // Monotonic ticket for analyses, so a slow earlier reply cannot overwrite
      // a newer one.
      const analysisSeq = React.useRef(0)
      // FLIP bookkeeping for the item list: the node per row id, and the top
      // offset each node had at the end of the previous layout.
      const rowNodes = React.useRef(new Map())
      const rowTops = React.useRef(new Map())
      // Whether the user has touched the selection since this scan started.
      // The model's ranking arrives after the list is already interactive, and
      // it must never overwrite a choice the user made by hand.
      const userTouched = React.useRef(false)
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

      /**
       * Fetch the model catalog once per panel instance. The timeout is short
       * on purpose: a provider that is slow to list models must not hold up the
       * scan, which is what the user actually asked for.
       */
      const loadCatalog = React.useCallback(() => {
        if (catalogRequest.current !== null) return catalogRequest.current
        catalogRequest.current = (async () => {
          let next = null
          try {
            const body = await request('/models', undefined, 8000)
            next = body.models ?? null
          } catch {
            next = null
          }
          if (!alive.current) return null
          catalogRef.current = next
          setCatalog(next)
          const chosen = matchPick(next, readStoredPick()) ?? matchPick(next, next?.default)
          pickRef.current = chosen
          setPick(chosen)
          return next
        })()
        return catalogRequest.current
      }, [])

      React.useEffect(() => { void loadCatalog() }, [loadCatalog])

      /**
       * FLIP for the cleanup list.
       *
       * A ranking changes the row order, and the rows must be seen travelling
       * to their new slots instead of swapping instantly. After each layout
       * the effect compares every row's current top with the top it had last
       * time; rows that moved are offset back to their old position and
       * released, so the browser animates the difference. Measuring the real
       * boxes means rows of different heights (a path row, a row with a reason
       * line) stay correct, which an assumed row height would not.
       *
       * The offset is written through the Web Animations API rather than a CSS
       * variable because it has to be committed in the same frame the layout is
       * measured in; a state write would cost another render and show one frame
       * of the new order first.
       */
      React.useLayoutEffect(() => {
        const result = measureRowShifts(rowNodes.current, rowTops.current)
        rowTops.current = result.tops
        if (result.moves.length === 0) return
        const reduce = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduce) return
        for (const [node, delta] of result.moves) {
          if (typeof node.animate !== 'function') continue
          node.animate(
            [{ transform: 'translateY(' + delta + 'px)' }, { transform: 'translateY(0)' }],
            { duration: 420, easing: 'cubic-bezier(.22,.68,.24,1)' },
          )
        }
      })

      /**
       * Ask for the ranking. Kept apart from the scan so switching models
       * re-ranks the findings already on screen instead of walking the disks
       * again.
       */
      const runAnalysis = React.useCallback(async (scanId, choice) => {
        // Two model switches in quick succession issue two requests; only the
        // newest one may write state, otherwise the slower earlier reply lands
        // last and the panel shows a ranking from a model that is not selected.
        analysisSeq.current += 1
        const seq = analysisSeq.current
        setAnalyzing(true)
        try {
          const payload = { scanId }
          if (choice !== null && typeof choice === 'object'
            && typeof choice.provider === 'string' && typeof choice.model === 'string') {
            payload.provider = choice.provider
            payload.model = choice.model
            if (typeof choice.effort === 'string' && choice.effort !== '') payload.reasoningEffort = choice.effort
          }
          const analyzed = await request('/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }, 180000)
          if (!alive.current || seq !== analysisSeq.current) return
          setAnalysis(analyzed.analysis ?? null)

          // The model's ranking replaces the rule-based preset only when the
          // user has not already chosen something themselves.
          const ranking = analyzed.analysis
          if (!userTouched.current
            && ranking !== null && ranking !== undefined
            && ranking.ai === true && Array.isArray(ranking.items)) {
            const recommended = new Set()
            for (const row of ranking.items) {
              if (row.recommended === true) recommended.add(row.id)
            }
            if (recommended.size > 0) setSelected(recommended)
          }
        } catch (failure) {
          if (!alive.current || seq !== analysisSeq.current) return
          // A failed ranking is not a failed scan: keep the list, and say why
          // the order is rule-based.
          setAnalysis({
            ai: false,
            note: '模型分析失败（' + (failure instanceof Error ? failure.message : String(failure)) + '），使用规则排序。',
          })
        } finally {
          if (alive.current && seq === analysisSeq.current) setAnalyzing(false)
        }
      }, [])

      const runScan = React.useCallback(async () => {
        setPhase('scanning')
        setError(null)
        setResult(null)
        setAnalysis(null)
        setAnalyzing(false)
        setSelected(new Set())
        userTouched.current = false
        try {
          // The catalog and the scan run together: a slow provider must not
          // delay the walk of the disks. The picker only has to be resolved
          // before the ranking starts, which is after the scan returns.
          const catalogPending = loadCatalog()
          const body = await request('/scan', undefined, 300000)
          if (!alive.current) return
          const next = body.scan
          setScan(next)
          setVolumes(Array.isArray(next.volumes) ? next.volumes : [])

          // Preselect the safe, non-report items while the model works.
          const preset = new Set()
          for (const item of next.items) {
            if (item.reportOnly !== true && item.risk === 'safe' && item.bytes > 0) preset.add(item.id)
          }
          if (alive.current) setSelected(preset)

          // The list becomes interactive now. Analysis runs alongside it: a
          // slow or missing model must not take selection away from the user,
          // which is exactly what it used to do.
          setPhase('idle')
          // Wait for the catalog so the first ranking uses the model on screen.
          // A failed catalog resolves to null and the server falls back on its
          // own default, so this never blocks the ranking.
          await catalogPending
          if (!alive.current) return
          await runAnalysis(next.id, pickRef.current)
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('idle')
          setAnalyzing(false)
        }
      }, [loadCatalog, runAnalysis])

      /**
       * Switch the ranking model. A model change only re-ranks: the scan data,
       * its selection and the checkboxes stay exactly as they are.
       */
      const chooseModel = React.useCallback((value, effort) => {
        if (typeof value !== 'string') return
        const slash = value.indexOf('/')
        if (slash <= 0) return
        const next = matchPick(catalogRef.current, {
          provider: value.slice(0, slash),
          model: value.slice(slash + 1),
          ...(typeof effort === 'string' ? { effort } : {}),
        })
        if (next === null) return
        pickRef.current = next
        setPick(next)
        writeStoredPick(next)
        if (scan !== null) void runAnalysis(scan.id, next)
      }, [scan, runAnalysis])

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
          // The server already decided what belongs in the list: it drops
          // genuinely empty entries, keeps blocked ones so the reason is
          // visible, and keeps a timed-out measurement so a slow disk does not
          // look like an empty disk. Filtering again here would re-hide them.
          .map((item) => ({ item, priority: rank.has(item.id) ? rank.get(item.id) : 50, reason: reason.get(item.id) }))
          .sort((a, b) => {
            if (a.item.reportOnly !== b.item.reportOnly) return a.item.reportOnly ? 1 : -1
            if (a.priority !== b.priority) return a.priority - b.priority
            return b.item.bytes - a.item.bytes
          })
      }, [scan, analysis])

      const selectable = React.useMemo(
        () => itemIndex.filter((row) => row.item.reportOnly !== true && row.item.blocked !== true),
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
        userTouched.current = true
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const toggleAll = (on) => {
        userTouched.current = true
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

      // Only operations that mutate or invalidate the list block it. Analysis
      // runs alongside and must never take the checkboxes away.
      const busy = phase === 'scanning' || phase === 'cleaning'
      const advice = analysis !== null && analysis !== undefined ? analysis : null
      const notice = advice !== null && advice.ai !== true && typeof advice.note === 'string' ? advice.note : null

      /**
       * Count the freed total up once when a clean lands.
       *
       * A cleanup result is a single number the user came for, and watching it
       * climb makes the amount legible as an outcome. The steps are coarse
       * (12 frames) and skipped entirely under reduced motion, where the final
       * value is used immediately. The DOM stays the only output: no state
       * churn after the last frame.
       */
      const [countedFreed, setCountedFreed] = React.useState(0)
      React.useEffect(() => {
        if (result === null) {
          setCountedFreed(0)
          return
        }
        const target = Number(result.freed) || 0
        const reduce = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduce || target <= 0) {
          setCountedFreed(target)
          return
        }
        let frame = 0
        const steps = 12
        let timer
        const tick = () => {
          frame += 1
          const progress = Math.min(1, frame / steps)
          // Ease-out: most of the distance early, so the pause at the end reads
          // as the number settling rather than stalling.
          const eased = 1 - (1 - progress) ** 2
          setCountedFreed(target * eased)
          if (progress < 1) timer = setTimeout(tick, 34)
          else setCountedFreed(target)
        }
        timer = setTimeout(tick, 60)
        return () => clearTimeout(timer)
      }, [result])

      /* ------------------------------------------------------------ render -- */

      const totals = volumes.reduce((sum, volume) => {
        sum.total += Number(volume.total) || 0
        sum.free += Number(volume.free) || 0
        sum.used += Number(volume.used) || 0
        return sum
      }, { total: 0, free: 0, used: 0 })

      const cleanableBytes = selectable.reduce((sum, row) => sum + (row.item.bytes > 0 ? row.item.bytes : 0), 0)
      const share = cleanableBytes > 0 ? Math.min(100, (selectedBytes / cleanableBytes) * 100) : 0

      // The status line is metadata, not prose: a label, a measured value, and
      // the model in play. Hairline separators keep it from turning into a run
      // of bullets. Before a ranking lands this is the selected model, after it
      // is the model that actually ran, which is what makes a fallback visible.
      const rankedModel = advice !== null && advice.ai === true && typeof advice.model === 'string' && advice.model !== ''
        ? advice.model
        : ''
      const selectedModel = pick === null ? '' : pick.provider + '/' + pick.model
      const statusNode = scan === null
        ? t('panel.subtitle')
        : h('span', { className: 'dskc_sub_row' },
            h('span', null, t('panel.scanned')),
            h('span', { className: 'dskc_sub_meta' }, '用时 ' + (scan.tookMs / 1000).toFixed(1) + ' 秒'),
            rankedModel === ''
              ? (selectedModel === '' ? null : h('span', { className: 'dskc_model', title: selectedModel }, selectedModel))
              : h('span', { className: 'dskc_model', title: rankedModel }, rankedModel),
          )

      // Picker options: provider groups, model names, and the model's badge when
      // the host advertises one ("beta", "fast", ...).
      const groups = catalog !== null && catalog.available === true && Array.isArray(catalog.groups)
        ? catalog.groups
        : []
      const chosenModel = findModel(catalog, pick)
      const effortOptions = chosenModel !== null && Array.isArray(chosenModel.reasoning?.efforts)
        ? chosenModel.reasoning.efforts
        : []
      const picker = groups.length === 0
        ? null
        : h('div', { className: 'dskc_pick' },
            h('span', { className: 'dskc_pick_label' }, t('panel.model')),
            h('span', { className: 'dskc_selectwrap' },
              h('select', {
                className: 'dskc_select',
                value: pick === null ? '' : pick.provider + '/' + pick.model,
                disabled: busy,
                'aria-label': t('panel.model'),
                onChange: (event) => chooseModel(event.target.value),
              },
                pick === null && h('option', { value: '' }, t('panel.modelDefault')),
                groups.map((group) => h('optgroup', { key: group.id, label: group.name },
                  (Array.isArray(group.models) ? group.models : []).map((model) => h('option', {
                    key: model.id,
                    value: group.id + '/' + model.id,
                  }, model.badge === undefined ? model.name : model.name + ' · ' + model.badge)),
                )),
              ),
            ),
            effortOptions.length > 1 && h('span', { className: 'dskc_pick_label' }, t('panel.effortShort')),
            effortOptions.length > 1 && h('span', { className: 'dskc_selectwrap' },
              h('select', {
                className: 'dskc_select dskc_select_effort',
                value: pick !== null && typeof pick.effort === 'string' ? pick.effort : '',
                disabled: busy,
                'aria-label': t('panel.effort'),
                onChange: (event) => chooseModel(pick.provider + '/' + pick.model, event.target.value),
              },
                effortOptions.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
              ),
            ),
          )

      const driveCards = volumes.map((volume) => {
        const usedPct = volume.total > 0 ? (volume.used / volume.total) * 100 : 0
        const critical = usedPct >= 90
        return h('div', { key: volume.letter, className: 'dskc_drive' },
          h('div', {
            className: 'dskc_ring',
            // The ring encodes the used share as an arc; at 90% it turns to the
            // error tone instead of quietly staying accent-coloured.
            style: { '--pct': usedPct.toFixed(1), '--ring': critical ? 'var(--dsw-alias-state-error-primary,#EA2143)' : null },
            'aria-hidden': true,
          }, h('span', { className: 'dskc_ring_letter' }, volume.letter)),
          h('div', { className: 'dskc_drive_body' },
            h('div', { className: 'dskc_drive_top' },
              h('span', { className: 'dskc_drive_name' }, volume.letter + ': 盘'),
              h('span', { className: 'dskc_drive_num' }, formatBytes(volume.free) + ' 可用'),
            ),
            h('span', { className: 'dskc_muted' }, '已用 ' + usedPct.toFixed(1) + '% · 共 ' + formatBytes(volume.total)),
          ),
        )
      })

      const rows = itemIndex.map(({ item, reason }) => {
        const risk = RISK_STYLE[item.risk] ?? RISK_STYLE.caution
        const isSelected = selected.has(item.id)
        // A row is only non-interactive when picking it could not do anything:
        // advisory entries, directories the process cannot read, or a running
        // clean that already submitted its ids.
        const disabled = item.reportOnly === true || item.blocked === true || busy
        // A row animates only when the ranking actually moved it. The offset is
        // the distance between its previous index and the new one, measured in
        // JS when the ranking landed; rows that did not move stay still so a
        // long list does not shimmer on every update.
        // Movement is measured after layout by the FLIP effect below, which
        // writes the offset straight onto the node. Rendering stays declarative
        // and the transition fires once per reordering.
        return h('div', {
          key: item.id,
          className: 'dskc_row',
          'data-selected': isSelected ? 'true' : 'false',
          ref: (node) => {
            if (node === null) rowNodes.current.delete(item.id)
            else rowNodes.current.set(item.id, node)
          },
        },
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
                className: item.kind === 'file' ? 'dskc_row_path' : 'dskc_row_name',
                title: item.label,
              }, item.label),
              h('span', { className: 'dskc_tag', style: { color: risk.color } }, risk.label),
              item.admin && h('span', { className: 'dskc_tag', style: { color: 'var(--dskc-ink-2)' } }, '需管理员'),
              item.blocked && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-state-error-primary,#EA2143)' } }, '当前无权限读取'),
              item.reportOnly && h('span', { className: 'dskc_tag', style: { color: 'var(--dskc-ink-2)' } }, '仅提示'),
              item.truncated && h('span', { className: 'dskc_tag', style: { color: 'var(--dsw-alias-state-warn-primary,#E89558)' } }, '未完整统计'),
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
            entry.truncated
              ? h('span', { className: 'dskc_muted' }, '部分目录未完整统计')
              : h('span', { className: 'dskc_count' }, String(entry.rows.length)),
          ),
          h('div', { className: 'dskc_grid' },
            entry.rows.map((row) => h('div', {
              key: row.path,
              className: 'dskc_mini',
              title: row.path + ' · ' + formatBytes(row.bytes),
            },
              h('div', { className: 'dskc_mini_head' },
                h('span', { className: 'dskc_mini_name' }, row.name),
                h('span', { className: 'dskc_mini_num' }, formatBytes(row.bytes)),
              ),
              h('div', { className: 'dskc_mini_bar' },
                h('div', { className: 'dskc_mini_fill', style: { width: Math.max(2, (row.bytes / max) * 100).toFixed(1) + '%' } }),
              ),
            )),
          ),
        )
      })

      return h('div', { className: 'dskc_root' },
        h('div', { className: 'dskc_scroll' },
          h('div', { className: entered ? 'dskc_inner dskc_enter' : 'dskc_inner' },
            h('div', { className: 'dskc_head' },
              h('div', { className: 'dskc_head_main' },
                h('span', { className: 'dskc_badge', 'aria-hidden': true }, h(DiskIcon, { size: 22 })),
                h('div', null,
                  h('h1', { className: 'dskc_title' }, t('panel.title')),
                  h('p', { className: 'dskc_sub' }, statusNode),
                ),
              ),
              h('div', { className: 'dskc_head_side' },
                totals.total > 0 && h('div', { className: 'dskc_metric' },
                  h('span', { className: 'dskc_metric_num' }, formatBytes(totals.free)),
                  h('span', { className: 'dskc_metric_label' }, '可用空间'),
                ),
                h('div', { className: 'dskc_actions' },
                  picker,
                  h('button', {
                    type: 'button',
                    className: 'dskc_btn',
                    onClick: () => void runScan(),
                    disabled: busy,
                  }, h(RefreshIcon, { size: 15 }), scan === null ? t('panel.scan') : t('panel.rescan')),
                ),
              ),
            ),

            driveCards.length > 0 && h('div', { className: 'dskc_drives' }, driveCards),

            error !== null && h('div', { className: 'dskc_card dskc_card_tone_err' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, h(AlertIcon, { size: 14 }), t('panel.error')),
                h('button', {
                  type: 'button',
                  className: 'dskc_btn dskc_btn_quiet',
                  onClick: () => void runScan(),
                  disabled: busy,
                }, h(RefreshIcon, { size: 14 }), t('panel.rescan')),
              ),
              h('div', { className: 'dskc_err_body' },
                h('span', { className: 'dskc_err_badge', 'aria-hidden': true }, h(AlertIcon, { size: 16 })),
                h('p', { className: 'dskc_err' }, error),
              ),
            ),

            result !== null && h('div', { className: 'dskc_card dskc_card_settle' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, h(CheckIcon, { size: 14 }), t('panel.cleaned')),
                // Counts up from zero once, so the released total reads as an
                // outcome rather than a value that was always there.
                h('span', { className: 'dskc_ok' }, '+' + formatBytes(countedFreed)),
              ),
              (result.results ?? []).length > 0
                ? h('div', { className: 'dskc_result_list' },
                    (result.results ?? []).map((row) => h('div', {
                      key: String(row.id ?? row.label),
                      className: 'dskc_result_row',
                    },
                      h('span', { className: 'dskc_result_dot', 'data-ok': row.freed > 0 ? 'true' : 'false' }),
                      h('span', { className: 'dskc_result_label', title: row.label }, row.label),
                      h('span', { className: 'dskc_result_freed' }, (row.freed > 0 ? '+' : '') + formatBytes(row.freed)),
                      (row.errors ?? []).slice(0, 3).map((line, index) => h('span', {
                        key: 'err-' + index,
                        className: 'dskc_result_err',
                      }, line)),
                    )),
                  )
                : h('div', { className: 'dskc_empty' }, t('panel.nothingCleaned')),
            ),

            phase === 'scanning' && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_empty', role: 'status' },
                h('div', { className: 'dskc_spinner' }),
                h('span', { className: 'dskc_empty_title' }, t('panel.scanning')),
                h('span', { className: 'dskc_muted' }, t('panel.scanHint')),
              ),
            ),

            phase === 'cleaning' && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_empty', role: 'status' },
                h('div', { className: 'dskc_spinner' }),
                h('span', { className: 'dskc_empty_title' }, t('panel.cleaning')),
              ),
            ),

            scan !== null && h('div', { className: 'dskc_card' },
              h('div', { className: 'dskc_card_head' },
                h('span', { className: 'dskc_card_title' }, t('panel.items'), h('span', { className: 'dskc_count' }, String(rows.length))),
                h('div', { className: 'dskc_actions' },
                  // The list is already usable here; this only reports that the
                  // ranking is still on its way and marks apply when it lands.
                  analyzing && h('span', { className: 'dskc_pulse' },
                    h('span', { className: 'dskc_pulse_dot' }),
                    t('panel.analyzing'),
                  ),
                  h('button', {
                    type: 'button', className: 'dskc_btn dskc_btn_quiet',
                    onClick: () => toggleAll(true), disabled: busy,
                  }, t('panel.selectAll')),
                  h('button', {
                    type: 'button', className: 'dskc_btn dskc_btn_quiet',
                    onClick: () => toggleAll(false), disabled: busy,
                  }, t('panel.selectNone')),
                ),
              ),
              advice !== null && advice.ai === true && typeof advice.advice === 'string' && advice.advice !== ''
                ? h('div', { className: 'dskc_advice_wrap' },
                    h('span', { className: 'dskc_advice_badge' }, 'AI 建议'),
                    h('div', { className: 'dskc_advice_body' },
                      h('p', { className: 'dskc_advice' }, advice.advice),
                      // The picker can outlive a provider change; say which model
                      // answered instead of leaving the old choice on screen.
                      typeof advice.switchedFrom === 'string' && advice.switchedFrom !== ''
                        ? h('p', { className: 'dskc_advice_note' },
                            t('panel.switched').replace('%s', advice.switchedFrom + ' → ' + advice.model))
                        : null,
                    ),
                  )
                : notice !== null
                  ? h('div', { className: 'dskc_advice_wrap' },
                      h('span', { className: 'dskc_advice_badge' }, '提示'),
                      h('p', { className: 'dskc_advice' }, notice),
                    )
                  : null,
              rows.length > 0
                ? h('div', { className: 'dskc_list' }, rows)
                : h('div', { className: 'dskc_empty' }, t('panel.noItems')),
              h('div', { className: 'dskc_foot' },
                h('div', { className: 'dskc_foot_info' },
                  h('span', { className: 'dskc_muted' },
                    '已选 ' + selected.size + ' 项 · 预计释放 ',
                    h('strong', { className: 'dskc_foot_value' }, formatBytes(selectedBytes)),
                  ),
                  h('div', { className: 'dskc_meter' },
                    h('div', { className: 'dskc_meter_fill', style: { width: share.toFixed(1) + '%' } }),
                  ),
                ),
                h('div', { className: 'dskc_actions' },
                  h('button', {
                    type: 'button', className: 'dskc_btn dskc_btn_primary',
                    onClick: () => void clean(),
                    disabled: busy || selected.size === 0,
                  }, h(TrashIcon, { size: 15 }), t('panel.clean')),
                ),
              ),
            ),

            ...(breakdownCards ?? []),

            scan === null && phase === 'idle' && result === null && error === null && h('div', { className: 'dskc_card dskc_card_empty' },
              h('div', { className: 'dskc_empty' },
                h('span', { className: 'dskc_empty_glyph' }, h(DiskIcon, { size: 28 })),
                h('span', { className: 'dskc_empty_title' }, t('panel.emptyHint')),
                h('span', { className: 'dskc_muted' }, t('panel.scanHint')),
              ),
            ),
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- install -- */

    return {
      inject: ['slots', 'locale'],
      // Pure helpers exposed for the render test only. The host ignores extra
      // fields on the plugin object; nothing here touches the DOM at load.
      __test: { measureRowShifts, matchPick, findModel },
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
          'panel.model': '模型',
          'panel.modelDefault': '默认模型',
          'panel.effort': '推理强度',
          'panel.effortShort': '强度',
          'panel.switched': '所选模型当前不可用，本次由 %s 排序。',
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
          'panel.model': 'Model',
          'panel.modelDefault': 'Default model',
          'panel.effort': 'Effort',
          'panel.effortShort': 'Effort',
          'panel.switched': 'The selected model is unavailable; %s ranked this run.',
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
