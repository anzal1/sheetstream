import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./mem-write.fixture.mjs', import.meta.url))
const LIMIT_MB = 150

// The child process reports both a sampled RSS (process.memoryUsage().rss every 50 ms)
// and the kernel's true peak (resourceUsage().maxRSS). Both must stay under the limit.
const cases = [
  ['constant', 'plain', 'writing 1M rows x 10 cols'],
  ['constant', 'formatted', 'writing 1M rows x 10 cols with column formats and headerStyle'],
  ['constant', 'csv', 'writing 1M rows x 10 cols as CSV'],
]
for (const [mode, variant, label] of cases) {
  test(`${label} keeps RSS under ${LIMIT_MB} MB (${variant})`, { timeout: 120_000 }, () => {
    const out = execFileSync(process.execPath, [fixture, '1000000', mode, variant], { encoding: 'utf8' })
    const r = JSON.parse(out.trim().split('\n').pop())
    console.log(`  ${variant}: ${r.rows} rows in ${r.seconds.toFixed(1)} s, ${(r.bytes / 1e6).toFixed(0)} MB file, sampled max RSS ${r.sampledMaxRssMB.toFixed(0)} MB, peak ${r.peakRssMB.toFixed(0)} MB`)
    assert.equal(r.rows, 1_000_001 - (variant === 'plain' ? 1 : 0))
    assert.ok(r.sampledMaxRssMB < LIMIT_MB, `sampled RSS ${r.sampledMaxRssMB} MB`)
    assert.ok(r.peakRssMB < LIMIT_MB, `peak RSS ${r.peakRssMB} MB`)
  })
}
