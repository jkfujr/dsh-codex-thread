/**
 * Codex thread bridge — read and continue existing Codex sessions from DeepSeek Harness.
 *
 * Read side: the native Codex thread store (`$CODEX_HOME/sessions/**\/rollout-*.jsonl`),
 * parsed by byte range so it never blocks a Codex writer and never rescans a whole file.
 *
 * Write side: two delivery paths, chosen by what Codex itself reports.
 *   turn  — `codex exec resume <id> -` with the prompt on stdin (idle thread, we own the turn)
 *   queue — `codex queue --thread <id> --message <text>` (thread owned by Codex Desktop)
 *
 * Every Codex turn, whichever path started it, appends to the same rollout, so one
 * parser serves both.
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as zlib from 'node:zlib'

export const name = 'codex-thread'
export const inject = ['tools']

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const UUID_RE_G = new RegExp(UUID_RE.source, 'gi')
const TAIL_BYTES = 256 * 1024
const MAX_SEGMENT_BYTES = 2 * 1024 * 1024
const WRITER_CONFLICT = /already has an active writer/i
const PROBE_MS = 3000
const POLL_MS = 700

const TEXT_OUTPUT = Object.freeze({
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: true,
  },
  render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
})

/**
 * A tool result must be lossless JSON. Dropping `undefined` fields here keeps one
 * unresolved value — an unknown model, a session with no recorded cwd — from
 * rejecting the entire call.
 */
function sanitize(value) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item === undefined ? null : item))
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = sanitize(item)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return value.toString()
  return value
}

// ---------------------------------------------------------------------------
// Paths and executable resolution
// ---------------------------------------------------------------------------

function codexHome() {
  return (process.env.CODEX_HOME || '').trim() || join(homedir(), '.codex')
}

function sessionsRoot() {
  return join(codexHome(), 'sessions')
}

