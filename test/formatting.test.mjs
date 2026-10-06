import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { writeXlsx, readXlsx, XlsxWriter, toBuffer, xlsxStream } from '../index.js'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('formatting')

const D1 = new Date(Date.UTC(2024, 0, 5))
const D2 = new Date(Date.UTC(2024, 0, 6))
const rows = [
  { id: 1, amount: 1234.5, when: D1, share: 0.25, note: 'a' },
  { id: 2, amount: 3, when: D2, share: 0.5, note: 'b' },
]
const columns = [
  { key: 'id', header: 'ID', width: 8 },
  { key: 'amount', header: 'Amount (USD)', width: 14, numFmt: '#,##0.00' },
  { key: 'when', numFmt: 'dd/mm/yyyy', width: 12 },
  { key: 'share', numFmt: '0%' },
  'note',
]
const style = { bold: true, fill: '#1F4E79', fontColor: '#FFFFFF', border: true }

/** Raw XML of one part of a produced .xlsx, straight from the zip. */
async function part(file, name) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  return zip.file(name).async('string')
}
const sheetXml = (file) => part(file, 'xl/worksheets/sheet1.xml')
const stylesXml = (file) => part(file, 'xl/styles.xml')

async function excel(file) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  return wb.worksheets[0]
}

for (const mode of ['constant', 'lowMemory']) {
  test(`headerStyle, columns, freeze and filter all land in the file (${mode})`, async () => {
    const file = tmp(`all-${mode}.xlsx`)
    const res = await writeXlsx(file, rows, { mode, columns, headerStyle: style, freezeHeader: true, autoFilter: true })
    assert.equal(res.rows, 3)

    // The XML itself.
    const xml = await sheetXml(file)
    assert.match(xml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/)
    assert.match(xml, /<autoFilter ref="A1:E3"\/>/)
    assert.match(xml, /<col min="1" max="1" width="8\.7\d*" customWidth="1"\/>/)
    assert.match(xml, /<col min="2" max="2" width="14\.7\d*" style="\d+" customWidth="1"\/>/)
    const styles = await stylesXml(file)
    for (const code of ['#,##0.00', 'dd/mm/yyyy', '0%']) assert.ok(styles.includes(`formatCode="${code}"`), code)
    assert.match(styles, /<b\/>/)
    assert.match(styles, /<fgColor rgb="FF1F4E79"\/>/)
    assert.match(styles, /<color rgb="FFFFFFFF"\/>/)
    assert.match(styles, /<left style="thin">/)

    // The same thing as a spreadsheet application would see it.
    const ws = await excel(file)
    assert.deepEqual(ws.getRow(1).values.slice(1), ['ID', 'Amount (USD)', 'when', 'share', 'note'])
    const h = ws.getCell('A1')
    assert.equal(h.font.bold, true)
    assert.equal(h.font.color.argb, 'FFFFFFFF')
    assert.equal(h.fill.fgColor.argb, 'FF1F4E79')
    assert.equal(h.border.top.style, 'thin')
    assert.equal(ws.getCell('E1').font.bold, true, 'every header cell is styled')
    assert.equal(ws.views[0].state, 'frozen')
    assert.equal(ws.views[0].ySplit, 1)
    assert.ok(Math.abs(ws.getColumn(1).width - 8.71) < 0.1)
    assert.ok(Math.abs(ws.getColumn(2).width - 14.71) < 0.1)
    assert.equal(ws.getCell('B2').numFmt, '#,##0.00')
    assert.equal(ws.getCell('B3').numFmt, '#,##0.00')
    assert.equal(ws.getCell('C2').numFmt, 'dd/mm/yyyy', 'a date takes its column format')
    assert.equal(ws.getCell('D2').numFmt, '0%')
    assert.ok(!ws.getCell('A2').numFmt || ws.getCell('A2').numFmt === 'General')
    assert.ok(!ws.getCell('A2').font?.bold, 'data rows are not header-styled')
  })
}

