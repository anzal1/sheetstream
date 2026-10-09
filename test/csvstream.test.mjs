import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { writeCsv, csvStream } from '../index.js'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('csvstream')

async function collect(stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

/** csvStream and writeCsv must produce the same bytes for the same rows and options. */
async function same(name, makeRows, options) {
  const file = tmp(`${name}.csv`)
  await writeCsv(file, makeRows(), options)
  const expected = fs.readFileSync(file)
  const got = await collect(csvStream(makeRows(), options))
  assert.equal(got.length, expected.length, `${name}: length`)
  assert.ok(got.equals(expected), `${name}: bytes differ`)
  return got
}

const NASTY = [
  'plain',
  'with, comma',
  'with "quotes" inside',
  '"starts and ends with quotes"',
  'line one\nline two',
  'windows\r\nnewline',
  'carriage\rreturn',
  'tab\tseparated',
  '  padded  ',
  'héllo wörld',
  '日本語のテキスト',
  '😀 emoji 🚀 and 👨‍👩‍👧 family',
  'العربية',
  "it's; semi; colons",
  ',',
  '"',
  '""',
  '',
  'a'.repeat(5000),
]

test('byte-identical to writeCsv: array rows', async () => {
  await same('arrays', () => [[1, 'a', true], [2, 'b', false], [3, null, undefined]])
})

test('byte-identical to writeCsv: object rows, inferred and explicit columns', async () => {
  const objs = () => Array.from({ length: 50 }, (_, i) => ({ id: i, name: `n${i}`, extra: i % 2 ? 'x' : null }))
  await same('objects', objs)
  await same('objects-cols', objs, { columns: ['name', 'id'] })
  await same('objects-cols-headers', objs, {
    columns: [{ key: 'id', header: 'ID' }, { key: 'name', header: 'Full name' }],
  })
  await same('arrays-with-header', () => [[1, 2], [3, 4]], { columns: ['a', 'b'], header: true })
  await same('objects-no-header', objs, { header: false })
})

test('byte-identical to writeCsv: custom delimiter, quote and BOM', async () => {
  const rows = () => NASTY.map((s, i) => ({ id: i, text: s, n: i / 7 }))
  await same('semicolon', rows, { delimiter: ';' })
  await same('tab', rows, { delimiter: '\t' })
  await same('quote', rows, { quote: "'" })
  await same('both', rows, { delimiter: '|', quote: '`', bom: true })
  const withBom = await same('bom', rows, { bom: true })
  assert.deepEqual([...withBom.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

test('byte-identical to writeCsv: values needing quoting, unicode and every cell type', async () => {
  const d = new Date(Date.UTC(2024, 1, 29, 13, 45, 30, 250))
  const day = new Date(Date.UTC(2024, 1, 29))
  await same('nasty', () => NASTY.map((s, i) => ({ id: String(i), text: s })))
  await same('types', () => [
    [1, -2.5, 1e21, 1e-7, 0.1 + 0.2, 5e-324, true, false, d, day, 12345678901234567890n, null, undefined, NaN, Infinity, -Infinity, new Date(NaN)],
  ])
})

test('byte-identical to writeCsv across batch sizes and the batch boundary', async () => {
  const rows = () => Array.from({ length: 2503 }, (_, i) => ({ i, s: `row, ${i}` }))
  for (const batchSize of [1, 7, 1000, 2503, 5000]) await same(`batch-${batchSize}`, rows, { batchSize })
})

test('empty input matches writeCsv: nothing, header only, BOM only', async () => {
  await same('empty', () => [])
  await same('empty-cols', () => [], { columns: ['a', 'b'] })
  await same('empty-bom', () => [], { bom: true })
  await same('empty-cols-bom', () => [], { columns: ['a', 'b'], bom: true })
  await same('empty-no-header', () => [], { columns: ['a', 'b'], header: false })
})

test('async iterables, sync generators and Node Readable sources all work', async () => {
  const data = Array.from({ length: 3000 }, (_, i) => ({ id: i, v: `v${i}` }))
  const file = tmp('sources.csv')
  await writeCsv(file, data)
  const expected = fs.readFileSync(file)

  async function* asyncGen() {
    for (const r of data) {
      yield r
      if (r.id % 500 === 0) await new Promise((r) => setImmediate(r))
    }
  }
  function* syncGen() {
    yield* data
  }
  assert.ok((await collect(csvStream(asyncGen()))).equals(expected), 'async generator')
  assert.ok((await collect(csvStream(syncGen()))).equals(expected), 'sync generator')
  assert.ok((await collect(csvStream(data))).equals(expected), 'array')
  assert.ok((await collect(csvStream(Readable.from(data)))).equals(expected), 'objectMode Readable')
  assert.ok((await collect(csvStream(new Set(data)))).equals(expected), 'Set')
})

test('Readable.toWeb gives a working web ReadableStream', async () => {
  const data = Array.from({ length: 2000 }, (_, i) => [i, `v${i}`])
  const file = tmp('web.csv')
  await writeCsv(file, data)
  const res = new Response(Readable.toWeb(csvStream(data)))
  const body = Buffer.from(await res.arrayBuffer())
  assert.ok(body.equals(fs.readFileSync(file)))
})

test('invalid arguments throw synchronously', () => {
  assert.throws(() => csvStream(42), TypeError)
  assert.throws(() => csvStream(null), TypeError)
  assert.throws(() => csvStream([], { batchSize: 0 }), TypeError)
  assert.throws(() => csvStream([], { delimiter: ';;' }), TypeError)
  assert.throws(() => csvStream([], { quote: 'é' }), TypeError)
  assert.throws(() => csvStream([], { bom: 'yes' }), TypeError)
  assert.throws(() => csvStream([], { columns: 'a' }), TypeError)
  assert.throws(() => csvStream([], { highWaterMark: 0 }), TypeError)
})

test('a stream nobody reads never touches the source', async () => {
  let started = false
  function* gen() {
    started = true
    yield [1]
  }
  const s = csvStream(gen())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(started, false)
  s.destroy()
  await once(s, 'close')
  assert.equal(started, false)
})

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

test('backpressure: the source never runs far ahead of a slow consumer', async () => {
  const TOTAL = 1_000_000
  const BATCH = 1000
  const HWM = 16 * 1024
  let produced = 0
  function* gen() {
    for (let i = 0; i < TOTAL; i++) {
      produced++
      yield [i, 'x']
    }
  }
  let writtenRows = 0
  let writes = 0
  let maxAhead = 0
  let maxAheadAtSlow = 0
  const SLOW_WRITES = 40
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, _enc, cb) {
      writes++
      // Row bytes are a fixed, small ASCII text with exactly one newline each.
      const ahead = produced - writtenRows
      maxAhead = Math.max(maxAhead, ahead)
      if (writes <= SLOW_WRITES) maxAheadAtSlow = Math.max(maxAheadAtSlow, ahead)
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) writtenRows++
      if (writes <= SLOW_WRITES) setTimeout(cb, 5)
      else cb()
    },
  })
  await pipeline(csvStream(gen(), { batchSize: BATCH, highWaterMark: HWM }), sink)
  assert.equal(produced, TOTAL)
  assert.equal(writtenRows, TOTAL)
  // Row text is 'N,x\n' (4 to 9 bytes). The stream may hold HWM bytes, plus one in-flight chunk on the
  // writable side and the batch being encoded: a few thousand rows, not the 1M that were available.
  const bound = Math.ceil(HWM / 4) + 4 * BATCH
  assert.ok(maxAhead <= bound, `source ran ${maxAhead} rows ahead (bound ${bound})`)
  assert.ok(maxAheadAtSlow <= bound, `source ran ${maxAheadAtSlow} rows ahead while the consumer was slow (bound ${bound})`)
  console.log(`  max rows produced but not yet written: ${maxAhead} (bound ${bound})`)
})

test('backpressure: a consumer that stops reading stops the source', async () => {
  let produced = 0
  function* gen() {
    for (let i = 0; i < 10_000_000; i++) {
      produced++
      yield [i, 'payload payload payload']
    }
  }
  const s = csvStream(gen(), { batchSize: 100, highWaterMark: 8192 })
  s.once('readable', () => {}) // arm reading without consuming
  await new Promise((r) => setTimeout(r, 200))
  const frozen = produced
  assert.ok(frozen > 0, 'the source should have started')
  assert.ok(frozen < 5000, `source ran ${frozen} rows with nobody reading`)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(produced, frozen, 'the source kept going with a full buffer')
  // Reading resumes it.
  s.read()
  s.read()
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(produced > frozen)
  s.destroy()
  await once(s, 'close')
})

test('backpressure with an async source: pulls follow reads', async () => {
  let produced = 0
  async function* gen() {
    for (let i = 0; i < 200_000; i++) {
      produced++
      yield { i, s: 'abc' }
    }
  }
  let writtenRows = 0
  let maxAhead = 0
  const sink = new Writable({
    highWaterMark: 512,
    write(chunk, _enc, cb) {
      maxAhead = Math.max(maxAhead, produced - writtenRows)
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) writtenRows++
      setImmediate(cb)
    },
  })
  await pipeline(csvStream(gen(), { batchSize: 500, highWaterMark: 8192 }), sink)
  assert.equal(writtenRows, 200_001) // plus the header
  assert.ok(maxAhead < 10_000, `source ran ${maxAhead} rows ahead`)
})

