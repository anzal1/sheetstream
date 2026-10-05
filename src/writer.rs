//! Streaming writer. JS hands us batches of rows; we write them straight into a
//! rust_xlsxwriter worksheet running in constant-memory or low-memory mode, so
//! neither side ever holds the whole sheet.

use std::ptr;

use napi::{sys, Env, Error, JsValue, Result, Status, Task};
use napi::bindgen_prelude::{Array, AsyncTask};
use napi_derive::napi;
use rust_xlsxwriter::{Format, Workbook, Worksheet};

const MS_PER_DAY: f64 = 86_400_000.0;
const UNIX_EPOCH_SERIAL: f64 = 25_569.0;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Unknown,
    Array,
    Object,
}

struct Sheet {
    columns: Option<Vec<String>>,
    /// None = decide from the first row (header for object rows only).
    header: Option<bool>,
    header_done: bool,
    next_row: u32,
    kind: Kind,
    rows: u64,
}

struct State {
    wb: Workbook,
    path: String,
    constant: bool,
    sheets: Vec<Sheet>,
    date_fmt: Format,
    datetime_fmt: Format,
    strbuf: Vec<u8>,
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

fn xerr(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

fn invalid(msg: String) -> Error {
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
    pub fn add_sheet(&mut self, name: String, columns: Option<Vec<String>>, header: Option<bool>) -> Result<u32> {
        let st = self.state.as_mut().ok_or_else(|| invalid("writer is closed".into()))?;
        let ws = if st.constant {
            st.wb.add_worksheet_with_constant_memory()
        } else {
            st.wb.add_worksheet_with_low_memory()
        };
        ws.set_name(name).map_err(xerr)?;
        st.sheets.push(Sheet {
            columns,
            header,
            header_done: false,
            next_row: 0,
            kind: Kind::Unknown,
            rows: 0,
        });
        Ok((st.sheets.len() - 1) as u32)
    }

    /// Writes one batch of rows (arrays or plain objects). Returns rows written.
    #[napi]
    pub fn write_rows(&mut self, env: &Env, sheet: u32, rows: Array) -> Result<u32> {
        let st = self.state.as_mut().ok_or_else(|| invalid("writer is closed".into()))?;
        let raw_env = env.raw();
        let State { wb, sheets, date_fmt, datetime_fmt, strbuf, .. } = st;
        let sh = sheets
            .get_mut(sheet as usize)
            .ok_or_else(|| invalid(format!("no sheet with index {sheet}")))?;
        let ws = wb.worksheet_from_index(sheet as usize).map_err(xerr)?;
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
                sh.next_row += 1;
                sh.rows += 1;
                continue;
            }
            let is_arr = unsafe { is_array(raw_env, row)? };
            let kind = if is_arr {
                Kind::Array
            } else if t == sys::ValueType::napi_object {
                Kind::Object
            } else {
                return Err(invalid(format!(
                    "row {} is not an array or object",
                    sh.next_row + 1
                )));
            };
            if sh.kind == Kind::Unknown {
                sh.kind = kind;
                if kind == Kind::Object && sh.columns.is_none() {
                    sh.columns = Some(unsafe { own_keys(raw_env, row, strbuf)? });
                }
                let want_header = sh.header.unwrap_or(kind == Kind::Object);
                if want_header && sh.columns.is_some() {
                    write_header(ws, sh)?;
                }
            }
            if sh.kind != kind {
                return Err(invalid(format!(
                    "row {} mixes arrays and objects in one sheet",
                    sh.next_row + 1
                )));
            }
            let r = sh.next_row;
            if kind == Kind::Array {
                let len = unsafe { array_len(raw_env, row)? };
                for c in 0..len {
                    let v = unsafe { get_element(raw_env, row, c)? };
                    unsafe { write_cell(raw_env, ws, date_fmt, datetime_fmt, strbuf, r, c, v)? };
                }
            } else {
                if !keys_ready {
                    for name in sh.columns.as_ref().unwrap() {
                        keys.push(unsafe { create_string(raw_env, name)? });
                    }
                    keys_ready = true;
                }
                for (c, key) in keys.iter().enumerate() {
                    let v = unsafe { get_property(raw_env, row, *key)? };
                    unsafe { write_cell(raw_env, ws, date_fmt, datetime_fmt, strbuf, r, c as u32, v)? };
                }
            }
            sh.next_row += 1;
            sh.rows += 1;
        }
        Ok(n)
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
            st.sheets.push(Sheet {
                columns: None,
                header: None,
                header_done: false,
                next_row: 0,
                kind: Kind::Unknown,
                rows: 0,
            });
        }
        // A sheet that got columns but no rows still gets its header row.
        for idx in 0..st.sheets.len() {
            let sh = &mut st.sheets[idx];
            if !sh.header_done && sh.columns.is_some() && sh.header != Some(false) && sh.next_row == 0 {
                let ws = st.wb.worksheet_from_index(idx).map_err(xerr)?;
                write_header(ws, &mut st.sheets[idx])?;
            }
        }
        let rows: u64 = st.sheets.iter().map(|s| s.rows).sum();
        st.wb.save(&st.path).map_err(xerr)?;
        let bytes = std::fs::metadata(&st.path).map(|m| m.len()).unwrap_or(0);
        Ok(WriteResult { rows: rows as f64, bytes: bytes as f64 })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn write_header(ws: &mut Worksheet, sh: &mut Sheet) -> Result<()> {
    if sh.header_done {
        return Ok(());
    }
    if let Some(cols) = &sh.columns {
        for (c, name) in cols.iter().enumerate() {
            ws.write_string(sh.next_row, c as u16, name.as_str()).map_err(xerr)?;
        }
        sh.next_row += 1;
        sh.rows += 1;
    }
    sh.header_done = true;
    Ok(())
}

// ---- raw N-API helpers (hot path, kept thin on purpose) ----

fn check(status: sys::napi_status, what: &str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(Error::new(Status::GenericFailure, format!("napi call failed ({what}), status {status}")))
    }
}

