// Self-check for the bundle without installing it: imports index.js, builds a minimal
// Cordis-like context, registers the tools, and exercises the read path against whatever
// Codex sessions exist on this machine.
//
//   node test/harness.mjs                    # read-only checks
//   HARNESS_NEW_SESSION=1 node test/harness.mjs   # also spends one real Codex turn
//   node test/harness.mjs <thread-id>        # check one specific session
import { apply } from '../index.js'

const registered = new Map()

const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  effect(fn) {
    fn()
    return () => {}
  },
  get() {
    return undefined
  },
}

apply(ctx)

console.log(`registered: ${[...registered.keys()].join(', ')}\n`)

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  const shown = detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`
  console.log(`  FAIL ${label}${shown}`)
  failures.push(label)
}

for (const definition of registered.values()) {
  check(`${definition.name} schema`, definition.parameters?.type === 'object')
  check(`${definition.name} output render`, typeof definition.output?.render === 'function')
  check(`${definition.name} execute`, typeof definition.execute === 'function')
}

const exec = { signal: new AbortController().signal, callId: 'harness', name: 'harness', arguments: {} }

// --- codex_thread_list -----------------------------------------------------
console.log('\n== codex_thread_list ==')
const list = registered.get('codex_thread_list')
const listed = await list.execute({ limit: 5 }, exec)
console.log(listed.text.split('\n').slice(0, 8).join('\n'))
check('list returns one text block', list.output.render({}, listed).length === 1)
check('list returns rows', Array.isArray(listed.threads) && listed.threads.length > 0)

const requested = process.argv[2] || process.env.CODEX_THREAD
const target = requested || listed.threads?.[0]?.id
if (!target) {
  console.log('\nNo Codex session found on this machine; nothing else to check.')
  process.exit(failures.length === 0 ? 0 : 1)
}

// --- codex_thread_read -----------------------------------------------------
console.log(`\n== codex_thread_read (${requested ? 'requested' : 'newest session'}) ==`)
const read = registered.get('codex_thread_read')
const readResult = await read.execute({ thread: target, messages: 4, textLimit: 200 }, exec)
console.log(readResult.text.split('\n').slice(0, 6).join('\n'))
check('read returns a thread id', /^[0-9a-f-]{36}$/.test(readResult.threadId ?? ''), readResult.threadId)
check('read reports a state', readResult.state === 'idle' || readResult.state === 'running', readResult.state)
check('read returns nextOffset', Number.isInteger(readResult.nextOffset))
check('read output is lossless JSON', Object.values(readResult).every((value) => value !== undefined))

const rolloutLine = String(readResult.text).split('\n').find((line) => line.includes('rollout:'))
const rolloutPath = rolloutLine?.split('rollout:')[1]?.trim()
if (rolloutPath) {
  const byPath = await read.execute({ thread: rolloutPath, messages: 1 }, exec)
  check('read accepts a rollout path', byPath.threadId === readResult.threadId, byPath.threadId)
}

// --- rejection paths -------------------------------------------------------
console.log('\n== rejection paths ==')
let rejected = false
try {
  await read.execute({ thread: 'not-a-thread' }, exec)
} catch (error) {
  rejected = /no Codex thread id/.test(error.message)
}
check('read rejects a value with no thread id', rejected)

let missing = false
try {
  await read.execute({ thread: '00000000-0000-0000-0000-000000000000' }, exec)
} catch (error) {
  missing = /no recorded rollout/.test(error.message)
}
check('read rejects an unknown thread', missing)

let emptyMessage = false
try {
  await registered.get('codex_thread_send').execute({ thread: target, message: '   ' }, exec)
} catch (error) {
  emptyMessage = /must not be empty/.test(error.message)
}
check('send rejects an empty message', emptyMessage)

const cancelIdle = await registered.get('codex_thread_cancel').execute({ thread: target }, exec)
check('cancel without an owned turn is a no-op', cancelIdle.cancelled === false)

// --- codex_thread_wait with no new activity --------------------------------
console.log('\n== codex_thread_wait (2s) ==')
const waited = await registered.get('codex_thread_wait').execute({ thread: target, timeoutMs: 2000 }, exec)
console.log(waited.text.split('\n').slice(0, 3).join('\n'))
check('wait returns a state and an offset', typeof waited.state === 'string' && Number.isInteger(waited.nextOffset))

// --- codex_thread_new: opens a real session, then keeps using it -----------
if (process.env.HARNESS_NEW_SESSION === '1') {
  console.log('\n== codex_thread_new (real Codex turn) ==')
  const created = await registered.get('codex_thread_new').execute({
    prompt: '只回复一行纯文本：DSH-NEW-SESSION-OK 。不要修改任何文件，不要运行任何命令。',
    cwd: process.cwd(),
  }, exec)
  console.log(created.text.split('\n').slice(0, 4).join('\n'))
  check('new returns a Codex thread id', /^[0-9a-f-]{36}$/.test(created.threadId ?? ''), created.threadId)
  console.log(`NEW_THREAD=${created.threadId}`)

  const createdWait = await registered.get('codex_thread_wait').execute({ thread: created.threadId, fromOffset: 0, timeoutMs: 180000 }, exec)
  check('new session becomes readable', Array.isArray(createdWait.messages) && createdWait.messages.length > 0)
  check('new session answers', createdWait.messages.some((message) => message.role === 'assistant' && message.text.includes('DSH-NEW-SESSION-OK')))
} else {
  console.log('\n== codex_thread_new skipped (HARNESS_NEW_SESSION=1 to spend one real Codex turn) ==')
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.join(' | ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
