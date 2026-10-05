# Benchmark results

1,000,000 rows x 10 columns (int, float, 6 strings of 5-20 chars, date, bool), seeded generator in `bench/gen.mjs`.
Run on darwin-arm64, Apple M5 Max, 18 cores, Node v24.20.0, 2026-10-05.
Each case runs once in its own process under `nice -n 19 /usr/bin/time -l` with `--max-old-space-size=4096` and a 90 s cap.
Versions: sheetstream 0.1.0, exceljs 4.4.0, SheetJS 0.20.3.
Reproduce with `npm run bench`.

## Write

| Library | Time (s) | Peak RSS (MB) | File (MB) | Notes |
|---|---:|---:|---:|---|
| sheetstream (constant) | 5.5 | 82 | 110.9 |  |
| sheetstream (lowMemory) | 5.4 | 101 | 68.6 |  |
| exceljs default | crash | - | - | JavaScript heap out of memory |
| exceljs streaming | 12.3 | 749 | 78.1 |  |
| SheetJS dense | 9.1 | 3270 | 214.9 |  |

## Read

Input is the file written by sheetstream in constant mode. Every reader counts rows and cells and sums column 1.

| Library | Time (s) | Peak RSS (MB) | Notes |
|---|---:|---:|---|
| sheetstream | 2.4 | 93 |  |
| exceljs streaming | 9.1 | 376 |  |
| SheetJS dense | 16.3 | 3048 |  |

Single runs; wall time under `nice` varies by roughly 25 percent between runs.
