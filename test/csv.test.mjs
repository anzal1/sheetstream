import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeCsv, readCsv } from '../index.js'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('csv')
const raw = (f) => fs.readFileSync(f, 'utf8')

const NASTY = [
  'plain',
  'with, comma',
  'with "quotes" inside',
  '"starts and ends with quotes"',
  'line one\nline two',
  'windows\r\nnewline',
  'carriage\rreturn',
  'tab\tseparated',
  '  padded  ',
  'héllo wörld',
  '日本語のテキスト',
  '😀 emoji 🚀 and 👨‍👩‍👧 family',
  'العربية',
  "it's; semi; colons",
  ',',
  '"',
  '""',
  'a'.repeat(5000),
]

test('quotes, commas, newlines and unicode round-trip as exact strings', async () => {
  const file = tmp('nasty.csv')
  const rows = NASTY.map((s, i) => ({ id: String(i), text: s }))
  const res = await writeCsv(file, rows)
  assert.equal(res.rows, NASTY.length + 1)
  assert.equal(res.bytes, fs.statSync(file).size)
  assert.deepEqual(await readCsv(file).toArray(), rows)
})

test('the file is plain RFC 4180 text', async () => {
  const file = tmp('rfc.csv')
  await writeCsv(file, [{ a: 'x,y', b: 'say "hi"', c: 'two\nlines', d: 1.5 }])
  assert.equal(raw(file), 'a,b,c,d\n"x,y","say ""hi""","two\nlines",1.5\n')
})

test('cell values: numbers, booleans, dates, bigint, null and non-finite numbers', async () => {
  const file = tmp('types.csv')
  const d = new Date(Date.UTC(2024, 1, 29, 13, 45, 30, 250))
  const day = new Date(Date.UTC(2024, 1, 29))
  await writeCsv(file, [[1, -2.5, 1e21, 1e-7, 0.1 + 0.2, 5e-324, true, false, d, day, 12345678901234567890n, null, undefined, NaN, Infinity, -Infinity, new Date(NaN)]])
  assert.equal(
    raw(file),
    '1,-2.5,1e21,1e-7,0.30000000000000004,5e-324,true,false,2024-02-29T13:45:30.250Z,2024-02-29,12345678901234567890,,,NaN,Infinity,-Infinity,\n',
  )
})

test('inferTypes restores numbers, booleans and dates; the default keeps text', async () => {
  const file = tmp('infer.csv')
  const d = new Date(Date.UTC(2024, 1, 29, 13, 45, 30, 250))
  const day = new Date(Date.UTC(2024, 1, 29))
  const rows = [{ n: 1, f: -2.5, big: 1e21, t: true, f2: false, d, day, s: 'text', e: null }]
  await writeCsv(file, rows)
  assert.deepEqual(await readCsv(file, { inferTypes: true }).toArray(), rows)
  assert.deepEqual(await readCsv(file).toArray(), [
    { n: '1', f: '-2.5', big: '1e21', t: 'true', f2: 'false', d: d.toISOString(), day: '2024-02-29', s: 'text', e: null },
  ])
})

test('inferTypes leaves ids, zip codes and loose dates alone', async () => {
  const file = tmp('infer-strict.csv')
  const row = ['007', '00123', '12345678901234567890', '+5', '1,5', '5.', '.5', '0x10', '1e', '2024-13-01', '2024-02-30T10:00:00', '2024-02-29T10:00:00+05:00', '2024-02-29 10:00', '12/31/2024', 'TRUE', '0', '-0.5', '1E3']
  await writeCsv(file, [row], { header: false })
  const [got] = await readCsv(file, { header: false, inferTypes: true }).toArray()
  assert.deepEqual(got.slice(0, 14), row.slice(0, 14))
  assert.equal(got[14], true) // case-insensitive booleans, as Excel writes them
  assert.equal(got[15], 0)
  assert.equal(got[16], -0.5)
  assert.equal(got[17], 1000)
})

test('delimiter and quote options, both ways', async () => {
  const rows = [{ a: 'x;y', b: "it's", c: 'tab\there', d: 'plain' }]
  const semi = tmp('semi.csv')
  await writeCsv(semi, rows, { delimiter: ';' })
  assert.equal(raw(semi), `a;b;c;d\n"x;y";it's;tab\there;plain\n`)
  assert.deepEqual(await readCsv(semi, { delimiter: ';' }).toArray(), rows)

  const tsv = tmp('t.tsv')
  await writeCsv(tsv, rows, { delimiter: '\t' })
  assert.equal(raw(tsv), `a\tb\tc\td\nx;y\tit's\t"tab\there"\tplain\n`)
  assert.deepEqual(await readCsv(tsv, { delimiter: '\t' }).toArray(), rows)

  const sq = tmp('sq.csv')
  await writeCsv(sq, rows, { quote: "'", delimiter: ';' })
  assert.equal(raw(sq), `a;b;c;d\n'x;y';'it''s';tab\there;plain\n`)
  assert.deepEqual(await readCsv(sq, { quote: "'", delimiter: ';' }).toArray(), rows)
})

test('columns, header text and key order work like writeXlsx; width and numFmt are ignored', async () => {
  const file = tmp('cols.csv')
  const rows = [{ id: 1, name: 'a', extra: 'x' }, { id: 2, name: 'b', extra: 'y' }]
  await writeCsv(file, rows, { columns: [{ key: 'name', header: 'Name', width: 20 }, { key: 'id', numFmt: '0.00' }] })
  assert.equal(raw(file), 'Name,id\na,1\nb,2\n')
})

