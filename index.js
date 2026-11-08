/**
 * Host half of `@local/dsh-share`.
 *
 * Owns four read-only routes and nothing else:
 *
 *   GET  /dsh-share/api/analysis?sessionId=…&lang=zh|en      → the analysis as JSON
 *   GET  /dsh-share/page?sessionId=…&lang=…[&download=1]     → the standalone page
 *   GET  /dsh-share/md?sessionId=…&lang=…[&download=1]       → the same page as Markdown
 *   POST /dsh-share/api/lan/start | /api/lan/stop            → a token-addressed LAN link
 *
 * The analysis is a deterministic fold over the session log — no model call, no
 * extra state, and the same input always produces the same page. The session log
 * is the only source: `snapshotEvents()` is the whole conversation (including a
 * fork's inherited prefix), so the result is reconstructable and honest.
 *
 * ## Why there are two kinds of share
 *
 * The Harness web server binds a loopback address, so `/dsh-share/page` is
 * reachable only from this machine: `127.0.0.1` means "the computer I am on", so
 * a colleague pasting that link into their own browser reaches *their* machine.
 * A link someone else can actually open therefore needs a listener they can
 * reach, which is what `/api/lan/start` provides: a short-lived HTTP server on
 * the LAN interfaces that serves one frozen snapshot under an unguessable token.
 * The file download stays the answer when the reader is not on this network.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'

export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-share'
const MAX_PROMPTS = 24
const PROMPT_CHARS = 700
const CONCLUSION_CHARS = 2600
const MAX_TIMELINE = 40
const MAX_FILES = 40
const MAX_ERRORS = 12
/** One transcript message, and the whole transcript, stay readable to render. */
const MAX_MESSAGE_CHARS = 40000
const MAX_TRANSCRIPT_CHARS = 300000

/**
 * The `user/message` sources that belong in a shared conversation.
 *
 * The Harness records everything it feeds the model as a user message, so a
 * plain "user/message" filter would either publish the runtime context and the
 * skill catalogue (noise that says nothing about the conversation) or drop the
 * teammate reports (the substance of a multi-agent session). This table keeps
 * exactly the three that are part of the conversation a person had:
 *
 *   user             — the person typing
 *   agent-message    — a teammate's message arriving in this Session
 *   subagent-settled — a background subagent's closing report
 *
 * Everything else (`user-approval`, `runtime-context`, `skill-catalog`,
 * `time-context`) is harness scaffolding and is left out.
 */
const CONVERSATION_SOURCES = {
  user: 'human',
  'agent-message': 'teammate',
  'subagent-settled': 'notice',
}
/** How long a LAN link lives, and the ceiling for what a caller may ask for. */
const LAN_DEFAULT_MINUTES = 30
const LAN_MAX_MINUTES = 12 * 60
const LAN_MAX_SHARES = 8
const MAX_BODY_BYTES = 64 * 1024

/** Tools whose arguments name the path they touched, and how to label that. */
const FILE_TOOL_OPS = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'write',
  multi_edit: 'write',
  apply_patch: 'write',
  notebook_edit: 'write',
  glob: 'search',
  grep: 'search',
  ls: 'search',
}

/** Every spelling a file tool has used for "the path I am about to touch". */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'absolute_path']

const TODO_TOOL = 'todo_write'

// ---------------------------------------------------------------------------
// Markdown
//
// The conversation is Markdown — models write it, and the teammate reports are
// full of headings, tables and bold claims. A share page that shows `**this**`
// literally is not a copy of the conversation, it is a mangled one. So the text
// is parsed once here into block tokens; the HTML page renders those tokens to
// HTML and the React panel renders the same tokens to elements. One parser, so
// the two surfaces can never disagree about what a message says.
// ---------------------------------------------------------------------------

/** Inline tokens: text, strong, em, code, link. */
function parseInline(text) {
  const tokens = []
  const source = String(text ?? '')
  let index = 0
  let plain = ''

  const flush = () => {
    if (plain) {
      tokens.push({ type: 'text', value: plain })
      plain = ''
    }
  }

  while (index < source.length) {
    const rest = source.slice(index)

    // `code` first: its body must not be interpreted as emphasis.
    const code = /^`([^`\n]+)`/.exec(rest)
    if (code) {
      flush()
      tokens.push({ type: 'code', value: code[1] })
      index += code[0].length
      continue
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest) || /^__([^_]+)__/.exec(rest)
    if (strong) {
      flush()
      tokens.push({ type: 'strong', value: strong[1] })
      index += strong[0].length
      continue
    }

    const em = /^\*([^*\n]+)\*/.exec(rest) || /^_([^_\n]+)_/.exec(rest)
    if (em) {
      flush()
      tokens.push({ type: 'em', value: em[1] })
      index += em[0].length
      continue
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      flush()
      tokens.push({ type: 'link', value: link[1], href: link[2] })
      index += link[0].length
      continue
    }

    plain += source[index]
    index += 1
  }

  flush()
  return tokens
}

const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/** Split a `| a | b |` row into trimmed cells. */
function tableCells(line) {
  let body = String(line).trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map((cell) => cell.trim())
}

/**
 * Common Mermaid diagram keywords and opening signatures.
 * Supports flowchart, graph, sequenceDiagram, classDiagram, stateDiagram,
 * erDiagram, gantt, pie, gitGraph, journey, quadrantChart, requirementDiagram,
 * c4, mindmap, timeline, zenuml, sankey, kanban, block, packet, xychart, architecture.
 */
const MERMAID_START_REGEX =
  /^(?:flowchart(?:\s+(?:TD|TB|BT|RL|LR)\b|\s*;|\s*$)|graph(?:\s+(?:TD|TB|BT|RL|LR)\b|\s*;|\s*$)|sequenceDiagram(?:\s*;|\s*$)|classDiagram(?:-v2)?(?:\s*;|\s*$)|stateDiagram(?:-v2)?(?:\s*;|\s*$)|erDiagram(?:\s*;|\s*$)|journey(?:\s*;|\s*$)|gantt(?:\s*;|\s*$)|pie(?:\s+title\b|\s+showData\b|\s*;|\s*$)|quadrantChart(?:\s*;|\s*$)|requirementDiagram(?:\s*;|\s*$)|gitGraph(?:\s*:|\s*;|\s*$)|c4(?:Context|Container|Component|Dynamic|Deployment)(?:\s*;|\s*$)|mindmap(?:\s*;|\s*$)|timeline(?:\s+title\b|\s*;|\s*$)|zenuml(?:\s*;|\s*$)|sankey(?:-beta)?(?:\s*;|\s*$)|kanban(?:\s*;|\s*$)|block(?:-beta)?(?:\s*;|\s*$)|xychart(?:-beta)?(?:\s*;|\s*$)|packet(?:-beta)?(?:\s*;|\s*$)|architecture(?:-beta)?(?:\s*;|\s*$))/i

/** Check whether a code block represents a Mermaid diagram. */
function isMermaidCode(lang, code) {
  const normLang = (lang || '').trim().toLowerCase()
  if (normLang === 'mermaid') return true

  // If a diagram type was given directly as the code fence language (e.g. ```flowchart)
  if (
    /^(?:flowchart|graph|sequencediagram|classdiagram|statediagram|erdiagram|journey|gantt|pie|quadrantchart|requirementdiagram|gitgraph|mindmap|timeline|zenuml|sankey|kanban|c4\w*)$/i.test(
      normLang,
    )
  ) {
    return true
  }

  // If a known non-mermaid language was explicitly declared, do not infer
  if (normLang && normLang !== 'text' && normLang !== 'txt') {
    return false
  }

  if (!code || typeof code !== 'string') return false

  let text = code.trimStart()
  // Strip YAML frontmatter: ^---\r?\n[\s\S]*?\r?\n---\s*
  if (text.startsWith('---')) {
    const match = /^---\r?\n[\s\S]*?\r?\n---\s*/.exec(text)
    if (match) {
      text = text.slice(match[0].length)
    }
  }

  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('%%')) continue
    return MERMAID_START_REGEX.test(line)
  }
  return false
}

/**
 * Parse Markdown into block tokens.
 *
 * Deliberately small: headings, paragraphs, lists, fenced code, quotes, tables
 * and rules — everything a conversation actually contains. Anything else stays
 * literal text, which is the honest result for a syntax this does not know.
 */
function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let index = 0

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ type: 'p', inline: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]

    // ```lang … ``` — verbatim, no inline parsing inside.
    const fence = /^\s*```([^\s`]*)\s*$/.exec(line)
    if (fence) {
      flushParagraph()
      const body = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      const rawLang = fence[1] || ''
      const codeVal = body.join('\n')
      const isMermaid = isMermaidCode(rawLang, codeVal)
      const lang = isMermaid ? (rawLang || 'mermaid') : rawLang
      blocks.push({
        type: 'code',
        lang,
        value: codeVal,
        ...(isMermaid ? { isMermaid: true } : {}),
      })
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: 'h',
        level: Math.min(6, heading[1].length),
        inline: parseInline(heading[2].trim()),
      })
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph()
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    // A table needs a header row and a divider row to be a table at all.
    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      flushParagraph()
      const head = tableCells(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      blocks.push({
        type: 'table',
        head: head.map((cell) => parseInline(cell)),
        rows: rows.map((cells) => cells.map((cell) => parseInline(cell))),
      })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      const body = [quote[1]]
      index += 1
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', inline: parseInline(body.join('\n')) })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      const items = []
      while (index < lines.length) {
        const match = /^\s*[-*+]\s+(.*)$/.exec(lines[index])
        if (!match) break
        items.push(parseInline(match[1]))
        index += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      const items = []
      while (index < lines.length) {
        const match = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index])
        if (!match) break
        items.push(parseInline(match[1]))
        index += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      index += 1
      continue
    }

    paragraph.push(line)
    index += 1
  }

  flushParagraph()
  return blocks
}

