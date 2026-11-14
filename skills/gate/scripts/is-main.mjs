// is-main.mjs — true when this module is the script Node was asked to run.
//
// 2026-11-14: every gate script checked `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`.
// Node gives an ES module the REAL path of its file (links and short names resolved), but process.argv[1]
// keeps the path as typed. Run through a junction, a symbolic link or a Windows short name (CI's temp folder
// is C:\Users\RUNNER~1\...), the two never matched: the script ran nothing and exited 0, with no output.
// Both sides are compared by their real path; Windows compares them without case.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

export function isMain(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!argv1) return false;
  const a = real(argv1), b = real(fileURLToPath(metaUrl));
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