test('a sync source does not starve the event loop', async () => {
  function* gen() {
    for (let i = 0; i < 1_000_000; i++) yield [i, 'some text', i / 3]
  }
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  let bytes = 0
  await pipeline(
    csvStream(gen()),
    new Writable({
      write(c, _e, cb) {
        bytes += c.length
        cb()
      },
    }),
  )
  clearInterval(timer)
  assert.ok(bytes > 10_000_000)
  assert.ok(ticks > 0, 'timers never ran during the stream')
})

// ---------------------------------------------------------------------------
// Early destroy, errors, abort
// ---------------------------------------------------------------------------

test('destroying the stream early stops an async generator and runs its finally block', async () => {
  let produced = 0
  let finallyRan = false
  async function* gen() {
    try {
      for (let i = 0; ; i++) {
        produced++
        yield [i]
      }
    } finally {
      finallyRan = true
    }
  }
  const s = csvStream(gen(), { batchSize: 10, highWaterMark: 256 })
  const first = await new Promise((resolve) => s.once('data', resolve))
  assert.ok(first.length > 0)
  s.destroy()
  await once(s, 'close')
  assert.equal(finallyRan, true)
  const at = produced
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(produced, at, 'the generator kept running after destroy')
})

test('destroying the stream early stops a sync generator and runs its finally block', async () => {
  let finallyRan = false
  let produced = 0
  function* gen() {
    try {
      for (let i = 0; ; i++) {
        produced++
        yield [i]
      }
    } finally {
      finallyRan = true
    }
  }
  const s = csvStream(gen(), { batchSize: 10, highWaterMark: 256 })
  await new Promise((resolve) => s.once('data', resolve))
  s.destroy()
  await once(s, 'close')
  assert.equal(finallyRan, true)
  const at = produced
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(produced, at)
})

