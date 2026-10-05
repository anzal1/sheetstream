'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const native = require('./binding.js')

const DEFAULT_BATCH = 1000
// Long synchronous generators would starve the event loop, so we hand control
// back whenever a slice of work has run for this long.
const SLICE_MS = 12

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

function checkBatchSize(n) {
  if (n === undefined) return DEFAULT_BATCH
  if (!Number.isInteger(n) || n < 1) throw new TypeError('batchSize must be a positive integer')
  return n
}

function checkMode(mode) {
  if (mode === undefined) return 'constant'
  if (mode !== 'constant' && mode !== 'lowMemory') {
    throw new TypeError("mode must be 'constant' or 'lowMemory'")
  }
  return mode
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

class XlsxSheet {
  constructor(native, index) {
    this._native = native
    this._index = index
  }

  /** Write one batch: an array of row arrays or plain objects. */
  writeRows(batch) {
    if (!Array.isArray(batch)) throw new TypeError('writeRows expects an array of rows')
    return this._native.writeRows(this._index, batch)
  }
}

class XlsxWriter {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('path must be a non-empty string')
    this._native = new native.NativeWriter(filePath, checkMode(options.mode))
  }

  addSheet(name = 'Sheet1', options = {}) {
    const columns = options.columns
    if (columns !== undefined && !(Array.isArray(columns) && columns.every((c) => typeof c === 'string'))) {
      throw new TypeError('columns must be an array of strings')
    }
    const index = this._native.addSheet(String(name), columns ?? null, options.header ?? null)
    return new XlsxSheet(this._native, index)
  }

  /** Finish the file. Resolves to { rows, bytes }. */
  close() {
    return this._native.close()
  }

  /** Discard everything written so far without producing a file. */
  abort() {
    this._native.abort()
  }
}

function isAsyncIterable(x) {
  return x != null && typeof x[Symbol.asyncIterator] === 'function'
}
function isIterable(x) {
  return x != null && typeof x[Symbol.iterator] === 'function'
}

async function pump(rows, sheet, batchSize, signal) {
  const batch = []
  let sliceStart = performance.now()
  const flush = async () => {
    sheet.writeRows(batch)
    batch.length = 0
    if (signal && signal.aborted) throw signal.reason ?? new Error('aborted')
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToLoop()
      sliceStart = performance.now()
    }
  }
  if (isAsyncIterable(rows)) {
    for await (const row of rows) {
      batch.push(row)
      if (batch.length >= batchSize) await flush()
    }
  } else if (isIterable(rows)) {
    for (const row of rows) {
      batch.push(row)
      if (batch.length >= batchSize) await flush()
    }
  } else {
    throw new TypeError('rows must be an Iterable or AsyncIterable')
  }
  if (batch.length) await flush()
}

async function writeXlsx(filePath, rows, options = {}) {
  const batchSize = checkBatchSize(options.batchSize)
  const w = new XlsxWriter(filePath, { mode: options.mode })
  try {
    const sheet = w.addSheet(options.sheetName ?? 'Sheet1', { columns: options.columns, header: options.header })
    await pump(rows, sheet, batchSize, options.signal)
  } catch (err) {
    w.abort()
    throw err
  }
  return w.close()
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstream-'))
  return { dir, file: path.join(dir, 'out.xlsx') }
}

const rmDir = (dir) => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})

/**
 * Node Readable of the finished .xlsx. The workbook is written to a temp file
 * first (a zip cannot be streamed out before its central directory exists),
 * then streamed from disk and deleted.
 */
function xlsxStream(rows, options = {}) {
  const out = new PassThrough()
  const { dir, file } = tempFile()
  const ac = new AbortController()
  out.on('close', () => {
    ac.abort()
    rmDir(dir)
  })
  writeXlsx(file, rows, { ...options, signal: ac.signal })
    .then(() => {
      if (out.destroyed) return
      const src = fs.createReadStream(file)
      src.on('error', (err) => out.destroy(err))
      src.pipe(out)
    })
    .catch((err) => out.destroy(err))
  return out
}

/** Resolves to a Buffer of the whole file. This holds the file in memory; use xlsxStream for large outputs. */
async function toBuffer(rows, options = {}) {
  const { dir, file } = tempFile()
  try {
    await writeXlsx(file, rows, options)
    return await fs.promises.readFile(file)
  } finally {
    await rmDir(dir)
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function makeObjectBuilder(names) {
  // One generated literal per sheet keeps V8 on a single hidden class, which
  // is several times faster than assigning keys dynamically.
  const parts = names.map((n, i) => {
    const key = JSON.stringify(n)
    const v = `(r[${i}] === undefined ? null : r[${i}])`
    return n === '__proto__' ? `[${key}]: ${v}` : `${key}: ${v}`
  })
  return new Function('r', `return {${parts.join(',')}}`)
}

function headerNames(row) {
  const seen = new Map()
  return row.map((v, i) => {
    let name = v === null || v === undefined || v === '' ? `column${i + 1}` : String(v)
    const n = seen.get(name) || 0
    seen.set(name, n + 1)
    if (n > 0) name = `${name}_${n + 1}`
    return name
  })
}

class XlsxReadStream {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('path must be a non-empty string')
    const { sheet } = options
    if (sheet !== undefined && typeof sheet !== 'string' && !(Number.isInteger(sheet) && sheet >= 0)) {
      throw new TypeError('sheet must be a name or a zero-based index')
    }
    this._path = filePath
    this._sheet = sheet
    this._batchSize = checkBatchSize(options.batchSize)
    this._header = options.header ?? true
  }

  async *[Symbol.asyncIterator]() {
    const sheet = this._sheet
    const reader = new native.NativeReader(
      this._path,
      typeof sheet === 'number' ? sheet : null,
      typeof sheet === 'string' ? sheet : null,
      this._batchSize,
    )
    let build = null
    try {
      for (;;) {
        let rows = await reader.next()
        if (rows === null) return
        if (this._header) {
          if (build === null) {
            build = makeObjectBuilder(headerNames(rows[0]))
            rows = rows.slice(1)
          }
          const out = new Array(rows.length)
          for (let i = 0; i < rows.length; i++) out[i] = build(rows[i])
          rows = out
        }
        if (rows.length) yield rows
      }
    } finally {
      reader.close()
    }
  }

  /** Reads everything into one array. This holds every row in JS memory, so only use it when the sheet is small. */
  async toArray() {
    const all = []
    for await (const batch of this) for (let i = 0; i < batch.length; i++) all.push(batch[i])
    return all
  }
}

function readXlsx(filePath, options) {
  return new XlsxReadStream(filePath, options)
}

function listSheets(filePath) {
  return native.listSheets(filePath)
}

exports.writeXlsx = writeXlsx
exports.readXlsx = readXlsx
exports.XlsxWriter = XlsxWriter
exports.XlsxSheet = XlsxSheet
exports.XlsxReadStream = XlsxReadStream
exports.listSheets = listSheets
exports.xlsxStream = xlsxStream
exports.toBuffer = toBuffer
