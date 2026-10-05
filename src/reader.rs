//! Streaming reader. A worker thread owns the calamine workbook and its cell
//! stream (which borrows the workbook, so it cannot live in a JS object),
//! assembles rows into batches and hands them over a small bounded channel.
//! JS pulls one batch per `next()`; the worker parses ahead by a few batches.

use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};

use calamine::{open_workbook, DataRef, Reader, Xlsx};
use napi::bindgen_prelude::{AsyncTask, Unknown};
use napi::{sys, Env, Error, Result, ScopedTask, Status, Task};
use napi_derive::napi;

const MS_PER_DAY: f64 = 86_400_000.0;
const UNIX_EPOCH_SERIAL: f64 = 25_569.0;

pub enum Cell {
    Empty,
    Num(f64),
    Str(String),
    Bool(bool),
    /// Milliseconds since the Unix epoch.
    Date(f64),
}

pub type Rows = Vec<Vec<Cell>>;

enum Msg {
    Rows(Rows),
    Done,
    Err(String),
}

struct Shared {
    rx: Mutex<Option<Receiver<Msg>>>,
    cancel: AtomicBool,
}

#[napi]
pub struct NativeReader {
    shared: Arc<Shared>,
}

#[napi]
impl NativeReader {
    /// `sheet_name` wins over `sheet_index`; with neither, the first sheet is read.
    #[napi(constructor)]
    pub fn new(path: String, sheet_index: Option<u32>, sheet_name: Option<String>, batch_size: Option<u32>) -> Self {
        let batch = batch_size.unwrap_or(1000).max(1) as usize;
        let (tx, rx) = sync_channel::<Msg>(3);
        let shared = Arc::new(Shared { rx: Mutex::new(Some(rx)), cancel: AtomicBool::new(false) });
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("sheetstream-reader".into())
            .spawn(move || {
                let res = read_sheet(&path, sheet_index, sheet_name, batch, &worker.cancel, &|rows| {
                    tx.send(Msg::Rows(rows)).is_ok()
                });
                let _ = match res {
                    Ok(()) => tx.send(Msg::Done),
                    Err(e) => tx.send(Msg::Err(e)),
                };
            })
            .expect("failed to spawn reader thread");
        NativeReader { shared }
    }

    /// Resolves to an array of row arrays, or null when the sheet is exhausted.
    #[napi]
    pub fn next(&self) -> AsyncTask<NextTask> {
        AsyncTask::new(NextTask { shared: self.shared.clone() })
    }

    /// Stops the worker early and releases the file.
    #[napi]
    pub fn close(&self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut g) = self.shared.rx.try_lock() {
            *g = None;
        }
    }
}

pub struct NextTask {
    shared: Arc<Shared>,
}

impl<'task> ScopedTask<'task> for NextTask {
    type Output = Option<Rows>;
    type JsValue = Unknown<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut g = self.shared.rx.lock().unwrap_or_else(|p| p.into_inner());
        let msg = match g.as_ref() {
            Some(rx) => rx.recv().unwrap_or(Msg::Done),
            None => Msg::Done,
        };
        match msg {
            Msg::Rows(r) => Ok(Some(r)),
            Msg::Done => {
                *g = None;
                Ok(None)
            }
            Msg::Err(e) => {
                *g = None;
                Err(Error::new(Status::GenericFailure, e))
            }
        }
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let raw = env.raw();
        unsafe {
            let mut out = ptr::null_mut();
            match output {
                None => {
                    ck(sys::napi_get_null(raw, &mut out))?;
                }
                Some(rows) => {
                    ck(sys::napi_create_array_with_length(raw, rows.len(), &mut out))?;
                    for (i, row) in rows.iter().enumerate() {
                        let mut arr = ptr::null_mut();
                        ck(sys::napi_create_array_with_length(raw, row.len(), &mut arr))?;
                        for (j, cell) in row.iter().enumerate() {
                            let v = match cell {
                                Cell::Empty => {
                                    let mut v = ptr::null_mut();
                                    ck(sys::napi_get_null(raw, &mut v))?;
                                    v
                                }
                                Cell::Num(x) => {
                                    let mut v = ptr::null_mut();
                                    ck(sys::napi_create_double(raw, *x, &mut v))?;
                                    v
                                }
                                Cell::Str(s) => {
                                    let mut v = ptr::null_mut();
                                    ck(sys::napi_create_string_utf8(raw, s.as_ptr() as *const _, s.len() as _, &mut v))?;
                                    v
                                }
                                Cell::Bool(b) => {
                                    let mut v = ptr::null_mut();
                                    ck(sys::napi_get_boolean(raw, *b, &mut v))?;
                                    v
                                }
                                Cell::Date(ms) => {
                                    let mut v = ptr::null_mut();
                                    ck(sys::napi_create_date(raw, *ms, &mut v))?;
                                    v
                                }
                            };
                            ck(sys::napi_set_element(raw, arr, j as u32, v))?;
                        }
                        ck(sys::napi_set_element(raw, out, i as u32, arr))?;
                    }
                }
            }
            Ok(Unknown::from_raw_unchecked(raw, out))
        }
    }
}

fn ck(status: sys::napi_status) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(Error::new(Status::GenericFailure, format!("napi call failed, status {status}")))
    }
}

