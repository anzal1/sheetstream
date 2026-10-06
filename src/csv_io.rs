//! Streaming CSV, built on the `csv` crate. The writer shares the row-walking
//! code with the XLSX writer (same row shapes, same column and header rules);
//! the reader runs on a worker thread and hands batches over the same channel
//! as the XLSX reader, so JS sees one batch protocol for both.

use std::fs::File;
use std::io::Write;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use csv::{ByteRecord, ReaderBuilder, Terminator, WriterBuilder};
use napi::bindgen_prelude::{Array, AsyncTask};
use napi::{sys, Env, Error, Result, Status};
use napi_derive::napi;

use crate::reader::{parse_iso, spawn_reader, Cell, NextTask, Rows, Shared};
use crate::writer::{
    check, civil_from_days, drive_rows, invalid, iso_from_ms, pos_err, read_string, type_of, Core, Sink, WriteResult,
};

const MS_PER_DAY: f64 = 86_400_000.0;

fn io_err(e: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

fn one_byte(opt: Option<String>, default: u8, what: &str) -> Result<u8> {
    match opt {
        None => Ok(default),
        Some(s) => match s.as_bytes() {
            [b] => Ok(*b),
            _ => Err(invalid(format!("{what} must be a single ASCII character"))),
        },
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// JS-style shortest number text: integers without a decimal point, exponent form only at the extremes.
fn fmt_number(x: f64, out: &mut String) {
    use std::fmt::Write as _;
    out.clear();
    let a = x.abs();
    if x == x.trunc() && a < 1e15 {
        let _ = write!(out, "{}", x as i64);
    } else if (1e-6..1e21).contains(&a) {
        let _ = write!(out, "{x}");
    } else {
        let _ = write!(out, "{x:e}");
    }
}

fn fmt_date(ms: f64, out: &mut String) {
    use std::fmt::Write as _;
    out.clear();
    if ms.rem_euclid(MS_PER_DAY) == 0.0 {
        let (y, m, d) = civil_from_days(ms.div_euclid(MS_PER_DAY) as i64);
        let _ = write!(out, "{y:04}-{m:02}-{d:02}");
    } else {
        out.push_str(&iso_from_ms(ms));
    }
}

struct CsvSink {
    w: csv::Writer<File>,
    num: String,
}

impl CsvSink {
    fn field(&mut self, bytes: &[u8], r: u32, c: u32) -> Result<()> {
        self.w.write_field(bytes).map_err(|e| pos_err(r, c, &e.to_string()))
    }
}

impl Sink for CsvSink {
    fn begin(&mut self, _core: &Core, _will_header: bool) -> Result<()> {
        Ok(())
    }

    fn header(&mut self, row: u32, texts: &[String]) -> Result<()> {
        for (c, t) in texts.iter().enumerate() {
            self.field(t.as_bytes(), row, c as u32)?;
        }
        Ok(())
    }

    unsafe fn cell(&mut self, env: sys::napi_env, buf: &mut Vec<u8>, r: u32, c: u32, v: sys::napi_value) -> Result<()> {
        let t = type_of(env, v)?;
        match t {
            sys::ValueType::napi_undefined | sys::ValueType::napi_null => self.field(b"", r, c),
            sys::ValueType::napi_number => {
                let mut x = 0f64;
                check(sys::napi_get_value_double(env, v, &mut x), "get_double")?;
                if x.is_finite() {
                    fmt_number(x, &mut self.num);
                    let s = std::mem::take(&mut self.num);
                    let res = self.field(s.as_bytes(), r, c);
                    self.num = s;
                    res
                } else {
                    let s = if x.is_nan() { "NaN" } else if x > 0.0 { "Infinity" } else { "-Infinity" };
                    self.field(s.as_bytes(), r, c)
                }
            }
            sys::ValueType::napi_string => {
                let s = read_string(env, v, buf)?;
                self.w.write_field(s.as_bytes()).map_err(|e| pos_err(r, c, &e.to_string()))
            }
            sys::ValueType::napi_boolean => {
                let mut b = false;
                check(sys::napi_get_value_bool(env, v, &mut b), "get_bool")?;
                self.field(if b { b"true" } else { b"false" }, r, c)
            }
            sys::ValueType::napi_bigint => {
                let mut sv = ptr::null_mut();
                check(sys::napi_coerce_to_string(env, v, &mut sv), "bigint_to_string")?;
                let s = read_string(env, sv, buf)?;
                self.w.write_field(s.as_bytes()).map_err(|e| pos_err(r, c, &e.to_string()))
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
                    return self.field(b"", r, c); // Invalid Date: empty field
                }
                fmt_date(ms, &mut self.num);
                let s = std::mem::take(&mut self.num);
                let res = self.field(s.as_bytes(), r, c);
                self.num = s;
                res
            }
            sys::ValueType::napi_symbol => Err(pos_err(r, c, "unsupported value type symbol")),
            sys::ValueType::napi_function => Err(pos_err(r, c, "unsupported value type function")),
            _ => Err(pos_err(r, c, "unsupported value type")),
        }
    }

    fn end_row(&mut self) -> Result<()> {
        self.w.write_record(None::<&[u8]>).map_err(io_err)
    }
}

struct CsvState {
    core: Core,
    sink: CsvSink,
    strbuf: Vec<u8>,
    path: String,
}

#[napi]
pub struct NativeCsvWriter {
    state: Option<CsvState>,
}

#[napi]
impl NativeCsvWriter {
    #[napi(constructor)]
    pub fn new(
        path: String,
        delimiter: Option<String>,
        quote: Option<String>,
        bom: Option<bool>,
        columns: Option<Vec<String>>,
        headers: Option<Vec<String>>,
        header: Option<bool>,
    ) -> Result<Self> {
        let delimiter = one_byte(delimiter, b',', "delimiter")?;
        let quote = one_byte(quote, b'"', "quote")?;
        let mut file = File::create(&path).map_err(|e| io_err(format!("cannot create '{path}': {e}")))?;
        if bom == Some(true) {
            file.write_all(b"\xEF\xBB\xBF").map_err(io_err)?;
        }
        let w = WriterBuilder::new()
            .delimiter(delimiter)
            .quote(quote)
            .flexible(true)
            .terminator(Terminator::Any(b'\n'))
            .buffer_capacity(1 << 16)
            .from_writer(file);
        Ok(NativeCsvWriter {
            state: Some(CsvState {
                core: Core::new(columns, headers, header),
                sink: CsvSink { w, num: String::with_capacity(32) },
                strbuf: Vec::with_capacity(4096),
                path,
            }),
        })
    }

    /// Writes one batch of rows (arrays or plain objects). Returns rows written.
    #[napi]
    pub fn write_rows(&mut self, env: &Env, rows: Array) -> Result<u32> {
        let st = self.state.as_mut().ok_or_else(|| invalid("writer is closed".into()))?;
        let CsvState { core, sink, strbuf, .. } = st;
        drive_rows(env, core, sink, strbuf, rows)
    }

    /// Flushes and closes the file.
    #[napi]
    pub fn close(&mut self) -> Result<WriteResult> {
        let mut st = self.state.take().ok_or_else(|| invalid("writer is already closed".into()))?;
        if !st.core.started {
            let want = st.core.header != Some(false) && st.core.next_row == 0;
            st.core.start(&mut st.sink, want)?;
        }
        st.sink.w.flush().map_err(io_err)?;
        let rows = st.core.rows;
        let path = st.path.clone();
        drop(st); // closes the file
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(WriteResult { rows: rows as f64, bytes: bytes as f64 })
    }

    /// Closes the file and deletes the partial output.
    #[napi]
    pub fn abort(&mut self) {
        if let Some(st) = self.state.take() {
            let path = st.path.clone();
            drop(st);
            let _ = std::fs::remove_file(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Plain decimal numbers only, and only when they survive a trip through f64 (at most 15 significant digits,
/// no leading zeros), so ids, zip codes and phone numbers stay strings.
fn infer_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i = 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_len = i - int_start;
    if int_len == 0 || (int_len > 1 && b[int_start] == b'0') {
        return None;
    }
    let mut digits = int_len;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == f {
            return None;
        }
        digits += i - f;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return None;
        }
    }
    if i != b.len() || digits > 15 {
        return None;
    }
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

/// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS[.fff]Z`, nothing looser.
fn infer_date(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let n = b.len();
    if n != 10 && !(n >= 20 && b[n - 1] == b'Z') {
        return None;
    }
    let digit = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_digit());
    if !(0..4).all(digit) || !(5..7).all(digit) || !(8..10).all(digit) {
        return None;
    }
    let month: u32 = s[5..7].parse().ok()?;
    let day: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if n > 10 {
        if b[10] != b'T' || !(11..13).all(digit) || b[13] != b':' || !(14..16).all(digit) || b[16] != b':' || !(17..19).all(digit) {
            return None;
        }
        if n > 20 && (b[19] != b'.' || !(20..n - 1).all(digit)) {
            return None;
        }
        if n == 21 {
            return None;
        }
    }
    parse_iso(s)
}

fn infer(field: &str) -> Cell {
    if field.eq_ignore_ascii_case("true") {
        return Cell::Bool(true);
    }
    if field.eq_ignore_ascii_case("false") {
        return Cell::Bool(false);
    }
    if let Some(x) = infer_number(field) {
        return Cell::Num(x);
    }
    if let Some(ms) = infer_date(field) {
        return Cell::Date(ms);
    }
    Cell::Str(field.to_string())
}

fn read_csv(
    path: &str,
    delimiter: u8,
    quote: u8,
    batch: usize,
    infer_types: bool,
    cancel: &AtomicBool,
    send: &dyn Fn(Rows) -> bool,
) -> std::result::Result<(), String> {
    let mut rdr = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .quote(quote)
        .buffer_capacity(1 << 16)
        .from_path(path)
        .map_err(|e| format!("cannot open '{path}': {e}"))?;
    let mut rec = ByteRecord::new();
    let mut out: Rows = Vec::with_capacity(batch);
    // Rows shorter than the first record are padded to its width, like the XLSX reader does.
    let mut width = 0usize;
    let mut first = true;
    loop {
        match rdr.read_byte_record(&mut rec) {
            Ok(true) => {}
            Ok(false) => break,
            Err(e) => return Err(format!("'{path}': {e}")),
        }
        if first {
            width = rec.len();
            first = false;
        }
        let mut row: Vec<Cell> = Vec::with_capacity(rec.len().max(width));
        for f in rec.iter() {
            if f.is_empty() {
                row.push(Cell::Empty);
                continue;
            }
            let text = String::from_utf8_lossy(f);
            row.push(if infer_types { infer(&text) } else { Cell::Str(text.into_owned()) });
        }
        while row.len() < width {
            row.push(Cell::Empty);
        }
        out.push(row);
        if out.len() >= batch
            && (cancel.load(Ordering::Relaxed) || !send(std::mem::replace(&mut out, Vec::with_capacity(batch))))
        {
            return Ok(());
        }
    }
    if !out.is_empty() && !cancel.load(Ordering::Relaxed) {
        send(out);
    }
    Ok(())
}

#[napi]
pub struct NativeCsvReader {
    shared: Arc<Shared>,
}

#[napi]
impl NativeCsvReader {
    #[napi(constructor)]
    pub fn new(
        path: String,
        delimiter: Option<String>,
        quote: Option<String>,
        batch_size: Option<u32>,
        infer_types: Option<bool>,
    ) -> Result<Self> {
        let delimiter = one_byte(delimiter, b',', "delimiter")?;
        let quote = one_byte(quote, b'"', "quote")?;
        let batch = batch_size.unwrap_or(1000).max(1) as usize;
        let infer_types = infer_types == Some(true);
        let shared = spawn_reader(move |cancel, send| read_csv(&path, delimiter, quote, batch, infer_types, cancel, send));
        Ok(NativeCsvReader { shared })
    }

    /// Resolves to an array of row arrays, or null when the file is exhausted.
    #[napi]
    pub fn next(&self) -> AsyncTask<NextTask> {
        AsyncTask::new(NextTask { shared: self.shared.clone() })
    }

    /// Stops the worker early and releases the file.
    #[napi]
    pub fn close(&self) {
        self.shared.close();
    }
}
