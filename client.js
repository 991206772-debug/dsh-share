/**
 * Client half of `@local/dsh-share`.
 *
 * Registers one Conversation View: 「分享会话」, a tab beside Chat and
 * Trajectory. It asks the Host half for the analysis of the Session it is
 * rendered in, then shows the same digest the share page shows — plus the three
 * things that make it shareable:
 *
 *   · the read-only link (the page the Host serves for this session),
 *   · the same digest as Markdown, for pasting into a chat or a doc,
 *   · a download of the page as one self-contained HTML file.
 *
 * All data comes from `GET /dsh-share/api/analysis`; this half folds nothing.
 * Styling is `--dsw-alias-*` tokens only, so the view follows the active theme.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-share',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-share'
    /** The Conversation View this plugin occupies. */
    const VIEW_ID = 'share'
    /** After the shipped views (chat 0, trajectory 10, context 20, fleet 30). */
    const VIEW_ORDER = 40
    /** How long a copied/opened confirmation stays on screen. */
    const NOTICE_MS = 2400

    const zh = {
      'view.tab': '分享会话',
      title: '对话分享',
      subtitle: '把这次对话整理成一页：问了什么、结论是什么、还剩什么没做。链接发给别人，对方不用装任何东西。',
      'action.refresh': '刷新',
      'action.copyMarkdown': '复制 Markdown',
      'action.downloadHtml': '下载 HTML',
      'action.downloadMd': '下载 Markdown',
      'action.open': '本机预览',
      'action.retry': '重试',
      'lan.lead': '要让别人真的能点开，就把这一页挂到这个局域网端口上。链接是一条冻结的快照，停止或到期即失效。',
      'lan.minutes': '有效期',
      'lan.start': '生成局域网链接',
      'lan.starting': '正在开启…',
      'lan.stop': '停止分享',
      'lan.copy': '复制链接',
      'lan.badge': '局域网可访问',
      'lan.expires': '到期于',
      'lan.alt': '其它网段：',
      'lan.note': '同一局域网（同一 Wi-Fi 或内网）的人可以直接打开；外网访问不到。不在同一网络的，用「下载 HTML」把文件发过去。',
      'lan.noAddress': '没有找到可用的局域网地址，请检查网络连接',
      'state.loading': '正在读取这次对话的日志…',
      'state.error': '读取失败',
      'state.empty.title': '这里还没有对话',
      'state.empty.body': '先在左边聊上几轮，这一页会自动把内容整理出来。',
      'state.noSession': '当前没有选中的会话。',
      'meta.generated': '生成时间',
      'meta.session': '会话',
      'meta.dir': '工作目录',
      'meta.copyId': '点击复制会话 ID',
      'section.overview': '概览',
      'section.overview.hint': '这次对话的体量',
      'section.thread': '对话主线',
      'section.thread.hint': '你在这次对话里提出的要求，按顺序',
      'section.transcript': '完整对话',
      'section.transcript.hint': '按时间顺序的全部消息，未经删减',
      'role.human': '你',
      'role.assistant': '助手',
      'role.teammate': '队友',
      'role.notice': '子代理完成',
      'role.context': '系统上下文',
      'transcript.truncated': '已截断',
      'section.conclusion': '结论',
      'section.conclusion.hint': '最后一条回答的正文',
      'section.todos': '待办',
      'section.todos.hint': '对话过程中维护的清单',
      'section.tools': '工具使用',
      'section.files': '涉及文件',
      'section.timeline': '时间线',
      'section.errors': '异常',
      'stats.turns': '轮次',
      'stats.user': '用户消息',
      'stats.assistant': '助手消息',
      'stats.tools': '工具调用',
      'stats.duration': '耗时',
      'stats.tokens': '累计 Tokens',
      'empty.todos': '这次对话没有维护待办清单',
      'empty.files': '这次对话没有改动文件',
      'empty.errors': '没有工具调用失败',
      'empty.tools': '这次对话没有调用工具',
      'empty.conclusion': '还没有回答',
      'status.pending': '待办',
      'status.in_progress': '进行中',
      'status.completed': '已完成',
      'status.cancelled': '已取消',
      'reason.completed': '正常结束',
      'reason.aborted': '已中断',
      'reason.blocked': '被拦截',
      'reason.error': '出错',
      'reason.max-tokens': '超出长度',
      'reason.interrupted': '被打断',
      'reason.forked': '已分叉',
      'op.read': '读取',
      'op.write': '写入',
      'op.search': '检索',
      'notice.markdown': 'Markdown 已复制',
      'notice.opened': '已在新标签页打开本机预览',
      'notice.downloaded': '已开始下载',
      'notice.idCopied': '会话 ID 已复制',
      'notice.copyFailed': '复制失败，浏览器没有放行剪贴板',
      'notice.lanStarted': '局域网链接已生成，复制后发给别人',
      'notice.lanCopied': '链接已复制，同一局域网的人可以直接打开',
      'notice.lanStopped': '分享已停止，链接立即失效',
      'mermaid.label': 'Mermaid 图表',
      'mermaid.chart': '查看图表',
      'mermaid.code': '查看源码',
      'mermaid.copy': '复制源码',
      'mermaid.copied': '已复制',
      'mermaid.copyFailed': '复制失败',
      'mermaid.zoom': '放大',
      'mermaid.zoomIn': '放大',
      'mermaid.zoomOut': '缩小',
      'mermaid.zoomReset': '1:1',
      'mermaid.zoomFit': '适应屏幕',
      'mermaid.close': '关闭',
      'mermaid.download': '下载图片',
      'mermaid.loading': '正在渲染图表…',
      'mermaid.error': '图表渲染失败，已显示源码',
      'mermaid.empty': '图表源码为空，已显示源码',
      'unit.sec': ' 秒',
      'unit.min': ' 分',
      'unit.hour': ' 时',
      'unit.minute': ' 分钟',
    }

    const en = {
      'view.tab': 'Share',
      title: 'Conversation share',      subtitle:
        'One page for this conversation: what was asked, what it concluded, what is left. Send the link — the reader needs nothing installed.',
      'action.refresh': 'Refresh',
      'action.copyMarkdown': 'Copy Markdown',
      'action.downloadHtml': 'Download HTML',
      'action.downloadMd': 'Download Markdown',
      'action.open': 'Preview here',
      'action.retry': 'Retry',
      'lan.lead':
        'To give someone a link they can actually open, publish this page on the local network. The link is a frozen snapshot and dies when you stop it or when it expires.',
      'lan.minutes': 'Lifetime',
      'lan.start': 'Create LAN link',
      'lan.starting': 'Opening\u2026',
      'lan.stop': 'Stop sharing',
      'lan.copy': 'Copy link',
      'lan.badge': 'Reachable on this LAN',
      'lan.expires': 'expires',
      'lan.alt': 'Other addresses:',
      'lan.note':
        'Anyone on the same network (same Wi-Fi or intranet) can open it; it is not reachable from the internet. For someone elsewhere, use Download HTML and send the file.',
      'lan.noAddress': 'No LAN address was found; check this machine\u2019s network connection',
      'state.loading': 'Reading this conversation\u2019s log\u2026',
      'state.error': 'Could not read it',
      'state.empty.title': 'Nothing to share yet',
      'state.empty.body': 'Chat for a few turns and this page fills itself in.',
      'state.noSession': 'No Session is selected.',
      'meta.generated': 'Generated',
      'meta.session': 'Session',
      'meta.dir': 'Directory',
      'meta.copyId': 'Copy the Session id',
      'section.overview': 'Overview',
      'section.overview.hint': 'How much this conversation contains',
      'section.thread': 'Thread',
      'section.thread.hint': 'What you asked for, in order',
      'section.transcript': 'Full conversation',
      'section.transcript.hint': 'Every message in order, nothing removed',
      'role.human': 'You',
      'role.assistant': 'Assistant',
      'role.teammate': 'Teammate',
      'role.notice': 'Subagent done',
      'role.context': 'System context',
      'transcript.truncated': 'truncated',
      'section.conclusion': 'Conclusion',
      'section.conclusion.hint': 'The body of the last reply',
      'section.todos': 'Open items',
      'section.todos.hint': 'The checklist maintained during the conversation',
      'section.tools': 'Tools',
      'section.files': 'Files',
      'section.timeline': 'Timeline',
      'section.errors': 'Failures',
      'stats.turns': 'Turns',
      'stats.user': 'User messages',
      'stats.assistant': 'Replies',
      'stats.tools': 'Tool calls',
      'stats.duration': 'Duration',
      'stats.tokens': 'Tokens total',
      'empty.todos': 'No checklist was maintained in this conversation',
      'empty.files': 'No file was touched in this conversation',
      'empty.errors': 'No tool call failed',
      'empty.tools': 'No tool was called in this conversation',
      'empty.conclusion': 'No reply yet',
      'status.pending': 'pending',
      'status.in_progress': 'in progress',
      'status.completed': 'done',
      'status.cancelled': 'cancelled',
      'reason.completed': 'completed',
      'reason.aborted': 'aborted',
      'reason.blocked': 'blocked',
      'reason.error': 'error',
      'reason.max-tokens': 'max tokens',
      'reason.interrupted': 'interrupted',
      'reason.forked': 'forked',
      'op.read': 'read',
      'op.write': 'write',
      'op.search': 'search',
      'notice.markdown': 'Markdown copied',
      'notice.opened': 'Opened the local preview in a new tab',
      'notice.downloaded': 'Download started',
      'notice.idCopied': 'Session id copied',
      'notice.copyFailed': 'The browser refused clipboard access',
      'notice.lanStarted': 'LAN link created — copy it and send it',
      'notice.lanCopied': 'Link copied; anyone on this network can open it',
      'notice.lanStopped': 'Sharing stopped — the link is dead now',
      'mermaid.label': 'Mermaid diagram',
      'mermaid.chart': 'View chart',
      'mermaid.code': 'View source',
      'mermaid.copy': 'Copy source',
      'mermaid.copied': 'Copied',
      'mermaid.copyFailed': 'Copy failed',
      'mermaid.zoom': 'Zoom',
      'mermaid.zoomIn': 'Zoom in',
      'mermaid.zoomOut': 'Zoom out',
      'mermaid.zoomReset': '1:1',
      'mermaid.zoomFit': 'Fit screen',
      'mermaid.close': 'Close',
      'mermaid.download': 'Download image',
      'mermaid.loading': 'Rendering diagram…',
      'mermaid.error': 'Diagram rendering failed; showing source',
      'mermaid.empty': 'Diagram source is empty; showing source',
      'unit.sec': 's',
      'unit.min': 'm',
      'unit.hour': 'h',
      'unit.minute': ' min',
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Resolve a Host route against the directory the page is served from. */
    function api(pathname) {
      const relative = String(pathname ?? '').replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      try {
        const url = new URL(relative, document.baseURI)
        return `${url.pathname}${url.search}`
      } catch {
        return `/${relative}`
      }
    }

    /** The absolute address of one Session's read-only page on THIS machine. */
    function localPageUrl(sessionId, lang) {
      const path = `dsh-share/page?sessionId=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(lang)}`
      if (typeof document === 'undefined') return `/${path}`
      try {
        return new URL(path, document.baseURI).href
      } catch {
        return `/${path}`
      }
    }

    /** A route on this machine's Host, resolved against the app's own base. */
    function hostUrl(pathname) {
      const relative = String(pathname ?? '').replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      try {
        return new URL(relative, document.baseURI).href
      } catch {
        return `/${relative}`
      }
    }

    async function getAnalysis(sessionId, lang) {
      const query = `?sessionId=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(lang)}`
      const response = await fetch(api(`dsh-share/api/analysis${query}`), { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      if (!body.analysis || typeof body.analysis !== 'object') {
        throw new Error('the Host returned no analysis')
      }
      return body
    }

    /** Ask the Host to publish one frozen snapshot on the LAN. */
    async function startLanShare(sessionId, lang, minutes) {
      const response = await fetch(api('dsh-share/api/lan/start'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, lang, minutes }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    async function stopLanShare(token) {
      const response = await fetch(api('dsh-share/api/lan/stop'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    async function readLanStatus() {
      try {
        const response = await fetch(api('dsh-share/api/lan/status'), { cache: 'no-store' })
        const body = await response.json().catch(() => null)
        return body?.ok === true ? body : null
      } catch {
        return null
      }
    }

    /** Clipboard write with the legacy fallback a non-HTTPS page needs. */
    async function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the textarea path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        try {
          area.select()
          return document.execCommand('copy')
        } finally {
          // `execCommand` throws on some browsers instead of returning false; a
          // stray textarea left in the app's body would then never be cleaned up.
          area.remove()
        }
      } catch {
        return false
      }
    }

    /** `t` returns the key itself when a dictionary misses it; show the raw value then. */
    function label(t, prefix, value) {
      if (!value) return ''
      const key = `${prefix}${value}`
      const text = t(key)
      return text === key ? String(value) : text
    }

    /** Re-render on a locale switch: the copy and the share link both follow it. */
    // Mermaid is loaded only when a diagram is present. Keep one shared promise
     // so several code blocks do not download or initialize the library in parallel.
     const MERMAID_KEYWORDS = /^(?:graph\b|flowchart\b|sequenceDiagram\b|classDiagram(?:-v2)?\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gantt\b|pie\b|quadrantChart\b|requirementDiagram\b|gitGraph\b|c4(?:Context|Container|Component|Dynamic|Deployment)\b|mindmap\b|timeline\b|zenuml\b|sankey-beta\b|xychart-beta\b|block-beta\b|packet-beta\b|kanban\b|architecture-beta\b)/i
     let mermaidPromise = null

     function isMermaidCode(lang, value) {
       const normalized = String(lang ?? '').trim().toLowerCase()
       if (normalized === 'mermaid') return true
       if (normalized && normalized !== 'txt' && normalized !== 'text') return false
       let source = String(value ?? '').trim()
       if (!source) return false
       source = source.replace(/^---[\s\S]*?---\s*/, '')
       source = source.replace(/^(?:%%(?:\{[\s\S]*?\}%%|[^\n]*)\s*)+/, '').trim()
       return MERMAID_KEYWORDS.test(source)
     }

     function loadMermaid() {
       if (typeof window !== 'undefined' && window.mermaid) return Promise.resolve(window.mermaid)
       if (!mermaidPromise) {
         mermaidPromise = import(/* webpackIgnore: true */ 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
           .then((module) => module?.default ?? module)
           .catch((failure) => {
             mermaidPromise = null
             throw failure
           })
       }
       return mermaidPromise
     }

     function prefersDarkTheme() {
       if (typeof document !== 'undefined') {
         const root = document.documentElement
         const explicit = root?.getAttribute('data-theme') || root?.getAttribute('data-color-mode')
         const className = root?.className && String(root.className)
         const theme = explicit || (/(?:^|\s)(dark|light)(?:\s|$)/i.exec(className ?? '')?.[1] ?? '')
         if (theme) return /dark/i.test(theme)
         try {
           const colorScheme = getComputedStyle(root).getPropertyValue('color-scheme').trim()
           if (/^dark(?:\s|$)/i.test(colorScheme)) return true
           if (/^light(?:\s|$)/i.test(colorScheme)) return false
         } catch {
           /* fall through to the system preference */
         }
       }
       try {
         return typeof window !== 'undefined'
           && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
       } catch {
         return false
       }
     }

     function parseSvgDimensions(svgString) {
       if (!svgString) return { width: null, height: null }
       const vb = svgString.match(/viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i)
       if (vb && parseFloat(vb[3]) > 0 && parseFloat(vb[4]) > 0) {
         return { width: parseFloat(vb[3]), height: parseFloat(vb[4]) }
       }
       const mw = svgString.match(/max-width:\s*([\d.]+)px/i)
       const h = svgString.match(/height\s*=\s*["']([\d.]+)["']/i)
       if (mw && parseFloat(mw[1]) > 0) {
         return { width: parseFloat(mw[1]), height: h ? parseFloat(h[1]) : null }
       }
       return { width: null, height: null }
     }

     function useLocaleTick(locale) {
      const [, setTick] = useState(0)
      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setTick((value) => value + 1))
      }, [locale])
    }

    function durationText(ms, t) {
      const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
      if (total < 60) return `${Math.round(total)}${t('unit.sec')}`
      if (total < 3600) {
        const seconds = Math.round(total % 60)
        return `${Math.floor(total / 60)}${t('unit.min')} ${String(seconds).padStart(2, '0')}${t('unit.sec')}`
      }
      return `${Math.floor(total / 3600)}${t('unit.hour')} ${Math.round((total % 3600) / 60)}${t('unit.min')}`
    }

    function stampText(time) {
      try {
        return new Date(Number(time) || Date.now()).toLocaleString()
      } catch {
        return ''
      }
    }

    function clockText(time) {
      try {
        return new Date(Number(time) || Date.now()).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    const STYLES = `
.dss-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:14px; }
.dss-head { flex:none; display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:22px 32px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dss-h1 { margin:0; font-size:17px; font-weight:650; letter-spacing:.01em; }
.dss-sub { margin:6px 0 0; font-size:13px; line-height:1.65; color:var(--dsw-alias-label-secondary); max-width:640px; }
.dss-tools { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; flex:none; }
.dss-btn { height:32px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.dss-btn:hover { border-color:var(--dsw-alias-border-l2); }
.dss-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:2px; }
.dss-btn:disabled { opacity:.55; cursor:default; }
.dss-btn-primary { border-color:transparent; background:var(--dsw-alias-button-primary-fill,#4f6ef7); color:var(--dsw-alias-label-primary-foreground,#fff); }
.dss-body { flex:1 1 auto; min-height:0; overflow:auto; padding:20px 32px 40px; }
.dss-inner { max-width:880px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.dss-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:14px 16px 16px; }
.dss-card-head { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
.dss-card-title { margin:0; font-size:14px; font-weight:620; }
.dss-card-hint { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dss-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:8px; }
.dss-stat { display:flex; flex-direction:column; gap:1px; padding:9px 11px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); }
.dss-stat-k { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dss-stat-v { font-size:18px; font-weight:640; font-variant-numeric:tabular-nums; }
.dss-thread { list-style:none; margin:0; padding:0; counter-reset:dss-step; }
.dss-thread li { position:relative; padding:9px 0 11px 32px; border-top:1px solid var(--dsw-alias-border-l1); }
.dss-thread li:first-child { border-top:0; padding-top:2px; }
.dss-thread li::before { counter-increment:dss-step; content:counter(dss-step); position:absolute; left:0; top:9px; width:21px; height:21px; border-radius:50%; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.dss-thread li:first-child::before { top:2px; }
.dss-thread p { margin:0; white-space:pre-wrap; word-break:break-word; line-height:1.62; }
.dss-meta { color:var(--dsw-alias-label-secondary); font-size:11.5px; white-space:nowrap; }
.dss-prose { margin:0; white-space:pre-wrap; word-break:break-word; line-height:1.68; max-height:360px; overflow:auto; }
.dss-rows { list-style:none; margin:0; padding:0; }
.dss-rows li { display:flex; align-items:flex-start; gap:9px; padding:8px 0; border-top:1px solid var(--dsw-alias-border-l1); font-size:13px; }
.dss-rows li:first-child { border-top:0; padding-top:2px; }
.dss-grow { flex:1 1 auto; min-width:0; word-break:break-word; }
.dss-code { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:1px 6px; border-radius:5px; background:var(--dsw-alias-bg-layer-2); word-break:break-all; }
.dss-count { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dss-chip { flex:none; font-size:11px; padding:1px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.dss-chip-ok { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-success-primary,#1f8a53); }
.dss-chip-bad { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-error-primary,#c0392b); }
.dss-turn { color:var(--dsw-alias-brand-primary,#4f6ef7); font-weight:640; font-variant-numeric:tabular-nums; min-width:30px; }
.dss-timeline li { align-items:center; }
.dss-dim { color:var(--dsw-alias-label-secondary); font-size:13px; margin:0; }
.dss-empty { padding:40px 8px; text-align:center; }
.dss-empty-title { margin:0 0 6px; font-size:15px; font-weight:620; }
.dss-empty-body { margin:0; color:var(--dsw-alias-label-secondary); font-size:13px; }
.dss-loading { padding:48px 0; text-align:center; color:var(--dsw-alias-label-secondary); font-size:13px; }
.dss-error { margin:0 0 14px; padding:10px 12px; border-radius:9px; border:1px solid var(--dsw-alias-state-error-primary,#c0392b); color:var(--dsw-alias-state-error-primary,#c0392b); font-size:13px; display:flex; gap:12px; align-items:center; }
.dss-metaRow { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12px; color:var(--dsw-alias-label-secondary); padding:0 2px 2px; }
.dss-summary { margin:8px 2px 0; font-size:13.5px; line-height:1.68; }
.dss-metaRow button { border:none; background:transparent; color:inherit; font:inherit; padding:0; cursor:pointer; text-decoration:underline dotted; }
.dss-lan { margin:0 0 14px; padding:12px 14px; border:1px solid var(--dsw-alias-brand-primary,#4f6ef7); border-radius:12px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:8px; }
.dss-lan-main { display:flex; align-items:center; flex-wrap:wrap; gap:8px 10px; }
.dss-lan-badge { flex:none; font-size:11px; padding:1px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary,#4f6ef7); }
.dss-lan-url { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:2px 8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); word-break:break-all; flex:1 1 260px; min-width:0; }
.dss-lan-exp { flex:none; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dss-lan-actions { display:flex; gap:8px; }
.dss-lan-alt { margin:0; font-size:11.5px; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.dss-shareBox { margin:0 0 14px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:10px; }
.dss-shareBox-lead { margin:0; font-size:13px; line-height:1.65; color:var(--dsw-alias-label-primary); }
.dss-shareBox-row { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.dss-shareBox-label { font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.dss-shareBox-note { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.dss-shareBox-error { margin:0; font-size:12.5px; color:var(--dsw-alias-state-error-primary,#c0392b); }
.dss-select { height:32px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; outline:none; cursor:pointer; }
.dss-select:focus-visible { border-color:var(--dsw-alias-brand-primary,#4f6ef7); }
/* The full conversation. Human/assistant rows are open; the rest start folded
   with a one-line preview, so the answers stay on screen. */
.dss-convo { display:flex; flex-direction:column; gap:8px; }
.dss-msg { border-left:3px solid var(--dsw-alias-border-l1); padding-left:11px; }
.dss-msg[data-role="human"] { border-left-color:var(--dsw-alias-brand-primary,#4f6ef7); }
.dss-msg[data-role="teammate"] { border-left-color:var(--dsw-alias-state-success-primary,#1f8a53); }
.dss-msg[data-role="notice"],.dss-msg[data-role="context"] { opacity:.78; }
.dss-msg[data-folded="true"] .dss-msg-role { color:var(--dsw-alias-label-secondary); }
.dss-msg-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; padding:2px 0; }
.dss-msg-head[role="button"] { cursor:pointer; }
.dss-msg-head[role="button"]:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:2px; border-radius:6px; }
.dss-msg-caret { flex:none; font-size:11px; color:var(--dsw-alias-label-secondary); transition:transform .12s ease; }
.dss-msg-caret[data-open="true"] { transform:rotate(90deg); }
.dss-msg-role { font-size:12px; font-weight:640; }
.dss-msg[data-role="human"] .dss-msg-role { color:var(--dsw-alias-brand-primary,#4f6ef7); }
.dss-msg[data-role="teammate"] .dss-msg-role { color:var(--dsw-alias-state-success-primary,#1f8a53); }
.dss-msg-preview { flex:1 1 200px; min-width:0; font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dss-msg .dss-md { padding:4px 0 10px; }
/* Markdown body. Quiet chrome: the text is the content. */
.dss-md { font-size:13.5px; line-height:1.7; word-break:break-word; }
.dss-md > *:first-child { margin-top:0; }
.dss-md > *:last-child { margin-bottom:0; }
.dss-md-p { margin:8px 0; }
.dss-md-h { margin:14px 0 7px; line-height:1.35; font-weight:640; }
.dss-md ul.dss-md-list, .dss-md ol.dss-md-list { margin:8px 0; padding-left:22px; }
.dss-md-list li { margin:3px 0; }
.dss-quote { margin:9px 0; padding:2px 0 2px 11px; border-left:3px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dss-hr { margin:14px 0; border:0; border-top:1px solid var(--dsw-alias-border-l1); }
.dss-md a { color:var(--dsw-alias-brand-primary,#4f6ef7); }
.dss-inline-code { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:1px 5px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }
.dss-pre { margin:10px 0; padding:9px 11px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); overflow:auto; font-size:12px; line-height:1.6; }
.dss-pre code { font:inherit; background:none; padding:0; }
.dss-tw { margin:10px 0; overflow-x:auto; }
.dss-tw table { border-collapse:collapse; width:100%; font-size:12.5px; }
.dss-tw th, .dss-tw td { border:1px solid var(--dsw-alias-border-l1); padding:5px 8px; text-align:left; vertical-align:top; }
.dss-tw th { background:var(--dsw-alias-bg-layer-2); font-weight:640; }
.dss-toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:60; padding:8px 14px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-label-primary); font-size:13px; box-shadow:0 6px 20px rgba(0,0,0,.22); }
.dss-mermaid { margin:12px 0; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.dss-mermaid-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--dsw-alias-bg-layer-2); border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; }
.dss-mermaid-tag { font-weight:600; color:var(--dsw-alias-label-secondary); font-size:11px; letter-spacing:.02em; text-transform:uppercase; }
.dss-mermaid-actions { display:flex; align-items:center; gap:6px; }
.dss-mermaid-btn { height:24px; padding:0 8px; border-radius:5px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:11.5px; cursor:pointer; white-space:nowrap; line-height:22px; }
.dss-mermaid-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.dss-mermaid-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:1px; }
.dss-mermaid-btn:disabled { opacity:.5; cursor:not-allowed; }
.dss-mermaid-body { padding:14px; overflow-x:auto; display:flex; justify-content:center; align-items:center; min-height:80px; background:var(--dsw-alias-bg-layer-1); }
.dss-mermaid-body svg { max-width:100%; height:auto; display:block; margin:0 auto; }
.dss-mermaid .dss-pre { margin:0; border-radius:0; border:none; background:transparent; }
.dss-mermaid-loading { font-size:12px; color:var(--dsw-alias-label-secondary); padding:16px; text-align:center; }
.dss-mermaid-err { padding:8px 12px; font-size:12px; color:var(--dsw-alias-state-danger-primary,#dc2626); background:var(--dsw-alias-bg-layer-2); border-bottom:1px solid var(--dsw-alias-border-l1); }
.dss-mermaid-modal { position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,.68); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; }
.dss-mermaid-modal-box, .dss-mermaid-modal-body, .dss-mermaid-modal-content { position:relative; width:96vw; height:94vh; max-width:96vw; max-height:94vh; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.4); display:flex; flex-direction:column; overflow:hidden; }
.dss-mermaid-modal-toolbar { position:absolute; top:14px; left:50%; transform:translateX(-50%); z-index:20; display:flex; align-items:center; gap:6px; padding:4px 8px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.25); backdrop-filter:blur(6px); }
.dss-mermaid-modal-toolbar .dss-mermaid-btn { height:26px; line-height:24px; padding:0 8px; font-size:12px; }
.dss-mermaid-modal-scale { font-size:12px; font-variant-numeric:tabular-nums; font-weight:600; color:var(--dsw-alias-label-primary); min-width:48px; text-align:center; padding:0 4px; user-select:none; }
.dss-mermaid-modal-divider { width:1px; height:16px; background:var(--dsw-alias-border-l1); margin:0 2px; }
.dss-mermaid-modal-close-btn { width:26px; height:26px; padding:0 !important; font-size:16px !important; display:inline-flex; align-items:center; justify-content:center; }
.dss-mermaid-modal-close { position:absolute; top:14px; right:14px; z-index:20; width:32px; height:32px; border-radius:50%; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:18px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s, border-color .15s; }
.dss-mermaid-modal-close:hover { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.dss-mermaid-modal-close:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:1px; }
.dss-mermaid-modal-viewport { flex:1; width:100%; height:100%; overflow:hidden; position:relative; cursor:grab; user-select:none; display:flex; align-items:center; justify-content:center; touch-action:none; }
.dss-mermaid-modal-viewport.is-dragging { cursor:grabbing; }
.dss-mermaid-modal-canvas { display:inline-flex; align-items:center; justify-content:center; transform-origin:center center; will-change:transform; user-select:none; transition:transform .12s ease-out; }
.dss-mermaid-modal-viewport.is-dragging .dss-mermaid-modal-canvas { transition:none !important; }
.dss-mermaid-modal-body svg, .dss-mermaid-modal-content svg, .dss-mermaid-modal-canvas svg { max-width:none !important; max-height:none !important; height:auto; display:block; margin:0 auto; pointer-events:none; }
.dss-mermaid-modal-canvas[data-has-dims="true"] svg { width:100% !important; height:100% !important; }
`

    function Stat(props) {
      return h('div', { className: 'dss-stat' },
        h('span', { className: 'dss-stat-k' }, props.label),
        h('span', { className: 'dss-stat-v' }, props.value))
    }

    function Card(props) {
      return h('section', { className: 'dss-card' },
        h('div', { className: 'dss-card-head' },
          h('h2', { className: 'dss-card-title' }, props.title),
          props.hint ? h('span', { className: 'dss-card-hint' }, props.hint) : null),
        props.children)
    }

    function Rows(props) {
      return h('ul', { className: `dss-rows${props.className ? ` ${props.className}` : ''}` },
        ...props.items)
    }

    // -----------------------------------------------------------------------
    // Markdown blocks → React elements
    //
    // The Host parses and returns block tokens; this turns those tokens into
    // elements. Deliberately not `dangerouslySetInnerHTML`: the content is model
    // and teammate output, and the browser should never be handed markup derived
    // from it. Every string here becomes a React text node, which escapes itself.
    // -----------------------------------------------------------------------

    function Inline(props) {
      const tokens = props.tokens
      if (!Array.isArray(tokens) || !tokens.length) return null
      return h(React.Fragment, null, ...tokens.map((token, index) => {
        const key = `i${index}`
        switch (token.type) {
          case 'strong':
            return h('strong', { key }, token.value)
          case 'em':
            return h('em', { key }, token.value)
          case 'code':
            return h('code', { key, className: 'dss-inline-code' }, token.value)
          case 'link':
            if (!/^https?:\/\//i.test(token.href ?? '')) return h(React.Fragment, { key }, token.value)
            return h('a', { key, href: token.href, rel: 'noreferrer noopener', target: '_blank' }, token.value)
          default:
            return h(React.Fragment, { key }, token.value)
        }
      }))
    }

    function MermaidBlock(props) {
      const block = props.block
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const source = String(block?.value ?? '')
      const [mode, setMode] = useState('chart')
      const [svg, setSvg] = useState('')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [copied, setCopied] = useState(false)
      const [isZoomed, setIsZoomed] = useState(false)
      const [dark, setDark] = useState(() => prefersDarkTheme())
      const [scale, setScale] = useState(1)
      const [position, setPosition] = useState({ x: 0, y: 0 })
      const [isDragging, setIsDragging] = useState(false)
      const dragStartRef = useRef(null)
      const viewportRef = useRef(null)
      const dims = useMemo(() => parseSvgDimensions(svg), [svg])

      useEffect(() => {
        function checkTheme() {
          const isDark = prefersDarkTheme()
          setDark((prev) => (prev !== isDark ? isDark : prev))
        }
        let mql = null
        try {
          mql = window.matchMedia?.('(prefers-color-scheme: dark)')
          mql?.addEventListener?.('change', checkTheme)
        } catch {}

        let observer = null
        try {
          if (typeof MutationObserver !== 'undefined' && document.documentElement) {
            observer = new MutationObserver(checkTheme)
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style'],
            })
          }
        } catch {}

        return () => {
          try {
            mql?.removeEventListener?.('change', checkTheme)
          } catch {}
          try {
            observer?.disconnect()
          } catch {}
        }
      }, [])

      useEffect(() => {
        if (!source.trim()) {
          setLoading(false)
          setError(t('mermaid.empty'))
          setMode('code')
          return
        }

        let cancelled = false
        setLoading(true)
        setError(null)

        loadMermaid()
          .then(async (mermaid) => {
            if (cancelled) return
            const id = 'dss-m-' + Math.random().toString(36).slice(2, 9)
            try {
              mermaid.initialize({
                startOnLoad: false,
                theme: dark ? 'dark' : 'default',
                securityLevel: 'loose',
                fontFamily: 'inherit',
              })
              const result = await mermaid.render(id, source)
              if (cancelled) return
              const svgCode = typeof result === 'string' ? result : (result?.svg ?? '')
              setSvg(svgCode)
              setLoading(false)
              setError(null)
            } catch (err) {
              if (cancelled) return
              try {
                const stray = document.getElementById(id) || document.getElementById('d' + id)
                stray?.remove?.()
              } catch {}
              setError(err?.message || t('mermaid.error'))
              setLoading(false)
              setMode('code')
            }
          })
          .catch((loadErr) => {
            if (cancelled) return
            setError(loadErr?.message || t('mermaid.error'))
            setLoading(false)
            setMode('code')
          })

        return () => {
          cancelled = true
        }
      }, [source, dark, t])

      const handleCopy = useCallback(async () => {
        const ok = await copyText(source)
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        }
      }, [source])

      const handleToggle = useCallback(() => {
        setMode((prev) => (prev === 'chart' ? 'code' : 'chart'))
      }, [])

      const handleZoom = useCallback(() => {
        if (svg) setIsZoomed(true)
      }, [svg])

      const handleCloseZoom = useCallback(() => {
        setIsZoomed(false)
      }, [])

      const handleZoomIn = useCallback(() => {
        setScale((prev) => Math.min(5, Math.round((prev + 0.2) * 10) / 10))
      }, [])

      const handleZoomOut = useCallback(() => {
        setScale((prev) => Math.max(0.2, Math.round((prev - 0.2) * 10) / 10))
      }, [])

      const handleResetZoom = useCallback(() => {
        setScale(1)
        setPosition({ x: 0, y: 0 })
      }, [])

      const handleFitZoom = useCallback(() => {
        const vp = viewportRef.current
        if (!vp) return
        const vpWidth = vp.clientWidth - 48
        const vpHeight = vp.clientHeight - 48
        if (vpWidth <= 0 || vpHeight <= 0) return
        let tw = dims.width
        let th = dims.height
        if (!tw || !th) {
          const svgEl = vp.querySelector('svg')
          if (svgEl) {
            const rect = svgEl.getBoundingClientRect()
            tw = rect.width / (scale || 1)
            th = rect.height / (scale || 1)
          }
        }
        if (!tw || !th || tw <= 0 || th <= 0) {
          setScale(1)
          setPosition({ x: 0, y: 0 })
          return
        }
        const fit = Math.min(vpWidth / tw, vpHeight / th)
        setScale(Math.max(0.2, Math.min(5, Math.round(fit * 100) / 100)))
        setPosition({ x: 0, y: 0 })
      }, [dims, scale])

      useEffect(() => {
        if (isZoomed) {
          setScale(1)
          setPosition({ x: 0, y: 0 })
          setIsDragging(false)
        }
      }, [isZoomed])

      useEffect(() => {
        if (!isZoomed) return
        const el = viewportRef.current
        if (!el) return
        const onWheel = (e) => {
          e.preventDefault()
          const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87
          setScale((prev) => {
            const next = prev * zoomFactor
            return Math.min(5, Math.max(0.2, Math.round(next * 100) / 100))
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [isZoomed])

      const handleMouseDown = useCallback((e) => {
        if (e.button !== 0) return
        setIsDragging(true)
        dragStartRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          origX: position.x,
          origY: position.y,
        }
      }, [position])

      useEffect(() => {
        if (!isDragging) return
        const onMouseMove = (e) => {
          if (!dragStartRef.current) return
          const dx = e.clientX - dragStartRef.current.startX
          const dy = e.clientY - dragStartRef.current.startY
          setPosition({
            x: Math.round(dragStartRef.current.origX + dx),
            y: Math.round(dragStartRef.current.origY + dy),
          })
        }
        const onMouseUp = () => {
          setIsDragging(false)
          dragStartRef.current = null
        }
        window.addEventListener('mousemove', onMouseMove)
        window.addEventListener('mouseup', onMouseUp)
        return () => {
          window.removeEventListener('mousemove', onMouseMove)
          window.removeEventListener('mouseup', onMouseUp)
        }
      }, [isDragging])

      const handleDownload = useCallback(() => {
        if (!svg || typeof document === 'undefined') return
        try {
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          const timestamp = Date.now()
          a.href = url
          a.download = `对话分享-图表-${timestamp}.svg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (e) {
          console.error('Failed to download mermaid svg:', e)
        }
      }, [svg])

      useEffect(() => {
        if (!isZoomed) return
        function onKeyDown(e) {
          if (e.key === 'Escape') {
            setIsZoomed(false)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [isZoomed])

      const hasError = Boolean(error)
      const isChart = mode === 'chart' && !hasError && Boolean(svg)
      const copyLabel = copied ? t('mermaid.copied') : t('mermaid.copy')
      const toggleLabel = mode === 'chart' ? t('mermaid.code') : t('mermaid.chart')

      const codeElement = h('pre', { className: 'dss-pre' },
        h('code', { className: 'lang-mermaid' }, source))

      return h('div', { className: 'dss-mermaid', 'data-view': mode },
        h('div', { className: 'dss-mermaid-bar' },
          h('span', { className: 'dss-mermaid-tag' }, t('mermaid.label') || 'MERMAID'),
          h('div', { className: 'dss-mermaid-actions' },
            !hasError && (svg || loading)
              ? h('button', {
                  type: 'button',
                  className: 'dss-mermaid-btn',
                  onClick: handleToggle,
                  disabled: loading,
                }, toggleLabel)
              : null,
            !hasError && (svg || loading)
              ? h('button', {
                  type: 'button',
                  className: 'dss-mermaid-btn',
                  onClick: handleZoom,
                  disabled: loading || !svg,
                  title: t('mermaid.zoom'),
                }, t('mermaid.zoom'))
              : null,
            !hasError && (svg || loading)
              ? h('button', {
                  type: 'button',
                  className: 'dss-mermaid-btn',
                  onClick: handleDownload,
                  disabled: loading || !svg,
                  title: t('mermaid.download'),
                }, t('mermaid.download'))
              : null,
            h('button', {
              type: 'button',
              className: 'dss-mermaid-btn',
              onClick: handleCopy,
            }, copyLabel))),
        hasError
          ? h('div', { className: 'dss-mermaid-err' }, error || t('mermaid.error'))
          : null,
        loading && mode === 'chart'
          ? h('div', { className: 'dss-mermaid-loading' }, t('mermaid.loading'))
          : null,
        isChart
          ? h('div', {
              className: 'dss-mermaid-body',
              dangerouslySetInnerHTML: { __html: svg },
            })
          : (!loading || mode === 'code' ? codeElement : null),
        isZoomed && svg
          ? h('div', {
              className: 'dss-mermaid-modal',
              onClick: (e) => {
                if (e.target === e.currentTarget) {
                  setIsZoomed(false)
                }
              },
            },
              h('div', {
                className: 'dss-mermaid-modal-box dss-mermaid-modal-body dss-mermaid-modal-content',
                onClick: (e) => e.stopPropagation(),
              },
                h('div', {
                  className: 'dss-mermaid-modal-toolbar',
                  onMouseDown: (e) => e.stopPropagation(),
                },
                  h('button', {
                    type: 'button',
                    className: 'dss-mermaid-btn',
                    onClick: handleZoomOut,
                    disabled: scale <= 0.2,
                    title: t('mermaid.zoomOut'),
                  }, '−'),
                  h('span', { className: 'dss-mermaid-modal-scale' }, `${Math.round(scale * 100)}%`),
                  h('button', {
                    type: 'button',
                    className: 'dss-mermaid-btn',
                    onClick: handleZoomIn,
                    disabled: scale >= 5,
                    title: t('mermaid.zoomIn'),
                  }, '+'),
                  h('div', { className: 'dss-mermaid-modal-divider' }),
                  h('button', {
                    type: 'button',
                    className: 'dss-mermaid-btn',
                    onClick: handleResetZoom,
                    title: t('mermaid.zoomReset'),
                  }, t('mermaid.zoomReset')),
                  h('button', {
                    type: 'button',
                    className: 'dss-mermaid-btn',
                    onClick: handleFitZoom,
                    title: t('mermaid.zoomFit'),
                  }, t('mermaid.zoomFit')),
                  h('div', { className: 'dss-mermaid-modal-divider' }),
                  h('button', {
                    type: 'button',
                    className: 'dss-mermaid-btn dss-mermaid-modal-close-btn',
                    onClick: handleCloseZoom,
                    title: t('mermaid.close'),
                    'aria-label': t('mermaid.close'),
                  }, '×')
                ),
                h('button', {
                  type: 'button',
                  className: 'dss-mermaid-modal-close',
                  onClick: handleCloseZoom,
                  title: t('mermaid.close'),
                  'aria-label': t('mermaid.close'),
                }, '×'),
                h('div', {
                  ref: viewportRef,
                  className: `dss-mermaid-modal-viewport${isDragging ? ' is-dragging' : ''}`,
                  onMouseDown: handleMouseDown,
                },
                  h('div', {
                    className: 'dss-mermaid-modal-canvas',
                    'data-has-dims': Boolean(dims.width && dims.height),
                    style: {
                      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                      ...(dims.width ? { width: `${dims.width}px` } : {}),
                      ...(dims.height ? { height: `${dims.height}px` } : {}),
                    },
                    dangerouslySetInnerHTML: { __html: svg },
                  })
                )
              )
            )
          : null)
    }

    /** One block → one element. Unknown blocks render as a paragraph. */
    function Block(props) {
      const block = props.block
      switch (block.type) {
        case 'h': {
          const level = Math.min(6, Math.max(2, block.level ?? 2))
          return h(`h${level}`, { className: 'dss-md-h' }, h(Inline, { tokens: block.inline }))
        }
        case 'code':
          if (isMermaidCode(block.lang, block.value)) {
            return h(MermaidBlock, { block, t: props.t })
          }
          return h('pre', { className: 'dss-pre' }, h('code', null, block.value))
        case 'quote':
          return h('blockquote', { className: 'dss-quote' }, h(Inline, { tokens: block.inline }))
        case 'hr':
          return h('hr', { className: 'dss-hr' })
        case 'ul':
          return h('ul', { className: 'dss-md-list' },
            ...(block.items ?? []).map((item, index) => h('li', { key: `u${index}` }, h(Inline, { tokens: item }))))
        case 'ol':
          return h('ol', { className: 'dss-md-list' },
            ...(block.items ?? []).map((item, index) => h('li', { key: `o${index}` }, h(Inline, { tokens: item }))))
        case 'table':
          return h('div', { className: 'dss-tw' },
            h('table', null,
              h('thead', null,
                h('tr', null, ...(block.head ?? []).map((cell, index) =>
                  h('th', { key: `h${index}` }, h(Inline, { tokens: cell }))))),
              h('tbody', null, ...(block.rows ?? []).map((row, rowIndex) =>
                h('tr', { key: `r${rowIndex}` }, ...(row ?? []).map((cell, cellIndex) =>
                  h('td', { key: `c${cellIndex}` }, h(Inline, { tokens: cell }))))))))
        default:
          return h('p', { className: 'dss-md-p' }, h(Inline, { tokens: block.inline }))
      }
    }

    /** A parsed Markdown body. */
    function Blocks(props) {
      const blocks = props.blocks
      const t = props.t
      if (!Array.isArray(blocks) || !blocks.length) return null
      return h('div', { className: 'dss-md' },
        ...blocks.map((block, index) => h(Block, { key: `b${index}`, block, t })))
    }

    /** Envelope lines say who sent a message, never what it says. */
    const ENVELOPE = /^(Team message from .+?:|Background subagent \S+ finished.*|Its closing message:|【.*】$)/i

    /** First meaningful line of a parsed body, for the folded row's preview. */
    function previewOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      for (const block of blocks) {
        const text = block.type === 'code'
          ? block.value
          : Array.isArray(block.inline)
            ? block.inline.map((token) => token.value ?? '').join('')
            : ''
        for (const line of String(text ?? '').split('\n')) {
          const bare = line.trim()
          if (!bare || ENVELOPE.test(bare)) continue
          return bare
        }
      }
      return ''
    }

    /**
     * One conversation row.
     *
     * Open by default only for the exchange itself — the person and the
     * assistant. Harness context, teammate reports and subagent notices start
     * folded with a one-line preview, so the page reads as a conversation first
     * and everything else is one click away instead of pushing the answers off
     * the screen.
     */
    function MessageRow(props) {
      const entry = props.entry
      const t = props.t
      const interactive = entry.role !== 'human' && entry.role !== 'assistant'
      const [open, setOpen] = useState(!interactive)
      const preview = interactive && !open ? previewOf(entry.blocks) : ''
      const meta = [
        clockText(entry.time),
        entry.source,
        entry.truncated ? t('transcript.truncated') : null,
      ].filter(Boolean).join(' · ')

      const head = h('div', {
        className: 'dss-msg-head',
        role: interactive ? 'button' : undefined,
        tabIndex: interactive ? 0 : undefined,
        'aria-expanded': interactive ? open : undefined,
        onClick: interactive ? () => setOpen((value) => !value) : undefined,
        onKeyDown: interactive
          ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setOpen((value) => !value)
          }
          : undefined,
      },
        h('span', { className: 'dss-msg-caret', 'data-open': open }, interactive ? '▸' : ''),
        h('span', { className: 'dss-msg-role' }, label(t, 'role.', entry.role)),
        h('span', { className: 'dss-meta' }, meta),
        preview ? h('span', { className: 'dss-msg-preview' }, preview) : null)

      return h('article', {
        className: 'dss-msg',
        'data-role': entry.role,
        'data-folded': interactive ? String(!open) : 'false',
      },
        head,
        open ? h(Blocks, { blocks: entry.blocks, t }) : null)
    }

    /** The analysis itself, rendered from the Host payload. */
    function Analysis(props) {
      const t = props.t
      const data = props.data
      const session = data?.session
      // The payload is ours, but a slot entry that throws renders as nothing at
      // all: one shape check turns a corrupt answer into a sentence instead.
      if (!session || typeof session !== 'object') {
        return h('p', { className: 'dss-dim' }, t('state.error'))
      }
      const thread = data.prompts ?? []
      const todos = data.todos ?? []
      const tools = data.tools ?? []
      const files = data.files ?? []
      const timeline = data.timeline ?? []
      const errors = data.errors ?? []
      const transcript = data.transcript ?? []

      return h('div', { className: 'dss-inner' },
        h(Card, { title: t('section.overview'), hint: t('section.overview.hint') },
          h('div', { className: 'dss-stats' },
            h(Stat, { label: t('stats.turns'), value: String(session.turns) }),
            h(Stat, { label: t('stats.user'), value: String(session.userMessages) }),
            h(Stat, { label: t('stats.assistant'), value: String(session.assistantMessages) }),
            h(Stat, { label: t('stats.tools'), value: String(session.toolCalls) }),
            h(Stat, { label: t('stats.duration'), value: durationText(session.durationMs, t) }),
            h(Stat, {
              label: t('stats.tokens'),
              value: String((session.inputTokens ?? 0) + (session.outputTokens ?? 0)),
            }))),

        thread.length
          ? h(Card, { title: t('section.thread'), hint: t('section.thread.hint') },
            h('ol', { className: 'dss-thread' },
              ...thread.map((prompt, index) => h('li', { key: `p${index}` },
                h('p', null, prompt.text),
                h('span', { className: 'dss-meta' }, clockText(prompt.time))))))
          : null,

        // The conversation itself. The Host already parsed it into blocks, so
        // this renders tokens — it never re-parses Markdown in the browser.
        transcript.length
          ? h(Card, { title: t('section.transcript'), hint: t('section.transcript.hint') },
            h('div', { className: 'dss-convo' },
              ...transcript.map((entry, index) => h(MessageRow, {
                key: `m${index}`,
                entry,
                t,
              }))))
          : null,

        h(Card, { title: t('section.conclusion'), hint: t('section.conclusion.hint') },
          data.conclusion
            ? h(Blocks, { blocks: data.conclusionBlocks ?? [], t })
            : h('p', { className: 'dss-dim' }, t('empty.conclusion'))),

        todos.length
          ? h(Card, { title: t('section.todos'), hint: t('section.todos.hint') },
            h(Rows, {
              items: todos.map((todo, index) => h('li', { key: `t${index}` },
                h('span', {
                  className: `dss-chip${todo.status === 'completed' ? ' dss-chip-ok' : ''}`,
                }, label(t, 'status.', todo.status)),
                h('span', { className: 'dss-grow' }, todo.content))),
            }))
          : null,

        h(Card, { title: t('section.tools') },
          tools.length
            ? h(Rows, {
              items: tools.map((tool, index) => h('li', { key: `x${index}` },
                h('span', { className: 'dss-code' }, tool.name),
                h('span', { className: 'dss-count' }, `× ${tool.count}`),
                tool.errors
                  ? h('span', { className: 'dss-chip dss-chip-bad' }, `${tool.errors} ✗`)
                  : null,
                h('span', { className: 'dss-grow' })))
            })
            : h('p', { className: 'dss-dim' }, t('empty.tools'))),

        h(Card, { title: t('section.files') },
          files.length
            ? h(Rows, {
              items: files.map((file, index) => h('li', { key: `f${index}` },
                h('span', { className: 'dss-code dss-grow' }, file.path),
                ...file.ops.map((op) => h('span', { key: op, className: 'dss-chip' }, label(t, 'op.', op))))),
            })
            : h('p', { className: 'dss-dim' }, t('empty.files'))),

        timeline.length
          ? h(Card, { title: t('section.timeline') },
            h(Rows, {
              className: 'dss-timeline',
              items: timeline.map((entry, index) => h('li', { key: `l${index}` },
                h('span', { className: 'dss-turn' }, `#${entry.turn}`),
                h('span', { className: 'dss-grow' }, entry.prompt || '—'),
                h('span', { className: 'dss-meta' },
                  `${durationText(entry.durationMs, t)}${entry.reason ? ` · ${label(t, 'reason.', entry.reason)}` : ''}`))),
            }))
          : null,

        errors.length
          ? h(Card, { title: t('section.errors') },
            h(Rows, {
              items: errors.map((error, index) => h('li', { key: `e${index}` },
                h('span', { className: 'dss-code' }, error.name),
                h('span', { className: 'dss-chip dss-chip-bad' }, error.code || '—'),
                h('span', { className: 'dss-grow' }, error.reason))),
            }))
          : null)
    }

    /** The Conversation View: the loaded panel, plus the share actions. */
    function ShareView(props) {
      // Subscribed before any hook that reads the language.
      useLocaleTick(props?.locale)
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const lang = typeof props?.lang === 'function' ? String(props.lang() || 'zh') : 'zh'
      const sessionId = props?.sessionId ? String(props.sessionId) : ''

      const [phase, setPhase] = useState('loading')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // LAN sharing: `busy` covers the round trip, `lan` the live link (if any).
      const [busy, setBusy] = useState(false)
      const [lan, setLan] = useState(null)
      const [lanError, setLanError] = useState('')
      const [minutes, setMinutes] = useState(30)
      // Every load takes a ticket; only the newest answer may land. A Refresh
      // racing a language switch would otherwise let the older one win.
      const run = useRef(0)

      const load = useCallback(async () => {
        const ticket = ++run.current
        if (!sessionId) {
          setPhase('empty')
          return
        }
        setPhase('loading')
        setError('')
        try {
          const body = await getAnalysis(sessionId, lang)
          if (ticket !== run.current) return
          setData(body)
          setPhase('ready')
        } catch (failure) {
          if (ticket !== run.current) return
          setError(failure?.message ?? String(failure))
          setPhase('error')
        }
      }, [sessionId, lang])

      useEffect(() => { void load() }, [load])

      /** Re-attach to a link that is still alive, so a re-render does not lose it. */
      useEffect(() => {
        let cancelled = false
        void (async () => {
          if (!sessionId) return
          const status = await readLanStatus()
          if (cancelled || !status?.listening) return
          const own = (status.shares ?? []).find((share) => share.sessionId === sessionId)
          if (!own || !own.urls?.length) return
          setLan({
            token: own.token,
            url: own.urls[0],
            urls: own.urls,
            expiresAt: own.expiresAt,
            fileName: own.fileName,
          })
        })()
        return () => { cancelled = true }
      }, [sessionId])

      useEffect(() => {
        if (!notice) return undefined
        const timer = window.setTimeout(() => setNotice(''), NOTICE_MS)
        return () => window.clearTimeout(timer)
      }, [notice])

      const previewUrl = useMemo(
        () => (sessionId ? localPageUrl(sessionId, lang) : ''),
        [sessionId, lang],
      )

      const onStartLan = useCallback(async () => {
        if (!sessionId || busy) return
        setBusy(true)
        setLanError('')
        try {
          const started = await startLanShare(sessionId, lang, minutes)
          if (!started.url) throw new Error(t('lan.noAddress'))
          setLan({
            token: started.token,
            url: started.url,
            urls: started.urls ?? [],
            expiresAt: started.expiresAt,
            fileName: data?.fileNames?.html ?? '',
          })
          setNotice(t('notice.lanStarted'))
        } catch (failure) {
          setLanError(failure?.message ?? String(failure))
        } finally {
          setBusy(false)
        }
      }, [sessionId, lang, minutes, busy, data, t])

      const onStopLan = useCallback(async () => {
        if (!lan || busy) return
        setBusy(true)
        try {
          await stopLanShare(lan.token)
          setLan(null)
          setNotice(t('notice.lanStopped'))
        } catch (failure) {
          setLanError(failure?.message ?? String(failure))
        } finally {
          setBusy(false)
        }
      }, [lan, busy, t])

      const onCopyLan = useCallback(async () => {
        if (!lan) return
        setNotice((await copyText(lan.url)) ? t('notice.lanCopied') : t('notice.copyFailed'))
      }, [lan, t])

      const onCopyMarkdown = useCallback(async () => {
        const markdown = data?.markdown
        if (!markdown) return
        setNotice((await copyText(markdown)) ? t('notice.markdown') : t('notice.copyFailed'))
      }, [data, t])

      const onOpenPreview = useCallback(() => {
        if (!previewUrl) return
        window.open(previewUrl, '_blank', 'noopener')
        setNotice(t('notice.opened'))
      }, [previewUrl, t])

      /** Download through the Host, so `Content-Disposition` names the file. */
      const onDownload = useCallback((kind) => {
        const target = kind === 'md'
          ? hostUrl(`dsh-share/md?sessionId=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(lang)}&download=1`)
          : hostUrl(`dsh-share/page?sessionId=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(lang)}&download=1`)
        if (!sessionId) return
        const anchor = document.createElement('a')
        anchor.href = target
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          // Same reason as `copyText`: remove the temporary element even if the
          // click throws, or it would stay in the app's body for the page's life.
          anchor.remove()
        }
        setNotice(t('notice.downloaded'))
      }, [sessionId, lang, t])

      const onCopyId = useCallback(async () => {
        if (!sessionId) return
        setNotice((await copyText(sessionId)) ? t('notice.idCopied') : t('notice.copyFailed'))
      }, [sessionId, t])

      const analysis = phase === 'ready' ? data?.analysis : undefined
      const ready = Boolean(analysis)
      const expiry = lan ? clockText(lan.expiresAt) : ''

      /** The live-link strip: the only thing on this page a colleague can open. */
      const lanBar = lan
        ? h('div', { className: 'dss-lan' },
          h('div', { className: 'dss-lan-main' },
            h('span', { className: 'dss-lan-badge' }, t('lan.badge')),
            h('code', { className: 'dss-lan-url', title: lan.url }, lan.url),
            h('span', { className: 'dss-lan-exp' }, `${t('lan.expires')} ${expiry}`)),
          h('div', { className: 'dss-lan-actions' },
            h('button', { type: 'button', className: 'dss-btn dss-btn-primary', onClick: () => { void onCopyLan() } },
              t('lan.copy')),
            h('button', { type: 'button', className: 'dss-btn', onClick: () => { void onStopLan() }, disabled: busy },
              t('lan.stop'))),
          lan.urls.length > 1
            ? h('p', { className: 'dss-lan-alt' },
              `${t('lan.alt')} ${lan.urls.slice(1).join('  ·  ')}`)
            : null)
        : null

      /** Before a link exists: the duration picker and the honest caveat. */
      const lanHint = !lan
        ? h('div', { className: 'dss-shareBox' },
          h('p', { className: 'dss-shareBox-lead' }, t('lan.lead')),
          h('div', { className: 'dss-shareBox-row' },
            h('label', { className: 'dss-shareBox-label' }, t('lan.minutes')),
            h('select', {
              className: 'dss-select',
              value: String(minutes),
              onChange: (event) => setMinutes(Number(event.target.value) || 30),
            }, ...[10, 30, 60, 180].map((value) => h('option', { key: value, value: String(value) }, `${value} ${t('unit.minute')}`))),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-primary',
              onClick: () => { void onStartLan() },
              disabled: busy || !sessionId,
            }, busy ? t('lan.starting') : t('lan.start'))),
          h('p', { className: 'dss-shareBox-note' }, t('lan.note')),
          lanError ? h('p', { className: 'dss-shareBox-error' }, lanError) : null)
        : null

      const body = phase === 'empty'
        ? h('div', { className: 'dss-empty' },
          h('p', { className: 'dss-empty-title' },
            sessionId ? t('state.empty.title') : t('state.noSession')),
          sessionId ? h('p', { className: 'dss-empty-body' }, t('state.empty.body')) : null)
        : phase === 'loading'
          ? h('div', { className: 'dss-loading' }, t('state.loading'))
          : phase === 'error'
            ? h('div', { className: 'dss-empty' },
              h('div', { className: 'dss-error' },
                h('span', null, `${t('state.error')}: ${error}`),
                h('button', { type: 'button', className: 'dss-btn', onClick: () => { void load() } }, t('action.retry'))))
            : analysis
              ? h(Analysis, { data: analysis, t })
              : h('p', { className: 'dss-dim' }, t('state.error'))

      return h('div', { className: 'dss-root' },
        h('style', null, STYLES),
        h('header', { className: 'dss-head' },
          h('div', null,
            h('h1', { className: 'dss-h1' }, t('title')),
            h('p', { className: 'dss-sub' }, t('subtitle'))),
          h('div', { className: 'dss-tools' },
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: () => { void load() },
              disabled: phase === 'loading' || !sessionId,
            }, t('action.refresh')),
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: () => { void onCopyMarkdown() },
              disabled: !ready,
            }, t('action.copyMarkdown')),
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: () => onDownload('html'),
              disabled: !sessionId,
            }, t('action.downloadHtml')),
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: () => onDownload('md'),
              disabled: !sessionId,
            }, t('action.downloadMd')),
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: onOpenPreview,
              disabled: !sessionId,
            }, t('action.open')))),
        h('div', { className: 'dss-body' },
          lanBar,
          !lan ? lanHint : null,
          ready
            ? h('div', { className: 'dss-inner', style: { marginBottom: '14px' } },
              h('div', { className: 'dss-metaRow' },
                h('span', null, `${t('meta.generated')}: ${stampText(analysis.generatedAt)}`),
                h('button', {
                  type: 'button',
                  title: t('meta.copyId'),
                  onClick: onCopyId,
                }, `${t('meta.session')}: ${sessionId}`),
                analysis.session.cwd
                  ? h('span', null, `${t('meta.dir')}: ${analysis.session.cwd}`)
                  : null),
              data.summary ? h('p', { className: 'dss-summary' }, data.summary) : null)
            : null,
          body),
        notice ? h('div', { className: 'dss-toast' }, notice) : null)
    }

    // -----------------------------------------------------------------------
    // Module
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-share: dictionaries')
        const t = ctx.locale.bind(NS)

        /** The locale the artifact should be written in, read at render time. */
        const lang = () => {
          try {
            const snapshot = ctx.locale.getLocale?.() ?? ctx.locale.getSnapshot?.()
            return String(snapshot?.active ?? 'zh')
          } catch {
            return 'zh'
          }
        }

        // The tab sits after the shipped Views. Its owner hands us the Session
        // through the standard props, which is where `sessionId` comes from.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: VIEW_ORDER,
          locale: NS,
          label: () => t('view.tab'),
          inject: () => ({ t, lang }),
        }, (slotProps) => h(ShareView, {
          t: slotProps?.t ?? t,
          lang: slotProps?.lang ?? lang,
          locale: ctx.locale,
          sessionId: slotProps?.sessionId,
        })))
      },
    }
  },
})