/** Inline tokens → HTML. Everything non-markup is escaped here. */
function inlineToHtml(tokens) {
  return (tokens ?? [])
    .map((token) => {
      switch (token.type) {
        case 'strong':
          return `<strong>${escapeHtml(token.value)}</strong>`
        case 'em':
          return `<em>${escapeHtml(token.value)}</em>`
        case 'code':
          return `<code>${escapeHtml(token.value)}</code>`
        case 'link': {
          // Only http(s) is turned into a link: a session log can contain any
          // scheme, and `javascript:` in a shared page is not a message.
          if (!/^https?:\/\//i.test(token.href ?? '')) return escapeHtml(token.value)
          return `<a href="${escapeHtml(token.href)}" rel="noreferrer noopener" target="_blank">${escapeHtml(token.value)}</a>`
        }
        default:
          return escapeHtml(token.value)
      }
    })
    .join('')
}

/** Render a dedicated Mermaid chart block container. */
function renderMermaidBlock(block, labels) {
  const l = labels || LABELS.zh
  const isEn = l === LABELS.en
  const codeLabel = l.mermaidCode || (isEn ? 'View source' : '查看源码')
  const chartLabel = l.mermaidChart || (isEn ? 'View chart' : '查看图表')
  const zoomLabel = l.mermaidZoom || (isEn ? 'Zoom' : '放大')
  const downloadLabel = l.mermaidDownload || (isEn ? 'Download image' : '下载图片')
  return [
    '<div class="mermaid-block" data-view="chart" data-rendered="false">',
    '  <div class="mermaid-toolbar">',
    '    <span class="mermaid-tag">Mermaid</span>',
    '    <div class="mermaid-actions">',
    `      <button type="button" class="mermaid-btn mermaid-zoom-btn" style="display:none;" title="${escapeHtml(zoomLabel)}">${escapeHtml(zoomLabel)}</button>`,
    `      <button type="button" class="mermaid-btn mermaid-download-btn" style="display:none;" title="${escapeHtml(downloadLabel)}">${escapeHtml(downloadLabel)}</button>`,
    `      <button type="button" class="mermaid-btn mermaid-toggle-btn" style="display:none;" data-label-code="${escapeHtml(codeLabel)}" data-label-chart="${escapeHtml(chartLabel)}" title="${escapeHtml(codeLabel)}">`,
    `        <span class="mermaid-btn-text">${escapeHtml(codeLabel)}</span>`,
    '      </button>',
    '    </div>',
    '  </div>',
    '  <div class="mermaid-chart" style="display:none;"></div>',
    `  <pre class="mermaid-code"><code class="lang-mermaid">${escapeHtml(block.value)}</code></pre>`,
    '</div>',
  ].join('\n')
}

/** Block tokens → HTML. */
function blocksToHtml(blocks, labels) {
  const parts = []
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'h':
        parts.push(`<h${block.level + 1}>${inlineToHtml(block.inline)}</h${block.level + 1}>`)
        break
      case 'code': {
        const isMermaid = Boolean(block.isMermaid || isMermaidCode(block.lang, block.value))
        if (isMermaid) {
          parts.push(renderMermaidBlock(block, labels))
        } else {
          parts.push(
            `<pre><code${block.lang ? ` class="lang-${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.value)}</code></pre>`,
          )
        }
        break
      }
      case 'quote':
        parts.push(`<blockquote>${inlineToHtml(block.inline)}</blockquote>`)
        break
      case 'hr':
        parts.push('<hr>')
        break
      case 'ul':
        parts.push(`<ul>${block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join('')}</ul>`)
        break
      case 'ol':
        parts.push(`<ol>${block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join('')}</ol>`)
        break
      case 'table':
        parts.push(
          `<div class="tw"><table><thead><tr>${block.head
            .map((cell) => `<th>${inlineToHtml(cell)}</th>`)
            .join('')}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inlineToHtml(cell)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        )
        break
      default:
        parts.push(`<p>${inlineToHtml(block.inline)}</p>`)
        break
    }
  }
  return parts.join('\n')
}

/**
 * A one-line preview of a folded message.
 *
 * The first line of a relayed message is its envelope — "Team message from
 * legal-audit:" or "Background subagent … finished" — which says who sent it and
 * nothing about what it says. Skipping those lines is the difference between a
 * folded row that invites a click and one that reads as pure noise.
 */
const ENVELOPE = /^(Team message from .+?:|Background subagent \S+ finished.*|Its closing message:|【.*】$)/i

function previewText(blocks) {
  const lines = blocksToText(blocks).split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const bare = line.replace(/<[^>]+>/g, '').trim()
    if (!bare || ENVELOPE.test(bare)) continue
    return bare
  }
  return lines[0] ?? ''
}

/** Block tokens → plain text, for a one-line preview of a folded message. */
function blocksToText(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block.type === 'code') parts.push(block.value)
    else if (block.type === 'table') {
      for (const row of block.rows ?? []) parts.push(row.map((cells) => cells.map((t) => t.value).join('')).join(' '))
    } else if (block.items) {
      for (const item of block.items) parts.push(item.map((token) => token.value ?? '').join(''))
    } else if (block.inline) {
      parts.push(block.inline.map((token) => token.value ?? '').join(''))
    }
  }
  return parts.join('\n').trim()
}

// ---------------------------------------------------------------------------
// Privacy: paths a reader must not receive
//
// The conversation is full of absolute paths — `@C:\Users\<name>\Desktop\x.docx`,
// tool arguments, the working directory, the session log location. A share page
// goes to somebody else, so those become `~` and `<user>` before anything is
// parsed: a path is the user's identity (their account name, their folder
// layout), not part of what they meant to say.
//
// Redaction happens once, at ingestion, so the page, the panel, the Markdown
// export and the download filename all inherit it — there is no second place
// able to put the real path back.
// ---------------------------------------------------------------------------

const HOME = (() => {
  try {
    return homedir()
  } catch {
    return ''
  }
})()

/**
 * Paths that carry an account name, in the spellings the platforms use.
 *
 * Separators are `[\\/]+` rather than a single character on purpose: a path
 * quoted inside a JSON string reaches this code with its separators doubled
 * (`D:\\Users\\me`), and that spelling is exactly as identifying as the plain one.
 */
const SEP = '[\\\\/]+'

const PRIVATE_PATHS = [
  // C:\Users\<name>, D:/Users/<name> — any drive, any separator run.
  new RegExp(`[A-Za-z]:${SEP}Users${SEP}[^\\\\/\\s"'<>|]+`, 'gi'),
  // \\?\C:\Users\<name> and \\server\Users\<name>
  new RegExp(`\\\\\\\\[?]?[^\\\\/\\s"'<>|]+${SEP}[^\\\\/\\s"'<>|]*${SEP}Users${SEP}[^\\\\/\\s"'<>|]+`, 'gi'),
  // /home/<name> and /Users/<name>
  /(^|[\s"'(\[])\/home\/[^/\s"'<>|]+/g,
  /(^|[\s"'(\[])\/Users\/[^/\s"'<>|]+/g,
]

/**
 * The account name itself, when it appears as a standalone word.
 *
 * Replacing whole paths is not enough: the name also shows up in prose — a
 * quoted file name, a command's output, a sentence about "C:\Users\me". A share
 * page must not carry the operator's account name at all, so any free-standing
 * occurrence becomes `<user>`.
 */
const ACCOUNT_NAME = (() => {
  if (!HOME) return ''
  const parts = HOME.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  // Only a name distinctive enough to be safe to match on its own: a two-letter
  // login would otherwise rewrite ordinary prose.
  return last.length >= 3 ? last : ''
})()

/**
 * Replace the reader-independent parts of a path with `~`.
 *
 * The home directory itself is replaced first: it is the longest spelling of the
 * same fact, and doing it first means a path under it becomes `~/Desktop/x.docx`
 * rather than `<user>\Desktop\x.docx`.
 */
function redactPaths(text) {
  let value = String(text ?? '')
  if (!value) return value
  if (HOME) {
    const escaped = HOME
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Both separator spellings of the same home directory, escaped or not.
      .replace(/\\\\/g, `[\\\\/]+`)
      .replace(/\//g, `[\\\\/]+`)
    value = value.replace(new RegExp(escaped, 'gi'), '~')
  }
  // Path shapes next: this is what turns `D:\Users\me` into `~` on a drive that
  // is not the home drive.
  for (const pattern of PRIVATE_PATHS) {
    value = value.replace(pattern, (match, lead) => {
      const prefix = typeof lead === 'string' ? lead : ''
      return prefix ? `${prefix}~` : '~'
    })
  }
  // Finally the bare account name. It runs last on purpose: by now every real
  // path has become `~`, so a standalone replacement can only hit the name used
  // as a word — a quoted filename, a command's output, a sentence about the
  // user — and it cannot eat the `<name>` inside a path that still needs folding.
  if (ACCOUNT_NAME) {
    const escaped = ACCOUNT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    value = value.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'gi'), '<user>')
  }
  return value
}

/** A path for display: home-relative, and its separators normalised. */
function displayPath(path) {
  return redactPaths(String(path ?? '').trim())
}

/**
 * Collapse a path so it identifies the file but not the machine's owner.
 *
 * A home path keeps only its file name (`~/报告.md`): the account name and the
 * folder layout under it say who owns the computer, which is not part of the
 * conversation. Any other absolute path keeps its last two segments
 * (`…/test/报告.md`), which still tells the reader which file is meant.
 */
function collapsePath(path) {
  const value = redactPaths(String(path ?? '').trim()).replace(/[\\/]{2,}/g, (run) => run[0])
  if (!value) return ''
  const parts = value.split(/[\\/]+/).filter((part) => part && part !== '~')
  if (value.startsWith('~')) return parts.length ? `~/${parts[parts.length - 1]}` : '~'
  if (parts.length <= 2) return value
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * The same collapse applied to prose.
 *
 * A message mentions files inline ("已写到 `D:\…\报告.md`"), so leaving prose
 * alone would leak exactly what the file card hides. Only path text changes.
 */
/**
 * Characters a path may plausibly start right after. `@` is the file-mention
 * sigil the Harness uses, so `@~\Desktop\x.docx` must collapse like any other
 * path; the rest are quotes and brackets.
 */
const PATH_LEAD = `^|[\\s"'(（【[\`@]`

function collapsePathsInText(text) {
  const value = redactPaths(String(text ?? ''))
  if (!value) return value
  const lead = new RegExp(`(${PATH_LEAD})(~[\\\\/]+(?:[^\\\\/\\s"'<>|，。；：、）\`]+[\\\\/]+)*[^\\\\/\\s"'<>|，。；：、）\`]+)`, 'g')
  return value
    // Home paths, already rewritten to `~\…` or `~/…` by `redactPaths`.
    .replace(lead, (match, before, path) => `${before}${collapsePath(path)}`)
    // Windows drive paths. Separators may be doubled: a path quoted inside a
    // JSON string reaches this code as `D:\\tools\\test`. The negative
    // lookbehind keeps a URL scheme (`http:`) from being read as a drive.
    .replace(
      /(?<![\w])[A-Za-z]:[\\/]+(?:[^\\/\s"'<>|，。；：、）]+[\\/]+)*[^\\/\s"'<>|，。；：、）]+/g,
      (match) => collapsePath(match),
    )
    // POSIX paths: a leading `/` plus at least two segments, and never inside a
    // URL (where the character before `/` is `:` or a word, not whitespace).
    .replace(
      new RegExp(`(${PATH_LEAD})(\\/(?:[^/\\s"'<>|，。；：、）\`]+\\/)+[^/\\s"'<>|，。；：、）\`]+)`, 'g'),
      (match, before, path) => `${before}${collapsePath(path)}`,
    )
}

/**
 * A sentence safe to use as a title or a filename.
 *
 * A first message is often "`@C:\…\制度.docx` 这个有什么坑", so the path — even
 * home-relative — is not part of what the conversation is about, and it must
 * not end up as the share page's headline or in the downloaded file's name.
 *
 * A `@`-mention is one whitespace-delimited token in practice, so it is removed
 * whole rather than matched up to punctuation: file names contain `、` and `，`,
 * which no "path ends at CJK punctuation" rule can tell apart from prose.
 */
function stripPathMentions(text) {
  return String(text ?? '')
    // File/folder mentions: `@A:\…`, `@/home/…`, `@~/…` — any token containing a
    // separator, which prose almost never does.
    .replace(/(^|\s)@\S*[\\/]\S*/g, '$1')
    // Absolute paths that were written without the leading `@`.
    .replace(/(^|\s)[A-Za-z]:[\\/]\S*/g, '$1')
    .replace(/(^|\s)\/(?:home|Users|tmp|var|etc|opt)\/\S*/g, '$1')
    .replace(/(^|\s)~\S*[\\/]\S*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/**
 * How one `user/message` belongs in a shared conversation.
 *
 * The Harness records everything it feeds the model as a user message, so the
 * kinds are not decoration: they are who is speaking. `user` is the person;
 * `agent-message` and `subagent-settled` are teammates reporting back — often
 * the longest and most substantive part of a multi-agent session; the rest is
 * harness scaffolding (runtime context, skill catalogue, time context, approval
 * notices) that is still kept, but labelled so a reader knows nobody said it.
 *
 * Nothing is dropped: this decides a role, not a filter.
 */
function conversationRole(event) {
  const kind = event?.data?.source?.kind
  if (typeof kind !== 'string' || !kind) return 'human'
  return CONVERSATION_SOURCES[kind] ?? 'context'
}

/** Prose of one message: text blocks only — reasoning and tool traffic are not an answer. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function truncate(text, max) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** The first non-empty line, which is what a title can be made of. */
function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const value = line.replace(/^[#>\s*-]+/, '').trim()
    if (value) return value
  }
  return ''
}

/** Tool arguments are model output: valid JSON is the normal case, not a promise. */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function pathOf(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Own-property lookup: a model-authored status can be `constructor`. */
function pick(map, key) {
  if (!map || typeof map !== 'object') return undefined
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined
  return typeof map[key] === 'string' ? map[key] : undefined
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Labels: the artifact is written in the language the reader asked for
// ---------------------------------------------------------------------------

const LABELS = {
  zh: {
    docTitle: '对话分享',
    summary: '这次对话共 {turns} 轮，你提出了 {prompts} 条要求，调用了 {tools} 次工具、涉及 {files} 个文件，前后约 {duration}。',
    generated: '生成时间',
    session: '会话',
    duration: '耗时',
    turns: '轮次',
    userMessages: '用户消息',
    assistantMessages: '助手消息',
    toolCalls: '工具调用',
    tokens: '累计 Tokens',
    overview: '概览',
    overviewHint: '这次对话的体量',
    prompts: '对话主线',
    promptsHint: '你在这次对话里提出的要求',
    transcript: '完整对话',
    transcriptHint: '按时间顺序的全部消息，未经删减',
    role: { human: '你', assistant: '助手', teammate: '队友', notice: '子代理完成', context: '系统上下文' },
    truncated: '已截断',
    conclusion: '结论',
    conclusionHint: '最后一条回答的正文',
    todos: '待办',
    todosHint: '对话过程中维护的清单',
    tools: '工具使用',
    files: '涉及文件',
    timeline: '时间线',
    errors: '异常',
    empty: '这次对话还没有内容',
    footer: '只读快照 · 由 DSH「分享会话」生成，不包含系统提示与思考过程',
    noTodos: '这次对话没有维护待办清单',
    noFiles: '这次对话没有改动文件',
    noErrors: '没有工具调用失败',
    ops: { read: '读取', write: '写入', search: '检索' },
    status: { pending: '待办', in_progress: '进行中', completed: '已完成', cancelled: '已取消' },
    reason: {
      completed: '正常结束',
      aborted: '已中断',
      blocked: '被拦截',
      error: '出错',
      'max-tokens': '超出长度',
      interrupted: '被打断',
      forked: '已分叉',
    },
    seconds: '秒',
    minutes: '分',
    hours: '时',
    mermaidChart: '查看图表',
    mermaidCode: '查看源码',
    mermaidError: '图表渲染异常，已显示原始代码',
    mermaidZoom: '放大',
    mermaidDownload: '下载图片',
    mermaidZoomIn: '放大',
    mermaidZoomOut: '缩小',
    mermaidZoomReset: '自适应',
    mermaidZoomActual: '1:1 原图',
    mermaidClose: '关闭',
  },
  en: {
    docTitle: 'Conversation share',
    summary: '{turns} turn(s), {prompts} request(s), {tools} tool call(s) across {files} file(s) — about {duration} of work.',
    generated: 'Generated',
    session: 'Session',
    duration: 'Duration',
    turns: 'Turns',
    userMessages: 'User messages',
    assistantMessages: 'Replies',
    toolCalls: 'Tool calls',
    tokens: 'Tokens total',
    overview: 'Overview',
    overviewHint: 'How much this conversation contains',
    prompts: 'Thread',
    promptsHint: 'What you asked for, in order',
    transcript: 'Full conversation',
    transcriptHint: 'Every message in order, nothing removed',
    role: { human: 'You', assistant: 'Assistant', teammate: 'Teammate', notice: 'Subagent done', context: 'System context' },
    truncated: 'truncated',
    conclusion: 'Conclusion',
    conclusionHint: 'The body of the last reply',
    todos: 'Open items',
    todosHint: 'The checklist maintained during the conversation',
    tools: 'Tools',
    files: 'Files',
    timeline: 'Timeline',
    errors: 'Failures',
    empty: 'This conversation has no content yet',
    footer: 'Read-only snapshot · generated by DSH conversation share; no system prompt and no reasoning',
    noTodos: 'No checklist was maintained in this conversation',
    noFiles: 'No file was touched in this conversation',
    noErrors: 'No tool call failed',
    ops: { read: 'read', write: 'write', search: 'search' },
    status: { pending: 'pending', in_progress: 'in progress', completed: 'done', cancelled: 'cancelled' },
    reason: {
      completed: 'completed',
      aborted: 'aborted',
      blocked: 'blocked',
      error: 'error',
      'max-tokens': 'max tokens',
      interrupted: 'interrupted',
      forked: 'forked',
    },
    seconds: 's',
    minutes: 'm',
    hours: 'h',
    mermaidChart: 'View chart',
    mermaidCode: 'View source',
    mermaidError: 'Diagram render error, original source shown',
    mermaidZoom: 'Zoom',
    mermaidDownload: 'Download image',
    mermaidZoomIn: 'Zoom in',
    mermaidZoomOut: 'Zoom out',
    mermaidZoomReset: 'Fit to screen',
    mermaidZoomActual: '1:1 Actual size',
    mermaidClose: 'Close',
  },
}

function labelsFor(lang) {
  return LABELS[String(lang ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh']
}

// ---------------------------------------------------------------------------
// The analysis: one deterministic pass over the session log
// ---------------------------------------------------------------------------

/**
 * Fold the log into what a reader other than the operator needs.
 *
 * Every field is derived from committed events: a turn boundary comes from
 * `turn/start`/`turn/end`, prose from message events, and the working set from
 * tool calls. Nothing is inferred about intent — the page states what happened.
 */
function analyze(session) {
  let events = []
  try {
    events = [...session.snapshotEvents()]
  } catch {
    try {
      events = [...session.ownEvents()]
    } catch {
      events = []
    }
  }
  const header = session?.header ?? {}
  const createdAt = Number(header.createdAt) || Number(events[0]?.time) || Date.now()

  let endedAt = createdAt
  let userMessages = 0
  let assistantMessages = 0
  let inputTokens = 0
  let outputTokens = 0
  let lastReply = ''
  let topic = ''

  const prompts = []
  const turns = []
  const errors = []
  const tools = new Map()
  const files = new Map()
  const callNames = new Map()
  let todos = []
  /**
   * Every message in the log, in order, with its role. This is the conversation
   * itself — the page's transcript section is a rendering of exactly this array,
   * so "the share is missing half the conversation" cannot happen again.
   */
  const transcript = []
  let transcriptChars = 0

  const appendToTranscript = (role, text, time, meta) => {
    const body = collapsePathsInText(text).trim()
    if (!body) return
    const remaining = MAX_TRANSCRIPT_CHARS - transcriptChars
    if (remaining <= 0) return
    const kept = body.length > Math.min(remaining, MAX_MESSAGE_CHARS)
      ? body.slice(0, Math.min(remaining, MAX_MESSAGE_CHARS))
      : body
    transcriptChars += kept.length
    transcript.push({
      role,
      text: kept,
      truncated: kept.length < body.length,
      time: Number(time) || 0,
      turn: meta?.turn,
      step: meta?.step,
      source: meta?.source,
    })
  }

  for (const event of events) {
    const time = Number(event?.time) || 0
    if (time > endedAt) endedAt = time

    switch (event?.type) {
      case 'turn/start': {
        turns.push({
          turn: Number(event.data?.turn) || turns.length + 1,
          startedAt: time,
          endedAt: 0,
          reason: '',
          prompt: '',
        })
        break
      }
      case 'turn/end': {
        const current = turns[turns.length - 1]
        if (current) {
          current.endedAt = time
          current.reason = String(event.data?.reason?.kind ?? '')
        }
        break
      }
      case 'user/message': {
        const text = collapsePathsInText(textOf(event.data?.content ?? event.data?.message?.content))
        const role = conversationRole(event)
        // Every kind is kept; only a human turn feeds the thread and the title,
        // because those answer "what did the person ask for".
        if (role === 'human') {
          userMessages += 1
          if (text && prompts.length < MAX_PROMPTS) {
            prompts.push({ text: truncate(text, PROMPT_CHARS), time })
          }
          const current = turns[turns.length - 1]
          if (text && current && !current.prompt) current.prompt = truncate(firstLine(text), 140)
        } else {
          userMessages += 1
        }
        appendToTranscript(role, text, time, {
          source: String(event.data?.source?.kind ?? ''),
        })
        break
      }
      case 'assistant/message': {
        assistantMessages += 1
        const text = collapsePathsInText(textOf(event.data?.message?.content))
        if (text) lastReply = text
        appendToTranscript('assistant', text, time, {
          turn: Number(event.data?.turn) || undefined,
          step: Number(event.data?.step) || undefined,
        })
        const usage = event.data?.usage
        if (usage) {
          inputTokens += Number(usage.inputTokens) || 0
          outputTokens += Number(usage.outputTokens) || 0
        }
        break
      }
      case 'tool/call': {
        const name = String(event.data?.name ?? 'unknown')
        const callId = String(event.data?.callId ?? '')
        if (callId) callNames.set(callId, name)
        const record = tools.get(name) ?? { name, count: 0, errors: 0 }
        record.count += 1
        tools.set(name, record)

        const args = parseArgs(event.data?.arguments)
        const op = FILE_TOOL_OPS[name]
        const target = pathOf(args)
        if (op && target) {
          const safePath = collapsePath(target)
          const file = files.get(safePath) ?? { path: safePath, ops: new Set(), count: 0 }
          file.ops.add(op)
          file.count += 1
          files.set(safePath, file)
        }
        if (name === TODO_TOOL) {
          const list = Array.isArray(args?.todos) ? args.todos : []
          const next = []
          for (const item of list) {
            if (!item || typeof item !== 'object') continue
            const content = String(item.content ?? '').trim()
            if (!content) continue
            next.push({ content: truncate(content, 200), status: String(item.status ?? 'pending') })
          }
          if (next.length) todos = next
        }
        break
      }
      case 'tool/result': {
        const callId = String(event.data?.message?.toolCallId ?? '')
        const name = callNames.get(callId)
        if (event.data?.error) {
          // An unknown call id means the `tool/call` is outside this window:
          // count the failure where it belongs, never as a phantom tool row.
          const record = name ? tools.get(name) : undefined
          if (record) record.errors += 1
          if (errors.length < MAX_ERRORS) {
            errors.push({
              name: name || 'unknown',
              code: String(event.data.error.code ?? ''),
              reason: truncate(collapsePathsInText(String(event.data.error.reason ?? event.data.error.name ?? '')), 240),
            })
          }
        }
        break
      }
      default:
        break
    }
  }

  // The topic is what the reader will scan first; the operator's own words are
  // a better label than anything this plugin could invent.
  if (prompts.length) {
    const headline = stripPathMentions(firstLine(prompts[0].text))
    topic = truncate(headline || firstLine(prompts[0].text), 80)
  } else {
    topic = displayPath(header.cwd ?? '')
  }

  const toolList = [...tools.values()].sort((left, right) => right.count - left.count)
  const toolCalls = toolList.reduce((sum, entry) => sum + entry.count, 0)
  const fileList = [...files.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_FILES)
    .map((entry) => ({ path: entry.path, ops: [...entry.ops].sort(), count: entry.count }))

  return {
    generatedAt: Date.now(),
    session: {
      id: String(session?.id ?? header.id ?? ''),
      topic,
      cwd: collapsePath(header.cwd ?? ''),
      createdAt,
      endedAt,
      durationMs: Math.max(0, endedAt - createdAt),
      prompts: prompts.length,
      userMessages,
      assistantMessages,
      turns: turns.length,
      toolCalls,
      fileCount: files.size,
      inputTokens,
      outputTokens,
    },
    prompts,
    conclusion: truncate(lastReply, CONCLUSION_CHARS),
    /**
     * The whole conversation, in order, parsed once for both renderers.
     * `text` is the source Markdown (the export writes it back verbatim);
     * `blocks` is the same content already parsed, so the panel never parses.
     */
    transcript: transcript.map((entry) => ({
      role: entry.role,
      time: entry.time,
      turn: entry.turn,
      step: entry.step,
      source: entry.source,
      truncated: entry.truncated,
      text: entry.text,
      blocks: parseMarkdown(entry.text),
    })),
    transcriptChars,
    /** The last reply, pre-parsed for the panel; `conclusion` stays plain text. */
    conclusionBlocks: parseMarkdown(truncate(lastReply, CONCLUSION_CHARS)),
    todos,
    tools: toolList,
    files: fileList,
    timeline: turns.slice(-MAX_TIMELINE).map((entry) => ({
      turn: entry.turn,
      startedAt: entry.startedAt,
      durationMs: Math.max(0, (entry.endedAt || endedAt) - entry.startedAt),
      reason: entry.reason,
      prompt: entry.prompt,
    })),
    errors,
  }
}

/** `12s`, `3m 04s`, `1h 12m` — compact and language-light. */
function durationText(ms, labels) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (total < 60) return `${Math.round(total)}${labels.seconds}`
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const seconds = Math.round(total % 60)
    return `${minutes}${labels.minutes} ${String(seconds).padStart(2, '0')}${labels.seconds}`
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  return `${hours}${labels.hours} ${minutes}${labels.minutes}`
}

function clockText(time) {
  if (!Number.isFinite(Number(time)) || !time) return ''
  try {
    return new Date(Number(time)).toLocaleTimeString()
  } catch {
    return ''
  }
}

function stampText(time) {
  try {
    return new Date(Number(time) || Date.now()).toLocaleString()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Artifacts: Markdown for copying, HTML for the link
// ---------------------------------------------------------------------------

/** `{key}` placeholders, so a label stays one sentence per language. */
function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match,
  )
}

/** The sentence a reader meets before the cards: size, then shape, of the work. */
function summaryText(analysis, labels) {
  const session = analysis.session
  // `prompts` and `files` are capped for display; the sentence must not be.
  return fill(labels.summary, {
    turns: session.turns,
    prompts: session.userMessages,
    tools: session.toolCalls,
    files: session.fileCount,
    duration: durationText(session.durationMs, labels),
  })
}

function renderMarkdown(analysis, labels) {
  const lines = []
  const session = analysis.session
  lines.push(`# ${session.topic || labels.docTitle}`)
  lines.push('')
  lines.push(`> ${summaryText(analysis, labels)}`)
  lines.push('')
  lines.push(`> ${labels.footer}`)
  lines.push(
    `> ${labels.generated}: ${stampText(analysis.generatedAt)} · ${labels.session}: ${session.id}`,
  )
  lines.push('')
  lines.push(`## ${labels.overview}`)
  lines.push('')
  lines.push(
    `- ${labels.turns}: ${session.turns}`,
    `- ${labels.userMessages}: ${session.userMessages}`,
    `- ${labels.assistantMessages}: ${session.assistantMessages}`,
    `- ${labels.toolCalls}: ${session.toolCalls}`,
    `- ${labels.duration}: ${durationText(session.durationMs, labels)}`,
    `- ${labels.tokens}: ${session.inputTokens + session.outputTokens} (${session.inputTokens} in / ${session.outputTokens} out)`,
  )
  lines.push('')

  if (analysis.prompts.length) {
    lines.push(`## ${labels.prompts}`)
    lines.push('')
    for (const prompt of analysis.prompts) {
      const body = prompt.text.replace(/\n{2,}/g, '\n').trim()
      lines.push(`1. ${body.replace(/\n/g, '\n   ')}`)
    }
    lines.push('')
  }

  // The conversation itself, unrendered: this export is Markdown, so the
  // original source text is what belongs here — re-serialising the parsed
  // blocks would only risk losing what the parser did not understand.
  if (analysis.transcript.length) {
    lines.push(`## ${labels.transcript}`)
    lines.push('')
    for (const entry of analysis.transcript) {
      const role = pick(labels.role, entry.role) ?? entry.role
      const meta = [clockText(entry.time)]
      if (entry.source) meta.push(entry.source)
      if (entry.truncated) meta.push(labels.truncated)
      lines.push(`### ${role} · ${meta.filter(Boolean).join(' · ')}`)
      lines.push('')
      lines.push(entry.text)
      lines.push('')
    }
  }

  if (analysis.conclusion) {
    lines.push(`## ${labels.conclusion}`)
    lines.push('')
    lines.push(analysis.conclusion)
    lines.push('')
  }

  if (analysis.todos.length) {
    lines.push(`## ${labels.todos}`)
    lines.push('')
    for (const todo of analysis.todos) {
      const mark = todo.status === 'completed' ? 'x' : ' '
      const status = pick(labels.status, todo.status) ?? todo.status
      lines.push(`- [${mark}] ${todo.content}${todo.status === 'completed' ? '' : ` · ${status}`}`)
    }
    lines.push('')
  }

  if (analysis.tools.length) {
    lines.push(`## ${labels.tools}`)
    lines.push('')
    for (const tool of analysis.tools) {
      const failed = tool.errors ? ` · ${tool.errors}✗` : ''
      lines.push(`- \`${tool.name}\` × ${tool.count}${failed}`)
    }
    lines.push('')
  }

  if (analysis.files.length) {
    lines.push(`## ${labels.files}`)
    lines.push('')
    for (const file of analysis.files) {
      const ops = file.ops.map((op) => pick(labels.ops, op) ?? op).join('/')
      lines.push(`- \`${file.path}\` · ${ops}`)
    }
    lines.push('')
  }

  if (analysis.errors.length) {
    lines.push(`## ${labels.errors}`)
    lines.push('')
    for (const error of analysis.errors) {
      lines.push(`- \`${error.name}\` ${error.code}${error.reason ? ` · ${error.reason}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function statTile(label, value) {
  return `<div class="stat"><span class="stat-k">${escapeHtml(label)}</span><span class="stat-v">${escapeHtml(value)}</span></div>`
}

function section(id, title, hint, body) {
  if (!body) return ''
  return [
    `<section class="card" id="${id}">`,
    '<div class="card-head">',
    `<h2>${escapeHtml(title)}</h2>`,
    hint ? `<p>${escapeHtml(hint)}</p>` : '',
    '</div>',
    body,
    '</section>',
  ].join('')
}

function renderPage(analysis, labels) {
  const session = analysis.session
  const title = session.topic || labels.docTitle

  const overview = `<div class="stats">${[
    statTile(labels.turns, String(session.turns)),
    statTile(labels.userMessages, String(session.userMessages)),
    statTile(labels.assistantMessages, String(session.assistantMessages)),
    statTile(labels.toolCalls, String(session.toolCalls)),
    statTile(labels.duration, durationText(session.durationMs, labels)),
    statTile(labels.tokens, `${session.inputTokens + session.outputTokens}`),
  ].join('')}</div>`

  const prompts = analysis.prompts.length
    ? `<ol class="thread">${analysis.prompts
      .map(
        (prompt) =>
          `<li><p>${escapeHtml(prompt.text)}</p><span class="meta">${escapeHtml(clockText(prompt.time))}</span></li>`,
      )
      .join('')}</ol>`
    : `<p class="muted">${escapeHtml(labels.empty)}</p>`

  const conclusion = analysis.conclusion
    ? `<div class="prose md">${blocksToHtml(parseMarkdown(analysis.conclusion), labels)}</div>`
    : ''

  // The conversation itself: every message, in order. This is the section the
  // reader came for, so it is rendered from the same block tokens the panel uses.
  //
  // Each row is a `<details>`: the exchange between the person and the assistant
  // is open, everything else (harness context, teammate reports, subagent
  // notices) starts folded. A reader scanning the conversation wants the answers,
  // not the scaffolding; anyone who wants the rest opens it in one click.
  const transcript = analysis.transcript.length
    ? `<div class="convo">${analysis.transcript
      .map((entry) => {
        const role = pick(labels.role, entry.role) ?? entry.role
        const meta = [clockText(entry.time)]
        if (entry.source) meta.push(entry.source)
        if (entry.truncated) meta.push(labels.truncated)
        const open = entry.role === 'human' || entry.role === 'assistant'
        return [
          `<details class="msg" data-role="${escapeHtml(entry.role)}"${open ? ' open' : ''}>`,
          `<summary class="msg-head"><span class="msg-role">${escapeHtml(role)}</span>`,
          `<span class="msg-meta">${escapeHtml(meta.filter(Boolean).join(' · '))}</span>`,
          // Only a folded row needs a preview; an open one already shows its body.
          open ? '' : `<span class="msg-preview">${escapeHtml(previewText(entry.blocks))}</span>`,
          '</summary>',
          `<div class="msg-body md">${blocksToHtml(entry.blocks, labels)}</div>`,
          '</details>',
        ].join('')
      })
      .join('')}</div>`
    : `<p class="muted">${escapeHtml(labels.empty)}</p>`

  const todos = analysis.todos.length
    ? `<ul class="rows">${analysis.todos
      .map(
        (todo) =>
          `<li><span class="chip" data-status="${escapeHtml(todo.status)}">${escapeHtml(pick(labels.status, todo.status) ?? todo.status)}</span><span>${escapeHtml(todo.content)}</span></li>`,
      )
      .join('')}</ul>`
    : `<p class="muted">${escapeHtml(labels.noTodos)}</p>`

  const tools = analysis.tools.length
    ? `<ul class="rows">${analysis.tools
      .map(
        (tool) =>
          `<li><code>${escapeHtml(tool.name)}</code><span class="count">× ${tool.count}</span>${tool.errors ? `<span class="chip chip-bad">${tool.errors} ✗</span>` : ''}</li>`,
      )
      .join('')}</ul>`
    : ''

  const files = analysis.files.length
    ? `<ul class="rows">${analysis.files
      .map(
        (file) =>
          `<li><code class="path">${escapeHtml(file.path)}</code>${file.ops
            .map((op) => `<span class="chip">${escapeHtml(pick(labels.ops, op) ?? op)}</span>`)
            .join('')}</li>`,
      )
      .join('')}</ul>`
    : `<p class="muted">${escapeHtml(labels.noFiles)}</p>`

  const timeline = analysis.timeline.length
    ? `<ul class="rows timeline">${analysis.timeline
      .map(
        (entry) =>
          `<li><span class="turn">#${entry.turn}</span><span class="grow">${escapeHtml(entry.prompt || '—')}</span><span class="meta">${escapeHtml(durationText(entry.durationMs, labels))}${entry.reason ? ` · ${escapeHtml(pick(labels.reason, entry.reason) ?? entry.reason)}` : ''}</span></li>`,
      )
      .join('')}</ul>`
    : ''

  const errors = analysis.errors.length
    ? `<ul class="rows">${analysis.errors
      .map(
        (error) =>
          `<li><code>${escapeHtml(error.name)}</code><span class="chip chip-bad">${escapeHtml(error.code)}</span><span class="grow">${escapeHtml(error.reason)}</span></li>`,
      )
      .join('')}</ul>`
    : ''

  const mermaidLabels = JSON.stringify({
    chart: labels.mermaidChart || (labels === LABELS.en ? 'View chart' : '查看图表'),
    code: labels.mermaidCode || (labels === LABELS.en ? 'View source' : '查看源码'),
    error: labels.mermaidError || (labels === LABELS.en ? 'Diagram render error, original source shown' : '图表渲染异常，已显示原始代码'),
    zoom: labels.mermaidZoom || (labels === LABELS.en ? 'Zoom' : '放大'),
    download: labels.mermaidDownload || (labels === LABELS.en ? 'Download image' : '下载图片'),
    zoomIn: labels.mermaidZoomIn || (labels === LABELS.en ? 'Zoom in' : '放大'),
    zoomOut: labels.mermaidZoomOut || (labels === LABELS.en ? 'Zoom out' : '缩小'),
    zoomReset: labels.mermaidZoomReset || (labels === LABELS.en ? 'Fit to screen' : '自适应'),
    zoomActual: labels.mermaidZoomActual || (labels === LABELS.en ? '1:1 Actual size' : '1:1 原图'),
    close: labels.mermaidClose || (labels === LABELS.en ? 'Close' : '关闭'),
  })

  const mermaidScript = `<script>
(function() {
  const blocks = document.querySelectorAll('.mermaid-block');
  if (!blocks.length) return;

  const labels = ${mermaidLabels};

  async function getMermaid() {
    if (window.mermaid) return window.mermaid;
    const CDNS = [
      'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs',
      'https://unpkg.com/mermaid@11/dist/mermaid.esm.min.mjs'
    ];
    for (const url of CDNS) {
      try {
        const mod = await Promise.race([
          import(/* webpackIgnore: true */ url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const m = mod && mod.default ? mod.default : mod;
        if (m && typeof m.render === 'function') return m;
      } catch (e) {}
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
      s.onload = () => {
        clearTimeout(timer);
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error('Mermaid not found'));
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Failed to load Mermaid'));
      };
      document.head.appendChild(s);
    });
  }

  let modalState = {
    active: false,
    scale: 1,
    fitScale: 1,
    x: 0,
    y: 0,
    origWidth: 0,
    origHeight: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startPosX: 0,
    startPosY: 0,
    canvasEl: null,
    bodyEl: null,
    scaleEl: null,
  };

  function updateTransform() {
    if (!modalState.canvasEl) return;
    modalState.canvasEl.style.transform = 'translate3d(' + modalState.x + 'px, ' + modalState.y + 'px, 0) scale(' + modalState.scale + ')';
    if (modalState.scaleEl) {
      modalState.scaleEl.textContent = Math.round(modalState.scale * 100) + '%';
    }
  }

  function zoomTo(newScale, anchorX, anchorY) {
    if (!modalState.bodyEl) return;
    newScale = Math.min(5.0, Math.max(0.2, newScale));
    if (Math.abs(newScale - modalState.scale) < 0.0001) return;

    const vw = modalState.bodyEl.clientWidth || (window.innerWidth * 0.96);
    const vh = modalState.bodyEl.clientHeight || (window.innerHeight * 0.94);
    const ax = anchorX !== undefined ? anchorX : vw / 2;
    const ay = anchorY !== undefined ? anchorY : vh / 2;

    const ratio = newScale / modalState.scale;
    modalState.x = ax - (ax - modalState.x) * ratio;
    modalState.y = ay - (ay - modalState.y) * ratio;
    modalState.scale = newScale;
    updateTransform();
  }

  function resetZoom(fitOnly) {
    if (!modalState.bodyEl || !modalState.origWidth || !modalState.origHeight) return;
    const vw = modalState.bodyEl.clientWidth || (window.innerWidth * 0.96);
    const vh = modalState.bodyEl.clientHeight || (window.innerHeight * 0.94);
    const pad = 48;
    const fitW = Math.max(10, vw - pad);
    const fitH = Math.max(10, vh - pad);
    let fitScale = Math.min(fitW / modalState.origWidth, fitH / modalState.origHeight);
    if (!Number.isFinite(fitScale) || fitScale <= 0) fitScale = 1;
    modalState.fitScale = Math.min(3.0, Math.max(0.2, fitScale));

    let targetScale;
    if (fitOnly) {
      targetScale = modalState.fitScale;
    } else {
      // 初始清晰自适应比例：若图表超大导致 fitScale < 0.55，以清晰字号比例(0.7~1.0)居中展示
      targetScale = modalState.fitScale < 0.55 ? Math.min(1.0, Math.max(modalState.fitScale, 0.7)) : modalState.fitScale;
    }
    modalState.scale = targetScale;
    modalState.x = (vw - modalState.origWidth * targetScale) / 2;
    modalState.y = Math.max(20, (vh - modalState.origHeight * targetScale) / 2);
    updateTransform();
  }

  function setActualSize() {
    if (!modalState.bodyEl || !modalState.origWidth || !modalState.origHeight) return;
    const vw = modalState.bodyEl.clientWidth || (window.innerWidth * 0.96);
    const vh = modalState.bodyEl.clientHeight || (window.innerHeight * 0.94);
    modalState.scale = 1.0;
    modalState.x = (vw - modalState.origWidth) / 2;
    modalState.y = Math.max(20, (vh - modalState.origHeight) / 2);
    updateTransform();
  }

  function initModal() {
    let modalEl = document.getElementById('mermaid-modal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'mermaid-modal';
      modalEl.className = 'mermaid-modal';
      modalEl.style.display = 'none';
      modalEl.setAttribute('aria-hidden', 'true');
      const closeTitle = labels.close || '关闭';
      const zoomInTitle = labels.zoomIn || '放大';
      const zoomOutTitle = labels.zoomOut || '缩小';
      const resetTitle = labels.zoomReset || '自适应';
      const actualTitle = labels.zoomActual || '1:1 原图';
      modalEl.innerHTML = '<div class="mermaid-modal-container">' +
        '<div class="mermaid-modal-toolbar">' +
          '<button type="button" class="mermaid-modal-btn" data-action="zoom-out" title="' + zoomOutTitle + '">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
          '</button>' +
          '<span class="mermaid-modal-scale">100%</span>' +
          '<button type="button" class="mermaid-modal-btn" data-action="zoom-in" title="' + zoomInTitle + '">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
          '</button>' +
          '<span class="mermaid-modal-divider"></span>' +
          '<button type="button" class="mermaid-modal-btn" data-action="zoom-actual" title="' + actualTitle + '">1:1</button>' +
          '<button type="button" class="mermaid-modal-btn" data-action="zoom-reset" title="' + resetTitle + '">Fit</button>' +
          '<span class="mermaid-modal-divider"></span>' +
          '<button type="button" class="mermaid-modal-btn mermaid-modal-btn-close" data-action="close" title="' + closeTitle + '">&times;</button>' +
        '</div>' +
        '<button type="button" class="mermaid-modal-close" title="' + closeTitle + '" aria-label="' + closeTitle + '">&times;</button>' +
        '<div class="mermaid-modal-body"></div>' +
      '</div>';
      document.body.appendChild(modalEl);
    }
    if (!modalEl._hasModalListener) {
      modalEl._hasModalListener = true;
      const bodyEl = modalEl.querySelector('.mermaid-modal-body');

      modalEl.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.mermaid-modal-close, [data-action="close"]');
        if (closeBtn) {
          closeModal();
          return;
        }
        if (e.target === modalEl) {
          closeModal();
          return;
        }
        const actionBtn = e.target.closest('.mermaid-modal-btn[data-action]');
        if (actionBtn) {
          const action = actionBtn.getAttribute('data-action');
          if (action === 'zoom-in') zoomTo(modalState.scale * 1.25);
          else if (action === 'zoom-out') zoomTo(modalState.scale / 1.25);
          else if (action === 'zoom-actual') setActualSize();
          else if (action === 'zoom-reset') resetZoom(true);
        }
      });

      if (bodyEl) {
        bodyEl.addEventListener('wheel', (e) => {
          e.preventDefault();
          const rect = bodyEl.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
          zoomTo(modalState.scale * factor, mouseX, mouseY);
        }, { passive: false });

        bodyEl.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          modalState.isDragging = true;
          modalState.dragStartX = e.clientX;
          modalState.dragStartY = e.clientY;
          modalState.startPosX = modalState.x;
          modalState.startPosY = modalState.y;
          bodyEl.classList.add('panning');
          e.preventDefault();
        });

        bodyEl.addEventListener('dblclick', (e) => {
          const rect = bodyEl.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          if (modalState.scale > modalState.fitScale * 1.3) {
            zoomTo(modalState.fitScale, mouseX, mouseY);
          } else {
            zoomTo(Math.max(1.0, modalState.fitScale * 2), mouseX, mouseY);
          }
        });
      }

      window.addEventListener('mousemove', (e) => {
        if (!modalState.isDragging) return;
        const dx = e.clientX - modalState.dragStartX;
        const dy = e.clientY - modalState.dragStartY;
        modalState.x = modalState.startPosX + dx;
        modalState.y = modalState.startPosY + dy;
        updateTransform();
      });

      window.addEventListener('mouseup', () => {
        if (modalState.isDragging) {
          modalState.isDragging = false;
          if (modalState.bodyEl) modalState.bodyEl.classList.remove('panning');
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Esc') {
          closeModal();
        }
      });
    }
    return modalEl;
  }

  function openModal(svg) {
    if (!svg) return;
    const modal = initModal();
    const body = modal.querySelector('.mermaid-modal-body');
    const scaleEl = modal.querySelector('.mermaid-modal-scale');
    if (!body) return;
    body.innerHTML = '';

    const canvasEl = document.createElement('div');
    canvasEl.className = 'mermaid-modal-canvas';

    const clone = svg.cloneNode(true);
    clone.removeAttribute('id');
    if (clone.style) {
      clone.style.removeProperty('max-width');
      clone.style.removeProperty('max-height');
      clone.style.removeProperty('width');
      clone.style.removeProperty('height');
    }

    let origWidth = 0;
    let origHeight = 0;
    if (clone.viewBox && clone.viewBox.baseVal && clone.viewBox.baseVal.width > 0) {
      origWidth = clone.viewBox.baseVal.width;
      origHeight = clone.viewBox.baseVal.height;
    } else {
      const vbAttr = clone.getAttribute('viewBox');
      if (vbAttr) {
        const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          origWidth = parts[2];
          origHeight = parts[3];
        }
      }
    }
    if (!origWidth || !origHeight) {
      try {
        const bbox = svg.getBBox ? svg.getBBox() : null;
        if (bbox && bbox.width > 0 && bbox.height > 0) {
          origWidth = bbox.width;
          origHeight = bbox.height;
        }
      } catch (e) {}
    }
    if (!origWidth || !origHeight) {
      const rect = svg.getBoundingClientRect();
      origWidth = rect.width || 800;
      origHeight = rect.height || 600;
    }

    clone.setAttribute('width', String(origWidth));
    clone.setAttribute('height', String(origHeight));
    clone.style.width = origWidth + 'px';
    clone.style.height = origHeight + 'px';

    canvasEl.appendChild(clone);
    body.appendChild(canvasEl);

    modalState.canvasEl = canvasEl;
    modalState.bodyEl = body;
    modalState.scaleEl = scaleEl;
    modalState.origWidth = origWidth;
    modalState.origHeight = origHeight;
    modalState.active = true;

    modal.classList.add('active');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    requestAnimationFrame(() => {
      resetZoom(false);
    });
  }

  function closeModal() {
    const modal = document.getElementById('mermaid-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    const body = modal.querySelector('.mermaid-modal-body');
    if (body) {
      body.innerHTML = '';
      body.classList.remove('panning');
    }
    modalState.active = false;
    modalState.isDragging = false;
    modalState.canvasEl = null;
  }

  function downloadSvg(chartEl) {
    const svg = chartEl ? chartEl.querySelector('svg') : null;
    if (!svg) return;
    let svgSource = svg.outerHTML;
    if (!svgSource && typeof XMLSerializer !== 'undefined') {
      svgSource = new XMLSerializer().serializeToString(svg);
    }
    if (!svgSource) return;
    if (!svgSource.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
      svgSource = svgSource.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!svgSource.match(/^<svg[^>]+"http:\/\/www\.w3\.org\/1999\/xlink"/)) {
      svgSource = svgSource.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    const blob = new Blob(['<?xml version="1.0" standalone="no"?>\r\n', svgSource], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mermaid-diagram-' + Date.now() + '.svg';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  let renderSeq = 0;
  async function renderDiagram(block, mermaid) {
    const codeEl = block.querySelector('.mermaid-code code');
    if (!codeEl) return;
    if (!block._mermaidCode) {
      block._mermaidCode = codeEl.textContent;
    }
    const rawCode = block._mermaidCode;
    const chartEl = block.querySelector('.mermaid-chart');
    const toggleBtn = block.querySelector('.mermaid-toggle-btn');
    const zoomBtn = block.querySelector('.mermaid-zoom-btn');
    const downloadBtn = block.querySelector('.mermaid-download-btn');
    const btnText = toggleBtn ? toggleBtn.querySelector('.mermaid-btn-text') : null;

    if (toggleBtn && !toggleBtn._hasToggleListener) {
      toggleBtn._hasToggleListener = true;
      toggleBtn.addEventListener('click', () => {
        const isChart = block.getAttribute('data-view') !== 'code';
        if (isChart) {
          block.setAttribute('data-view', 'code');
          chartEl.style.display = 'none';
          codeEl.parentElement.style.display = '';
          if (zoomBtn) zoomBtn.style.display = 'none';
          if (downloadBtn) downloadBtn.style.display = 'none';
          if (btnText) btnText.textContent = toggleBtn.getAttribute('data-label-chart') || labels.chart;
        } else {
          block.setAttribute('data-view', 'chart');
          chartEl.style.display = '';
          codeEl.parentElement.style.display = 'none';
          if (zoomBtn) zoomBtn.style.display = '';
          if (downloadBtn) downloadBtn.style.display = '';
          if (btnText) btnText.textContent = toggleBtn.getAttribute('data-label-code') || labels.code;
        }
      });
    }

    if (zoomBtn && !zoomBtn._hasZoomListener) {
      zoomBtn._hasZoomListener = true;
      zoomBtn.addEventListener('click', () => {
        const svg = chartEl.querySelector('svg');
        if (svg) openModal(svg);
      });
    }

    if (downloadBtn && !downloadBtn._hasDownloadListener) {
      downloadBtn._hasDownloadListener = true;
      downloadBtn.addEventListener('click', () => {
        downloadSvg(chartEl);
      });
    }

    const id = 'dsh-mermaid-' + (++renderSeq) + '-' + Math.random().toString(36).slice(2, 7);
    try {
      const { svg } = await mermaid.render(id, rawCode);
      chartEl.innerHTML = svg;
      block.setAttribute('data-rendered', 'true');
      const prevErr = block.querySelector('.mermaid-error');
      if (prevErr) prevErr.remove();

      const currentView = block.getAttribute('data-view') || 'chart';
      if (currentView === 'chart') {
        chartEl.style.display = '';
        codeEl.parentElement.style.display = 'none';
        if (btnText && toggleBtn) {
          btnText.textContent = toggleBtn.getAttribute('data-label-code') || labels.code;
        }
        if (zoomBtn) zoomBtn.style.display = '';
        if (downloadBtn) downloadBtn.style.display = '';
      } else {
        chartEl.style.display = 'none';
        codeEl.parentElement.style.display = '';
        if (btnText && toggleBtn) {
          btnText.textContent = toggleBtn.getAttribute('data-label-chart') || labels.chart;
        }
        if (zoomBtn) zoomBtn.style.display = 'none';
        if (downloadBtn) downloadBtn.style.display = 'none';
      }
      if (toggleBtn) toggleBtn.style.display = '';
    } catch (err) {
      console.warn('Mermaid render error:', err);
      const tmp = document.getElementById('d' + id);
      if (tmp) tmp.remove();
      block.setAttribute('data-rendered', 'error');
      chartEl.style.display = 'none';
      codeEl.parentElement.style.display = '';
      if (toggleBtn) toggleBtn.style.display = 'none';
      if (zoomBtn) zoomBtn.style.display = 'none';
      if (downloadBtn) downloadBtn.style.display = 'none';

      if (!block.querySelector('.mermaid-error')) {
        const errBox = document.createElement('div');
        errBox.className = 'mermaid-error';
        const msg = err && err.message ? ': ' + err.message : '';
        errBox.textContent = labels.error + msg;
        block.insertBefore(errBox, codeEl.parentElement);
      }
    }
  }

  function initMermaid(mermaid, isDark) {
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
    });
  }

  async function boot() {
    let mermaid;
    try {
      mermaid = await getMermaid();
    } catch (e) {
      console.warn('Mermaid could not be loaded; displaying raw code.', e);
      return;
    }

    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    let isDark = mql ? mql.matches : false;
    initModal();
    initMermaid(mermaid, isDark);

    for (const block of blocks) {
      await renderDiagram(block, mermaid);
    }

    if (mql) {
      const onThemeChange = async (e) => {
        isDark = e.matches;
        initMermaid(mermaid, isDark);
        for (const block of blocks) {
          await renderDiagram(block, mermaid);
        }
      };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onThemeChange);
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onThemeChange);
      }
    }

    document.addEventListener('toggle', (e) => {
      if (e.target && e.target.tagName === 'DETAILS' && e.target.open) {
        const unrendered = e.target.querySelectorAll('.mermaid-block[data-rendered="false"]');
        for (const b of unrendered) {
          renderDiagram(b, mermaid);
        }
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>`

  return `<!DOCTYPE html>
<html lang="${labels === LABELS.en ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${escapeHtml(labels.docTitle)}</title>
<style>
:root{
  --bg:#f4f6fb; --panel:#ffffff; --ink:#15181f; --dim:#5c6472; --line:#e2e6ef;
  --brand:#3f5cf6; --brand-soft:#eef1ff; --bad:#c0392b; --bad-soft:#fdeeec; --ok:#1f8a53; --ok-soft:#e9f7ee;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#101216; --panel:#181b21; --ink:#e8ecf4; --dim:#98a1b2; --line:#282d37;
    --brand:#8ba0ff; --brand-soft:#1d2540; --bad:#ff8b7d; --bad-soft:#3a1f1c; --ok:#6ad39a; --ok-soft:#16301f;
  }
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:44px 24px 64px}
header.hero{margin-bottom:26px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--brand);font-weight:600}
.eyebrow::before{content:"";width:22px;height:2px;border-radius:2px;background:var(--brand)}
h1{margin:12px 0 8px;font-size:30px;line-height:1.28;letter-spacing:-.01em}
.lead{margin:0;color:var(--dim);font-size:14px}
.meta-row{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px;color:var(--dim)}
.meta-row code{font-size:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px 20px;margin-bottom:16px}
.card-head{margin-bottom:12px}
.card-head h2{margin:0;font-size:15px;letter-spacing:.01em}
.card-head p{margin:4px 0 0;font-size:12.5px;color:var(--dim)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}
.stat{background:var(--brand-soft);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.stat-k{font-size:11.5px;color:var(--dim)}
.stat-v{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums}
ol.thread{list-style:none;margin:0;padding:0;counter-reset:step}
ol.thread li{position:relative;padding:10px 0 12px 34px;border-top:1px solid var(--line)}
ol.thread li:first-child{border-top:0;padding-top:2px}
ol.thread li::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:10px;width:22px;height:22px;border-radius:50%;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center}
ol.thread li:first-child::before{top:2px}
ol.thread p{margin:0;white-space:pre-wrap;word-break:break-word}
.prose{margin:0;white-space:pre-wrap;word-break:break-word;font-size:14.5px}
ul.rows{list-style:none;margin:0;padding:0}
ul.rows li{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--line);font-size:13.5px}
ul.rows li:first-child{border-top:0;padding-top:2px}
ul.rows .grow{flex:1 1 auto;min-width:0;word-break:break-word}
.timeline .turn{color:var(--brand);font-weight:650;font-variant-numeric:tabular-nums;min-width:34px}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--brand-soft);color:var(--ink);padding:1px 6px;border-radius:5px}
code.path{word-break:break-all}
.count{color:var(--dim);font-variant-numeric:tabular-nums}
.chip{flex:none;font-size:11.5px;padding:1px 8px;border-radius:999px;background:var(--brand-soft);color:var(--brand);border:1px solid transparent}
.chip[data-status="completed"]{background:var(--ok-soft);color:var(--ok)}
.chip[data-status="pending"],.chip[data-status="in_progress"]{background:var(--bad-soft);color:var(--bad)}
.chip-bad{background:var(--bad-soft);color:var(--bad)}
.muted{color:var(--dim);font-size:13px;margin:0}
.meta{color:var(--dim);font-size:11.5px;white-space:nowrap}
footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:11.5px;display:flex;flex-wrap:wrap;gap:6px 16px}
/* The transcript: one <details> per message, role-coloured on the left edge.
   Human and assistant rows start open; the scaffolding starts folded. */
.convo{display:flex;flex-direction:column;gap:8px}
.msg{border-left:3px solid var(--line);padding-left:12px}
.msg[data-role="human"]{border-left-color:var(--brand)}
.msg[data-role="teammate"]{border-left-color:var(--ok)}
.msg[data-role="notice"],.msg[data-role="context"]{border-left-color:var(--line);opacity:.78}
.msg[data-role="notice"]:not([open]) .msg-role,.msg[data-role="context"]:not([open]) .msg-role{color:var(--dim)}
.msg-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;cursor:pointer;list-style:none;padding:2px 0}
.msg-head::-webkit-details-marker{display:none}
.msg-head::before{content:"▸";flex:none;font-size:11px;color:var(--dim);transition:transform .12s ease}
.msg[open]>.msg-head::before{transform:rotate(90deg)}
.msg-role{font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--ink)}
.msg[data-role="human"] .msg-role{color:var(--brand)}
.msg[data-role="teammate"] .msg-role{color:var(--ok)}
.msg-meta{font-size:11px;color:var(--dim)}
/* A folded row still says what it is about — otherwise collapsing hides the fact
   that there is anything worth opening. */
.msg-preview{flex:1 1 220px;min-width:0;font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg[open]>.msg-head .msg-preview{display:none}
.msg-body{font-size:14px;line-height:1.7;word-break:break-word;padding:4px 0 10px}
/* Markdown inside a message. Kept quiet: the text is the content, not the chrome. */
.md>*:first-child{margin-top:0}
.md>*:last-child{margin-bottom:0}
.md p{margin:9px 0}
.md h2,.md h3,.md h4,.md h5,.md h6,.md h7{margin:16px 0 8px;line-height:1.35;letter-spacing:-.005em}
.md h2{font-size:19px}
.md h3{font-size:17px}
.md h4{font-size:15.5px}
.md h5,.md h6,.md h7{font-size:14.5px}
.md ul,.md ol{margin:9px 0;padding-left:22px}
.md li{margin:4px 0}
.md blockquote{margin:10px 0;padding:2px 0 2px 12px;border-left:3px solid var(--line);color:var(--dim)}
.md hr{margin:16px 0;border:0;border-top:1px solid var(--line)}
.md a{color:var(--brand)}
.md pre{margin:12px 0;padding:10px 12px;border-radius:9px;background:var(--brand-soft);overflow:auto;font-size:12.5px;line-height:1.6}
.md pre code{background:none;padding:0;font-size:inherit}
.md .tw{margin:12px 0;overflow-x:auto}
.md table{border-collapse:collapse;width:100%;font-size:13px}
.md th,.md td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
.md th{background:var(--brand-soft);font-weight:650}
.mermaid-block{margin:14px 0;border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.mermaid-toolbar{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:var(--brand-soft);border-bottom:1px solid var(--line);font-size:11.5px}
.mermaid-tag{font-weight:650;color:var(--brand);letter-spacing:.02em;text-transform:uppercase}
.mermaid-actions{display:flex;align-items:center;gap:8px}
.mermaid-btn{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font-size:11.5px;cursor:pointer;line-height:1.5;transition:all .15s ease}
.mermaid-btn:hover{background:var(--brand-soft);border-color:var(--brand);color:var(--brand)}
.mermaid-chart{padding:16px;overflow-x:auto;display:flex;justify-content:center;align-items:center;min-height:80px;background:var(--panel)}
.mermaid-chart svg{max-width:100%;height:auto;display:block;margin:0 auto}
.mermaid-block pre.mermaid-code{margin:0;border-radius:0;background:var(--brand-soft)}
.mermaid-error{padding:8px 12px;margin:8px 12px;font-size:12px;color:var(--bad);background:var(--bad-soft);border-radius:6px;border:1px solid var(--bad)}
.mermaid-modal{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,0.68);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-sizing:border-box}
.mermaid-modal.active{display:flex}
.mermaid-modal-container{position:relative;width:96vw;height:94vh;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,0.4);display:flex;flex-direction:column;overflow:hidden}
.mermaid-modal-toolbar{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:20;display:flex;align-items:center;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:4px 8px;box-shadow:0 4px 18px rgba(0,0,0,0.18);user-select:none}
.mermaid-modal-btn{background:transparent;border:1px solid transparent;color:var(--ink);border-radius:16px;padding:3px 9px;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1.4;transition:all .15s ease}
.mermaid-modal-btn:hover{background:var(--brand-soft);border-color:var(--brand);color:var(--brand)}
.mermaid-modal-btn-close{color:var(--dim);font-size:16px;padding:2px 7px}
.mermaid-modal-btn-close:hover{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}
.mermaid-modal-scale{font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dim);min-width:44px;text-align:center;padding:0 4px}
.mermaid-modal-divider{width:1px;height:14px;background:var(--line);margin:0 2px}
.mermaid-modal-close{position:absolute;top:12px;right:14px;width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--panel);color:var(--ink);font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:20;transition:all .15s ease}
.mermaid-modal-close:hover{background:var(--bad-soft);color:var(--bad);border-color:var(--bad)}
.mermaid-modal-body{position:relative;flex:1 1 auto;width:100%;height:100%;overflow:hidden;cursor:grab;user-select:none;display:block;touch-action:none}
.mermaid-modal-body.panning{cursor:grabbing}
.mermaid-modal-canvas{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.mermaid-modal-body svg{max-width:none !important;max-height:none !important;height:auto;display:block;margin:0;pointer-events:none}
@media (prefers-color-scheme: dark){
  .mermaid-modal{background:rgba(0,0,0,0.82)}
  .mermaid-modal-container{box-shadow:0 24px 60px rgba(0,0,0,0.75)}
  .mermaid-modal-toolbar{box-shadow:0 4px 20px rgba(0,0,0,0.45)}
}
@media print{
  :root{--bg:#fff;--panel:#fff;--ink:#000;--dim:#444;--line:#ddd}
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  .card{break-inside:avoid;border-radius:0}
  .msg{break-inside:auto}
  .mermaid-toolbar{display:none !important}
  .mermaid-block[data-rendered="true"] .mermaid-code{display:none !important}
  .mermaid-block[data-rendered="true"] .mermaid-chart{display:block !important;padding:0 !important}
  .mermaid-block:not([data-rendered="true"]) .mermaid-code{display:block !important}
  .mermaid-modal{display:none !important}
}
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <span class="eyebrow">${escapeHtml(labels.docTitle)}</span>
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(summaryText(analysis, labels))}</p>
    <div class="meta-row">
      <span>${escapeHtml(labels.generated)}: ${escapeHtml(stampText(analysis.generatedAt))}</span>
      <span>${escapeHtml(labels.session)}: <code>${escapeHtml(session.id)}</code></span>
      ${session.cwd ? `<span>${escapeHtml(session.cwd)}</span>` : ''}
    </div>
  </header>
  ${section('overview', labels.overview, labels.overviewHint, overview)}
  ${section('thread', labels.prompts, labels.promptsHint, prompts)}
  ${section('transcript', labels.transcript, labels.transcriptHint, transcript)}
  ${analysis.conclusion ? section('conclusion', labels.conclusion, labels.conclusionHint, conclusion) : ''}
  ${analysis.todos.length ? section('todos', labels.todos, labels.todosHint, todos) : ''}
  ${analysis.tools.length ? section('tools', labels.tools, '', tools) : ''}
  ${section('files', labels.files, '', files)}
  ${analysis.timeline.length ? section('timeline', labels.timeline, '', timeline) : ''}
  ${analysis.errors.length ? section('errors', labels.errors, '', errors) : ''}
  <footer>
    <span>${escapeHtml(labels.footer)}</span>
  </footer>
</div>
<div id="mermaid-modal" class="mermaid-modal" style="display:none;" aria-hidden="true">
  <div class="mermaid-modal-container">
    <div class="mermaid-modal-toolbar">
      <button type="button" class="mermaid-modal-btn" data-action="zoom-out" title="${escapeHtml(labels.mermaidZoomOut || (labels === LABELS.en ? 'Zoom out' : '缩小'))}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <span class="mermaid-modal-scale">100%</span>
      <button type="button" class="mermaid-modal-btn" data-action="zoom-in" title="${escapeHtml(labels.mermaidZoomIn || (labels === LABELS.en ? 'Zoom in' : '放大'))}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <span class="mermaid-modal-divider"></span>
      <button type="button" class="mermaid-modal-btn" data-action="zoom-actual" title="${escapeHtml(labels.mermaidZoomActual || (labels === LABELS.en ? '1:1 Actual size' : '1:1 原图'))}">1:1</button>
      <button type="button" class="mermaid-modal-btn" data-action="zoom-reset" title="${escapeHtml(labels.mermaidZoomReset || (labels === LABELS.en ? 'Fit to screen' : '自适应'))}">Fit</button>
      <span class="mermaid-modal-divider"></span>
      <button type="button" class="mermaid-modal-btn mermaid-modal-btn-close" data-action="close" title="${escapeHtml(labels.mermaidClose || (labels === LABELS.en ? 'Close' : '关闭'))}">&times;</button>
    </div>
    <button type="button" class="mermaid-modal-close" title="${escapeHtml(labels.mermaidClose || (labels === LABELS.en ? 'Close' : '关闭'))}" aria-label="${escapeHtml(labels.mermaidClose || (labels === LABELS.en ? 'Close' : '关闭'))}">&times;</button>
    <div class="mermaid-modal-body"></div>
  </div>
</div>
${mermaidScript}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/**
 * Send a document, optionally as a download with a readable name.
 *
 * `Content-Disposition` carries both an ASCII fallback and the RFC 5987 UTF-8
 * form: every current browser reads `filename*`, and an old client falls back to
 * a transliterated name instead of a mangled one.
 */
function sendDocument(response, status, contentType, body, filename, fallbackName) {
  const headers = {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (filename) {
    const ascii = (fallbackName || 'dsh-share').replace(/[^\x20-\x7e]+/g, '').replace(/["\\]/g, '')
    headers['content-disposition'] =
      `attachment; filename="${ascii || 'dsh-share'}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  }
  response.writeHead(status, headers)
  response.end(body)
}

function sendHtml(response, status, html, filename, fallbackName) {
  sendDocument(response, status, 'text/html', html, filename, fallbackName)
}

/** Read a bounded JSON body; resolves `undefined` for an empty one. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}function requestUrl(request) {
  try {
    return new URL(request?.url ?? '/', 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

/** The live Session object, or undefined when nothing with that id is loaded. */
function lookupSession(ctx, sessionId) {
  try {
    const store = ctx.get('sessions')
    if (!store || typeof store.get !== 'function') return undefined
    return store.get(sessionId)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Download names
// ---------------------------------------------------------------------------

/** `20261031-0812` — sortable, no separators a filesystem would argue about. */
function stampForFile(time) {
  const date = new Date(Number(time) || Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/**
 * The name a downloaded artifact gets.
 *
 * The reader keeps this file, so it is named for what it is: the product, the
 * conversation's own topic, and when it was made. Only characters Windows,
 * macOS and Linux all reject are removed — the rest of the topic survives, which
 * is the point.
 */
function fileNameFor(analysis, labels, extension) {
  const topic = String(analysis.session.topic || analysis.session.id || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .replace(/[. ]+$/, '')
  const base = topic ? `${labels.docTitle}-${topic}` : `${labels.docTitle}-${analysis.session.id}`
  return `${base}-${stampForFile(analysis.generatedAt)}.${extension}`
}

/**
 * The ASCII name an old client falls back to.
 *
 * `Content-Disposition` sends both forms: modern browsers use `filename*` and
 * get the real, readable name. A client that only reads `filename` must still
 * receive something sane, so the transliteration keeps the product and the date
 * and drops what it cannot represent — never a run of dashes where the topic was.
 */
function asciiFileName(filename, labels) {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? 'html'
  const stamp = /(\d{8}-\d{4})/.exec(filename)?.[1] ?? ''
  const stem = String(labels.docTitle).replace(/[^\x20-\x7e]+/g, '').trim() || 'share'
  const slug = stem.replace(/["\\]/g, '').replace(/\s+/g, '-')
  return [slug, stamp].filter(Boolean).join('-') + '.' + extension
}

// ---------------------------------------------------------------------------
// LAN addressing
// ---------------------------------------------------------------------------

/**
 * IPv4 addresses another device on the same network could reach.
 *
 * Loopback and link-local are useless to a reader. `198.18.0.0/15` is a
 * benchmarking range some proxy tools hand out; it routes nowhere, so offering
 * it would produce a link that looks right and never loads.
 */
function lanAddresses() {
  const found = []
  let interfaces = {}
  try {
    interfaces = networkInterfaces()
  } catch {
    return found
  }
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (!info || info.family !== 'IPv4' || info.internal) continue
      const address = String(info.address ?? '')
      if (!address || address.startsWith('127.') || address.startsWith('169.254.')) continue
      if (address.startsWith('198.18.') || address.startsWith('198.19.')) continue
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
      if (!found.some((entry) => entry.address === address)) found.push({ address, isPrivate })
    }
  }
  // A private LAN address is the one a colleague can plausibly reach; a public
  // one is worth listing but is rarely the intended target.
  found.sort((left, right) => Number(right.isPrivate) - Number(left.isPrivate))
  return found.map((entry) => entry.address)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  /**
   * Resolve the request into the one thing every route needs: a live session and
   * the labels for the reader's language. Returns undefined after answering an
   * error, so each handler stays a flat sequence of checks.
   *
   * `fail` is the route's own error responder: the JSON route answers JSON, the
   * page route answers HTML, because a person opens that one in a browser.
   */
  const resolve = (request, response, params, fail = (status, message) => {
    sendJson(response, status, { ok: false, error: message })
  }) => {
    const sessionId = (params.get('sessionId') ?? '').trim()
    const labels = labelsFor(params.get('lang') ?? 'zh')
    if (!sessionId) {
      fail(400, 'sessionId is required')
      return undefined
    }
    const session = lookupSession(ctx, sessionId)
    if (!session) {
      fail(
        404,
        `session ${sessionId} is not loaded in this Harness process; open it once and retry`,
      )
      return undefined
    }
    return { session, labels }
  }

  const wantsDownload = (params) =>
    ['1', 'true', 'yes'].includes(String(params.get('download') ?? '').toLowerCase())

  const analysisRoute = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const params = requestUrl(request).searchParams
    const resolved = resolve(request, response, params)
    if (!resolved) return
    let payload
    try {
      const analysis = analyze(resolved.session)
      payload = {
        ok: true,
        labels: resolved.labels.docTitle,
        summary: summaryText(analysis, resolved.labels),
        analysis,
        markdown: renderMarkdown(analysis, resolved.labels),
        fileNames: {
          html: fileNameFor(analysis, resolved.labels, 'html'),
          md: fileNameFor(analysis, resolved.labels, 'md'),
        },
      }
    } catch (error) {
      // Everything the handler renders stays inside the guard: a throw after it
      // would escape into the HTTP stack and leave the request unanswered.
      sendJson(response, 500, { ok: false, error: `cannot build the analysis: ${error?.message ?? error}` })
      return
    }
    sendJson(response, 200, payload)
  }

  // A person opens the page and Markdown routes in a browser, so even their
  // errors are HTML/text: raw JSON in a tab looks like the plugin is broken.
  const failAsDocument = (response, contentType) => (status, message) => {
    sendDocument(
      response,
      status,
      contentType,
      `<!DOCTYPE html><meta charset="utf-8"><title>${escapeHtml(String(status))}</title>` +
        `<p style="font:15px/1.6 system-ui,sans-serif;margin:48px auto;max-width:640px">${escapeHtml(message)}</p>`,
    )
  }

  const pageRoute = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const fail = failAsDocument(response, 'text/html')
    const params = requestUrl(request).searchParams
    const resolved = resolve(request, response, params, fail)
    if (!resolved) return
    try {
      const analysis = analyze(resolved.session)
      const body = renderPage(analysis, resolved.labels)
      const name = wantsDownload(params) ? fileNameFor(analysis, resolved.labels, 'html') : undefined
      sendHtml(response, 200, body, name, name ? asciiFileName(name, resolved.labels) : undefined)
    } catch (error) {
      fail(500, `cannot render the share page: ${error?.message ?? error}`)
    }
  }

  const markdownRoute = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const fail = failAsDocument(response, 'text/plain')
    const params = requestUrl(request).searchParams
    const resolved = resolve(request, response, params, fail)
    if (!resolved) return
    try {
      const analysis = analyze(resolved.session)
      const body = renderMarkdown(analysis, resolved.labels)
      const name = wantsDownload(params) ? fileNameFor(analysis, resolved.labels, 'md') : undefined
      sendDocument(
        response,
        200,
        'text/markdown',
        body,
        name,
        name ? asciiFileName(name, resolved.labels) : undefined,
      )
    } catch (error) {
      fail(500, `cannot render the Markdown: ${error?.message ?? error}`)
    }
  }

  // ---- LAN sharing --------------------------------------------------------
  //
  // The Harness listener is loopback-only, so `/page` cannot serve a colleague.
  // This is the smallest listener that can: it serves exactly one frozen HTML
  // snapshot per token, on the LAN interfaces, and dies with its expiry or when
  // the last share is stopped. The snapshot is frozen at start time on purpose —
  // a link somebody else opened must not change under them, and revoking the
  // link must actually revoke the content.

  /** token → { html, fileName, expiresAt, timer } */
  const shares = new Map()
  let server = null
  let boundPort = 0
  let boundAddress = ''

  const baseUrlFor = (address) => `http://${address}:${boundPort}`

  const stopShare = (token) => {
    const share = shares.get(token)
    if (!share) return false
    clearTimeout(share.timer)
    shares.delete(token)
    if (shares.size === 0) closeServer()
    return true
  }

  const closeServer = () => {
    const current = server
    server = null
    boundPort = 0
    boundAddress = ''
    if (!current) return
    try {
      current.close()
    } catch {
      /* already closing */
    }
    // A connection still open keeps `close()` pending; drop it rather than leak
    // a listener nobody can reach any more.
    try {
      current.closeAllConnections?.()
    } catch {
      /* not available on this Node */
    }
  }

  const respondNotFound = (response) => {
    sendDocument(response, 404, 'text/html', '<!DOCTYPE html><meta charset="utf-8"><p>link expired or unknown</p>')
  }

  const serveShare = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    const url = requestUrl(request)
    const params = url.searchParams
    // `/dsh-share/s/<token>`; a bare `/` is not a share and must not leak one.
    const match = /^\/dsh-share\/s\/([A-Za-z0-9_-]{8,})$/.exec(url.pathname)
    const token = match ? match[1] : ''
    const share = token ? shares.get(token) : undefined
    if (!share || share.expiresAt <= Date.now()) {
      if (share) stopShare(token)
      respondNotFound(response)
      return
    }
    sendHtml(
      response,
      200,
      share.html,
      wantsDownload(params) ? share.fileName : undefined,
      wantsDownload(params) ? share.asciiFileName : undefined,
    )
  }

  /** Start the listener once, on all interfaces, with an OS-assigned port. */
  const ensureServer = () =>
    new Promise((resolvePromise, rejectPromise) => {
      if (server) {
        resolvePromise({ port: boundPort, address: boundAddress })
        return
      }
      const created = createServer((request, response) => {
        try {
          serveShare(request, response)
        } catch (error) {
          try {
            sendDocument(response, 500, 'text/html', `<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(String(error?.message ?? error))}</p>`)
          } catch {
            /* the socket is already gone */
          }
        }
      })
      created.on('error', (error) => {
        server = null
        boundPort = 0
        boundAddress = ''
        rejectPromise(error)
      })
      created.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => {
        const info = created.address()
        if (!info || typeof info === 'string') {
          try {
            created.close()
          } catch {
            /* nothing to close */
          }
          rejectPromise(new Error('the LAN listener has no port'))
          return
        }
        server = created
        boundPort = info.port
        // `0.0.0.0` is not an address a reader can type; the useful base is the
        // first real interface, and `/api/analysis` reports them all.
        boundAddress = '0.0.0.0'
        resolvePromise({ port: boundPort, address: boundAddress })
      })
    })

  const lanStartRoute = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `invalid request body: ${error?.message ?? error}` })
      return
    }
    const params = new URLSearchParams()
    if (body?.sessionId) params.set('sessionId', String(body.sessionId))
    if (body?.lang) params.set('lang', String(body.lang))
    const resolved = resolve(request, response, params)
    if (!resolved) return
    if (shares.size >= LAN_MAX_SHARES) {
      sendJson(response, 429, { ok: false, error: `at most ${LAN_MAX_SHARES} links at a time; stop one first` })
      return
    }
    const minutes = Math.min(
      LAN_MAX_MINUTES,
      Math.max(1, Number(body?.minutes) || LAN_DEFAULT_MINUTES),
    )
    let html
    let fileName
    let asciiName
    try {
      const analysis = analyze(resolved.session)
      html = renderPage(analysis, resolved.labels)
      fileName = fileNameFor(analysis, resolved.labels, 'html')
      asciiName = asciiFileName(fileName, resolved.labels)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: `cannot render the share page: ${error?.message ?? error}` })
      return
    }
    let bound
    try {
      bound = await ensureServer()
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: `cannot listen for LAN readers: ${error?.message ?? error}`,
      })
      return
    }
    const token = randomBytes(18).toString('base64url')
    const expiresAt = Date.now() + minutes * 60 * 1000
    const timer = setTimeout(() => stopShare(token), expiresAt - Date.now())
    if (typeof timer.unref === 'function') timer.unref()
    shares.set(token, {
      html,
      fileName,
      asciiFileName: asciiName,
      expiresAt,
      timer,
      sessionId: String(resolved.session.id ?? ''),
    })

    const addresses = lanAddresses()
    sendJson(response, 200, {
      ok: true,
      token,
      port: bound.port,
      minutes,
      expiresAt,
      addresses,
      // The first address is the best guess; the rest are offered as alternatives
      // because a machine with WSL, a VPN and Wi-Fi exposes several.
      url: addresses.length ? `${baseUrlFor(addresses[0])}/dsh-share/s/${token}` : '',
      urls: addresses.map((address) => `${baseUrlFor(address)}/dsh-share/s/${token}`),
      downloadUrl: addresses.length
        ? `${baseUrlFor(addresses[0])}/dsh-share/s/${token}?download=1`
        : '',
    })
  }

  const lanStopRoute = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `invalid request body: ${error?.message ?? error}` })
      return
    }
    const token = String(body?.token ?? '').trim()
    if (!token) {
      sendJson(response, 400, { ok: false, error: 'token is required' })
      return
    }
    sendJson(response, 200, { ok: true, stopped: stopShare(token), remaining: shares.size })
  }

  const lanStatusRoute = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    sendJson(response, 200, {
      ok: true,
      listening: Boolean(server),
      port: boundPort,
      addresses: server ? lanAddresses() : [],
      shares: [...shares.entries()].map(([token, share]) => ({
        token,
        expiresAt: share.expiresAt,
        fileName: share.fileName,
        sessionId: share.sessionId,
        urls: lanAddresses().map((address) => `${baseUrlFor(address)}/dsh-share/s/${token}`),
      })),
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/api/analysis`, handler: analysisRoute }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/page`, handler: pageRoute }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/md`, handler: markdownRoute }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/api/lan/start`, handler: lanStartRoute }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/api/lan/stop`, handler: lanStopRoute }),
      ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/api/lan/status`, handler: lanStatusRoute }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* already gone */
        }
      }
      for (const token of [...shares.keys()]) stopShare(token)
      closeServer()
    }
  }, 'dsh-share: routes')
}
