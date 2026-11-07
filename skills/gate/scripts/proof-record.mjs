// proof-record.mjs — what red-proof.mjs proved, kept so pre-review can tell whether the current
// tests were ever seen failing under a break of the rule they test (2026-11-07: three rounds in a
// row, a "nothing happens" check passed review that no run had ever seen fail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';

export function proofDir() { return process.env.SANAD_STATE_DIR ? path.join(process.env.SANAD_STATE_DIR, 'proof') : path.join(os.homedir(), '.claude', 'state', 'proof'); }

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function toplevelOf(dir) { return git(dir, ['rev-parse', '--show-toplevel']); }
export function defaultBase(top) { return 'origin/' + (git(top, ['config', '--get', 'sanad.integration']) || 'staging'); }

// Changed and new test files since the merge base with <base>, or null when there is none.
export function changedTestFiles(top, base) {
  const from = git(top, ['merge-base', base, 'HEAD']);
  if (!from) return null;
  const tracked = git(top, ['diff', '--name-only', '--diff-filter=d', from]).split(/\r?\n/);
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/);
  return [...new Set([...tracked, ...untracked].filter(f => f && TEST_FILE.test(f) && fs.existsSync(path.join(top, f))))].sort();
}

export function testFileHashes(top, files) {
  return Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(top, f))).digest('hex')]));
}

function recordPath(top) {
  return path.join(proofDir(), crypto.createHash('sha1').update(path.resolve(top).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16) + '.json');
}
export function writeRecord(top, record) {
  fs.mkdirSync(proofDir(), { recursive: true });
  fs.writeFileSync(recordPath(top), JSON.stringify({ ...record, top: path.resolve(top), at: new Date().toISOString() }, null, 2));
}
export function readRecord(top) {
  try { return JSON.parse(fs.readFileSync(recordPath(top), 'utf8')); } catch { return null; }
}

// True when the record proved at least one break on exactly the test files that exist now.
export function provesCurrent(record, hashes) {
  if (!record || !record.ok || !(record.breaks >= 1) || !record.files) return false;
  const now = Object.keys(hashes).sort(), then = Object.keys(record.files).sort();
  return now.length > 0 && now.length === then.length && now.every((f, i) => f === then[i] && hashes[f] === record.files[f]);
}