test('header option: off for objects, on for arrays with columns, default off for arrays', async () => {
  const a = tmp('h-off.csv')
  await writeCsv(a, [{ x: 1 }], { header: false })
  assert.equal(raw(a), '1\n')
  const b = tmp('h-arr.csv')
  await writeCsv(b, [[1, 2]], { columns: ['p', 'q'], header: true })
  assert.equal(raw(b), 'p,q\n1,2\n')
  const c = tmp('h-default.csv')
  await writeCsv(c, [[1, 2]])
  assert.equal(raw(c), '1,2\n')
  const d = tmp('h-only.csv')
  const res = await writeCsv(d, [], { columns: ['p', 'q'] })
  assert.equal(raw(d), 'p,q\n')
  assert.equal(res.rows, 1)
})

test('reading with header: false gives arrays; ragged rows are padded to the first row', async () => {
  const file = tmp('ragged.csv')
  fs.writeFileSync(file, 'a,b,c\n1,2\n1,2,3,4\n\nx,,z\n')
  assert.deepEqual(await readCsv(file, { header: false }).toArray(), [
    ['a', 'b', 'c'],
    ['1', '2', null],
    ['1', '2', '3', '4'],
    ['x', null, 'z'],
  ])
})

test('reading handles CRLF, a trailing line without newline, and duplicate or empty header cells', async () => {
  const file = tmp('crlf.csv')
  fs.writeFileSync(file, 'a,a,\r\n1,2,3\r\n4,5,6')
  assert.deepEqual(await readCsv(file).toArray(), [
    { a: '1', a_2: '2', column3: '3' },
    { a: '4', a_2: '5', column3: '6' },
  ])
})

test('a UTF-8 BOM is written on request and always stripped on read', async () => {
  const file = tmp('bom.csv')
  await writeCsv(file, [{ name: 'Zoë' }], { bom: true })
  const bytes = fs.readFileSync(file)
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.deepEqual(await readCsv(file).toArray(), [{ name: 'Zoë' }])
  const plain = tmp('nobom.csv')
  await writeCsv(plain, [{ name: 'Zoë' }])
  assert.notEqual(fs.readFileSync(plain)[0], 0xef)
})

test('batches have the requested size, and breaking out of the loop is clean', async () => {
  const file = tmp('batches.csv')
  const N = 2500
  await writeCsv(file, ({ *[Symbol.iterator]() { for (let i = 0; i < N; i++) yield [i, `v${i}`] } }), { batchSize: 700 })
  const sizes = []
  let seen = 0
  for await (const batch of readCsv(file, { header: false, batchSize: 1000, inferTypes: true })) {
    sizes.push(batch.length)
    for (const r of batch) assert.deepEqual(r, [seen, `v${seen++}`])
  }
  assert.deepEqual(sizes, [1000, 1000, 500])
  assert.equal(seen, N)
  for await (const batch of readCsv(file, { header: false, batchSize: 10 })) {
    assert.equal(batch.length, 10)
    break
  }
})

test('async sources work', async () => {
  const file = tmp('async.csv')
  async function* src() { for (let i = 0; i < 3000; i++) yield { i, sq: i * i } }
  const res = await writeCsv(file, src())
  assert.equal(res.rows, 3001)
  const all = await readCsv(file, { inferTypes: true }).toArray()
  assert.equal(all.length, 3000)
  assert.deepEqual(all[2999], { i: 2999, sq: 2999 * 2999 })
})

test('errors: bad rows name their position, a failed write leaves no file, a missing file rejects', async () => {
  const file = tmp('err.csv')
  await assert.rejects(() => writeCsv(file, [[1], [1, { nested: true }]]), /row 2, column 2/)
  assert.equal(fs.existsSync(file), false, 'partial output is removed')
  await assert.rejects(() => writeCsv(file, [{ a: 1 }, [1]]), /mixes arrays and objects/)
  async function* boom() { yield { a: 1 }; throw new Error('source failed') }
  await assert.rejects(() => writeCsv(file, boom()), /source failed/)
  assert.equal(fs.existsSync(file), false)
  await assert.rejects(() => readCsv(tmp('missing.csv')).toArray(), /cannot open/)
})

test('option validation', async () => {
  const f = tmp('opts.csv')
  await assert.rejects(() => writeCsv(f, [], { delimiter: ',,' }), /delimiter must be a single ASCII character/)
  await assert.rejects(() => writeCsv(f, [], { delimiter: '→' }), /delimiter must be a single ASCII character/)
  await assert.rejects(() => writeCsv(f, [], { quote: '' }), /quote must be a single ASCII character/)
  await assert.rejects(() => writeCsv(f, [], { bom: 'yes' }), /bom must be a boolean/)
  await assert.rejects(() => writeCsv(f, [], { batchSize: 0 }), /batchSize/)
  assert.throws(() => readCsv(f, { delimiter: 'ab' }), /delimiter/)
  assert.throws(() => readCsv(f, { inferTypes: 1 }), /inferTypes must be a boolean/)
  assert.throws(() => readCsv(''), /path/)
})

test('single-column rows with empty values survive', async () => {
  const file = tmp('single.csv')
  await writeCsv(file, [['a'], [null], ['c']], { header: false })
  assert.deepEqual(await readCsv(file, { header: false }).toArray(), [['a'], [null], ['c']])
})

test('csv written from a large iterable reads back in full', async () => {
  const file = tmp('big.csv')
  const N = 200_000
  function* src() { for (let i = 0; i < N; i++) yield { id: i, name: `user, "${i}"`, ok: i % 2 === 0 } }
  await writeCsv(file, src())
  let n = 0
  for await (const batch of readCsv(file, { inferTypes: true, batchSize: 5000 })) {
    for (const r of batch) {
      if (n % 1009 === 0) assert.deepEqual(r, { id: n, name: `user, "${n}"`, ok: n % 2 === 0 })
      n++
    }
  }
  assert.equal(n, N)
})