unsafe fn get_element(env: sys::napi_env, arr: sys::napi_value, i: u32) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(sys::napi_get_element(env, arr, i, &mut out), "get_element")?;
    Ok(out)
}

unsafe fn get_property(env: sys::napi_env, obj: sys::napi_value, key: sys::napi_value) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(sys::napi_get_property(env, obj, key, &mut out), "get_property")?;
    Ok(out)
}

unsafe fn type_of(env: sys::napi_env, v: sys::napi_value) -> Result<i32> {
    let mut t = 0;
    check(sys::napi_typeof(env, v, &mut t), "typeof")?;
    Ok(t)
}

unsafe fn is_array(env: sys::napi_env, v: sys::napi_value) -> Result<bool> {
    let mut b = false;
    check(sys::napi_is_array(env, v, &mut b), "is_array")?;
    Ok(b)
}

unsafe fn array_len(env: sys::napi_env, v: sys::napi_value) -> Result<u32> {
    let mut n = 0u32;
    check(sys::napi_get_array_length(env, v, &mut n), "array_length")?;
    Ok(n)
}

unsafe fn create_string(env: sys::napi_env, s: &str) -> Result<sys::napi_value> {
    let mut out = ptr::null_mut();
    check(
        sys::napi_create_string_utf8(env, s.as_ptr() as *const _, s.len() as _, &mut out),
        "create_string",
    )?;
    Ok(out)
}

/// Reads a JS string into `buf` (reused across calls) and returns it as &str.
unsafe fn read_string<'a>(env: sys::napi_env, v: sys::napi_value, buf: &'a mut Vec<u8>) -> Result<&'a str> {
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

unsafe fn own_keys(env: sys::napi_env, obj: sys::napi_value, buf: &mut Vec<u8>) -> Result<Vec<String>> {
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

fn civil_from_days(z: i64) -> (i64, u32, u32) {
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
fn iso_from_ms(ms: f64) -> String {
    let ms = ms as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

fn pos_err(r: u32, c: u32, what: &str) -> Error {
    invalid(format!("row {}, column {}: {}", r + 1, c + 1, what))
}

#[allow(clippy::too_many_arguments)]
unsafe fn write_cell(
    env: sys::napi_env,
    ws: &mut Worksheet,
    date_fmt: &Format,
    datetime_fmt: &Format,
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
                let fmt = if ms.rem_euclid(MS_PER_DAY) == 0.0 { date_fmt } else { datetime_fmt };
                ws.write_number_with_format(r, col, serial, fmt).map(|_| ())
            }
        }
        sys::ValueType::napi_symbol => return Err(pos_err(r, c, "unsupported value type symbol")),
        sys::ValueType::napi_function => return Err(pos_err(r, c, "unsupported value type function")),
        _ => return Err(pos_err(r, c, "unsupported value type")),
    };
    res.map_err(|e| pos_err(r, c, &e.to_string()))
}
