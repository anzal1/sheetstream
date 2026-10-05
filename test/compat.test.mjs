// SheetJS builds Dates from local time; pin the zone so date assertions are exact.
process.env.TZ = 'UTC'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { writeXlsx, readXlsx, listSheets } from '../index.js'
import { tmpDir } from './helpers.mjs'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const tmp = tmpDir('compat')

const D1 = new Date(Date.UTC(2024, 1, 29, 13, 45, 30))
const D2 = new Date(Date.UTC(1969, 6, 20)) // before 1970, date only
const header = ['num', 'float', 'str', 'bool', 'date', 'pre1970']
const data = [
  [1, 1.5, 'plain', true, D1, D2],
  [-7, 0.1, 'héllo 日本 😀', false, D1, D2],
  [0, 1e21, '  spaced  ', true, D1, D2],
]

test('files we write read identically in exceljs', async () => {
  const file = tmp('ours-exceljs.xlsx')
  await writeXlsx(file, data, { columns: header, header: true, sheetName: 'Data' })
  for (const mode of ['constant', 'lowMemory']) {
    await writeXlsx(file, data, { columns: header, header: true, sheetName: 'Data', mode })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)
    const ws = wb.getWorksheet('Data')
    assert.equal(ws.rowCount, 4)
    assert.deepEqual(ws.getRow(1).values.slice(1), header)
    for (let i = 0; i < data.length; i++) {
      assert.deepEqual(ws.getRow(i + 2).values.slice(1), data[i], `${mode} row ${i}`)
    }
  }
})

test('files we write read identically in SheetJS', async () => {
  const file = tmp('ours-sheetjs.xlsx')
  await writeXlsx(file, data, { columns: header, header: true, sheetName: 'Data' })
  const wb = XLSX.readFile(file, { cellDates: true })
  const ws = wb.Sheets.Data
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  assert.deepEqual(rows[0], header)
  for (let i = 0; i < data.length; i++) assert.deepEqual(rows[i + 1], data[i], `row ${i}`)
})

test('files we write read identically in both libraries (shared strings mode)', async () => {
  const file = tmp('ours-sst.xlsx')
  await writeXlsx(file, data, { columns: header, header: true, mode: 'lowMemory' })
  const sj = XLSX.utils.sheet_to_json(XLSX.readFile(file, { cellDates: true }).Sheets.Sheet1, { header: 1, raw: true })
  assert.deepEqual(sj.slice(1), data)
})

test('we read files written by exceljs', async () => {
  const file = tmp('exceljs.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('First')
  ws.addRow(header)
  for (const r of data) ws.addRow(r)
  ws.getColumn(5).numFmt = 'yyyy-mm-dd hh:mm:ss'
  ws.getColumn(6).numFmt = 'yyyy-mm-dd'
  wb.addWorksheet('Second').addRow(['only', 'this'])
  await wb.xlsx.writeFile(file)

  assert.deepEqual((await listSheets(file)).map((s) => s.name), ['First', 'Second'])
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [header, ...data])
  assert.deepEqual(await readXlsx(file, { sheet: 'Second', header: false }).toArray(), [['only', 'this']])
  const objs = await readXlsx(file).toArray()
  assert.equal(objs[1].str, 'héllo 日本 😀')
  assert.deepEqual(objs[2].date, D1)
})

test('we read files written by SheetJS (dates as numbers and as ISO t="d" cells)', async () => {
  for (const cellDates of [false, true]) {
    const file = tmp(`sheetjs-${cellDates}.xlsx`)
    const ws = XLSX.utils.aoa_to_sheet([header, ...data], { cellDates: true })
    ws['E2'].z = 'yyyy-mm-dd hh:mm:ss' // make sure the number format marks them as dates
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'SJS')
    XLSX.writeFile(wb, file, { cellDates, compression: true })
    const got = await readXlsx(file, { header: false }).toArray()
    assert.deepEqual(got[0], header)
    for (let i = 0; i < data.length; i++) {
      assert.deepEqual(got[i + 1].slice(0, 4), data[i].slice(0, 4), `cellDates=${cellDates} row ${i}`)
      assert.ok(got[i + 1][4] instanceof Date, `cellDates=${cellDates} date cell`)
      assert.equal(got[i + 1][4].getTime(), D1.getTime(), `cellDates=${cellDates} datetime`)
      assert.equal(got[i + 1][5].getTime(), D2.getTime(), `cellDates=${cellDates} pre-1970`)
    }
  }
})

test('error cells and formulas read as cached values / null', async () => {
  const file = tmp('formula.xlsx')
  const ws = XLSX.utils.aoa_to_sheet([[1, 2]])
  ws.C1 = { t: 'n', f: 'A1+B1', v: 3 }
  ws.D1 = { t: 'e', v: 0x07, w: '#DIV/0!' }
  ws['!ref'] = 'A1:D1'
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'F')
  XLSX.writeFile(wb, file)
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [[1, 2, 3, null]])
})
