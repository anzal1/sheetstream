//! Streaming writer. JS hands us batches of rows; we write them straight into a
//! rust_xlsxwriter worksheet running in constant-memory or low-memory mode, so
//! neither side ever holds the whole sheet.

use std::ptr;

use napi::{sys, Env, Error, JsValue, Result, Status, Task};
use napi::bindgen_prelude::{Array, AsyncTask};
use napi_derive::napi;
use rust_xlsxwriter::{Color, Format, FormatBorder, Workbook, Worksheet};

const MS_PER_DAY: f64 = 86_400_000.0;
const UNIX_EPOCH_SERIAL: f64 = 25_569.0;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Unknown,
    Array,
    Object,
}

/// Row bookkeeping shared by the XLSX and CSV writers.
pub(crate) struct Core {
    /// Property keys for object rows (and the header text unless `headers` is set).
    pub columns: Option<Vec<String>>,
    /// Header text per column, when it differs from the keys.
    pub headers: Option<Vec<String>>,
    /// None = decide from the first row (header for object rows only).
    pub header: Option<bool>,
    pub started: bool,
    pub header_written: bool,
    pub header_row: u32,
    pub next_row: u32,
    pub kind: Kind,
    pub rows: u64,
}

impl Core {
    pub fn new(columns: Option<Vec<String>>, headers: Option<Vec<String>>, header: Option<bool>) -> Self {
        Core { columns, headers, header, started: false, header_written: false, header_row: 0, next_row: 0, kind: Kind::Unknown, rows: 0 }
    }

    fn header_texts(&self) -> Vec<String> {
        match (&self.headers, &self.columns) {
            (Some(h), Some(c)) => (0..c.len()).map(|i| h.get(i).unwrap_or(&c[i]).clone()).collect(),
            (None, Some(c)) => c.clone(),
            _ => Vec::new(),
        }
    }

    /// One-time setup before the first cell: lets the sink configure the sheet, then writes the header row.
    pub fn start<S: Sink>(&mut self, sink: &mut S, want_header: bool) -> Result<()> {
        self.started = true;
        let will_header = want_header && self.columns.is_some();
        sink.begin(self, will_header)?;
        if will_header {
            let texts = self.header_texts();
            sink.header(self.next_row, &texts)?;
            sink.end_row()?;
            self.header_row = self.next_row;
            self.next_row += 1;
            self.rows += 1;
            self.header_written = true;
        }
        Ok(())
    }
}

/// Where cells go: an xlsx worksheet or a CSV record stream.
pub(crate) trait Sink {
    /// Called once before the first cell is written.
    fn begin(&mut self, core: &Core, will_header: bool) -> Result<()>;
    fn header(&mut self, row: u32, texts: &[String]) -> Result<()>;
    /// # Safety
    /// `env` and `v` must be valid for the current N-API call.
    unsafe fn cell(&mut self, env: sys::napi_env, buf: &mut Vec<u8>, r: u32, c: u32, v: sys::napi_value) -> Result<()>;
    /// Called after every row (header and blank rows included).
    fn end_row(&mut self) -> Result<()>;
}