fn serial_to_ms(serial: f64, is_1904: bool) -> f64 {
    let s = if is_1904 { serial + 1462.0 } else { serial };
    // Same convention as calamine: before 1900-03-01 Excel's serials run one day behind.
    // Pure time-of-day values (0 <= s < 1) land on 1899-12-30, like exceljs and SheetJS.
    let s = if s >= 60.0 || (0.0..1.0).contains(&s) { s } else { s + 1.0 };
    ((s - UNIX_EPOCH_SERIAL) * MS_PER_DAY).round()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS[.fff][Z]` (the t="d" cell form).
fn parse_iso(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let days = days_from_civil(num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let mut ms = days as f64 * MS_PER_DAY;
    if b.len() > 10 {
        if b[10] != b'T' || b.len() < 19 {
            return None;
        }
        ms += (num(11, 13)? * 3_600_000 + num(14, 16)? * 60_000 + num(17, 19)? * 1000) as f64;
        if b.len() > 20 && b[19] == b'.' {
            let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
            ms += format!("{:0<3}", frac).parse::<f64>().ok()?;
        }
    }
    Some(ms)
}

fn convert(v: &DataRef<'_>, is_1904: bool) -> Cell {
    match v {
        DataRef::Int(i) => Cell::Num(*i as f64),
        DataRef::Float(f) => Cell::Num(*f),
        DataRef::String(s) => Cell::Str(s.clone()),
        DataRef::SharedString(s) => Cell::Str((*s).to_string()),
        DataRef::Bool(b) => Cell::Bool(*b),
        DataRef::DateTime(dt) => {
            if dt.is_datetime() {
                Cell::Date(serial_to_ms(dt.as_f64(), is_1904))
            } else {
                Cell::Num(dt.as_f64()) // durations stay numeric (days)
            }
        }
        DataRef::DateTimeIso(s) => match parse_iso(s) {
            Some(ms) => Cell::Date(ms),
            None => Cell::Str(s.clone()),
        },
        DataRef::DurationIso(s) => Cell::Str(s.clone()),
        DataRef::Error(_) | DataRef::Empty => Cell::Empty,
    }
}

fn read_sheet(
    path: &str,
    sheet_index: Option<u32>,
    sheet_name: Option<String>,
    batch: usize,
    cancel: &AtomicBool,
    send: &dyn Fn(Rows) -> bool,
) -> std::result::Result<(), String> {
    let mut wb: Xlsx<_> = open_workbook(path).map_err(|e| format!("cannot open '{path}': {e}"))?;
    let names = wb.sheet_names();
    let name = match (&sheet_name, sheet_index) {
        (Some(n), _) => {
            if !names.contains(n) {
                return Err(format!("sheet '{n}' not found (available: {})", names.join(", ")));
            }
            n.clone()
        }
        (None, Some(i)) => names
            .get(i as usize)
            .cloned()
            .ok_or_else(|| format!("sheet index {i} out of range ({} sheets)", names.len()))?,
        (None, None) => names.first().cloned().ok_or("workbook has no sheets")?,
    };
    let is_1904 = wb.has_1904_epoch();
    let mut rd = wb.worksheet_cells_reader(&name).map_err(|e| e.to_string())?;
    let dim = rd.dimensions();
    // The declared width lets us return rectangular rows. 0 = unknown, rows stay as long as their last cell.
    let width = if dim.end.1 >= dim.start.1 && dim.end != (0, 0) { dim.end.1 as usize + 1 } else { 0 };

    let mut out: Rows = Vec::with_capacity(batch);
    let mut cur: Vec<Cell> = Vec::new();
    let mut cur_row: Option<u32> = None;

    let pad = |row: &mut Vec<Cell>| {
        while row.len() < width {
            row.push(Cell::Empty);
        }
    };

    loop {
        let cell = rd.next_cell().map_err(|e| e.to_string())?;
        let Some(cell) = cell else { break };
        let (r, c) = cell.get_position();
        if cur_row != Some(r) {
            if let Some(prev) = cur_row {
                let mut done = std::mem::take(&mut cur);
                pad(&mut done);
                out.push(done);
                // Interior blank rows are kept so row positions stay meaningful.
                for _ in 0..(r - prev - 1) {
                    let mut blank = Vec::new();
                    pad(&mut blank);
                    out.push(blank);
                }
                if out.len() >= batch {
                    if cancel.load(Ordering::Relaxed) || !send(std::mem::replace(&mut out, Vec::with_capacity(batch))) {
                        return Ok(());
                    }
                }
            }
            cur_row = Some(r);
        }
        let c = c as usize;
        while cur.len() < c {
            cur.push(Cell::Empty);
        }
        let v = convert(cell.get_value(), is_1904);
        if cur.len() == c {
            cur.push(v);
        } else {
            cur[c] = v;
        }
    }
    if cur_row.is_some() {
        pad(&mut cur);
        out.push(cur);
    }
    if !out.is_empty() && !cancel.load(Ordering::Relaxed) && !send(out) {
        return Ok(());
    }
    Ok(())
}

// ---- listSheets ----

#[napi(object)]
pub struct SheetInfo {
    pub name: String,
    pub index: u32,
}

pub struct ListTask {
    path: String,
}

impl Task for ListTask {
    type Output = Vec<String>;
    type JsValue = Vec<SheetInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        let wb: Xlsx<_> = open_workbook(&self.path)
            .map_err(|e| Error::new(Status::GenericFailure, format!("cannot open '{}': {e}", self.path)))?;
        Ok(wb.sheet_names())
    }

    fn resolve(&mut self, _env: Env, names: Self::Output) -> Result<Self::JsValue> {
        Ok(names.into_iter().enumerate().map(|(i, name)| SheetInfo { name, index: i as u32 }).collect())
    }
}

#[napi]
pub fn list_sheets(path: String) -> AsyncTask<ListTask> {
    AsyncTask::new(ListTask { path })
}

