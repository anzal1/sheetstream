# sheetstream

Read and write XLSX files of any size from Node.js without ever holding all the rows in JavaScript.

Status: v0.1, not on npm yet. The API below works and is tested on macOS; prebuilt binaries for the other platforms come from CI on the first release. Bun should work through its napi support but isn't tested yet.

Native code (Rust, through napi-rs) does the parsing and zipping. Rows go in and out in batches of 1000 by default, so a million-row file costs tens of megabytes, not gigabytes.

## Install

```sh
npm install sheetstream
```

Once released, prebuilt binaries ship for macOS (arm64, x64), Linux (x64 glibc, x64 musl, arm64 glibc) and Windows (x64), so there is nothing to compile on install.

## Usage

```js
import { writeXlsx, readXlsx } from 'sheetstream'

function* rows() {
  for (let i = 0; i < 1_000_000; i++) yield { id: i, name: `user ${i}`, joined: new Date(), active: i % 2 === 0 }
}

await writeXlsx('users.xlsx', rows())            // resolves to { rows, bytes }

for await (const batch of readXlsx('users.xlsx')) {
  for (const user of batch) { /* user: { id, name, joined, active } */ }
}
```

More in [examples/](examples/): streaming an HTTP response, multiple sheets, a million-row round trip.

## API

```ts
import { writeXlsx, readXlsx, XlsxWriter, listSheets, xlsxStream, toBuffer } from 'sheetstream'
```

### `writeXlsx(path, rows, options?)`

`rows` is any `Iterable` or `AsyncIterable` of arrays or plain objects. Rows are collected into batches and sent to Rust one batch at a time. Resolves to `{ rows, bytes }`. `rows` counts every row written, including the header.

| Option | Default | Meaning |
|---|---|---|
| `sheetName` | `'Sheet1'` | Name of the sheet. |
| `columns` | inferred | Header text and key order for object rows. If omitted, the keys of the first object are used. |
| `header` | `true` for object rows, `false` for array rows | Write a header row. |
| `mode` | `'constant'` | `'constant'` writes inline strings and uses the least memory. `'lowMemory'` uses shared strings: smaller files, and memory grows with the number of distinct strings. |
| `batchSize` | `1000` | Rows per native call. |
| `signal` | none | An `AbortSignal` to stop a write in progress. |

A sync generator is fine as a source. The writer hands control back to the event loop every few milliseconds, so timers and requests keep running during a long write.

### `XlsxWriter`, multiple sheets

```js
const w = new XlsxWriter('out.xlsx', { mode: 'constant' })
const orders = w.addSheet('Orders', { columns: ['id', 'total'] })   // header, columns
orders.writeRows([{ id: 1, total: 9.5 }])                           // array of arrays or objects
await w.close()                                                     // { rows, bytes }
```

Each sheet must receive rows in order and uses either arrays or objects, not both. `w.abort()` discards everything without writing a file.

### `xlsxStream(rows, options?)` and `toBuffer(rows, options?)`

`xlsxStream` returns a Node `Readable` you can pipe into an HTTP response. An XLSX file is a zip, and a zip cannot be emitted before its central directory is known, so the workbook is written to a temp file first, then streamed from disk and deleted. `Readable.toWeb(stream)` gives a web `ReadableStream`.

`toBuffer` resolves to a `Buffer` of the whole file. Use it for small outputs only.

### `readXlsx(path, options?)`

Returns an async iterable of batches.

| Option | Default | Meaning |
|---|---|---|
| `sheet` | first sheet | Sheet name or zero-based index. |
| `batchSize` | `1000` | Rows per batch. |
| `header` | `true` | Use the first row as keys and yield objects. With `false`, batches are arrays of arrays. |

```js
for await (const batch of readXlsx('in.xlsx', { sheet: 'Orders', batchSize: 5000 })) { /* object[] */ }
const all = await readXlsx('small.xlsx').toArray()   // explicit opt-in, see below
```

Breaking out of the loop stops the native reader and closes the file. A parser thread runs a few batches ahead of your loop.

### `listSheets(path)`

Resolves to `[{ name, index }]`.

## Memory versus convenience