test('formatted files still read back with the right values and types', async () => {
  const file = tmp('values.xlsx')
  await writeXlsx(file, rows, { columns, headerStyle: style, freezeHeader: true, autoFilter: true })
  const got = await readXlsx(file).toArray()
  assert.deepEqual(got, [
    { ID: 1, 'Amount (USD)': 1234.5, when: D1, share: 0.25, note: 'a' },
    { ID: 2, 'Amount (USD)': 3, when: D2, share: 0.5, note: 'b' },
  ])
})

test('defaults stay plain: no pane, no filter, no custom styles or widths', async () => {
  const file = tmp('plain.xlsx')
  await writeXlsx(file, rows)
  const xml = await sheetXml(file)
  assert.ok(!xml.includes('<pane'))
  assert.ok(!xml.includes('<autoFilter'))
  assert.ok(!xml.includes('<cols>'))
  const styles = await stylesXml(file)
  assert.match(styles, /<cellXfs count="2">/, 'only the default style and the date style')
  assert.ok(!styles.includes('<b/>'))
})

test('headerStyle options work one at a time, and an empty one changes nothing', async () => {
  const bold = tmp('bold.xlsx')
  await writeXlsx(bold, rows, { headerStyle: { bold: true } })
  let ws = await excel(bold)
  assert.equal(ws.getCell('A1').font.bold, true)
  assert.equal(ws.getCell('A1').fill?.fgColor, undefined)

  const fill = tmp('fill.xlsx')
  await writeXlsx(fill, rows, { headerStyle: { fill: 'ffcc00' } }) // no '#', lower case
  ws = await excel(fill)
  assert.equal(ws.getCell('B1').fill.fgColor.argb, 'FFFFCC00')
  assert.ok(!ws.getCell('B1').font.bold)

  const short = tmp('short.xlsx')
  await writeXlsx(short, rows, { headerStyle: { fontColor: '#f00' } }) // 3-digit hex
  ws = await excel(short)
  assert.equal(ws.getCell('A1').font.color.argb, 'FFFF0000')

  const empty = tmp('empty-style.xlsx')
  await writeXlsx(empty, rows, { headerStyle: {} })
  assert.match(await stylesXml(empty), /<cellXfs count="2">/)
})

test('column options accept a mix of strings and objects, with keys deciding the order', async () => {
  const file = tmp('mix.xlsx')
  await writeXlsx(file, rows, { columns: ['note', { key: 'amount', header: 'Total', numFmt: '0.0' }, 'id'] })
  const got = await readXlsx(file).toArray()
  assert.deepEqual(got, [
    { note: 'a', Total: 1234.5, id: 1 },
    { note: 'b', Total: 3, id: 2 },
  ])
  assert.equal((await excel(file)).getCell('B2').numFmt, '0.0')
})

test('array rows take header, width and numFmt by position', async () => {
  const file = tmp('arrays.xlsx')
  await writeXlsx(file, [[1, 0.5], [2, 0.75]], {
    columns: [{ key: 'n', header: 'N', width: 6 }, { key: 'p', header: 'Share', numFmt: '0.0%' }],
    header: true,
    headerStyle: { bold: true },
    freezeHeader: true,
    autoFilter: true,
  })
  const ws = await excel(file)
  assert.deepEqual(ws.getRow(1).values.slice(1), ['N', 'Share'])
  assert.equal(ws.getCell('B3').numFmt, '0.0%')
  assert.equal(ws.getCell('A1').font.bold, true)
  assert.match(await sheetXml(file), /<autoFilter ref="A1:B3"\/>/)
})

test('freezeHeader and autoFilter do nothing when there is no header row', async () => {
  const file = tmp('noheader.xlsx')
  await writeXlsx(file, rows, { header: false, headerStyle: { bold: true }, freezeHeader: true, autoFilter: true })
  const xml = await sheetXml(file)
  assert.ok(!xml.includes('<pane'))
  assert.ok(!xml.includes('<autoFilter'))
  assert.equal((await excel(file)).rowCount, 2)
})

