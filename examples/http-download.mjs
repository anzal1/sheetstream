import http from 'node:http'
import { xlsxStream } from 'sheetstream'

async function* rows() {
  for (let i = 0; i < 200_000; i++) yield [i, `item ${i}`, i / 3]
}

// GET /report.xlsx streams a spreadsheet without holding it in memory.
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"')
    xlsxStream(rows(), { columns: ['id', 'name', 'value'], header: true }).pipe(res)
  })
  .listen(3000, () => console.log('http://localhost:3000/report.xlsx'))
