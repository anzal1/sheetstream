import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeXlsx, readXlsx } from '../index.js'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('roundtrip')

async function roundTrip(name, rows, opts = {}) {
  const file = tmp(name + '.xlsx')
  await writeXlsx(file, rows, opts)
  return readXlsx(file, { header: false }).toArray()
}

for (const mode of ['constant', 'lowMemory']) {
  test(`every cell type round-trips (${mode})`, async () => {
    const d = new Date(Date.UTC(2024, 1, 29, 13, 45, 30, 250))
    const rows = [[1, -2.5, 'text', true, false, d, null, 1e300, 0.1 + 0.2, Number.MAX_SAFE_INTEGER, 5e-324]]
    const [got] = await roundTrip('types-' + mode, rows, { mode })
    assert.deepEqual(got.slice(0, 6), [1, -2.5, 'text', true, false, d])
    assert.equal(got[6], null)
    assert.equal(got[7], 1e300)
    assert.equal(got[8], 0.1 + 0.2)
    assert.equal(got[9], Number.MAX_SAFE_INTEGER)
    assert.equal(got[10], 5e-324)
  })
}

test('unicode, whitespace, markup and control characters survive', async () => {
  const strings = [
    'héllo wörld',
    '日本語のテキスト',
    '😀 emoji 🚀 and 👨‍👩‍👧 family',
    'العربية',
    '  leading and trailing  ',
    'line one\nline two\r\nline three',
    'tab\tseparated',
    '<xml attr="x">&amp; \'quotes\'</xml>',
    '=SUM(A1:A2)',
    '@mention',
    '\u0001control\u001f',
    'a'.repeat(300),
  ]
  const [got] = await roundTrip('unicode', [strings])
  assert.deepEqual(got, strings)
})

test('empty strings and nulls read back as empty cells', async () => {
  const rows = [
    [1, null, 3],
    [null, undefined, 'x'],
    [4, 5, 6],
  ]
  const got = await roundTrip('empty', rows)
  assert.deepEqual(got, [
    [1, null, 3],
    [null, null, 'x'],
    [4, 5, 6],
  ])
})

test('blank rows keep their position', async () => {
  const got = await roundTrip('blankrows', [['a', 1], null, ['b', 2]])
  assert.equal(got.length, 3)
  assert.deepEqual(got[0], ['a', 1])
  assert.deepEqual(got[1], [null, null])
  assert.deepEqual(got[2], ['b', 2])
})

test('long strings up to the Excel limit', async () => {
  const s30k = 'x'.repeat(30_000)
  const max = 'ü'.repeat(32_767)
  const [got] = await roundTrip('long', [[s30k, max]])
  assert.equal(got[0], s30k)
  assert.equal(got[1], max)
})

test('a string over the Excel limit is rejected with its position', async () => {
  await assert.rejects(
    () => writeXlsx(tmp('toolong.xlsx'), [['ok'], ['ok', 'y'.repeat(40_000)]]),
    /row 2, column 2/,
  )
})

test('dates before and after 1970', async () => {
  const dates = [
    new Date(Date.UTC(1970, 0, 1)),
    new Date(Date.UTC(1969, 11, 31, 23, 59, 59, 999)),
    new Date(Date.UTC(1969, 6, 20, 20, 17, 40)),
    new Date(Date.UTC(1960, 5, 15)),
    new Date(Date.UTC(1950, 0, 1, 12)),
    new Date(Date.UTC(1900, 2, 1)), // first day after Excel's fake leap day
    new Date(Date.UTC(1900, 1, 28)), // last day before it
    new Date(Date.UTC(1900, 0, 1)), // Excel serial 1
    new Date(Date.UTC(2000, 1, 29, 6, 30)),
    new Date(Date.UTC(2038, 0, 19, 3, 14, 8)),
    new Date(Date.UTC(2262, 3, 11, 23, 47, 16, 854)),
    new Date(Date.UTC(9999, 11, 31)),
  ]
  const [got] = await roundTrip('dates', [dates])
  assert.deepEqual(got, dates)
  for (const g of got) assert.ok(g instanceof Date)
})

test('date-only cells come back at UTC midnight, with milliseconds kept on datetimes', async () => {
  const a = new Date(Date.UTC(2021, 4, 5))
  const b = new Date(Date.UTC(2021, 4, 5, 0, 0, 0, 1))
  const [got] = await roundTrip('datems', [[a, b]])
  assert.equal(got[0].getTime(), a.getTime())
  assert.equal(got[1].getTime(), b.getTime())
})

test('dates before 1900 and invalid dates', async () => {
  const [got] = await roundTrip('olddates', [[new Date(Date.UTC(1850, 5, 1, 12)), new Date(NaN), 'end']])
  // Excel cannot represent them: pre-1900 becomes ISO text, an invalid Date an empty cell.
  assert.deepEqual(got, ['1850-06-01T12:00:00.000Z', null, 'end'])
})

test('bigint: safe values become numbers, large ones become strings', async () => {
  const [got] = await roundTrip('bigint', [[42n, -7n, 9007199254740991n, 9007199254740993n, 2n ** 70n]])
  assert.deepEqual(got, [42, -7, 9007199254740991, '9007199254740993', (2n ** 70n).toString()])
})

test('NaN and Infinity are kept as text', async () => {
  const [got] = await roundTrip('nan', [[NaN, Infinity, -Infinity]])
  assert.deepEqual(got, ['NaN', 'Infinity', '-Infinity'])
})

test('unsupported cell values are rejected with their position', async () => {
  await assert.rejects(() => writeXlsx(tmp('bad1.xlsx'), [[1, { nested: true }]]), /row 1, column 2/)
  await assert.rejects(() => writeXlsx(tmp('bad2.xlsx'), [[Symbol('s')]]), /row 1, column 1/)
  await assert.rejects(() => writeXlsx(tmp('bad3.xlsx'), [[() => 1]]), /row 1, column 1/)
})

test('non-iterable input is a TypeError', async () => {
  await assert.rejects(() => writeXlsx(tmp('bad4.xlsx'), 42), TypeError)
})

test('a sheet with only a header and an empty input both produce valid files', async () => {
  const f1 = tmp('onlyheader.xlsx')
  await writeXlsx(f1, [], { columns: ['a', 'b'] })
  assert.deepEqual(await readXlsx(f1, { header: false }).toArray(), [['a', 'b']])
  const f2 = tmp('nothing.xlsx')
  const res = await writeXlsx(f2, [])
  assert.equal(res.rows, 0)
  assert.deepEqual(await readXlsx(f2, { header: false }).toArray(), [])
})

test('multi-byte strings around the native buffer boundary are not truncated', async () => {
  const rows = []
  for (const ch of ['ü', '日', '😀']) {
    for (let n = 55; n <= 90; n++) rows.push([ch.repeat(n), 'k'.repeat(250 + (n % 12)) + ch])
  }
  const got = await roundTrip('boundary', rows)
  assert.deepEqual(got, rows)
})
