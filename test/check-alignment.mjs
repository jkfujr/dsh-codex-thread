// Check the byte-offset alignment contract: an offset returned by wait must sit on a line
// boundary, and reading from it must start at a complete record (not a fragment).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply } from '../index.js'

const tools = {}
apply({
  tools: { register: (d) => { tools[d.name] = d; return () => {} } },
  effect: (f) => { f(); return () => {} },
  get: () => undefined,
})

const threadId = process.argv[2] || '01a18b99-b485-7872-b6c4-56393de401d8'
const exec = { signal: new AbortController().signal, callId: 'align', name: 'align', arguments: {} }

const first = await tools.codex_thread_wait.execute({ thread: threadId, fromOffset: 0, timeoutMs: 1200 }, exec)
console.log(`first pass: ${first.text.split('\n')[2]}`)
console.log(`nextOffset = ${first.nextOffset}`)

const result = await tools.codex_thread_read.execute({ thread: threadId, messages: 1, textLimit: 40 }, exec)
const rolloutLine = String(result.text).split('\n').find((l) => l.includes('rollout:'))
const path = rolloutLine.split('rollout:')[1].trim()

let buffer
const windowStart = Math.max(0, first.nextOffset - 1)
const windowBytes = 64 * 1024
if (path.endsWith('.zst')) {
  const { zstdDecompressSync } = await import('node:zlib')
  buffer = zstdDecompressSync(readFileSync(path)).subarray(windowStart, windowStart + windowBytes)
} else {
  // Rollouts can exceed 2 GiB, so read only the window around the offset.
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    buffer = Buffer.alloc(windowBytes)
    const { bytesRead } = await handle.read(buffer, 0, windowBytes, windowStart)
    buffer = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
const shift = first.nextOffset - windowStart

const byteBefore = buffer[shift - 1]
const byteAt = buffer[shift]
console.log(`byte before nextOffset = ${byteBefore} (10 = newline), byte at = ${byteAt}`)
console.log('nextOffset 落在行首:', byteBefore === 0x0a)

const nextNewline = buffer.indexOf(0x0a, shift)
const line = buffer.subarray(shift, nextNewline < 0 ? buffer.length : nextNewline).toString('utf8')
let parses = false
try { JSON.parse(line); parses = true } catch {}
console.log(`nextOffset 起的第一行是完整 JSON: ${parses}${parses ? '' : ' :: ' + line.slice(0, 120)}`)