function pathDirs() {
  return (process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
}

let executable

/** Resolve the Codex CLI once: a native binary when one exists, otherwise the npm shim's entry script. */
function resolveExecutable() {
  if (executable) return executable
  const override = (process.env.CODEX_BIN || '').trim()
  if (override) return (executable = { file: override, prefix: [] })

  if (process.platform !== 'win32') return (executable = { file: 'codex', prefix: [] })

  for (const dir of pathDirs()) {
    const binary = join(dir, 'codex.exe')
    if (existsSync(binary)) return (executable = { file: binary, prefix: [] })
  }
  for (const dir of pathDirs()) {
    if (!existsSync(join(dir, 'codex.cmd'))) continue
    const packageRoot = join(dir, 'node_modules', '@openai', 'codex')
    const native = findVendorBinary(packageRoot)
    if (native) return (executable = { file: native, prefix: [] })
    const entry = join(packageRoot, 'bin', 'codex.js')
    if (existsSync(entry)) {
      const node = findNode(dir)
      if (node) return (executable = { file: node, prefix: [entry] })
    }
  }
  throw new Error(
    'codex-thread: the Codex CLI was not found on PATH. Set CODEX_BIN to the codex executable.',
  )
}

function findVendorBinary(packageRoot) {
  const vendorRoot = join(packageRoot, 'node_modules', '@openai')
  if (!existsSync(vendorRoot)) return undefined
  for (const platformPackage of safeReaddir(vendorRoot)) {
    const vendor = join(vendorRoot, platformPackage, 'vendor')
    if (!existsSync(vendor)) continue
    for (const triple of safeReaddir(vendor)) {
      const binary = join(vendor, triple, 'bin', 'codex.exe')
      if (existsSync(binary)) return binary
    }
  }
  return undefined
}

function findNode(shimDir) {
  const local = join(shimDir, 'node.exe')
  if (existsSync(local)) return local
  const declared = (process.env.NODE_EXE || '').trim()
  if (declared && existsSync(declared)) return declared
  for (const dir of pathDirs()) {
    const node = join(dir, 'node.exe')
    if (existsSync(node)) return node
  }
  return undefined
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Codex CLI processes
// ---------------------------------------------------------------------------

/** Start a Codex CLI child with an exact argv (no shell, so instruction text is never re-quoted). */
function spawnCodex(args, { cwd } = {}) {
  const { file, prefix } = resolveExecutable()
  return spawn(file, [...prefix, ...args], {
    cwd: cwd && existsSync(cwd) ? cwd : undefined,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Run one short-lived Codex CLI command and collect its output. */
function runCodex(args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnCodex(args, { cwd })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      kill(child)
      finish({ code: -1, stdout, stderr: `${stderr}\ncodex-thread: command timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { child.kill() } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Thread store: index, rollout lookup, byte-range reads
// ---------------------------------------------------------------------------

let indexCache = { at: 0, threads: [] }

function readSessionIndex() {
  if (Date.now() - indexCache.at < 15000) return indexCache.threads
  const file = join(codexHome(), 'session_index.jsonl')
  const threads = []
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (typeof row.id === 'string') {
          threads.push({
            id: row.id,
            name: typeof row.thread_name === 'string' ? row.thread_name : '',
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
          })
        }
      } catch {}
    }
  } catch {}
  threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  indexCache = { at: Date.now(), threads }
  return threads
}

let rolloutCache = { at: 0, byId: new Map() }

/**
 * Codex names a rollout `rollout-<timestamp>-<threadId>.jsonl`. Older sessions are
 * stored compressed (`.jsonl.zst`), and a continued session gets a second id appended
 * (`<threadId>_<continuationId>.jsonl`) — that file belongs to the continuation, not to
 * the thread that names the front of it. Rank candidates so the thread's own rollout wins.
 */
const ROLLOUT_NAME = /^(.*?)(\.jsonl)(\.zst)?$/i

function rankRollout(entry) {
  const stem = entry.replace(/\.zst$/i, '')
  if (!stem.toLowerCase().endsWith('.jsonl')) return undefined
  const ids = [...stem.matchAll(UUID_RE_G)].map((match) => match[0].toLowerCase())
  if (ids.length === 0) return undefined
  const exact = ids.length === 1
  const compressed = /\.zst$/i.test(entry)
  return { id: ids[0], rank: (exact ? 0 : 2) + (compressed ? 1 : 0) }
}

function rolloutMap() {
  if (Date.now() - rolloutCache.at < 30000) return rolloutCache.byId
  const all = new Map()
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!ROLLOUT_NAME.test(entry)) continue
      const candidate = rankRollout(entry)
      if (!candidate) continue
      const list = all.get(candidate.id) ?? []
      list.push({ path: full, rank: candidate.rank, mtimeMs: stats.mtimeMs })
      all.set(candidate.id, list)
    }
  }
  walk(sessionsRoot(), 0)
  const byId = new Map()
  for (const [id, list] of all) {
    // Best rank is the thread's own rollout; the rest are continuations that keep growing.
    list.sort((a, b) => (a.rank - b.rank) || (b.mtimeMs - a.mtimeMs))
    byId.set(id, list)
  }
  rolloutCache = { at: Date.now(), byId }
  return byId
}

function rolloutEntries(threadId) {
  const hit = rolloutMap().get(threadId)
  if (hit) return hit
  // A session created moments ago may predate the cached scan; miss once, then rescan.
  rolloutCache = { at: 0, byId: new Map() }
  return rolloutMap().get(threadId) ?? []
}

function rolloutOf(threadId) {
  return rolloutEntries(threadId)[0]?.path
}

/**
 * Every file that belongs to a thread, newest write first. A continued session writes its
 * later turns into a sibling file, and the original rollout's mtime can stay frozen at
 * creation, so live state has to consider all of them.
 */
function siblingRollouts(threadId) {
  return [...rolloutEntries(threadId)].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Drop cached store indexes after creating a session so the new rollout resolves immediately. */
function resetThreadCaches() {
  rolloutCache = { at: 0, byId: new Map() }
  indexCache = { at: 0, threads: [] }
}

function threadIdOf(value) {
  if (typeof value !== 'string') return undefined
  const match = UUID_RE.exec(value)
  return match ? match[0].toLowerCase() : undefined
}

async function requireThread(input) {
  const id = threadIdOf(input)
  if (!id) {
    throw new Error(
      `codex-thread: no Codex thread id in ${JSON.stringify(input)}. Pass a thread id, a codex://threads/<id> link, or a rollout path.`,
    )
  }
  const rollout = rolloutOf(id)
  if (!rollout) {
    throw new Error(`codex-thread: thread ${id} has no recorded rollout under ${sessionsRoot()}.`)
  }
  return { id, rollout }
}

const ZSTD_EXT = /\.zst$/i
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const inflatedCache = new Map()

/**
 * Codex compresses old rollouts with zstd. A compressed file cannot be tail-read at a
 * byte offset, so it is inflated whole and cached; the byte offsets the tools speak are
 * always offsets into the inflated JSONL.
 */
async function rolloutBuffer(file) {
  const stats = await fsp.stat(file)
  const cached = inflatedCache.get(file)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.compressedSize === stats.size) return cached

  if (stats.size > MAX_COMPRESSED_BYTES) {
    throw new Error(
      `codex-thread: ${file} is a ${(stats.size / 1048576).toFixed(1)} MiB compressed rollout; inflating it in memory is not reasonable. Open it in Codex instead.`,
    )
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(`codex-thread: ${file} is zstd-compressed and this runtime cannot inflate it.`)
  }
  const buffer = zlib.zstdDecompressSync(await fsp.readFile(file))
  const entry = { mtimeMs: stats.mtimeMs, compressedSize: stats.size, buffer, size: buffer.length }
  inflatedCache.set(file, entry)
  return entry
}

/**
 * Turn one byte slice into whole-line text and line-aligned offsets.
 * A leading partial line is dropped only when the slice really starts mid-line; a trailing
 * incomplete line is dropped and both `start` and `end` stay on line boundaries, so re-reading
 * from `end` never loses a record. (`from` usually comes from a previous `end`, which is
 * already aligned, so this mostly protects an offset that was computed while the file grew.)
 */
function sliceLines(buffer, offsetOfStart, fileSize) {
  let begin = 0
  if (offsetOfStart > 0) {
    if (buffer[0] === 0x0a) begin = 1
    else {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) {
        return { text: '', start: offsetOfStart + buffer.length, end: offsetOfStart + buffer.length, truncatedTail: false }
      }
      begin = newline + 1
    }
  }

  const endOfData = offsetOfStart + buffer.length
  const truncatedTail = endOfData < fileSize
  let stop = buffer.length
  if (truncatedTail) {
    const lastNewline = buffer.lastIndexOf(0x0a)
    if (lastNewline < begin) {
      return { text: '', start: offsetOfStart + begin, end: offsetOfStart + begin, truncatedTail }
    }
    stop = lastNewline + 1
  }

  return {
    text: buffer.subarray(begin, stop).toString('utf8'),
    start: offsetOfStart + begin,
    end: offsetOfStart + stop,
    truncatedTail,
  }
}

/** Read bytes `[from, from + maxBytes)` as utf8, aligned to whole lines. */
async function readBytes(file, from, maxBytes) {
  if (ZSTD_EXT.test(file)) {
    const { buffer: whole, size } = await rolloutBuffer(file)
    const start = Math.max(0, Math.min(from, size))
    const probe = start > 0 ? start - 1 : 0
    const slice = whole.subarray(probe, Math.min(size, start + maxBytes))
    return { ...sliceLines(slice, probe, size), size }
  }

  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, Math.min(from, size))
    const probe = start > 0 ? start - 1 : 0
    const length = Math.max(0, Math.min(size, start + maxBytes) - probe)
    if (length === 0) return { text: '', size, start, end: start, truncatedTail: false }
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, probe)
    return { ...sliceLines(buffer, probe, size), size }
  } finally {
    await handle.close()
  }
}

async function fileSize(file) {
  if (ZSTD_EXT.test(file)) return (await rolloutBuffer(file)).size
  const stats = await fsp.stat(file)
  return stats.size
}

// ---------------------------------------------------------------------------
// Rollout parsing
// ---------------------------------------------------------------------------

/**
 * Codex records its own injected context as user-role messages: XML-shaped blocks
 * (`<environment_context>`, `<skills_instructions>`, …) and the heading-form
 * `# AGENTS.md instructions` / `# CLAUDE.md instructions`. Neither is the human talking.
 */
