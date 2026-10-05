# Benchmark results

100,000 rows x 10 columns (int, float, 6 strings of 5-20 chars, date, bool), seeded generator in `bench/gen.mjs`.
Run on darwin-arm64, Apple M5 Max, 18 cores, Node v24.20.0, 2026-10-05.
Each case runs once in its own process under `nice -n 19 /usr/bin/time -l` with `--max-old-space-size=4096` and a 60 s cap.
Versions: sheetstream 0.1.0, exceljs 4.4.0, SheetJS ?.
Reproduce with `npm run bench`.

## Write

| Library | Time (s) | Peak RSS (MB) | File (MB) | Notes |
|---|---:|---:|---:|---|
| sheetstream (constant) | 0.6 | 81 | 11.1 |  |
| sheetstream (lowMemory) | 0.6 | 103 | 7.7 |  |
| exceljs default | 3.1 | 1605 | 7.8 |  |
| exceljs streaming | 1.4 | 289 | 8.7 |  |
| SheetJS dense | 1.0 | 551 | 21.3 |  |

## Read

Input is the file written by sheetstream in constant mode. Every reader counts rows and cells and sums column 1.

| Library | Time (s) | Peak RSS (MB) | Notes |
|---|---:|---:|---|
| sheetstream | 0.3 | 79 |  |
| exceljs streaming | 1.0 | 295 |  |
| SheetJS dense | 1.6 | 554 |  |

Single runs; wall time under `nice` varies by roughly 25 percent between runs.