/// Walks a batch of rows (arrays or plain objects) and feeds a sink.
pub(crate) fn drive_rows<S: Sink>(
    env: &Env,
    core: &mut Core,
    sink: &mut S,
    strbuf: &mut Vec<u8>,
    rows: Array,
) -> Result<u32> {
    let raw_env = env.raw();
    let arr = rows.value().value;
    let n = rows.len();
    // Property keys for object rows, created once per batch.
    let mut keys: Vec<sys::napi_value> = Vec::new();
    let mut keys_ready = false;

    for i in 0..n {
        let row = unsafe { get_element(raw_env, arr, i)? };
        let t = unsafe { type_of(raw_env, row)? };
        if t == sys::ValueType::napi_undefined || t == sys::ValueType::napi_null {
            // A hole in the input: keep an empty row so row numbers stay aligned.
            core.next_row += 1;
            core.rows += 1;
            sink.end_row()?;
            continue;
        }
        let is_arr = unsafe { is_array(raw_env, row)? };
        let kind = if is_arr {
            Kind::Array
        } else if t == sys::ValueType::napi_object {
            Kind::Object
        } else {
            return Err(invalid(format!("row {} is not an array or object", core.next_row + 1)));
        };
        if core.kind == Kind::Unknown {
            core.kind = kind;
            if kind == Kind::Object && core.columns.is_none() {
                core.columns = Some(unsafe { own_keys(raw_env, row, strbuf)? });
            }
            let want_header = core.header.unwrap_or(kind == Kind::Object);
            core.start(sink, want_header)?;
        }
        if core.kind != kind {
            return Err(invalid(format!("row {} mixes arrays and objects in one sheet", core.next_row + 1)));
        }
        let r = core.next_row;
        if kind == Kind::Array {
            let len = unsafe { array_len(raw_env, row)? };
            for c in 0..len {
                let v = unsafe { get_element(raw_env, row, c)? };
                unsafe { sink.cell(raw_env, strbuf, r, c, v)? };
            }
        } else {
            if !keys_ready {
                for name in core.columns.as_ref().unwrap() {
                    keys.push(unsafe { create_string(raw_env, name)? });
                }
                keys_ready = true;
            }
            for (c, key) in keys.iter().enumerate() {
                let v = unsafe { get_property(raw_env, row, *key)? };
                unsafe { sink.cell(raw_env, strbuf, r, c as u32, v)? };
            }
        }
        sink.end_row()?;
        core.next_row += 1;
        core.rows += 1;
    }
    Ok(n)
}

/// Per-column worksheet formatting, taken from `columns: [{ key, width, numFmt }]`.
#[napi(object)]
pub struct NativeColumn {
    pub width: Option<f64>,
    pub num_fmt: Option<String>,
}

#[napi(object)]
pub struct NativeSheetOptions {
    /// Header text per column when it differs from the keys.
    pub headers: Option<Vec<String>>,
    pub column_formats: Option<Vec<NativeColumn>>,
    pub header_bold: Option<bool>,
    /// 0xRRGGBB
    pub header_fill: Option<u32>,
    /// 0xRRGGBB
    pub header_font_color: Option<u32>,
    pub header_border: Option<bool>,
    pub freeze_header: Option<bool>,
    pub auto_filter: Option<bool>,
}

struct ColFmt {
    width: Option<f64>,
    fmt: Option<Format>,
}

/// Everything formatting-related for one sheet. Built once in `add_sheet`; nothing here grows with the row count.
struct SheetFmt {
    cols: Vec<ColFmt>,
    header_fmt: Option<Format>,
    freeze_header: bool,
    auto_filter: bool,
}

impl SheetFmt {
    fn plain() -> Self {
        SheetFmt { cols: Vec::new(), header_fmt: None, freeze_header: false, auto_filter: false }
    }

    fn from_options(o: &NativeSheetOptions) -> Self {
        let cols = o
            .column_formats
            .iter()
            .flatten()
            .map(|c| ColFmt {
                width: c.width,
                fmt: c.num_fmt.as_ref().map(|f| Format::new().set_num_format(f.as_str())),
            })
            .collect();
        let styled = o.header_bold == Some(true)
            || o.header_fill.is_some()
            || o.header_font_color.is_some()
            || o.header_border == Some(true);
        let header_fmt = styled.then(|| {
            let mut f = Format::new();
            if o.header_bold == Some(true) {
                f = f.set_bold();
            }
            if let Some(rgb) = o.header_fill {
                f = f.set_background_color(Color::RGB(rgb));
            }
            if let Some(rgb) = o.header_font_color {
                f = f.set_font_color(Color::RGB(rgb));
            }
            if o.header_border == Some(true) {
                f = f.set_border(FormatBorder::Thin);
            }
            f
        });
        SheetFmt {
            cols,
            header_fmt,
            freeze_header: o.freeze_header == Some(true),
            auto_filter: o.auto_filter == Some(true),
        }
    }

