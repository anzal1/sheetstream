// Writes 1,000,000 rows x 10 columns to .xlsx two ways, both under the same 1 GB heap cap.
// Run it as: node --max-old-space-size=1024 demo/demo.mjs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { row, rows } from '../bench/gen.mjs'

const N = 1_000_000
const file = join(tmpdir(), 'sheetstream-demo.xlsx')
const me = fileURLToPath(import.meta.url)
const [, , mode] = process.argv

if (mode === 'exceljs') {
  // What most people write first: build the workbook, then save it.
  const ExcelJS = createRequire(import.meta.url)('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  for (let i = 0; i < N; i++) ws.addRow(row(i))
  await wb.xlsx.writeFile(file)
  console.log('done')
} else if (mode === 'sheetstream') {
  const { writeXlsx } = await import('../index.js')
  const t0 = performance.now()
  const { rows: n } = await writeXlsx(file, rows(N))
  const secs = ((performance.now() - t0) / 1000).toFixed(1)
  const mb = Math.round(process.resourceUsage().maxRSS / 1024)
  console.log(`wrote ${n.toLocaleString('en-US')} rows in ${secs}s, peak RSS ${mb} MB`)
} else {
  const heap = process.execArgv.find((a) => a.startsWith('--max-old-space-size='))?.split('=')[1]
  console.log(`1,000,000 rows x 10 columns, ${heap} MB heap (a small serverless function)\n`)
  for (const lib of ['exceljs', 'sheetstream']) {
    console.log(`\x1b[33m${lib === 'exceljs' ? 'exceljs, default workbook' : 'sheetstream'}\x1b[0m`)
    const child = spawn(process.execPath, [...process.execArgv, me, lib], { stdio: ['ignore', 'inherit', 'pipe'] })
    // V8 prints a long native stack trace after the fatal error. Show the error, trim the trace.
    const cols = (process.stdout.columns || 120) - 1
    let buf = '', trimmed = false
    child.stderr.on('data', (d) => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop()
      for (const l of lines) {
        if (trimmed) continue
        if (l.includes('Native stack trace')) { trimmed = true; console.log('\x1b[90m(native stack trace trimmed for the clip)\x1b[0m'); continue }
        if (l.trim()) console.log(l.length > cols ? l.slice(0, cols - 3) + '...' : l)
      }
    })
    const [code, signal] = await new Promise((res) => child.on('close', (c, s) => res([c, s])))
    if (code !== 0) console.log(`\x1b[31mcrashed (${signal ?? 'exit ' + code})\x1b[0m`)
    console.log()
  }
  try { unlinkSync(file) } catch {}
}
