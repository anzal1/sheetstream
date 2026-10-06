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

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

function parseColor(value, name) {
  const m = typeof value === 'string' ? HEX.exec(value) : null
  if (!m) throw new TypeError(`${name} must be a hex color like '#1F4E79'`)
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return parseInt(h, 16)
}

/**
 * Accepts strings or { key, header, width, numFmt } objects and splits them into what the native side wants:
 * keys (object property names), header text, and per-column width and number format.
 */
function normalizeColumns(columns) {
  if (columns === undefined) return { keys: null, headers: undefined, formats: undefined }
  if (!Array.isArray(columns)) throw new TypeError('columns must be an array of strings or { key, header, width, numFmt } objects')
  const keys = []
  const headers = []
  const formats = []
  let anyHeader = false
  let anyFormat = false
  columns.forEach((col, i) => {
    if (typeof col === 'string') {
      keys.push(col)
      headers.push(col)
      formats.push({})
      return
    }
    if (col === null || typeof col !== 'object' || typeof col.key !== 'string') {
      throw new TypeError(`columns[${i}] must be a string or an object with a string 'key'`)
    }
    const { key, header, width, numFmt } = col
    if (header !== undefined && typeof header !== 'string') throw new TypeError(`columns[${i}].header must be a string`)
    if (width !== undefined && !(typeof width === 'number' && width > 0 && width <= 255)) {
      throw new TypeError(`columns[${i}].width must be a number between 0 and 255 (Excel character units)`)
    }
    if (numFmt !== undefined && (typeof numFmt !== 'string' || !numFmt)) {
      throw new TypeError(`columns[${i}].numFmt must be a non-empty string such as '#,##0.00'`)
    }
    keys.push(key)
    headers.push(header ?? key)
    if (header !== undefined) anyHeader = true
    formats.push({ width, numFmt })
    if (width !== undefined || numFmt !== undefined) anyFormat = true
  })
  return { keys, headers: anyHeader ? headers : undefined, formats: anyFormat ? formats : undefined }
}

function normalizeHeaderStyle(style) {
  if (style === undefined || style === null) return {}
  if (typeof style !== 'object' || Array.isArray(style)) throw new TypeError('headerStyle must be an object')
  const { bold, fill, fontColor, border } = style
  for (const [k, v] of [['bold', bold], ['border', border]]) {
    if (v !== undefined && typeof v !== 'boolean') throw new TypeError(`headerStyle.${k} must be a boolean`)
  }
  return {
    headerBold: bold,
    headerFill: fill === undefined ? undefined : parseColor(fill, 'headerStyle.fill'),
    headerFontColor: fontColor === undefined ? undefined : parseColor(fontColor, 'headerStyle.fontColor'),
    headerBorder: border,
  }
}

function checkBool(v, name) {
  if (v !== undefined && typeof v !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return v
}

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
    const { keys, headers, formats } = normalizeColumns(options.columns)
    const native = {
      headers,
      columnFormats: formats,
      ...normalizeHeaderStyle(options.headerStyle),
      freezeHeader: checkBool(options.freezeHeader, 'freezeHeader'),
      autoFilter: checkBool(options.autoFilter, 'autoFilter'),
    }
    const index = this._native.addSheet(String(name), keys, options.header ?? null, native)
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
    const sheet = w.addSheet(options.sheetName ?? 'Sheet1', {
      columns: options.columns,
      header: options.header,
      headerStyle: options.headerStyle,
      freezeHeader: options.freezeHeader,
      autoFilter: options.autoFilter,
    })
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

/** Pulls batches from a native reader; with `header`, turns the first row into keys and yields objects. */
async function* readBatches(open, header) {
  const reader = open()
  let build = null
  try {
    for (;;) {
      let rows = await reader.next()
      if (rows === null) return
      if (header) {
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

class BatchStream {
  /** Reads everything into one array. This holds every row in JS memory, so only use it when the source is small. */
  async toArray() {
    const all = []
    for await (const batch of this) for (let i = 0; i < batch.length; i++) all.push(batch[i])
    return all
  }
}

class XlsxReadStream extends BatchStream {
  constructor(filePath, options = {}) {
    super()
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

  [Symbol.asyncIterator]() {
    const sheet = this._sheet
    return readBatches(
      () =>
        new native.NativeReader(
          this._path,
          typeof sheet === 'number' ? sheet : null,
          typeof sheet === 'string' ? sheet : null,
          this._batchSize,
        ),
      this._header,
    )
  }
}

function readXlsx(filePath, options) {
  return new XlsxReadStream(filePath, options)
}

function listSheets(filePath) {
  return native.listSheets(filePath)
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function checkChar(v, name) {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length !== 1 || v.charCodeAt(0) > 127) {
    throw new TypeError(`${name} must be a single ASCII character`)
  }
  return v
}

/**
 * Streams rows to a CSV file. Same row shapes, `columns` and `header` rules as writeXlsx; per-column
 * width and numFmt and all the formatting options are XLSX-only and ignored here.
 */
async function writeCsv(filePath, rows, options = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('path must be a non-empty string')
  const batchSize = checkBatchSize(options.batchSize)
  const { keys, headers } = normalizeColumns(options.columns)
  const w = new native.NativeCsvWriter(
    filePath,
    checkChar(options.delimiter, 'delimiter'),
    checkChar(options.quote, 'quote'),
    checkBool(options.bom, 'bom'),
    keys,
    headers,
    options.header ?? null,
  )
  try {
    await pump(rows, { writeRows: (batch) => w.writeRows(batch) }, batchSize, options.signal)
  } catch (err) {
    w.abort()
    throw err
  }
  return w.close()
}

class CsvReadStream extends BatchStream {
  constructor(filePath, options = {}) {
    super()
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('path must be a non-empty string')
    this._path = filePath
    this._delimiter = checkChar(options.delimiter, 'delimiter')
    this._quote = checkChar(options.quote, 'quote')
    this._batchSize = checkBatchSize(options.batchSize)
    this._header = options.header ?? true
    this._infer = checkBool(options.inferTypes, 'inferTypes')
  }

  [Symbol.asyncIterator]() {
    return readBatches(
      () => new native.NativeCsvReader(this._path, this._delimiter, this._quote, this._batchSize, this._infer),
      this._header,
    )
  }
}

function readCsv(filePath, options) {
  return new CsvReadStream(filePath, options)
}

exports.writeCsv = writeCsv
exports.readCsv = readCsv
exports.CsvReadStream = CsvReadStream
exports.writeXlsx = writeXlsx
exports.readXlsx = readXlsx
exports.XlsxWriter = XlsxWriter
exports.XlsxSheet = XlsxSheet
exports.XlsxReadStream = XlsxReadStream
exports.listSheets = listSheets
exports.xlsxStream = xlsxStream
exports.toBuffer = toBuffer
