import type { Readable } from 'node:stream'

export type Cell = string | number | boolean | bigint | Date | null | undefined
export type RowArray = Cell[]
export type RowObject = Record<string, Cell>
export type Row = RowArray | RowObject

export type Mode = 'constant' | 'lowMemory'

/** A column with options. A plain string is shorthand for `{ key: string }`. */
export interface ColumnSpec {
  /** Property name for object rows. For array rows only the position matters. */
  key: string
  /** Header text. Defaults to `key`. */
  header?: string
  /** Width in Excel character units (the number Excel shows in its column width box), above 0 and up to 255. XLSX only. */
  width?: number
  /**
   * Excel number format for the column, such as '#,##0.00', '0%' or 'yyyy-mm-dd'. XLSX only.
   * Numbers and Dates in the column use it (it replaces the default date format); the header row does not.
   */
  numFmt?: string
}

export type Column = string | ColumnSpec

export interface HeaderStyle {
  bold?: boolean
  /** Background color as hex: '#1F4E79', '1F4E79' or '#fff'. */
  fill?: string
  /** Text color as hex. */
  fontColor?: string
  /** Thin border around each header cell. */
  border?: boolean
}

export interface SheetOptions {
  /**
   * Keys and order for object rows, optionally with header text, width and number format per column.
   * Inferred from the first object (keys only) when omitted.
   */
  columns?: Column[]
  /** Write a header row. Defaults to true for object rows, false for array rows. Array rows need `columns` to have a header. */
  header?: boolean
  /** Style for the header row. Default: plain. XLSX only. */
  headerStyle?: HeaderStyle
  /** Freeze the header row so it stays visible when scrolling. Needs a header row. XLSX only. */
  freezeHeader?: boolean
  /** Add filter dropdowns to the header row. Needs a header row. XLSX only. */
  autoFilter?: boolean
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

export interface CsvWriteOptions {
  /** Keys, order and header text, same as writeXlsx. `width` and `numFmt` are ignored. */
  columns?: Column[]
  /** Write a header row. Defaults to true for object rows, false for array rows. */
  header?: boolean
  /** One ASCII character. Default ','. */
  delimiter?: string
  /** One ASCII character. Default '"'. Fields containing it, the delimiter or a line break are quoted. */
  quote?: string
  /** Start the file with a UTF-8 byte order mark, which makes Excel read non-ASCII text correctly. Default false. */
  bom?: boolean
  /** Rows per native call. Default 1000. */
  batchSize?: number
  /** Abort a write in progress. The partial file is deleted. */
  signal?: AbortSignal
}

export interface CsvReadOptions {
  /** One ASCII character. Default ','. */
  delimiter?: string
  /** One ASCII character. Default '"'. */
  quote?: string
  /** Rows per batch. Default 1000. */
  batchSize?: number
  /** Treat the first row as a header and yield objects. Default true. */
  header?: boolean
  /**
   * Turn plain numbers, true/false and ISO dates ('2024-02-29', '2024-02-29T13:45:30Z') into numbers,
   * booleans and Dates. Default false: every non-empty field is a string. Ids with leading zeros and
   * numbers over 15 digits always stay strings.
   */
  inferTypes?: boolean
}

export type CsvRow = Record<string, string | number | boolean | Date | null>
export type CsvRowArray = Array<string | number | boolean | Date | null>

/** Streams rows to a CSV file. Dates are written as ISO 8601 in UTC; null and undefined as empty fields. */
export function writeCsv(
  path: string,
  rows: Iterable<Row> | AsyncIterable<Row>,
  options?: CsvWriteOptions,
): Promise<WriteResult>

/** Async-iterable of row batches. Empty fields read as null; rows shorter than the first row are padded with null. */
export function readCsv(path: string, options: CsvReadOptions & { header: false }): XlsxReadStream<CsvRowArray>
export function readCsv(path: string, options?: CsvReadOptions): XlsxReadStream<CsvRow>

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