Streaming is the default and the only thing the library does on its own. `toArray()` exists because sometimes you want the whole sheet, but it holds every row in V8 memory. Measured here, `toArray()` on the million-row benchmark file peaked at about 590 MB of RSS with `header: false`, and object rows cost more. Sheets much larger than that will hit Node's heap limit. Prefer the async iterator and process each batch as it arrives.

Memory you should still expect:

- Writing in `'constant'` mode holds one batch plus a small zip buffer. The sheet XML goes to a temp file (about 5 times the final file size, 525 MB for the million-row benchmark file) before it is compressed into the output, so the temp directory needs the disk space.
- Writing in `'lowMemory'` mode also keeps the table of distinct strings in RAM. It is cheap for repeated values and costly for a million unique strings.
- Reading holds the file's shared strings table in RAM (the whole table, not just the strings in the current batch). Files written in `'constant'` mode have none.
- `xlsxStream` and `toBuffer` write to a temp file, so disk, not RAM, is the cost.

## Cell mapping

Write:

| JS value | Cell |
|---|---|
| number | number (NaN and Infinity are written as text, Excel cannot store them) |
| string | string (inline in `'constant'` mode), up to 32,767 characters |
| boolean | boolean |
| Date | Excel date or datetime with a date format. Dates before 1900-01-01 cannot be stored by Excel and are written as ISO text. An invalid Date is an empty cell. |
| null, undefined | empty cell |
| bigint | number if it is within the safe integer range, otherwise a string |
| anything else | throws, with the row and column |

Read:

| Cell | JS value |
|---|---|
| number, string, boolean | as is |
| date or datetime format | `Date` (UTC) |
| duration format | number of days |
| error (`#DIV/0!` and so on), empty | `null` |
| formula | its cached value |

Reading details: leading blank rows are skipped, interior blank rows are kept as rows of `null`, and column A is always index 0. Rows are padded with `null` to the width the sheet declares, so trailing empty cells in a row survive only if the sheet's used range reaches them. Duplicate or empty header cells become `name_2`, `column3` and so on.

## Support matrix

| | v0.1 |
|---|---|
| Cell data: numbers, strings, booleans, dates, empty | yes |
| Several sheets, choose by name or index | yes |
| Streaming read and write, any iterable or async iterable | yes |
| Object rows with column inference | yes |
| Styles (fonts, fills, borders, number formats beyond dates), column widths | not yet |
| Formulas (writing them) | not yet |
| Merged cells, freeze panes, filters | not yet |
| Images and charts | not yet |
| Reading `.xls`, `.xlsb`, `.ods`, password-protected files | not yet |
| Node.js 18+ | yes |
| Bun | expected to work through N-API, not yet tested in CI |

Excel's own limits apply: 1,048,576 rows and 16,384 columns per sheet.

## Benchmark

1,000,000 rows by 10 columns (int, float, six short strings, date, bool). Apple M5 Max, Node 24.20, each case run once in its own process under `nice` with `--max-old-space-size=4096` and a 90 second cap. Peak RSS comes from `/usr/bin/time -l` and includes the benchmark's row generator, about 65 MB.

Write:

| Library | Time (s) | Peak RSS (MB) | File (MB) |
|---|---:|---:|---:|
| sheetstream (constant) | 5.5 | 82 | 110.9 |
| sheetstream (lowMemory) | 5.4 | 101 | 68.6 |
| exceljs default | crash (heap out of memory) | - | - |
| exceljs streaming | 12.3 | 749 | 78.1 |
| SheetJS dense | 9.1 | 3270 | 214.9 |

Read (input written by sheetstream):

| Library | Time (s) | Peak RSS (MB) |
|---|---:|---:|
| sheetstream | 2.4 | 93 |
| exceljs streaming | 9.1 | 376 |
| SheetJS dense | 16.3 | 3048 |

The honest summary: memory is a very large win, reading is about 4 times faster than exceljs streaming, and writing is about 2 times faster than the best JS option. Reproduce with `npm run bench` (full numbers in [bench/RESULTS.md](bench/RESULTS.md)).

## Building from source

```sh
npm install
npm run build        # needs a Rust toolchain
npm test
```

## License

MIT