function looksSynthetic(text) {
  const head = text.slice(0, 96)
  if (head.startsWith('<')) {
    const close = head.indexOf('>')
    return close > 0
  }
  return /^#\s*(AGENTS|CLAUDE)\.md\s+instructions/i.test(head)
}

function parseRollout(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const payload = entry.payload
    if (!payload) continue
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : ''

    if (entry.type === 'session_meta') {
      records.push({
        kind: 'meta',
        at,
        id: payload.id ?? payload.session_id,
        cwd: payload.cwd,
        cli: payload.cli_version,
        originator: payload.originator,
      })
      continue
    }
    if (entry.type === 'turn_context') {
      records.push({
        kind: 'context',
        at,
        cwd: payload.cwd,
        model: payload.model,
        effort: payload.effort,
        approval: payload.approval_policy,
      })
      continue
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_started') records.push({ kind: 'start', at })
      else if (payload.type === 'task_complete') records.push({ kind: 'done', at })
      continue
    }
    if (entry.type !== 'response_item') continue

    if (payload.type === 'message') {
      const parts = Array.isArray(payload.content) ? payload.content : []
      const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
      if (!text.trim()) continue
      if (payload.role === 'assistant') records.push({ kind: 'assistant', at, text })
      else if (payload.role === 'user' && !looksSynthetic(text.trim())) records.push({ kind: 'user', at, text })
      continue
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      records.push({ kind: 'tool', at, name: typeof payload.name === 'string' ? payload.name : 'tool' })
    }
  }
  return records
}

function stateOf(records) {
  let state = 'idle'
  let at = ''
  for (const record of records) {
    if (record.kind === 'start') {
      state = 'running'
      at = record.at
    } else if (record.kind === 'done') {
      state = 'idle'
      at = record.at
    }
  }
  return { state, at }
}

/** Last observed model and cwd, recorded per turn; falls back to the session header. */
function contextOf(records) {
  const result = { cwd: undefined, model: undefined, effort: undefined, cli: undefined, originator: undefined, id: undefined }
  for (const record of records) {
    if (record.kind === 'meta') {
      result.id = record.id ?? result.id
      result.cwd = record.cwd ?? result.cwd
      result.cli = record.cli ?? result.cli
      result.originator = record.originator ?? result.originator
    } else if (record.kind === 'context') {
      result.cwd = record.cwd ?? result.cwd
      result.model = record.model ?? result.model
      result.effort = record.effort ?? result.effort
    }
  }
  return result
}

function isRunning(records) {
  return stateOf(records).state === 'running'
}

function clockOf(at) {
  if (!at) return '--:--'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString('en-GB', { hour12: false })
}

function clip(text, limit) {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}\n…(${normalized.length - limit} more characters)`
}

/**
 * A thread's shared header: identity, cwd, model, and whether a Codex turn is live.
 * The session header lands at the start of a rollout and each turn's settings just
 * before its messages, so identity comes from the head and the live state from the tail.
 *
 * A rollout can end on `task_started` with no completion — a compressed archive cut
 * mid-turn, or a turn that died with the process. Codex appends continuously while a
 * turn runs, so an unwritten rollout cannot still be working: report it idle and say why.
 */
const STALE_TURN_MS = 15 * 60 * 1000

async function inspectThread(id, rollout) {
  const stats = await fsp.stat(rollout)
  const size = await fileSize(rollout)
  const [head, tail] = await Promise.all([
    readBytes(rollout, 0, 64 * 1024),
    readBytes(rollout, Math.max(0, size - TAIL_BYTES), TAIL_BYTES),
  ])
  const headRecords = parseRollout(head.text)
  const records = parseRollout(tail.text)

  // Live state must consider every file of the thread. A continued session writes later
  // turns into a sibling rollout, and the original file's mtime can stay frozen at
  // creation, so neither one alone is trustworthy.
  const siblings = siblingRollouts(id)
  const newestMs = Math.max(stats.mtimeMs, ...siblings.map((entry) => entry.mtimeMs))
  let state = { state: 'idle', at: '' }
  let sawBoundary = false
  const consider = (list) => {
    if (!list.some((record) => record.kind === 'start' || record.kind === 'done')) return
    sawBoundary = true
    const found = stateOf(list)
    if (!state.at || found.at > state.at) state = found
  }
  consider(records)
  for (const sibling of siblings.slice(0, 3)) {
    if (sibling.path === rollout) continue
    try {
      const siblingSize = await fileSize(sibling.path)
      const chunk = await readBytes(sibling.path, Math.max(0, siblingSize - TAIL_BYTES), TAIL_BYTES)
      consider(parseRollout(chunk.text))
    } catch {}
  }
  if (!sawBoundary) {
    state = { state: Date.now() - newestMs < STALE_TURN_MS ? 'running' : 'idle', at: '', inferred: true }
  }
  const stale = state.state === 'running' && !state.inferred && Date.now() - newestMs > STALE_TURN_MS

  return {
    id,
    rollout,
    siblingCount: siblings.length,
    size,
    updatedMs: newestMs,
    context: contextOf([...headRecords, ...records]),
    state: stale ? { state: 'idle', at: state.at, stale: true } : state,
    records,
    tailTruncated: tail.start > 0,
  }
}

// ---------------------------------------------------------------------------
// Resume turns owned by this plugin
// ---------------------------------------------------------------------------

let sequence = 0
const turns = new Map()

/**
 * Codex chooses its model through several surfaces, not just `-m`: a profile layer,
 * an arbitrary config override, or the direct model flag. Emit whichever were asked for.
 */
function modelArgs({ model, profile, effort, config } = {}) {
  const args = []
  if (profile) args.push('-p', profile)
  if (model) args.push('-m', model)
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      args.push('-c', `${key}=${String(value)}`)
    }
  }
  // Codex has no dedicated reasoning-effort flag: the level is a config value. Emit it
  // after the caller's own overrides so an equal-named config entry cannot win over it.
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  return args
}

/** One readable line for whatever model selection the caller asked Codex for. */
function describeSelection(selection = {}) {
  const parts = []
  if (selection.model) parts.push(`model=${selection.model}`)
  if (selection.effort) parts.push(`effort=${selection.effort}`)
  if (selection.profile) parts.push(`profile=${selection.profile}`)
  for (const [key, value] of Object.entries(selection.config ?? {})) {
    parts.push(`-c ${key}=${value}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'Codex defaults'
}