test('a consumer that breaks out of for-await closes the source', async () => {
  let finallyRan = false
  async function* gen() {
    try {
      for (let i = 0; ; i++) yield [i, 'row']
    } finally {
      finallyRan = true
    }
  }
  for await (const chunk of csvStream(gen(), { batchSize: 50 })) {
    assert.ok(chunk.length > 0)
    break
  }
  await new Promise((r) => setImmediate(r))
  assert.equal(finallyRan, true)
})

test('destroying with a Node Readable source destroys the source too', async () => {
  const src = Readable.from((function* () { for (let i = 0; ; i++) yield [i] })())
  const s = csvStream(src, { batchSize: 10 })
  await new Promise((resolve) => s.once('data', resolve))
  s.destroy()
  await once(s, 'close')
  assert.equal(src.destroyed, true)
})

test('destroy while the source is awaiting does not hang and still closes the source', async () => {
  let finallyRan = false
  let release
  const gate = new Promise((r) => (release = r))
  async function* gen() {
    try {
      yield [1]
      await gate // stalled source
      yield [2]
    } finally {
      finallyRan = true
    }
  }
  const s = csvStream(gen(), { batchSize: 1 })
  await new Promise((r) => setTimeout(r, 20)) // arm
  s.resume()
  await new Promise((r) => setTimeout(r, 20))
  s.destroy()
  await once(s, 'close') // must not wait for the gate
  release()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(finallyRan, true)
})

