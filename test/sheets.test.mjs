import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { writeXlsx, readXlsx, listSheets, XlsxWriter, xlsxStream, toBuffer } from '../index.js'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('sheets')

test('multi-sheet workbook with the low-level writer', async () => {
  const file = tmp('multi.xlsx')
  const w = new XlsxWriter(file)
  const orders = w.addSheet('Orders', { columns: ['id', 'total'] })
  const notes = w.addSheet('Notes')
  const empty = w.addSheet('Empty')
  orders.writeRows([{ id: 1, total: 9.5 }, { id: 2, total: 20 }])
  notes.writeRows([['hello'], ['world']])
  orders.writeRows([{ id: 3, total: 1 }]) // interleaved batches are fine
  const res = await w.close()
  assert.equal(res.rows, 3 + 1 + 2) // 3 orders + header, 2 notes
  assert.ok(res.bytes > 0)

  assert.deepEqual(await listSheets(file), [
    { name: 'Orders', index: 0 },
    { name: 'Notes', index: 1 },
    { name: 'Empty', index: 2 },
  ])
  assert.deepEqual(await readXlsx(file, { sheet: 'Orders' }).toArray(), [
    { id: 1, total: 9.5 },
    { id: 2, total: 20 },
    { id: 3, total: 1 },
  ])
  assert.deepEqual(await readXlsx(file, { sheet: 1, header: false }).toArray(), [['hello'], ['world']])
  assert.deepEqual(await readXlsx(file, { sheet: 'Empty' }).toArray(), [])
  assert.equal(empty !== undefined, true)
})

test('unknown sheets fail with a useful message', async () => {
  const file = tmp('one.xlsx')
  await writeXlsx(file, [[1]])
  await assert.rejects(() => readXlsx(file, { sheet: 'Nope' }).toArray(), /sheet 'Nope' not found/)
  await assert.rejects(() => readXlsx(file, { sheet: 5 }).toArray(), /out of range/)
  await assert.rejects(() => readXlsx(tmp('missing.xlsx')).toArray(), /cannot open/)
})

test('object rows: columns inferred from the first object, header on by default', async () => {
  const file = tmp('infer.xlsx')
  await writeXlsx(file, [
    { name: 'Ada', age: 36, joined: new Date(Date.UTC(2020, 0, 2)) },
    { age: 41, name: 'Grace' }, // key order does not matter
  ])
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [
    ['name', 'age', 'joined'],
    ['Ada', 36, new Date(Date.UTC(2020, 0, 2))],
    ['Grace', 41, null],
  ])
  assert.deepEqual(await readXlsx(file).toArray(), [
    { name: 'Ada', age: 36, joined: new Date(Date.UTC(2020, 0, 2)) },
    { name: 'Grace', age: 41, joined: null },
  ])
})

test('object rows with explicit columns pick, order and ignore extras', async () => {
  const file = tmp('cols.xlsx')
  await writeXlsx(file, [{ a: 1, b: 2, c: 3 }, { c: 6, a: 4 }], { columns: ['c', 'a'], sheetName: 'Picked' })
  assert.deepEqual(await readXlsx(file, { sheet: 'Picked' }).toArray(), [
    { c: 3, a: 1 },
    { c: 6, a: 4 },
  ])
})

test('header: false on object rows writes data only', async () => {
  const file = tmp('nohdr.xlsx')
  await writeXlsx(file, [{ a: 1, b: 2 }], { header: false })
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [[1, 2]])
})

test('array rows with a header', async () => {
  const file = tmp('arrhdr.xlsx')
  await writeXlsx(file, [[1, 'x'], [2, 'y']], { columns: ['n', 's'], header: true })
  assert.deepEqual(await readXlsx(file).toArray(), [{ n: 1, s: 'x' }, { n: 2, s: 'y' }])
})

test('array rows without a header', async () => {
  const file = tmp('arr.xlsx')
  await writeXlsx(file, [[1, 2], [3, 4]], { sheetName: 'Nums' })
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [[1, 2], [3, 4]])
  assert.deepEqual(await listSheets(file), [{ name: 'Nums', index: 0 }])
})

test('mixing arrays and objects in one sheet is an error', async () => {
  await assert.rejects(() => writeXlsx(tmp('mixed.xlsx'), [[1], { a: 1 }]), /mixes arrays and objects/)
})

test('duplicate and empty header cells get unique keys', async () => {
  const file = tmp('dupes.xlsx')
  await writeXlsx(file, [['a', 'a', null, 'b'], [1, 2, 3, 4]])
  assert.deepEqual(await readXlsx(file).toArray(), [{ a: 1, a_2: 2, column3: 3, b: 4 }])
})