function startTurn(id, message, cwd, selection) {
  // `resume` owns -m and -c but not -p, so the whole selection precedes the subcommand.
  const args = ['exec', ...modelArgs(selection), 'resume', id, '-', '--json', '--skip-git-repo-check', '--all']
  const child = spawnCodex(args, { cwd })
  return feedTurn(attachTurn(child, id), message)
}

/** Start a brand-new Codex session; its thread id arrives on the `thread.started` event. */
function startNewThread(message, { cwd, ...selection } = {}) {
  const args = ['exec', ...modelArgs(selection), '-', '--json', '--skip-git-repo-check']
  if (cwd) args.push('-C', cwd)
  const child = spawnCodex(args, { cwd })
  return feedTurn(attachTurn(child, undefined), message)
}

function attachTurn(child, id) {
  const turn = {
    taskId: `codex-turn-${++sequence}`,
    id,
    child,
    startedAt: Date.now(),
    status: 'starting',
    detail: undefined,
    output: '',
    settled: undefined,
  }
  let resolveStarted
  let resolveIdentified
  turn.started = new Promise((resolve) => { resolveStarted = resolve })
  turn.identified = new Promise((resolve) => { resolveIdentified = resolve })
  if (id) resolveIdentified(id)
  let decided = false
  const decide = (verdict, detail) => {
    if (decided) return
    decided = true
    if (verdict !== 'started') turn.detail = detail ?? turn.detail
    resolveStarted(verdict)
  }

  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    turn.output += chunk
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'thread.started') {
        if (typeof event.thread_id === 'string' && event.thread_id) {
          turn.id = event.thread_id.toLowerCase()
          resolveIdentified(turn.id)
        }
        turn.status = 'running'
        decide('started')
      } else if (event.type === 'turn.started') {
        turn.status = 'running'
        decide('started')
      } else if (event.type === 'item.completed' && event.item?.type === 'error' && typeof event.item.message === 'string') {
        turn.detail = turn.detail ?? clip(event.item.message, 400)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { turn.output += chunk })

  child.on('error', (error) => {
    turn.status = 'failed'
    turn.settled = error.message
    decide('failed', error.message)
  })
  child.on('close', (code) => {
    turns.delete(turn.taskId)
    if (turn.status !== 'killed') {
      if (code === 0) {
        turn.status = 'completed'
      } else {
        turn.status = 'failed'
        turn.settled = clip(turn.detail ?? turn.output, 600) || `codex exited with code ${code}`
      }
    }
    if (WRITER_CONFLICT.test(turn.output)) decide('writer-conflict')
    else decide(code === 0 || turn.status === 'completed' ? 'started' : 'failed')
  })

  turns.set(turn.taskId, turn)
  return turn
}

function feedTurn(turn, message) {
  turn.child.stdin.write(message.endsWith('\n') ? message : `${message}\n`)
  turn.child.stdin.end()
  return turn
}

function turnOf(id) {
  for (const turn of turns.values()) if (turn.id === id) return turn
  return undefined
}

async function queueMessage(id, message) {
  const result = await runCodex(['queue', '--thread', id, '--message', message], { timeoutMs: 30000 })
  if (result.code !== 0) {
    throw new Error(`codex-thread: codex queue failed: ${clip(result.stderr || result.stdout, 500)}`)
  }
  const match = /Queued message (\S+) for thread/i.exec(`${result.stdout}\n${result.stderr}`)
  return { queueId: match?.[1] }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function newTool(ctx) {
  return {
    name: 'codex_thread_new',
    description:
      'Start a NEW Codex session in a directory and hand it the first instruction. Returns the new thread id, which every other codex_thread_* tool then accepts like any existing session. The turn keeps running after this call returns.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'First instruction of the new Codex session.' },
        cwd: { type: 'string', description: 'Directory the session is created in; defaults to the calling session working directory.' },
        model: { type: 'string', description: 'Codex model id, for example `gpt-6.1-sol`; omit to use native Codex settings.' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Reasoning effort, passed as `-c model_reasoning_effort=<level>`. Omit to use the model default; `ultra` is only offered by some models. Verify what actually took effect with the `model:` line of codex_thread_read.',
        },
        profile: { type: 'string', description: 'Codex config profile; layers `$CODEX_HOME/<name>.config.toml` over the user config for this run.' },
        config: { type: 'object', description: 'Raw Codex config overrides, each passed as `-c key=value`, for example { "model_provider": "custom", "model_reasoning_effort": "high" }.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) throw new Error('codex-thread: prompt must not be empty.')
      const selection = {
        model: typeof args?.model === 'string' && args.model.trim() ? args.model.trim() : undefined,
        effort: typeof args?.effort === 'string' && args.effort.trim() ? args.effort.trim() : undefined,
        profile: typeof args?.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined,
        config: args?.config && typeof args.config === 'object' && !Array.isArray(args.config) ? args.config : undefined,
      }

      let cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
      let cwdSource = cwd ? 'argument' : undefined
      if (!cwd) {
        const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
        if (workingDirectory && typeof workingDirectory.ensure === 'function') {
          try {
            const sessionDirectory = await workingDirectory.ensure(exec.agent, exec.signal)
            if (typeof sessionDirectory === 'string' && sessionDirectory) {
              cwd = sessionDirectory
              cwdSource = 'session'
            }
          } catch {}
        }
      }
      if (!cwd) {
        cwd = process.cwd()
        cwdSource = 'host'
      }
      if (!existsSync(cwd)) throw new Error(`codex-thread: working directory does not exist: ${cwd}`)

      const turn = startNewThread(prompt, { cwd, ...selection })
      const verdict = await Promise.race([
        turn.started,
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20000)),
      ])
      const id = await Promise.race([
        turn.identified,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 15000)),
      ])
      if (!id) {
        turns.delete(turn.taskId)
        kill(turn.child)
        const models = typeof args?.model === 'string' && args.model ? availableModels() : []
        throw new Error(
          [
            `codex-thread: Codex did not open a session: ${turn.settled ?? turn.detail ?? (clip(turn.output, 600) || verdict)}`,
            models.length > 0 ? `Known model ids: ${models.join(', ')}` : '',
          ].filter(Boolean).join('\n'),
        )
      }
      resetThreadCaches()
      const source = cwdSource === 'argument'
        ? 'explicit cwd argument'
        : cwdSource === 'session'
          ? 'this DSH session working directory'
          : 'the DSH host process directory (no session directory was available)'
      return {
        text: [
          `Started a new Codex session ${id}.`,
          `  cwd:    ${cwd}`,
          `  from:   ${source}`,
          `  model:  ${describeSelection(selection)}`,
          `  task:   ${turn.taskId} (${turn.status})`,
          `  offset: 0`,
          '',
          `Codex is working now. Do your own share before collecting: read the code it will touch,`,
          `run the project's build/tests to capture a baseline, draft fixtures or tests, or split the`,
          `rest of the task. Then collect with codex_thread_wait { thread: "${id}", fromOffset: 0 }`,
          `only when you actually need those results.`,
          `Keep the collaboration going with codex_thread_send { thread: "${id}", message: "..." }`,
          `and send the merged result back through codex_thread_review.`,
        ].join('\n'),
        threadId: id,
        cwd,
        cwdSource,
        taskId: turn.taskId,
        delivery: 'turn',
        fromOffset: 0,
      }
    },
  }
}

