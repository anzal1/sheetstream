import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

/** A per-file temp dir that is removed when the test file finishes. */
export function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sheetstream-test-${label}-`))
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return (name) => path.join(dir, name)
}