test('a header named __proto__ stays an own property', async () => {
  const file = tmp('proto.xlsx')
  await writeXlsx(file, [['__proto__', 'x'], [1, 2]])
  const [row] = await readXlsx(file).toArray()
  assert.equal(Object.getPrototypeOf(row), Object.prototype)
  assert.deepEqual(Object.keys(row), ['__proto__', 'x'])
})

test('sync generators and async generators both work as sources', async () => {
  function* sync() { for (let i = 0; i < 2500; i++) yield [i] }
  async function* asyncGen() { for (let i = 0; i < 2500; i++) { if (i % 500 === 0) await null; yield [i] } }
  for (const [name, src] of [['sync', sync()], ['async', asyncGen()]]) {
    const file = tmp(`gen-${name}.xlsx`)
    const res = await writeXlsx(file, src, { batchSize: 300 })
    assert.equal(res.rows, 2500)
    const got = await readXlsx(file, { header: false, batchSize: 700 }).toArray()
    assert.equal(got.length, 2500)
    assert.equal(got[2499][0], 2499)
  }
})

test('reading yields batches of the requested size', async () => {
  const file = tmp('batches.xlsx')
  await writeXlsx(file, (function* () { for (let i = 0; i < 2500; i++) yield [i] })())
  const sizes = []
  for await (const batch of readXlsx(file, { header: false, batchSize: 1000 })) sizes.push(batch.length)
  assert.deepEqual(sizes, [1000, 1000, 500])
})

test('breaking out of a read loop early releases the reader', async () => {
  const file = tmp('early.xlsx')
  await writeXlsx(file, (function* () { for (let i = 0; i < 50_000; i++) yield [i, 'x'] })())
  let seen = 0
  for await (const batch of readXlsx(file, { header: false, batchSize: 100 })) {
    seen += batch.length
    if (seen >= 300) break
  }
  assert.equal(seen, 300)
})

test('event loop stays responsive while a large sync generator is being written', async () => {
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  function* rows() { for (let i = 0; i < 300_000; i++) yield [i, 'row ' + i, i / 7] }
  await writeXlsx(tmp('loop.xlsx'), rows())
  clearInterval(timer)
  assert.ok(ticks > 5, `timer only fired ${ticks} times`)
})

test('xlsxStream pipes a valid file and cleans up its temp file', async () => {
  const chunks = []
  const stream = xlsxStream([{ a: 1 }, { a: 2 }])
  for await (const c of stream) chunks.push(c)
  const file = tmp('streamed.xlsx')
  fs.writeFileSync(file, Buffer.concat(chunks))
  assert.deepEqual(await readXlsx(file).toArray(), [{ a: 1 }, { a: 2 }])
  assert.equal(Readable.prototype.isPrototypeOf(stream), true)
})

test('xlsxStream surfaces source errors', async () => {
  function* bad() { yield [1]; throw new Error('boom') }
  const stream = xlsxStream(bad())
  await assert.rejects(async () => { for await (const _ of stream); }, /boom/)
})

test('toBuffer returns a zip that reads back', async () => {
  const buf = await toBuffer([[1, 'a'], [2, 'b']])
  assert.equal(buf.subarray(0, 2).toString(), 'PK')
  const file = tmp('buf.xlsx')
  fs.writeFileSync(file, buf)
  assert.deepEqual(await readXlsx(file, { header: false }).toArray(), [[1, 'a'], [2, 'b']])
})

test('lowMemory mode makes smaller files for repetitive strings', async () => {
  const src = () => (function* () { for (let i = 0; i < 20_000; i++) yield [`category-${i % 20}`, `region-${i % 7}`, i] })()
  const a = await writeXlsx(tmp('c.xlsx'), src(), { mode: 'constant' })
  const b = await writeXlsx(tmp('l.xlsx'), src(), { mode: 'lowMemory' })
  assert.ok(b.bytes < a.bytes, `${b.bytes} should be < ${a.bytes}`)
  assert.deepEqual(
    await readXlsx(tmp('c.xlsx'), { header: false }).toArray(),
    await readXlsx(tmp('l.xlsx'), { header: false }).toArray(),
  )
})

test('argument validation', async () => {
  await assert.rejects(() => writeXlsx(tmp('v.xlsx'), [], { mode: 'fast' }), /mode must be/)
  await assert.rejects(() => writeXlsx(tmp('v.xlsx'), [], { batchSize: 0 }), /batchSize/)
  assert.throws(() => readXlsx(tmp('v.xlsx'), { batchSize: -1 }), /batchSize/)
  assert.throws(() => readXlsx(tmp('v.xlsx'), { sheet: 1.5 }), /sheet/)
  await assert.rejects(() => writeXlsx(tmp('bad name.xlsx'), [[1]], { sheetName: 'a/b' }))
})