/** Model ids the installed Codex CLI advertises in its own cache; empty when unreadable. */
function availableModels() {
  try {
    const cached = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8'))
    const models = Array.isArray(cached?.models) ? cached.models : []
    return models
      .map((model) => model?.slug ?? model?.id)
      .filter((value) => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

function listTool() {
  return {
    name: 'codex_thread_list',
    description:
      'List recent Codex sessions from the local Codex thread store, newest first. `lock` marks a session that the Codex app currently has open, which makes it writable only through the queue path.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows to return; defaults to 15.' },
        query: { type: 'string', description: 'Case-insensitive substring of the session name.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit ?? 15) || 15, 1), 100)
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      const map = rolloutMap()
      const rows = readSessionIndex()
        .filter((thread) => thread.id && (query === '' || thread.name.toLowerCase().includes(query)))
        .slice(0, limit)
        .map((thread) => {
          const rollout = map.get(thread.id) ?? rolloutOf(thread.id)
          return {
            id: thread.id,
            name: thread.name || '(unnamed)',
            updatedAt: thread.updatedAt,
            lock: existsSync(join(codexHome(), 'thread-writer-locks', `${thread.id}.lock`)),
            rollout,
          }
        })
      if (rows.length === 0) {
        return { text: `No Codex sessions matched${query ? ` "${query}"` : ''}. Thread store: ${sessionsRoot()}` }
      }
      const lines = rows.map((row, index) =>
        `${String(index + 1).padStart(2)}. ${row.id}  ${row.updatedAt || '?'}${row.lock ? '  [open in Codex]' : ''}\n    ${row.name}`)
      return {
        text: [
          `${rows.length} Codex session(s) from ${sessionsRoot()}:`,
          ...lines,
          '',
          'Pass an id, a codex://threads/<id> link, or a rollout path to codex_thread_read.',
        ].join('\n'),
        threads: rows,
      }
    },
  }
}

function readTool() {
  return {
    name: 'codex_thread_read',
    description:
      'Read one Codex session: its working directory, model, whether a Codex turn is running now, recent user and assistant messages, and tool activity. Accepts an id, a codex://threads/<id> link, or a rollout path. Also returns `nextOffset`; pass it to codex_thread_wait to collect only what happens after this read.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id, codex://threads/<id> link, or rollout path.' },
        messages: { type: 'integer', minimum: 1, maximum: 60, description: 'Recent messages to return; defaults to 12.' },
        textLimit: { type: 'integer', minimum: 120, maximum: 8000, description: 'Characters kept per message; defaults to 1200.' },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { id, rollout } = await requireThread(args?.thread)
      const wanted = Math.min(Math.max(Number(args?.messages ?? 12) || 12, 1), 60)
      const limit = Math.min(Math.max(Number(args?.textLimit ?? 1200) || 1200, 120), 8000)
      const info = await inspectThread(id, rollout)
      const messages = info.records.filter((record) => record.kind === 'user' || record.kind === 'assistant').slice(-wanted)
      const tools = new Map()
      for (const record of info.records) {
        if (record.kind !== 'tool') continue
        tools.set(record.name, (tools.get(record.name) ?? 0) + 1)
      }
      const name = readSessionIndex().find((thread) => thread.id === id)?.name ?? ''
      const header = [
        `Codex thread ${id}${name ? ` — ${name}` : ''}`,
        `  cwd:      ${info.context.cwd ?? '(unknown)'}`,
        `  model:    ${info.context.model ?? '(unknown)'}${info.context.effort ? ` (effort ${info.context.effort})` : ''}`,
        `  origin:   ${info.context.originator ?? '(unknown)'}${info.context.cli ? ` / cli ${info.context.cli}` : ''}`,
        `  state:    ${info.state.state}${info.state.inferred ? ' (inferred from the rollout write time; no turn boundary in the read window)' : info.state.stale ? ' (a turn start has no completion in this rollout)' : info.state.at ? ` (last turn boundary ${clockOf(info.state.at)})` : ''}`,
        `  rollout:  ${rollout}`,
        `  updated:  ${new Date(info.updatedMs).toLocaleString('sv-SE', { hour12: false })}`,
        `  size:     ${info.size} bytes${info.tailTruncated ? `, reading the last ${TAIL_BYTES} bytes` : ''}`,
      ]
      const body = messages.length === 0
        ? ['', 'No user or assistant messages in the read window.']
        : ['', `Recent messages (${messages.length}):`, ...messages.map((message, index) =>
          `${index + 1}. [${message.kind === 'user' ? 'user' : 'codex'} ${clockOf(message.at)}] ${clip(message.text, limit)}`)]
      const activity = tools.size === 0
        ? []
        : ['', 'Tool activity in the window:', ...[...tools.entries()].map(([toolName, count]) => `  ${toolName} ×${count}`)]
      return {
        text: [...header, ...body, ...activity, '', `nextOffset: ${info.size}`].join('\n'),
        threadId: id,
        state: info.state.state,
        cwd: info.context.cwd,
        model: info.context.model,
        nextOffset: info.size,
        messages: messages.map((message) => ({ role: message.kind, at: message.at, text: message.text })),
      }
    },
  }
}