test('a header-only sheet still gets its style, freeze and filter', async () => {
  const file = tmp('headeronly.xlsx')
  await writeXlsx(file, [], { columns: ['a', { key: 'b', width: 20 }], headerStyle: { bold: true }, freezeHeader: true, autoFilter: true })
  const xml = await sheetXml(file)
  assert.match(xml, /state="frozen"/)
  assert.match(xml, /<autoFilter ref="A1:B1"\/>/)
  assert.equal((await excel(file)).getCell('A1').font.bold, true)
})

test('each sheet of a multi-sheet workbook carries its own options', async () => {
  const file = tmp('sheets.xlsx')
  const w = new XlsxWriter(file)
  const a = w.addSheet('Styled', { columns: [{ key: 'x', numFmt: '0.00' }], headerStyle: { bold: true }, freezeHeader: true })
  const b = w.addSheet('Plain', { columns: ['x'] })
  a.writeRows([{ x: 1 }, { x: 2 }])
  b.writeRows([{ x: 1 }])
  await w.close()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const [styled, plain] = wb.worksheets
  assert.equal(styled.getCell('A1').font.bold, true)
  assert.equal(styled.getCell('A2').numFmt, '0.00')
  assert.equal(styled.views[0].state, 'frozen')
  assert.ok(!plain.getCell('A1').font?.bold)
  assert.notEqual(plain.views[0]?.state, 'frozen')
})

test('toBuffer and xlsxStream accept the formatting options', async () => {
  const opts = { columns, headerStyle: style, freezeHeader: true, autoFilter: true }
  const buf = await toBuffer(rows, opts)
  const zip = await JSZip.loadAsync(buf)
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /state="frozen"/)
  assert.match(await zip.file('xl/styles.xml').async('string'), /formatCode="#,##0\.00"/)

  const chunks = []
  for await (const c of xlsxStream(rows, opts)) chunks.push(c)
  const zip2 = await JSZip.loadAsync(Buffer.concat(chunks))
  assert.match(await zip2.file('xl/worksheets/sheet1.xml').async('string'), /<autoFilter ref="A1:E3"\/>/)
})

test('a column format does not change how data is stored', async () => {
  // Same values with and without formats: the cell payloads in the XML are identical.
  const plain = tmp('same-plain.xlsx')
  const fancy = tmp('same-fancy.xlsx')
  await writeXlsx(plain, rows, { columns: ['id', 'amount', 'when', 'share', 'note'] })
  await writeXlsx(fancy, rows, { columns })
  const strip = (x) => [...x.matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1])
  assert.deepEqual(strip(await sheetXml(fancy)), strip(await sheetXml(plain)))
})

test('bad formatting options are rejected up front', async () => {
  const f = tmp('bad.xlsx')
  const bad = (opts, re) => assert.rejects(() => writeXlsx(f, rows, opts), re)
  await bad({ headerStyle: { fill: 'blue' } }, /headerStyle\.fill must be a hex color/)
  await bad({ headerStyle: { fontColor: '#12' } }, /headerStyle\.fontColor must be a hex color/)
  await bad({ headerStyle: { bold: 'yes' } }, /headerStyle\.bold must be a boolean/)
  await bad({ headerStyle: 'bold' }, /headerStyle must be an object/)
  await bad({ columns: [{ key: 'id', width: 0 }] }, /columns\[0\]\.width/)
  await bad({ columns: [{ key: 'id', width: 300 }] }, /columns\[0\]\.width/)
  await bad({ columns: [{ key: 'id', numFmt: 5 }] }, /columns\[0\]\.numFmt/)
  await bad({ columns: [{ header: 'no key' }] }, /columns\[0\] must be a string or an object/)
  await bad({ columns: 'id' }, /columns must be an array/)
  await bad({ freezeHeader: 1 }, /freezeHeader must be a boolean/)
  await bad({ autoFilter: 'on' }, /autoFilter must be a boolean/)
})