test('an error thrown by an async source destroys the stream with that error', async () => {
  let finallyRan = false
  async function* gen() {
    try {
      for (let i = 0; i < 5000; i++) yield [i]
      throw new Error('source blew up')
    } finally {
      finallyRan = true
    }
  }
  const s = csvStream(gen(), { batchSize: 100 })
  await assert.rejects(collect(s), { message: 'source blew up' })
  assert.equal(s.destroyed, true)
  assert.equal(finallyRan, true)
})

test('an error thrown by a sync source destroys the stream with that error', async () => {
  function* gen() {
    yield [1]
    yield [2]
    throw new RangeError('sync source blew up')
  }
  await assert.rejects(collect(csvStream(gen())), { name: 'RangeError', message: 'sync source blew up' })
})

test('a source that errors before the first row still errors the stream', async () => {
  async function* gen() {
    throw new Error('immediate')
  }
  await assert.rejects(collect(csvStream(gen())), { message: 'immediate' })
})

test('a failing Node Readable source propagates its error', async () => {
  const src = new Readable({
    objectMode: true,
    read() {
      this.push([1])
      this.destroy(new Error('readable failed'))
    },
  })
  await assert.rejects(collect(csvStream(src)), { message: 'readable failed' })
})

test('a bad row (mixed arrays and objects, unsupported value) errors the stream and closes the source', async () => {
  let finallyRan = false
  function* gen() {
    try {
      yield [1, 2]
      yield { a: 1 }
    } finally {
      finallyRan = true
    }
  }
  await assert.rejects(collect(csvStream(gen())), /mixes arrays and objects/)
  assert.equal(finallyRan, true)
  await assert.rejects(collect(csvStream([[1, Symbol('x')]])), /unsupported/)
})

test('abort via signal ends the stream with the abort reason and closes the source', async () => {
  const ac = new AbortController()
  let finallyRan = false
  async function* gen() {
    try {
      for (let i = 0; ; i++) {
        yield [i]
        if (i === 2500) ac.abort()
      }
    } finally {
      finallyRan = true
    }
  }
  const s = csvStream(gen(), { batchSize: 100, signal: ac.signal })
  await assert.rejects(collect(s), (err) => err.name === 'AbortError')
  assert.equal(finallyRan, true)
})

test('abort with a custom reason, and an already aborted signal', async () => {
  const ac = new AbortController()
  const reason = new Error('custom reason')
  ac.abort(reason)
  let started = false
  function* gen() {
    started = true
    yield [1]
  }
  await assert.rejects(collect(csvStream(gen(), { signal: ac.signal })), (err) => err === reason)
  assert.equal(started, false)
})

test('abort while the source is stalled ends the stream immediately', async () => {
  const ac = new AbortController()
  async function* gen() {
    yield [1]
    await new Promise(() => {}) // never resolves
  }
  const s = csvStream(gen(), { batchSize: 1, signal: ac.signal })
  const done = collect(s)
  setTimeout(() => ac.abort(new Error('stop')), 30)
  await assert.rejects(done, { message: 'stop' })
})

test('piping a finished stream through pipeline to a file matches writeCsv', async () => {
  const rows = () => Array.from({ length: 5000 }, (_, i) => ({ i, t: `t,${i}` }))
  const a = tmp('pipe-a.csv')
  const b = tmp('pipe-b.csv')
  await writeCsv(a, rows())
  await pipeline(csvStream(rows()), fs.createWriteStream(b))
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)))
})
