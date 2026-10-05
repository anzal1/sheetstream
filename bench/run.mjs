// Reproducible benchmark. Every case runs in its own process under `nice -n 19 /usr/bin/time -l`,
// with --max-old-space-size=4096 and a hard time cap. Crashes and timeouts are recorded, not hidden.
//
//   node bench/run.mjs [--rows 1000000] [--cap 90] [--only write:exceljs-streaming,read:sheetstream]
//
// Writes bench/results.json and bench/RESULTS.md.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : dflt
}
const ROWS = Number(arg('rows', 1_000_000))
const CAP_S = Number(arg('cap', 90))
const only = arg('only', '')?.split(',').filter(Boolean)
const outDir = path.join(here, 'out')
fs.mkdirSync(outDir, { recursive: true })

const WRITES = [
  ['write:sheetstream-constant', 'sheetstream (constant)'],
  ['write:sheetstream-lowMemory', 'sheetstream (lowMemory)'],
  ['write:exceljs-default', 'exceljs default'],
  ['write:exceljs-streaming', 'exceljs streaming'],
  ['write:sheetjs-dense', 'SheetJS dense'],
]
const READS = [
  ['read:sheetstream', 'sheetstream'],
  ['read:exceljs-streaming', 'exceljs streaming'],
  ['read:sheetjs-dense', 'SheetJS dense'],
]
const readInput = path.join(outDir, 'write_sheetstream-constant.xlsx')

function parseTime(stderr) {
  // macOS: "  12.34 real ...", "  123456789  maximum resident set size" (bytes)
  let m = stderr.match(/([\d.]+)\s+real/)
  const wall = m ? parseFloat(m[1]) : null
  m = stderr.match(/(\d+)\s+maximum resident set size/)
  if (m) return { wall, rssMB: parseInt(m[1], 10) / 1e6 }
  // GNU time -v (Linux)
  m = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/)
  const w = stderr.match(/Elapsed \(wall clock\) time.*: (?:(\d+):)?(\d+):([\d.]+)/)
  const wallL = w ? (w[1] ? +w[1] * 3600 : 0) + +w[2] * 60 + parseFloat(w[3]) : wall
  return { wall: wallL, rssMB: m ? parseInt(m[1], 10) / 1024 : null }
}

function runCase(name) {
  const file = path.join(outDir, name.replace(':', '_') + '.xlsx')
  const isWrite = name.startsWith('write:')
  const input = isWrite ? file : readInput
  if (isWrite && fs.existsSync(file)) fs.rmSync(file)
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v'
  const cmd = ['nice', '-n', '19', '/usr/bin/time', timeFlag, process.execPath, '--max-old-space-size=4096',
    path.join(here, 'worker.mjs'), name, String(ROWS), input]
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-p.pid, 'SIGKILL') } catch {}
    }, CAP_S * 1000)
    p.on('close', (code) => {
      clearTimeout(timer)
      const elapsed = (Date.now() - t0) / 1000
      const { wall, rssMB } = parseTime(err)
      let status = 'ok', detail = ''
      let payload = null
      try { payload = JSON.parse(out.trim().split('\n').pop()) } catch {}
      if (timedOut) status = `timeout (>${CAP_S}s)`
      else if (code !== 0 || !payload) {
        status = 'crash'
        detail = (/(heap out of memory|Invalid string length|JavaScript heap)[^\n]*/i.exec(err)?.[0]) ||
          err.split('\n').filter((l) => /error|abort|fatal/i.test(l)).slice(0, 2).join(' | ') || `exit ${code}`
      }
      const rec = {
        case: name, status, detail,
        seconds: status === 'ok' ? (wall ?? elapsed) : (timedOut ? CAP_S : +(wall ?? elapsed).toFixed(1)),
        rssMB: status === 'ok' ? +rssMB.toFixed(0) : null,
        fileMB: isWrite && fs.existsSync(file) && status === 'ok' ? +(fs.statSync(file).size / 1e6).toFixed(1) : null,
        rows: payload?.rows ?? null,
      }
      if (status === 'ok' && !isWrite && payload.rows !== ROWS) { rec.status = 'wrong row count'; rec.detail = `read ${payload.rows}` }
      console.log(JSON.stringify(rec))
      if (isWrite && name !== 'write:sheetstream-constant' && fs.existsSync(file)) fs.rmSync(file)
      resolve(rec)
    })
  })
}

const wanted = (id) => !only?.length || only.includes(id)
const results = []
for (const [id] of WRITES) if (wanted(id)) results.push(await runCase(id))
if (READS.some(([id]) => wanted(id)) && !fs.existsSync(readInput)) {
  console.log('read input missing, generating with sheetstream (constant)')
  await runCase('write:sheetstream-constant')
}
for (const [id] of READS) if (wanted(id)) results.push(await runCase(id))
if (fs.existsSync(readInput)) fs.rmSync(readInput)

// ---- report ----
let pkg = {}
try { pkg = require('../package.json') } catch {}
const ver = (n) => { try { return JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', n, 'package.json'), 'utf8')).version } catch { return '?' } }
const cpu = os.cpus()[0]?.model ?? 'unknown cpu'
const meta = {
  date: new Date().toISOString().slice(0, 10),
  rows: ROWS, cols: 10, capSeconds: CAP_S,
  node: process.version, platform: `${process.platform}-${process.arch}`, cpu, cores: os.cpus().length,
  versions: { sheetstream: pkg.version, exceljs: ver('exceljs'), xlsx: ver('xlsx') },
}
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify({ meta, results }, null, 2) + '\n')

const label = Object.fromEntries([...WRITES, ...READS])
const cell = (r) => (r.status === 'ok' ? [`${r.seconds.toFixed(1)}`, `${r.rssMB}`] : [r.status, '-'])
const table = (list, extra) => {
  const lines = [`| Library | Time (s) | Peak RSS (MB) |${extra ? ' File (MB) |' : ''} Notes |`, `|---|---:|---:|${extra ? '---:|' : ''}---|`]
  for (const [id] of list) {
    const r = results.find((x) => x.case === id)
    if (!r) continue
    const [t, m] = cell(r)
    lines.push(`| ${label[id]} | ${t} | ${m} |${extra ? ` ${r.fileMB ?? '-'} |` : ''} ${r.status === 'ok' ? '' : r.detail} |`)
  }
  return lines.join('\n')
}
const md = `# Benchmark results

${ROWS.toLocaleString('en-US')} rows x 10 columns (int, float, 6 strings of 5-20 chars, date, bool), seeded generator in \`bench/gen.mjs\`.
Run on ${meta.platform}, ${cpu}, ${meta.cores} cores, Node ${meta.node}, ${meta.date}.
Each case runs once in its own process under \`nice -n 19 /usr/bin/time ${process.platform === 'darwin' ? '-l' : '-v'}\` with \`--max-old-space-size=4096\` and a ${CAP_S} s cap.
Versions: sheetstream ${meta.versions.sheetstream}, exceljs ${meta.versions.exceljs}, SheetJS ${meta.versions.xlsx}.
Reproduce with \`npm run bench\`.

## Write

${table(WRITES, true)}

## Read

Input is the file written by sheetstream in constant mode. Every reader counts rows and cells and sums column 1.

${table(READS, false)}

Single runs; wall time under \`nice\` varies by roughly 25 percent between runs.
`
fs.writeFileSync(path.join(here, 'RESULTS.md'), md)
console.log('\n' + md)