    fn col_has_fmt(&self, c: u32) -> bool {
        self.cols.get(c as usize).is_some_and(|f| f.fmt.is_some())
    }
}

struct SheetEntry {
    core: Core,
    fmt: SheetFmt,
}

struct State {
    wb: Workbook,
    path: String,
    constant: bool,
    sheets: Vec<SheetEntry>,
    date_fmt: Format,
    datetime_fmt: Format,
    strbuf: Vec<u8>,
}

struct XlsxSink<'a> {
    ws: &'a mut Worksheet,
    fmt: &'a SheetFmt,
    date_fmt: &'a Format,
    datetime_fmt: &'a Format,
}

impl Sink for XlsxSink<'_> {
    fn begin(&mut self, core: &Core, will_header: bool) -> Result<()> {
        // Column widths and formats go into the <cols> element, which rust_xlsxwriter emits
        // before the first row is flushed, so they work in constant-memory mode. Cells written
        // without a format of their own pick up the column format at save time, at no per-cell cost.
        for (c, spec) in self.fmt.cols.iter().enumerate() {
            let c = u16::try_from(c).map_err(|_| invalid("too many columns (Excel allows 16384)".into()))?;
            if let Some(w) = spec.width {
                self.ws.set_column_width(c, w).map_err(xerr)?;
            }
            if let Some(f) = &spec.fmt {
                self.ws.set_column_format(c, f).map_err(xerr)?;
            }
        }
        if will_header && self.fmt.freeze_header {
            self.ws.set_freeze_panes(core.next_row + 1, 0).map_err(xerr)?;
        }
        Ok(())
    }

    fn header(&mut self, row: u32, texts: &[String]) -> Result<()> {
        for (c, name) in texts.iter().enumerate() {
            let col = u16::try_from(c).map_err(|_| pos_err(row, c as u32, "too many columns (Excel allows 16384)"))?;
            match &self.fmt.header_fmt {
                Some(f) => self.ws.write_string_with_format(row, col, name.as_str(), f),
                None => self.ws.write_string(row, col, name.as_str()),
            }
            .map_err(|e| pos_err(row, c as u32, &e.to_string()))?;
        }
        Ok(())
    }

    unsafe fn cell(&mut self, env: sys::napi_env, buf: &mut Vec<u8>, r: u32, c: u32, v: sys::napi_value) -> Result<()> {
        let col_fmt = self.fmt.col_has_fmt(c);
        write_cell(env, self.ws, self.date_fmt, self.datetime_fmt, col_fmt, buf, r, c, v)
    }

    fn end_row(&mut self) -> Result<()> {
        Ok(())
    }
}

#[napi(object)]
pub struct WriteResult {
    pub rows: f64,
    pub bytes: f64,
}

#[napi]
pub struct NativeWriter {
    state: Option<State>,
}