function sendTool() {
  return {
    name: 'codex_thread_send',
    description:
      'Send instructions to an existing Codex session and continue it. Delivery `turn` means this DSH process now owns the turn and streams it; delivery `queued` means the Codex app owns the session and will run the message. Use the returned `fromOffset` with codex_thread_wait to read what follows.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id, codex://threads/<id> link, or rollout path.' },
        message: { type: 'string', description: 'Instruction text sent as one Codex user turn.' },
        mode: {
          type: 'string',
          enum: ['auto', 'turn', 'queue'],
          description: 'auto tries a turn and falls back to the queue when Codex already owns the session; turn or queue forces one path.',
        },
        cwd: { type: 'string', description: 'Working directory for the turn; defaults to the directory recorded in the session.' },
        model: {
          type: 'string',
          description: 'Codex model for this turn and later turns of this session, for example `gpt-6.1-sol`. Only the owned-turn path can apply it; the queue path always runs the model the session already uses.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Reasoning effort for this turn and later turns, passed as `-c model_reasoning_effort=<level>`. Owned-turn path only; a queued message runs whatever the session already uses.',
        },
        profile: {
          type: 'string',
          description: 'Codex config profile; layers `$CODEX_HOME/<name>.config.toml` over the user config for this run. Owned-turn path only.',
        },
        config: {
          type: 'object',
          description: 'Raw Codex config overrides, each passed as `-c key=value`, for example { "model_reasoning_effort": "high", "model_provider": "custom" }. Owned-turn path only.',
        },
      },
      required: ['thread', 'message'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { id, rollout } = await requireThread(args?.thread)
      const message = typeof args?.message === 'string' ? args.message.trim() : ''
      if (!message) throw new Error('codex-thread: message must not be empty.')
      const mode = args?.mode === 'turn' || args?.mode === 'queue' ? args.mode : 'auto'
      const selection = {
        model: typeof args?.model === 'string' && args.model.trim() ? args.model.trim() : undefined,
        effort: typeof args?.effort === 'string' && args.effort.trim() ? args.effort.trim() : undefined,
        profile: typeof args?.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined,
        config: args?.config && typeof args.config === 'object' && !Array.isArray(args.config) ? args.config : undefined,
      }
      const hasSelection = Boolean(selection.model || selection.effort || selection.profile || selection.config)
      const info = await inspectThread(id, rollout)
      const fromOffset = info.size
      const cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : info.context.cwd

      const live = turnOf(id)
      if (live) {
        return {
          text: `Thread ${id} already has a turn started by this DSH process (${live.taskId}, status ${live.status}). Wait for it with codex_thread_wait, or cancel it with codex_thread_cancel.`,
          threadId: id,
          delivery: 'none',
          taskId: live.taskId,
          fromOffset,
        }
      }

      if (mode !== 'queue') {
        const turn = startTurn(id, message, cwd, selection)
        const verdict = await Promise.race([
          turn.started,
          new Promise((resolve) => setTimeout(() => resolve('pending'), PROBE_MS)),
        ])
        if (verdict === 'started' || verdict === 'pending') {
          return {
            text: [
              `Sent to Codex thread ${id} as an owned turn (taskId ${turn.taskId}).`,
              `  cwd:    ${cwd ?? '(Codex default)'}`,
              `  model:  ${describeSelection(selection)}${selection.model || selection.profile || selection.config ? '' : ` (session recorded ${info.context.model ?? 'unknown'})`}`,
              `  state:  ${verdict === 'pending' ? 'running (no terminal event yet)' : 'running'}`,
              `  offset: ${fromOffset}`,
              '',
              'Codex is working now. Do your own share first — read the code it will touch, run the',
              'build/tests for a baseline, draft fixtures or tests, or split what is left. Collect with',
              `codex_thread_wait { thread: "${id}", fromOffset: ${fromOffset} } only when you need these`,
              'results, and use codex_thread_review for an independent review before delivering.',
            ].join('\n'),
            threadId: id,
            delivery: 'turn',
            model: selection.model,
            taskId: turn.taskId,
            fromOffset,
          }
        }
        if (verdict === 'writer-conflict' && mode === 'auto') {
          turns.delete(turn.taskId)
          const queued = await queueMessage(id, message)
          return {
            text: [
              `Codex already owns thread ${id} (another Codex process holds its writer lock), so the instruction was queued instead:`,
              `  queueId: ${queued.queueId ?? '(unreported)'}`,
              `  offset:  ${fromOffset}`,
              hasSelection ? `  model:   NOT applied (${describeSelection(selection)}) — a queued message always runs what the session already uses.` : '',
              '',
              'The Codex app runs it as its next turn on its own schedule — nothing here can start it.',
              'Do your own share meanwhile; check back with',
              `codex_thread_wait { thread: "${id}", fromOffset: ${fromOffset} } when you need the result,`,
              'and do not poll in a loop.',
            ].filter((line) => line !== '').join('\n'),
            threadId: id,
            delivery: 'queued',
            modelApplied: false,
            fromOffset,
          }
        }
        turns.delete(turn.taskId)
        throw new Error(
          `codex-thread: the Codex turn did not start: ${turn.settled ?? turn.detail ?? 'unknown failure'}\n` +
            `This usually means the Codex app holds the session's writer lock. Retry with mode "auto" or "queue".`,
        )
      }

      const queued = await queueMessage(id, message)
      return {
        text: [
          `Queued the instruction in Codex thread ${id}.`,
          `  queueId: ${queued.queueId ?? '(unreported)'}`,
          `  offset:  ${fromOffset}`,
          ...(hasSelection ? [`  model:   not applied (${describeSelection(selection)}) — a queued message always runs what the session already uses.`] : []),
          '',
          'The Codex app runs queued messages on its own schedule; nothing runs until a Codex process resumes this thread.',
          'Do your own share meanwhile, then use',
          `codex_thread_wait { thread: "${id}", fromOffset: ${fromOffset} } once you need the result.`,
        ].join('\n'),
        threadId: id,
        delivery: 'queued',
        modelApplied: false,
        fromOffset,
      }
    },
  }
}

