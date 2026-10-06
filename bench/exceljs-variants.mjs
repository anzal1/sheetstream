// exceljs streaming writer, four ways, to see where its memory goes. Usage: node exceljs-variants.mjs <variant> <rows> <file>
import { createRequire } from 'node:module'
import { row } from './gen.mjs'
const [variant, nStr, file] = process.argv.slice(2)
const N = Number(nStr)
const ExcelJS = createRequire(import.meta.url)('exceljs')
const tick = () => new Promise((r) => setImmediate(r))
const opts = variant === 'as-benchmarked' ? { useSharedStrings: true, useStyles: true } : { useSharedStrings: false, useStyles: false }
const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, ...opts })
const ws = wb.addWorksheet('Data')
const t = performance.now()
for (let r = 0; r < N; r++) {
  ws.addRow(row(r)).commit()
  if (r % 1000 === 999) {
    if (variant === 'yield' || variant === 'yield+drain') await tick()
    if (variant === 'yield+drain' && wb.stream && wb.stream.writableNeedDrain) await new Promise((res) => wb.stream.once('drain', res))
  }
}
ws.commit(); await wb.commit()
console.log(JSON.stringify({ variant, rows: N, seconds: +((performance.now() - t) / 1000).toFixed(2) }))