pub(crate) fn xerr(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

pub(crate) fn invalid(msg: String) -> Error {
    Error::new(Status::InvalidArg, msg)
}

#[napi]
impl NativeWriter {
    #[napi(constructor)]
    pub fn new(path: String, mode: Option<String>) -> Result<Self> {
        let constant = match mode.as_deref() {
            None | Some("constant") => true,
            Some("lowMemory") => false,
            Some(m) => return Err(invalid(format!("unknown mode '{m}', expected 'constant' or 'lowMemory'"))),
        };
        Ok(NativeWriter {
            state: Some(State {
                wb: Workbook::new(),
                path,
                constant,
                sheets: Vec::new(),
                date_fmt: Format::new().set_num_format("yyyy-mm-dd"),
                datetime_fmt: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
                strbuf: Vec::with_capacity(4096),
            }),
        })
    }

    /// Adds a sheet and returns its index.
    #[napi]
    pub fn add_sheet(
        &mut self,
        name: String,
        columns: Option<Vec<String>>,
        header: Option<bool>,
        options: Option<NativeSheetOptions>,
    ) -> Result<u32> {
        let st = self.state.as_mut().ok_or_else(|| invalid("writer is closed".into()))?;
        let ws = if st.constant {
            st.wb.add_worksheet_with_constant_memory()
        } else {
            st.wb.add_worksheet_with_low_memory()
        };
        ws.set_name(name).map_err(xerr)?;
        let (fmt, headers) = match &options {
            Some(o) => (SheetFmt::from_options(o), o.headers.clone()),
            None => (SheetFmt::plain(), None),
        };
        st.sheets.push(SheetEntry { core: Core::new(columns, headers, header), fmt });
        Ok((st.sheets.len() - 1) as u32)
    }

    /// Writes one batch of rows (arrays or plain objects). Returns rows written.
    #[napi]
    pub fn write_rows(&mut self, env: &Env, sheet: u32, rows: Array) -> Result<u32> {
        let st = self.state.as_mut().ok_or_else(|| invalid("writer is closed".into()))?;
        let State { wb, sheets, date_fmt, datetime_fmt, strbuf, .. } = st;
        let entry = sheets
            .get_mut(sheet as usize)
            .ok_or_else(|| invalid(format!("no sheet with index {sheet}")))?;
        let ws = wb.worksheet_from_index(sheet as usize).map_err(xerr)?;
        let mut sink = XlsxSink { ws, fmt: &entry.fmt, date_fmt, datetime_fmt };
        drive_rows(env, &mut entry.core, &mut sink, strbuf, rows)
    }

    /// Drops the workbook and its temp files without writing anything.
    #[napi]
    pub fn abort(&mut self) {
        self.state = None;
    }

    /// Finishes the workbook on a worker thread. The writer is unusable afterwards.
    #[napi]
    pub fn close(&mut self) -> Result<AsyncTask<CloseTask>> {
        let st = self.state.take().ok_or_else(|| invalid("writer is already closed".into()))?;
        Ok(AsyncTask::new(CloseTask { state: Some(st) }))
    }
}

pub struct CloseTask {
    state: Option<State>,
}

impl Task for CloseTask {
    type Output = WriteResult;
    type JsValue = WriteResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut st = self.state.take().ok_or_else(|| invalid("writer is already closed".into()))?;
        if st.sheets.is_empty() {
            let ws = if st.constant {
                st.wb.add_worksheet_with_constant_memory()
            } else {
                st.wb.add_worksheet_with_low_memory()
            };
            ws.set_name("Sheet1").map_err(xerr)?;
            st.sheets.push(SheetEntry { core: Core::new(None, None, None), fmt: SheetFmt::plain() });
        }
        let State { wb, sheets, date_fmt, datetime_fmt, .. } = &mut st;
        for (idx, entry) in sheets.iter_mut().enumerate() {
            let ws = wb.worksheet_from_index(idx).map_err(xerr)?;
            let mut sink = XlsxSink { ws, fmt: &entry.fmt, date_fmt, datetime_fmt };
            // A sheet that got columns but no rows still gets its header row.
            if !entry.core.started {
                let want = entry.core.header != Some(false) && entry.core.next_row == 0;
                entry.core.start(&mut sink, want)?;
            }
            // The filter range needs the last row, which is only known now.
            if entry.fmt.auto_filter && entry.core.header_written {
                let last_col = entry.core.header_texts().len().saturating_sub(1);
                let last_col = u16::try_from(last_col).map_err(|_| invalid("too many columns (Excel allows 16384)".into()))?;
                let first_row = entry.core.header_row;
                let last_row = entry.core.next_row.saturating_sub(1).max(first_row);
                sink.ws.autofilter(first_row, 0, last_row, last_col).map_err(xerr)?;
            }
        }
        let rows: u64 = st.sheets.iter().map(|s| s.core.rows).sum();
        st.wb.save(&st.path).map_err(xerr)?;
        let bytes = std::fs::metadata(&st.path).map(|m| m.len()).unwrap_or(0);
        Ok(WriteResult { rows: rows as f64, bytes: bytes as f64 })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ---- raw N-API helpers (hot path, kept thin on purpose) ----

pub(crate) fn check(status: sys::napi_status, what: &str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(Error::new(Status::GenericFailure, format!("napi call failed ({what}), status {status}")))
    }
}

pub(crate) unsafe fn get_element(env: sys::napi_env, arr: sys::napi_value, i: u32) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(sys::napi_get_element(env, arr, i, &mut out), "get_element")?;
    Ok(out)
}