function waitTool() {
  return {
    name: 'codex_thread_wait',
    description:
      'Wait for a Codex session to advance, then return what appeared after `fromOffset`. Returns early by default: use it to check on progress between other work, not as one long block. Prefer sending an instruction, doing your own work, then waiting here — a single long wait leaves you idle while Codex works.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id, codex://threads/<id> link, or rollout path.' },
        fromOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Byte offset returned by codex_thread_read or codex_thread_send; omit to wait only for the next turn boundary.',
        },
        until: {
          type: 'string',
          enum: ['activity', 'message', 'turn-complete'],
          description: 'When to return: any new record (default), the first user/assistant message, or the whole turn finishing. Only turn-complete waits for the end.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: 'Total wait, capped at 120s; defaults to 12000. Waiting longer than that is almost always better expressed as other work followed by another call.',
        },
        settleMs: { type: 'integer', minimum: 0, maximum: 600000, description: 'Idle time after new activity before returning in turn-complete mode; defaults to 0.' },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    timeoutMs: 180000,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { id, rollout } = await requireThread(args?.thread)
      const until = args?.until === 'message' || args?.until === 'turn-complete' ? args.until : 'activity'
      const total = Math.min(Math.max(Number(args?.timeoutMs ?? 12000) || 12000, 1000), 120000)
      const settle = Math.min(Math.max(Number(args?.settleMs ?? 0) || 0, 0), 600000)
      const from = Number.isInteger(args?.fromOffset) && args.fromOffset >= 0 ? args.fromOffset : undefined
      const start = Date.now()
      let offset = from
      let activityAt
      let state = 'idle'
      let lossy = false
      let cancelled = false

      for (;;) {
        if (exec?.signal?.aborted) {
          cancelled = true
          break
        }
        const info = await inspectThread(id, rollout)
        state = info.state.state
        if (offset === undefined) offset = info.size
        const grew = info.size > offset
        if (grew) activityAt = activityAt ?? Date.now()

        if (grew && until === 'activity') break
        if (grew && until === 'message') {
          const peek = await readBytes(rollout, offset, MAX_SEGMENT_BYTES)
          if (parseRollout(peek.text).some((record) => record.kind === 'user' || record.kind === 'assistant')) break
        }
        if (until === 'turn-complete' && grew && state === 'idle' && Date.now() - (activityAt ?? Date.now()) >= settle) break

        if (Date.now() - start >= total) break
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }

      const info = await inspectThread(id, rollout)
      const segment = await readBytes(rollout, offset, MAX_SEGMENT_BYTES)
      lossy = segment.truncatedTail || (segment.text.length === 0 && info.size > offset)
      const records = parseRollout(segment.text)
      const messages = records.filter((record) => record.kind === 'user' || record.kind === 'assistant')
      const tools = records.filter((record) => record.kind === 'tool').map((record) => record.name)
      const turn = turnOf(id)
      const elapsed = Date.now() - start
      const idle = info.state.state === 'idle'
      const reason = cancelled
        ? 'cancelled by the caller'
        : idle
          ? 'turn finished'
          : until === 'turn-complete'
            ? 'still working'
            : messages.length > 0
              ? 'returned on new activity'
              : 'timed out'
      const header = [
        `Thread ${id}: ${info.state.state}${info.state.at ? ` (last turn boundary ${clockOf(info.state.at)})` : ''}`,
        `  waited:  ${elapsed} ms — ${reason}`,
        `  from:    ${offset} → ${segment.end} of ${info.size} bytes${lossy ? ' (truncated)' : ''}`,
      ]
      if (turn) header.push(`  task:    ${turn.taskId}${idle ? ' (turn finished)' : ` ${turn.status}`}`)
      const body = messages.length === 0
        ? ['', 'No new user or assistant messages in that range.']
        : ['', `New messages (${messages.length}):`, ...messages.map((message, index) =>
          `${index + 1}. [${message.kind === 'user' ? 'user' : 'codex'} ${clockOf(message.at)}] ${clip(message.text, 4000)}`)]
      const activity = tools.length === 0 ? [] : ['', `Tool calls: ${tools.join(', ')}`]
      // Say what to do next, so a short wait does not turn into another immediate wait.
      const next = idle
        ? `Done. nextOffset is ${segment.end}; the next turn starts a new range.`
        : `Still working. Do other work now, then call codex_thread_wait again with fromOffset ${segment.end}${until === 'turn-complete' ? '' : ', or use until:"turn-complete" if nothing else is pending'}.`
      return {
        text: [...header, ...body, ...activity, '', next].join('\n'),
        threadId: id,
        state: info.state.state,
        idle,
        cancelled,
        until,
        reason,
        elapsedMs: elapsed,
        nextOffset: segment.end,
        lossy,
        messages: messages.map((message) => ({ role: message.kind, at: message.at, text: message.text })),
      }
    },
  }
}

/**
 * Hand finished work back to Codex for an independent review. It is a `codex_thread_send`
 * with a review brief: the point is that the caller keeps working while Codex reads.
 */
