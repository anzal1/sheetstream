// Child process for the memory guard: writes N rows and reports peak RSS.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeXlsx, writeCsv } from '../index.js'
import { rows } from '../bench/gen.mjs'

const n = Number(process.argv[2] || 1_000_000)
const mode = process.argv[3] || 'constant'
// 'plain' = v0.1 behaviour, 'formatted' = column widths and number formats on all 10 columns plus a styled,
// frozen, filtered header, 'csv' = the CSV writer.
const variant = process.argv[4] || 'plain'
const columns = [
  { key: 'id', header: 'ID', width: 10, numFmt: '0' },
  { key: 'amount', header: 'Amount', width: 14, numFmt: '#,##0.00' },
  { key: 's1', width: 18 }, { key: 's2', width: 18, numFmt: '@' }, { key: 's3', width: 18 },
  { key: 's4', width: 18 }, { key: 's5', width: 18 }, { key: 's6', width: 18 },
  { key: 'when', header: 'Date', width: 12, numFmt: 'dd/mm/yyyy' },
  { key: 'ok', header: 'OK', width: 6 },
]
const formatted = {
  columns,
  header: true,
  headerStyle: { bold: true, fill: '#1F4E79', fontColor: '#FFFFFF', border: true },
  freezeHeader: true,
  autoFilter: true,
}
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstream-mem-')), variant === 'csv' ? 'out.csv' : 'out.xlsx')
let sampledMax = 0
const timer = setInterval(() => {
  sampledMax = Math.max(sampledMax, process.memoryUsage().rss)
}, 50)
const t0 = performance.now()
const res =
  variant === 'csv'
    ? await writeCsv(file, rows(n), { columns, header: true })
    : await writeXlsx(file, rows(n), variant === 'formatted' ? { mode, ...formatted } : { mode })
clearInterval(timer)
sampledMax = Math.max(sampledMax, process.memoryUsage().rss)
const out = {
  rows: res.rows,
  bytes: res.bytes,
  seconds: (performance.now() - t0) / 1000,
  sampledMaxRssMB: sampledMax / 1e6,
  // resourceUsage().maxRSS is the kernel's peak, in KB.
  peakRssMB: process.resourceUsage().maxRSS / 1024,
}
fs.rmSync(path.dirname(file), { recursive: true, force: true })
console.log(JSON.stringify(out))
