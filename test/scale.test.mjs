import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeXlsx, readXlsx } from '../index.js'
import { rows, row } from '../bench/gen.mjs'
import { tmpDir } from './helpers.mjs'

const tmp = tmpDir('scale')
const N = 100_000

for (const mode of ['constant', 'lowMemory']) {
  test(`100k rows x 10 cols write and read, values intact (${mode})`, async () => {
    const file = tmp(`100k-${mode}.xlsx`)
    const t0 = performance.now()
    const res = await writeXlsx(file, rows(N), { mode })
    const tw = performance.now() - t0
    assert.equal(res.rows, N)

    const t1 = performance.now()
    let count = 0
    for await (const batch of readXlsx(file, { header: false })) {
      for (const r of batch) {
        // Check every 997th row in full, plus shape on all of them.
        assert.equal(r.length, 10)
        if (count % 997 === 0) assert.deepEqual(r, row(count))
        count++
      }
    }
    const tr = performance.now() - t1
    assert.equal(count, N)
    console.log(`  ${mode}: write ${tw.toFixed(0)} ms, read ${tr.toFixed(0)} ms, ${(res.bytes / 1e6).toFixed(1)} MB`)
    assert.ok(tw < 15_000 && tr < 15_000)
  })
}
