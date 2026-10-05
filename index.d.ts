import type { Readable } from 'node:stream'

export type Cell = string | number | boolean | bigint | Date | null | undefined
export type RowArray = Cell[]
export type RowObject = Record<string, Cell>
export type Row = RowArray | RowObject

export type Mode = 'constant' | 'lowMemory'

export interface SheetOptions {
  /** Header and key order for object rows. Inferred from the first object when omitted. */
  columns?: string[]
  /** Write a header row. Defaults to true for object rows, false for array rows. */
  header?: boolean
}

export interface WriteOptions extends SheetOptions {
  /** Default 'Sheet1'. */
  sheetName?: string
  /**
   * 'constant' writes inline strings and uses the least memory (default).
   * 'lowMemory' uses shared strings: smaller files, memory grows with the number of distinct strings.
   */
  mode?: Mode
  /** Rows per native call. Default 1000. */
  batchSize?: number
  /** Abort a write in progress. */
  signal?: AbortSignal
}

export interface WriteResult {
  /** Rows written, including header rows. */
  rows: number
  /** Size of the finished file. */
  bytes: number
}

export interface SheetInfo {
  name: string
  index: number
}

export interface ReadOptions {
  /** Sheet name or zero-based index. Default: the first sheet. */
  sheet?: number | string
  /** Rows per batch. Default 1000. */
  batchSize?: number
  /** Treat the first row as a header and yield objects. Default true. */
  header?: boolean
}

/** Async-iterable of row batches. `toArray()` materializes everything and costs memory proportional to the sheet. */
export interface XlsxReadStream<T> extends AsyncIterable<T[]> {
  toArray(): Promise<T[]>
}

export type ReadRow = Record<string, string | number | boolean | Date | null>
export type ReadRowArray = Array<string | number | boolean | Date | null>

export function writeXlsx(
  path: string,
  rows: Iterable<Row> | AsyncIterable<Row>,
  options?: WriteOptions,
): Promise<WriteResult>

export function readXlsx(path: string, options: ReadOptions & { header: false }): XlsxReadStream<ReadRowArray>
export function readXlsx(path: string, options?: ReadOptions): XlsxReadStream<ReadRow>

export function listSheets(path: string): Promise<SheetInfo[]>

export class XlsxSheet {
  /** Write one batch of row arrays or plain objects. Returns the number of rows written. */
  writeRows(batch: Row[]): number
}

export class XlsxWriter {
  constructor(path: string, options?: { mode?: Mode })
  addSheet(name?: string, options?: SheetOptions): XlsxSheet
  /** Finish the file. */
  close(): Promise<WriteResult>
  /** Discard everything written so far. */
  abort(): void
}

/** Node Readable of the finished file. Writes a temp file under the hood and deletes it afterwards. */
export function xlsxStream(rows: Iterable<Row> | AsyncIterable<Row>, options?: WriteOptions): Readable

/** The whole file in memory. Prefer xlsxStream for large outputs. */
export function toBuffer(rows: Iterable<Row> | AsyncIterable<Row>, options?: WriteOptions): Promise<Buffer>
