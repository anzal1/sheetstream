// Deterministic lazy row generator, same shape as the kill test:
// int, float, 6 strings (5-20 chars from 20k-string pools), date, bool.
const SEED = 0x5eed1234
export function h(x) {
  x = x >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789'
export const POOL = 20000
function poolStr(c, i) {
  const base = (SEED + Math.imul(i, 7) + Math.imul(c, 1000003)) >>> 0
  const len = 5 + (h(base) % 16)
  let s = ''
  for (let k = 0; k < len; k++) s += ALPHA[h((base + Math.imul(k, 31) + 1) >>> 0) % 36]
  return s
}
const pools = []
for (let c = 2; c < 8; c++) {
  const p = new Array(POOL)
  for (let i = 0; i < POOL; i++) p[i] = poolStr(c, i)
  pools[c] = p
}
const BASE = Date.UTC(2020, 0, 1)
export const DATES = []
for (let d = 0; d < 2000; d++) DATES.push(new Date(BASE + d * 86400000))

export function row(r) {
  const k = (c) => h((Math.imul(r, 10) + c + SEED) >>> 0)
  return [
    k(0) % 1000000,
    (k(1) % 10000000) / 100,
    pools[2][k(2) % POOL], pools[3][k(3) % POOL], pools[4][k(4) % POOL],
    pools[5][k(5) % POOL], pools[6][k(6) % POOL], pools[7][k(7) % POOL],
    DATES[k(8) % 2000],
    (k(9) & 1) === 1,
  ]
}

export function* rows(n) {
  for (let r = 0; r < n; r++) yield row(r)
}
