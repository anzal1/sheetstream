// Measures the synchronous cost of one writeRows() call on a 1000-row batch (the event-loop stall per batch).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { XlsxWriter } from '../index.js'
import { row } from './gen.mjs'

const BATCH = 1000
const ROUNDS = 300
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstream-batch-'))

function measure(label, mk, mode) {
  const w = new XlsxWriter(path.join(dir, 'b.xlsx'), { mode })
  const s = w.addSheet('S', mk.columns ? { columns: mk.columns } : {})
  const times = []
  let r = 0
  for (let b = 0; b < ROUNDS; b++) {
    const batch = new Array(BATCH)
    for (let i = 0; i < BATCH; i++) batch[i] = mk.make(r++)
    const t0 = performance.now()
    s.writeRows(batch)
    times.push(performance.now() - t0)
  }
  w.abort()
  times.sort((a, b) => a - b)
  const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))]
  console.log(`${label.padEnd(34)} median ${q(0.5).toFixed(2)} ms   p95 ${q(0.95).toFixed(2)} ms   max ${times.at(-1).toFixed(2)} ms`)
  return { label, medianMs: q(0.5), p95Ms: q(0.95), maxMs: times.at(-1) }
}

const cols = ['int', 'float', 's1', 's2', 's3', 's4', 's5', 's6', 'date', 'bool']
const arrayRows = { make: (r) => row(r) }
const objectRows = {
  columns: cols,
  make: (r) => {
    const a = row(r)
    return { int: a[0], float: a[1], s1: a[2], s2: a[3], s3: a[4], s4: a[5], s5: a[6], s6: a[7], date: a[8], bool: a[9] }
  },
}
const out = [
  measure('array rows, constant, 1000x10', arrayRows, 'constant'),
  measure('array rows, lowMemory, 1000x10', arrayRows, 'lowMemory'),
  measure('object rows, constant, 1000x10', objectRows, 'constant'),
]
fs.rmSync(dir, { recursive: true, force: true })
if (process.argv.includes('--json')) console.log(JSON.stringify(out))
