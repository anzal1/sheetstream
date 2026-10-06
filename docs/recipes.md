# Recipes

Copy-paste examples for the common ways to get large spreadsheets in and out of a web app. Each recipe says how it was checked. "Run" means the code in this file, extracted as written, was executed; "code only" means it was not.

Checked with sheetstream 0.1.0 as published on npm, Node 24, Express 5.2, Hono 4.13 with `@hono/node-server` 2, and busboy. The recipes use only the 0.1 API: `xlsxStream`, `writeXlsx`, `readXlsx`.

- [How `xlsxStream` behaves](#how-xlsxstream-behaves)
- [1. Express: stream a 1M-row export](#1-express-stream-a-1m-row-export)
- [2. Next.js App Router, Node runtime](#2-nextjs-app-router-node-runtime)
- [3. Hono on Node](#3-hono-on-node)
- [4. NestJS controller](#4-nestjs-controller)
- [5. Postgres cursor straight into writeXlsx](#5-postgres-cursor-straight-into-writexlsx)
- [6. Import a large upload in batches of 1,000](#6-import-a-large-upload-in-batches-of-1000)

## How `xlsxStream` behaves

Three facts shape every export recipe below.

- An xlsx file is a zip, and a zip cannot be sent before its central directory is known. So `xlsxStream` writes the whole workbook to a temp file first, then streams that file from disk and deletes it. Memory stays flat. Disk does not: the temp directory needs room for the sheet XML, about 5 times the final file size.
- Because of that, no byte reaches the client until the last row has been written. A 1M-row export takes several seconds of generation plus your query time, with an idle connection. If that can exceed a proxy or load balancer timeout (60 seconds is common), generate the file in a background job with `writeXlsx` and serve it from storage instead.
- If your row source throws, the stream emits an error. If the response headers are already out, the client gets a truncated download. Every recipe below waits for the stream to become readable before it commits to a 200, which costs nothing because the data is not available earlier anyway, and lets an early failure become a normal 500.

The helper used in the recipes:

```js
// Resolves when the first bytes are ready. Rejects if the export fails or the stream is destroyed first.
const ready = (stream) =>
  new Promise((resolve, reject) => {
    const closed = () => reject(new Error('Export stream closed before it was ready'))
    stream.once('error', reject)
    stream.once('close', closed)
    stream.once('readable', () => {
      stream.off('error', reject)
      stream.off('close', closed)
      resolve(stream)
    })
  })
```

## 1. Express: stream a 1M-row export

```js
// file: express-export.mjs
import express from 'express'
import { pipeline } from 'node:stream'
import { xlsxStream } from 'sheetstream'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const ready = (stream) =>
  new Promise((resolve, reject) => {
    const closed = () => reject(new Error('Export stream closed before it was ready'))
    stream.once('error', reject)
    stream.once('close', closed)
    stream.once('readable', () => {
      stream.off('error', reject)
      stream.off('close', closed)
      resolve(stream)
    })
  })

// Stand-in for your database cursor. Any async iterable of objects or arrays works.
async function* userRows(total) {
  for (let id = 1; id <= total; id++) {
    yield { id, name: `user ${id}`, email: `user${id}@example.com`, balance: id / 7, joined: new Date(Date.UTC(2020, 0, 1 + (id % 1000))), active: id % 2 === 0 }
  }
}

export const app = express()

app.get('/users.xlsx', async (req, res, next) => {
  const total = Math.min(Number(req.query.rows) || 1_000_000, 1_000_000)
  try {
    const stream = xlsxStream(userRows(total), { sheetName: 'Users' })
    // If the client goes away, destroying the stream stops the write and removes the temp directory.
    res.once('close', () => stream.destroy())
    const file = await ready(stream)
    res.set({ 'Content-Type': XLSX, 'Content-Disposition': 'attachment; filename="users.xlsx"' })
    pipeline(file, res, () => {})
  } catch (err) {
    if (!res.destroyed) next(err)
  }
})

if (process.argv[1] === new URL(import.meta.url).pathname) {
  app.listen(3000, () => console.log('http://localhost:3000/users.xlsx'))
}
```

Use `pipeline` and the `close` handler, not a bare `file.pipe(res)`. With a bare `pipe`, a client that disconnects leaves the writer running and the temp directory on disk until the whole file is done.

Row order and the header come from the first object's keys. Pass `columns: ['id', 'name']` to fix the order and the header text.

Status: run. The server was started on a random local port and `GET /users.xlsx?rows=100000` was fetched. Checks: HTTP 200 with the xlsx content type; the body starts with `PK`; `unzip -t` reports no errors; `readXlsx` on the saved file counted 100,000 data rows with the first row `{ id: 1, name: 'user 1', ... }` and the last `id` equal to 100000; openpyxl read the same row count and header. A row source that throws on row 5,000 produced a 500 and no attachment header. A request aborted mid-export left no `sheetstream-*` directory behind in the temp directory.

## 2. Next.js App Router, Node runtime

`app/api/users.xlsx/route.ts`:

```ts
// file: next-route.ts
import { Readable } from 'node:stream'
import { xlsxStream } from 'sheetstream'

export const runtime = 'nodejs' // sheetstream is a native addon, so not the edge runtime
export const dynamic = 'force-dynamic'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const ready = (stream: Readable) =>
  new Promise<Readable>((resolve, reject) => {
    const closed = () => reject(new Error('Export stream closed before it was ready'))
    stream.once('error', reject)
    stream.once('close', closed)
    stream.once('readable', () => {
      stream.off('error', reject)
      stream.off('close', closed)
      resolve(stream)
    })
  })

// Stand-in for your database cursor.
async function* userRows(total: number) {
  for (let id = 1; id <= total; id++) {
    yield { id, name: `user ${id}`, balance: id / 7 }
  }
}

export async function GET(request: Request) {
  const total = Math.min(Number(new URL(request.url).searchParams.get('rows')) || 1_000_000, 1_000_000)
  try {
    const stream = xlsxStream(userRows(total), { sheetName: 'Users' })
    request.signal.addEventListener('abort', () => stream.destroy())
    const file = await ready(stream)
    return new Response(Readable.toWeb(file) as unknown as ReadableStream, {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': 'attachment; filename="users.xlsx"' },
    })
  } catch {
    return new Response('Export failed', { status: 500 })
  }
}
```

`next.config.js`: keep the native addon out of the bundle.

```js
// Next 15 and later
module.exports = { serverExternalPackages: ['sheetstream'] }
// Next 14: module.exports = { experimental: { serverComponentsExternalPackages: ['sheetstream'] } }
```

Status: Next itself was not installed or run, so treat this as untested in Next. The `GET` function was run in Node with a plain `Request`: the response was 200 with the xlsx content type, and its body, read as a web stream, was a valid xlsx with 100,000 data rows (`unzip -t` clean, `readXlsx` count). Aborting the request signal destroyed the stream. Not shown: Next's bundler handling of the addon (the `serverExternalPackages` line is the documented fix, not something I ran), and behaviour on serverless hosts. A Vercel-style function with a short timeout is the wrong place for a long export for the reason given at the top.

## 3. Hono on Node

```ts
// file: hono-export.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { xlsxStream } from 'sheetstream'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const ready = (stream: Readable) =>
  new Promise<Readable>((resolve, reject) => {
    const closed = () => reject(new Error('Export stream closed before it was ready'))
    stream.once('error', reject)
    stream.once('close', closed)
    stream.once('readable', () => {
      stream.off('error', reject)
      stream.off('close', closed)
      resolve(stream)
    })
  })

// Stand-in for your database cursor.
async function* userRows(total: number) {
  for (let id = 1; id <= total; id++) {
    yield { id, name: `user ${id}`, balance: id / 7 }
  }
}

export const app = new Hono()

app.get('/users.xlsx', async (c) => {
  const total = Math.min(Number(c.req.query('rows')) || 1_000_000, 1_000_000)
  const stream = xlsxStream(userRows(total), { sheetName: 'Users' })
  c.req.raw.signal.addEventListener('abort', () => stream.destroy())
  const file = await ready(stream)
  c.header('Content-Type', XLSX)
  c.header('Content-Disposition', 'attachment; filename="users.xlsx"')
  return c.body(Readable.toWeb(file) as unknown as ReadableStream)
})

app.onError((err, c) => c.text('Export failed', 500))

if (process.argv[1] === new URL(import.meta.url).pathname) {
  serve({ fetch: app.fetch, port: 3000 })
}
```

Hono's response body is a web stream, so `Readable.toWeb` is the bridge. This only works where the native addon loads, so Node (and Bun, untested). Not on Workers or Deno Deploy.

Status: run with `@hono/node-server` on a random local port. `GET /users.xlsx?rows=100000` returned 200 with the xlsx content type and a valid file (`unzip -t` clean, `readXlsx` counted 100,000 data rows). A throwing row source returned the 500 from `onError` (checked through `app.request()`), and a client that aborted mid-export left no temp directory behind.

## 4. NestJS controller

```ts
// file: reports.controller.ts
import { Controller, Get, StreamableFile } from '@nestjs/common'
import type { Readable } from 'node:stream'
import { xlsxStream } from 'sheetstream'
import { UsersService } from './users.service'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const ready = (stream: Readable) =>
  new Promise<Readable>((resolve, reject) => {
    const closed = () => reject(new Error('Export stream closed before it was ready'))
    stream.once('error', reject)
    stream.once('close', closed)
    stream.once('readable', () => {
      stream.off('error', reject)
      stream.off('close', closed)
      resolve(stream)
    })
  })

@Controller('reports')
export class ReportsController {
  constructor(private readonly users: UsersService) {}

  @Get('users.xlsx')
  async exportUsers(): Promise<StreamableFile> {
    // users.iterate() is yours: any async iterable of objects, such as a TypeORM or Prisma stream or a pg cursor generator (recipe 5).
    const file = await ready(xlsxStream(this.users.iterate(), { sheetName: 'Users' }))
    return new StreamableFile(file, {
      type: XLSX,
      disposition: 'attachment; filename="users.xlsx"',
    })
  }
}
```

Return the `StreamableFile` and do not inject `@Res()`. Nest then pipes the stream, sets the headers, and works the same on the Express and Fastify adapters. If the route throws before returning (the `await ready` rejects), Nest's exception filter produces the normal 500.

Status: code only. Nest was not installed. The `ready` helper and the stream it wraps are the same ones run in recipes 1 to 3. The `StreamableFile` options (`type`, `disposition`) are from Nest's documented API as I remember it (v8 and later), so check them against your version.

## 5. Postgres cursor straight into writeXlsx

`writeXlsx` takes any async iterable, and it pulls from it as fast as the file can be written, so a database cursor gives you backpressure for free. Rows are never all in memory: one cursor batch and one writer batch at a time.

With `pg` and `pg-cursor`:

```ts
// file: pg-export.ts
import type { Pool } from 'pg'
import Cursor from 'pg-cursor'
import { writeXlsx } from 'sheetstream'

async function* cursorRows(pool: Pool, text: string, values: unknown[] = [], batch = 1000) {
  const client = await pool.connect()
  try {
    const cursor = client.query(new Cursor(text, values))
    try {
      for (;;) {
        const rows = await cursor.read(batch)
        if (rows.length === 0) return
        yield* rows
      }
    } finally {
      await cursor.close()
    }
  } finally {
    client.release()
  }
}

export async function exportOrders(pool: Pool, path: string, signal?: AbortSignal) {
  return writeXlsx(
    path,
    cursorRows(pool, 'select id, customer, total::float8 as total, created_at from orders order by id'),
    { sheetName: 'Orders', signal }
  )
}
```

With postgres.js, `.cursor(n)` is async iterable and yields arrays of rows:

```ts
// file: postgres-js-export.ts
import postgres from 'postgres'
import { writeXlsx } from 'sheetstream'

const sql = postgres(process.env.DATABASE_URL!)

async function* orderRows() {
  for await (const rows of sql`select id, customer, total::float8 as total, created_at from orders order by id`.cursor(1000)) {
    yield* rows
  }
}

export const exportOrders = (path: string) => writeXlsx(path, orderRows(), { sheetName: 'Orders' })
```

To send it over HTTP instead of writing a file, hand the same generator to `xlsxStream` as in recipes 1 to 3.

What to watch:

- **Types.** `pg` returns `int8` and `numeric` as strings, so they become text cells in Excel. Cast in SQL (`total::float8`, `id::int`) or register a parser such as `pg.types.setTypeParser(1700, parseFloat)`. `timestamptz` arrives as a `Date`, which writes as an Excel date. `json` and `jsonb` columns arrive as objects, and `writeXlsx` throws on those with the row and column, so cast them to text.
- **Cleanup.** The `finally` blocks run when `writeXlsx` stops early (an error or an `AbortSignal`), because stopping the loop closes the generator. That releases the client even when the export fails or you pass a `signal` to cancel it.
- **Consistency.** A cursor only lives inside a transaction in Postgres, and `pg-cursor` and postgres.js each open one for you. A long export holds that snapshot and the connection for its whole duration, so use a read replica for very large exports.
- **Order.** Add an `order by`. The header comes from the first row's keys, and without a stable order a retry produces a different file.

Status: code only against a real database. There is no Postgres on this machine. I ran the `pg-cursor` generator against a fake pool and cursor with the same `read(n)` and `close()` shape, real `pg-cursor` imported for the constructor, and `writeXlsx` writing 100,000 rows to a file: `readXlsx` counted 100,000 data rows, every `read` was asked for 1,000 rows, and an aborted `AbortSignal` mid-write left the fake cursor closed and the fake client released. Whether `pg-cursor` and postgres.js behave as described against a live server is from their documentation, not from a run. `pg` and `postgres` themselves were not installed.

## 6. Import a large upload in batches of 1,000

`readXlsx` reads from a path, so the upload has to land on disk first. Stream it there with busboy (no multer, no buffering in memory), then read it back 1,000 rows at a time. `readXlsx` already yields batches of at most `batchSize` rows, so one loop turn is one insert. The header row counts toward the first batch in 0.1.0, so with the default header handling the first batch holds 999 data rows and the later ones 1,000.

The insert function, here with postgres.js (a multi-row `insert` from an array of objects):

```js
// file: db.mjs
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL)

// One statement per batch. Postgres allows 65,535 parameters per statement, so
// 1,000 rows is safe up to 65 columns. Use fewer rows per batch beyond that.
export async function insertMany(rows) {
  await sql`insert into contacts ${sql(rows, 'name', 'email', 'age')}`
}
```

The route:

```js
// file: express-import.mjs
import busboy from 'busboy'
import express from 'express'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { readXlsx } from 'sheetstream'
import { insertMany } from './db.mjs'

const BATCH = 1000
const MAX_UPLOAD = 200 * 1024 * 1024
const REQUIRED = ['name', 'email', 'age']

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function saveUpload(req, dest) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD } })
    let seen = false
    bb.on('file', (_field, stream) => {
      seen = true
      let truncated = false
      stream.on('limit', () => (truncated = true))
      pipeline(stream, createWriteStream(dest)).then(
        () => (truncated ? reject(new HttpError(413, 'File too large')) : resolve()),
        reject
      )
    })
    bb.on('error', reject)
    bb.on('close', () => seen || reject(new HttpError(400, 'No file in the upload')))
    req.pipe(bb)
  })
}

export const app = express()

app.post('/import', async (req, res, next) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-'))
  try {
    const file = path.join(dir, 'upload.xlsx')
    await saveUpload(req, file)

    let imported = 0
    let checked = false
    try {
      for await (const batch of readXlsx(file, { batchSize: BATCH })) {
        if (!checked) {
          const missing = REQUIRED.filter((key) => !(key in batch[0]))
          if (missing.length) throw new HttpError(400, `Missing columns: ${missing.join(', ')}`)
          checked = true
        }
        await insertMany(batch)
        imported += batch.length
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (imported === 0) throw new HttpError(400, 'Not a readable .xlsx file')
      throw err
    }
    res.json({ imported })
  } catch (err) {
    next(err)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Import failed' })
})

if (process.argv[1] === new URL(import.meta.url).pathname) {
  app.listen(3000, () => console.log('POST a multipart form with one file to http://localhost:3000/import'))
}
```

What to watch:

- **Partial imports.** If the file fails at row 40,000, the first 39 batches are already in the table. Wrap the loop in one transaction if you want all or nothing, or insert into a staging table and swap. For a huge file, a staging table is kinder than a long transaction.
- **Validate the header and the first rows before the first insert**, as the column check above does for the header. Bad data in batch 1,200 is much more expensive than bad data in batch 1.
- **Cell types.** Dates arrive as `Date` (UTC), empty cells as `null`, numbers as numbers. Duplicate or empty headers become `name_2` and `column3`. Formulas arrive as their cached values.
- **Idempotency.** A retry after a failure re-inserts everything. Use `on conflict do nothing` or an upload id.
- **Limits.** `MAX_UPLOAD` caps the bytes written to disk. The file is compressed, so a small upload can expand into a large sheet. Reading holds the file's shared strings table in memory, and a file with millions of distinct strings costs real RAM.
- **Disk.** The upload and the temp directory live on local disk. That is fine on a server, and not on a read-only or tiny serverless filesystem.

Status: run, with `insertMany` replaced by an in-memory recorder (there is no database here; the postgres.js call itself was not run). A 100,000-row workbook written by `writeXlsx` was uploaded as multipart form data to the route on a random local port. Result: HTTP 200 with `{ imported: 100000 }`; the recorder saw 101 batches (the first with 999 rows, then 99 with 1,000, then one with the last row), with the first and last rows matching what was written; the temp directory was gone afterwards. An upload of a text file renamed `.xlsx` returned 400, a file missing the `email` column returned 400 with no insert, and an upload over a lowered size cap returned 413.
