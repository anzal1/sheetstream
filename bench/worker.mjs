// One benchmark case in one process. Usage: node worker.mjs <case> <rows> <file>
// Prints a single JSON line on stdout when it finishes.
import { createRequire } from 'node:module'
import { row, rows as genRows } from './gen.mjs'

const [caseName, nStr, file] = process.argv.slice(2)
const N = Number(nStr)
const require = createRequire(import.meta.url)

const cases = {
  async 'write:sheetstream-constant'() {
    const { writeXlsx } = await import('../index.js')
    return writeXlsx(file, genRows(N), { mode: 'constant' })
  },
  async 'write:sheetstream-lowMemory'() {
    const { writeXlsx } = await import('../index.js')
    return writeXlsx(file, genRows(N), { mode: 'lowMemory' })
  },
  async 'write:exceljs-default'() {
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Data')
    ws.getColumn(9).numFmt = 'yyyy-mm-dd'
    const all = new Array(N)
    for (let r = 0; r < N; r++) all[r] = row(r)
    ws.addRows(all)
    await wb.xlsx.writeFile(file)
    return { rows: N }
  },
  async 'write:exceljs-streaming'() {
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true, useStyles: true })
    const ws = wb.addWorksheet('Data')
    ws.getColumn(9).numFmt = 'yyyy-mm-dd'
    for (let r = 0; r < N; r++) ws.addRow(row(r)).commit()
    ws.commit()
    await wb.commit()
    return { rows: N }
  },
  async 'write:sheetjs-dense'() {
    const XLSX = require('xlsx')
    XLSX.set_fs(await import('node:fs'))
    const all = new Array(N)
    for (let r = 0; r < N; r++) all[r] = row(r)
    const ws = XLSX.utils.aoa_to_sheet(all, { cellDates: true, dense: true })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Data')
    XLSX.writeFile(wb, file, { cellDates: true, compression: true })
    return { rows: N }
  },

  async 'read:sheetstream'() {
    const { readXlsx } = await import('../index.js')
    let rows = 0, cells = 0, isum = 0
    for await (const batch of readXlsx(file, { header: false })) {
      for (const r of batch) {
        rows++
        for (let i = 0; i < r.length; i++) if (r[i] !== null) cells++
        isum += r[0] || 0
      }
    }
    return { rows, cells, isum }
  },
  async 'read:exceljs-streaming'() {
    const ExcelJS = require('exceljs')
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
      entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', worksheets: 'emit',
    })
    let rows = 0, cells = 0, isum = 0
    for await (const ws of reader) {
      for await (const row of ws) {
        rows++
        const v = row.values
        for (let i = 1; i < v.length; i++) if (v[i] !== undefined) cells++
        isum += v[1] || 0
      }
    }
    return { rows, cells, isum }
  },
  async 'read:sheetjs-dense'() {
    const XLSX = require('xlsx')
    XLSX.set_fs(await import('node:fs'))
    const wb = XLSX.readFile(file, { cellDates: true, dense: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
    let cells = 0, isum = 0
    for (const r of all) {
      for (let i = 0; i < r.length; i++) if (r[i] !== undefined) cells++
      isum += r[0] || 0
    }
    return { rows: all.length, cells, isum }
  },
}

const fn = cases[caseName]
if (!fn) {
  console.error(`unknown case ${caseName}; known: ${Object.keys(cases).join(', ')}`)
  process.exit(2)
}
const t0 = performance.now()
const result = await fn()
console.log(JSON.stringify({ case: caseName, seconds: (performance.now() - t0) / 1000, ...result }))