function reviewTool() {
  return {
    name: 'codex_thread_review',
    description:
      'Send finished work back to a Codex session for an independent review. Returns immediately: keep working while Codex reads the result, then collect it with codex_thread_wait. Falls back to the Codex queue when the Codex app holds the session\'s writer lock. Use this before delivering anything Codex helped produce.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id, codex://threads/<id> link, or rollout path.' },
        summary: { type: 'string', description: 'What was done and what should be reviewed, in a few lines.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories in scope.' },
        focus: {
          type: 'string',
          enum: ['correctness', 'maintainability', 'risk', 'tests', 'all'],
          description: 'Review focus; defaults to all.',
        },
        evidence: { type: 'string', description: 'Verification you already ran (build, tests, lint) and its outcome.' },
        cwd: { type: 'string', description: 'Directory to review from; defaults to the directory recorded in the session.' },
      },
      required: ['thread', 'summary'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const { id, rollout } = await requireThread(args?.thread)
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (!summary) throw new Error('codex-thread: summary must not be empty.')
      const focus = ['correctness', 'maintainability', 'risk', 'tests', 'all'].includes(args?.focus) ? args.focus : 'all'
      const paths = Array.isArray(args?.paths)
        ? args.paths.filter((path) => typeof path === 'string' && path.trim()).map((path) => path.trim())
        : []
      const evidence = typeof args?.evidence === 'string' && args.evidence.trim() ? args.evidence.trim() : ''
      const info = await inspectThread(id, rollout)
      const fromOffset = info.size
      const cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : info.context.cwd

      const live = turnOf(id)
      if (live) {
        return {
          text: `Thread ${id} already has a turn started by this DSH process (${live.taskId}, ${live.status}). Cancel it or wait for it before starting a review.`,
          threadId: id,
          delivery: 'none',
          taskId: live.taskId,
          fromOffset,
        }
      }

      const message = [
        'Review this work as a reviewer, not as an implementer. Do not modify files.',
        '',
        `What changed: ${summary}`,
        paths.length > 0 ? `\nFiles in scope:\n${paths.map((path) => `- ${path}`).join('\n')}` : '',
        evidence ? `\nVerification already run: ${evidence}` : '\nVerification already run: nothing reported — say so if that blocks the review.',
        `\nFocus: ${focus}.`,
        '',
        'For every finding give: severity (high/medium/low), location (file:line), the concrete problem, and the smallest fix.',
        'If an area is correct, say so in one line instead of padding. End with a verdict: ship / fix-then-ship / rework.',
      ].filter(Boolean).join('\n')

      const turn = startTurn(id, message, cwd, {})
      const started = await Promise.race([
        turn.started,
        new Promise((resolve) => setTimeout(() => resolve('pending'), PROBE_MS)),
      ])
      if (started === 'started' || started === 'pending') {
        return {
          text: [
            `Review started on Codex thread ${id} (taskId ${turn.taskId}).`,
            `  cwd:    ${cwd ?? '(Codex default)'}`,
            `  focus:  ${focus}`,
            `  offset: ${fromOffset}`,
            '',
            'Keep working — do not wait here. When the review is ready, collect it with',
            `codex_thread_wait { thread: "${id}", fromOffset: ${fromOffset} }.`,
          ].join('\n'),
          threadId: id,
          delivery: 'turn',
          taskId: turn.taskId,
          focus,
          fromOffset,
        }
      }
      // The Codex app holds the writer lock on an open session, so the review is queued
      // instead of failing: a review that cannot start is worse than a late one.
      if (started === 'writer-conflict') {
        turns.delete(turn.taskId)
        const queued = await queueMessage(id, message)
        return {
          text: [
            `Codex owns thread ${id} (the app holds its writer lock), so the review was queued:`,
            `  queueId: ${queued.queueId ?? '(unreported)'}`,
            `  focus:   ${focus}`,
            `  offset:  ${fromOffset}`,
            '',
            'The Codex app runs it as its next turn. Collect it with',
            `codex_thread_wait { thread: "${id}", fromOffset: ${fromOffset} }.`,
          ].join('\n'),
          threadId: id,
          delivery: 'queued',
          queueId: queued.queueId,
          focus,
          fromOffset,
        }
      }
      turns.delete(turn.taskId)
      throw new Error(`codex-thread: the review turn did not start: ${turn.settled ?? turn.detail ?? 'unknown failure'}`)
    },
  }
}

function cancelTool() {
  return {
    name: 'codex_thread_cancel',
    description:
      'Cancel a Codex turn that this DSH process started. A turn owned by the Codex app cannot be cancelled from here; interrupt it in Codex.',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread id, codex://threads/<id> link, or rollout path.' },
        taskId: { type: 'string', description: 'Task id returned by codex_thread_send; defaults to the turn this process owns for the thread.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      let turn
      if (typeof args?.taskId === 'string' && args.taskId) turn = turns.get(args.taskId)
      else if (args?.thread) {
        const id = threadIdOf(args.thread)
        turn = id ? turnOf(id) : undefined
      }
      if (!turn) {
        return {
          text: 'No Codex turn started by this DSH process is running for that target. Turns run by the Codex app are interrupted from Codex itself.',
          cancelled: false,
        }
      }
      turn.status = 'killed'
      kill(turn.child)
      turns.delete(turn.taskId)
      return {
        text: `Cancelled Codex turn ${turn.taskId} (thread ${turn.id}) started by this DSH process.`,
        cancelled: true,
        taskId: turn.taskId,
        threadId: turn.id,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const definitions = [
    newTool(ctx),
    listTool(),
    readTool(),
    sendTool(),
    reviewTool(),
    waitTool(),
    cancelTool(),
  ]
  const disposers = definitions.map((definition) => ctx.effect(() => ctx.tools.register({
    ...definition,
    execute: async (args, exec) => sanitize(await definition.execute(args, exec)),
  })))

  ctx.effect(() => () => {
    for (const turn of [...turns.values()]) kill(turn.child)
    turns.clear()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'codex-thread',
      order: 96,
      text: [
        '## Codex sessions',
        'The user may paste a `codex://threads/<uuid>` link, name a Codex session, or point at a rollout file. Call `codex_thread_read` with that value before answering about it; it returns the session directory, the model, whether Codex is running the session now, and recent messages. `codex_thread_new` opens a session that does not exist yet.',
        '',
        '### Run Codex work in parallel, never idle',
        '`codex_thread_send` never blocks: it returns while Codex is still working. Treat it as handing work to a colleague, not as a request you must sit through.',
        '1. Split first. Decide what Codex owns (the part that needs its context, model, or tools) and what you can do yourself: read code, run the project\'s build/tests/lint to get a baseline, write fixtures, skeletons, or tests, and gather the facts Codex will need.',
        '2. Do your share immediately after sending. Two things can then happen at once. Keep a short list of what you finished.',
        '3. Collect only when you need it: `codex_thread_wait` with the returned `fromOffset`, and only when nothing else can proceed. Never wait in a loop, and never pass a long timeout as a way to avoid thinking about what else to do.',
        '4. Review before delivering. `codex_thread_review` sends the merged result back to Codex for an independent review while you keep working.',
        'Waiting with nothing to do is the failure mode this plugin exists to avoid: one long `codex_thread_wait` occupies a whole model step and produces nothing.',
      ].join('\n'),
    }))
  }
}
