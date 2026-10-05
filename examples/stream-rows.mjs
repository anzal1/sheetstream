import { writeXlsx, readXlsx, listSheets } from 'sheetstream'

// Rows come from a generator, so only one batch of 1000 is in memory at a time.
function* orders(n) {
  for (let i = 1; i <= n; i++) {
    yield { id: i, customer: `customer-${i % 500}`, total: i * 1.25, paid: i % 3 === 0, placed: new Date(Date.UTC(2025, 0, 1 + (i % 365))) }
  }
}

const { rows, bytes } = await writeXlsx('orders.xlsx', orders(1_000_000), { sheetName: 'Orders' })
console.log(`wrote ${rows} rows, ${(bytes / 1e6).toFixed(0)} MB`)
console.log(await listSheets('orders.xlsx'))

let total = 0
for await (const batch of readXlsx('orders.xlsx')) {
  for (const order of batch) total += order.total
}
console.log('sum of totals:', total)
