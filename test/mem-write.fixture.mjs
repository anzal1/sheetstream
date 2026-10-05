// Child process for the memory guard: writes N rows and reports peak RSS.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeXlsx } from '../index.js'
import { rows } from '../bench/gen.mjs'

const n = Number(process.argv[2] || 1_000_000)
const mode = process.argv[3] || 'constant'
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstream-mem-')), 'out.xlsx')
let sampledMax = 0
const timer = setInterval(() => {
  sampledMax = Math.max(sampledMax, process.memoryUsage().rss)
}, 50)
const t0 = performance.now()
const res = await writeXlsx(file, rows(n), { mode })
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