pub(crate) unsafe fn get_property(env: sys::napi_env, obj: sys::napi_value, key: sys::napi_value) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(sys::napi_get_property(env, obj, key, &mut out), "get_property")?;
    Ok(out)
}

pub(crate) unsafe fn type_of(env: sys::napi_env, v: sys::napi_value) -> Result<i32> {
    let mut t = 0;
    check(sys::napi_typeof(env, v, &mut t), "typeof")?;
    Ok(t)
}

pub(crate) unsafe fn is_array(env: sys::napi_env, v: sys::napi_value) -> Result<bool> {
    let mut b = false;
    check(sys::napi_is_array(env, v, &mut b), "is_array")?;
    Ok(b)
}

pub(crate) unsafe fn array_len(env: sys::napi_env, v: sys::napi_value) -> Result<u32> {
    let mut n = 0u32;
    check(sys::napi_get_array_length(env, v, &mut n), "array_length")?;
    Ok(n)
}

pub(crate) unsafe fn create_string(env: sys::napi_env, s: &str) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(
        sys::napi_create_string_utf8(env, s.as_ptr() as *const _, s.len() as _, &mut out),
        "create_string",
    )?;
    Ok(out)
}

/// Reads a JS string into `buf` (reused across calls) and returns it as &str.
pub(crate) unsafe fn read_string<'a>(env: sys::napi_env, v: sys::napi_value, buf: &'a mut Vec<u8>) -> Result<&'a str> {
    if buf.len() < 256 {
        buf.resize(256, 0);
    }
    loop {
        let mut written = 0usize;
        check(
            sys::napi_get_value_string_utf8(env, v, buf.as_mut_ptr() as *mut _, buf.len(), &mut written),
            "get_string",
        )?;
        // napi never splits a character, so a truncated copy can fall up to 3 bytes short of
        // the buffer end; anything within 4 bytes of it gets re-measured.
        if written + 4 < buf.len() {
            // napi guarantees well-formed UTF-8 (lone surrogates become U+FFFD).
            return Ok(std::str::from_utf8_unchecked(&buf[..written]));
        }
        // Possibly truncated: ask for the true length and retry once with room to spare.
        let mut need = 0usize;
        check(
            sys::napi_get_value_string_utf8(env, v, ptr::null_mut(), 0, &mut need),
            "get_string_len",
        )?;
        buf.resize(need + 5, 0);
    }
}

pub(crate) unsafe fn own_keys(env: sys::napi_env, obj: sys::napi_value, buf: &mut Vec<u8>) -> Result<Vec<String>> {
    let mut names = ptr::null_mut();
    check(
        sys::napi_get_all_property_names(
            env,
            obj,
            sys::KeyCollectionMode::own_only,
            sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
            sys::KeyConversion::numbers_to_strings,
            &mut names,
        ),
        "property_names",
    )?;
    let n = array_len(env, names)?;
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let k = get_element(env, names, i)?;
        out.push(read_string(env, k, buf)?.to_string());
    }
    Ok(out)
}

pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ISO-8601 text for dates Excel cannot hold (before 1900-01-01).
pub(crate) fn iso_from_ms(ms: f64) -> String {
    let ms = ms as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

pub(crate) fn pos_err(r: u32, c: u32, what: &str) -> Error {
    invalid(format!("row {}, column {}: {}", r + 1, c + 1, what))
}

#[allow(clippy::too_many_arguments)]
unsafe fn write_cell(
    env: sys::napi_env,
    ws: &mut Worksheet,
    date_fmt: &Format,
    datetime_fmt: &Format,
    col_fmt: bool,
    buf: &mut Vec<u8>,
    r: u32,
    c: u32,
    v: sys::napi_value,
) -> Result<()> {
    let col = u16::try_from(c).map_err(|_| pos_err(r, c, "too many columns (Excel allows 16384)"))?;
    let t = type_of(env, v)?;
    let res = match t {
        sys::ValueType::napi_undefined | sys::ValueType::napi_null => return Ok(()),
        sys::ValueType::napi_number => {
            let mut x = 0f64;
            check(sys::napi_get_value_double(env, v, &mut x), "get_double")?;
            if x.is_finite() {
                ws.write_number(r, col, x).map(|_| ())
            } else {
                // Excel cannot store NaN or Infinity; keep the information as text.
                let s = if x.is_nan() { "NaN" } else if x > 0.0 { "Infinity" } else { "-Infinity" };
                ws.write_string(r, col, s).map(|_| ())
            }
        }
        sys::ValueType::napi_string => {
            let s = read_string(env, v, buf)?;
            ws.write_string(r, col, s).map(|_| ())
        }
        sys::ValueType::napi_boolean => {
            let mut b = false;
            check(sys::napi_get_value_bool(env, v, &mut b), "get_bool")?;
            ws.write_boolean(r, col, b).map(|_| ())
        }
        sys::ValueType::napi_bigint => {
            let mut x = 0i64;
            let mut lossless = false;
            check(sys::napi_get_value_bigint_int64(env, v, &mut x, &mut lossless), "get_bigint")?;
            if lossless && x.abs() <= MAX_SAFE {
                ws.write_number(r, col, x as f64).map(|_| ())
            } else {
                let mut sv = ptr::null_mut();
                check(sys::napi_coerce_to_string(env, v, &mut sv), "bigint_to_string")?;
                let s = read_string(env, sv, buf)?;
                ws.write_string(r, col, s).map(|_| ())
            }
        }
        sys::ValueType::napi_object => {
            let mut is_date = false;
            check(sys::napi_is_date(env, v, &mut is_date), "is_date")?;
            if !is_date {
                return Err(pos_err(r, c, "unsupported object value (expected a primitive or a Date)"));
            }
            let mut ms = 0f64;
            check(sys::napi_get_date_value(env, v, &mut ms), "get_date")?;
            if ms.is_nan() {
                return Ok(()); // Invalid Date: empty cell
            }
            let mut serial = ms / MS_PER_DAY + UNIX_EPOCH_SERIAL;
            // Excel's fictitious 1900-02-29 shifts every earlier serial by one.
            if serial < 61.0 {
                serial -= 1.0;
            }
            if serial < 1.0 {
                ws.write_string(r, col, iso_from_ms(ms)).map(|_| ())
            } else {
                if col_fmt {
                    // The column declares its own number format (say 'dd/mm/yyyy'); the cell adopts it.
                    ws.write_number(r, col, serial).map(|_| ())
                } else {
                    let fmt = if ms.rem_euclid(MS_PER_DAY) == 0.0 { date_fmt } else { datetime_fmt };
                    ws.write_number_with_format(r, col, serial, fmt).map(|_| ())
                }
            }
        }
        sys::ValueType::napi_symbol => return Err(pos_err(r, c, "unsupported value type symbol")),
        sys::ValueType::napi_function => return Err(pos_err(r, c, "unsupported value type function")),
        _ => return Err(pos_err(r, c, "unsupported value type")),
    };
    res.map_err(|e| pos_err(r, c, &e.to_string()))
}
