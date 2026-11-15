// run-record.mjs — one small record per red-proof run that asks for a green run (--then-green), for the
// stop hook.
//
// 2026-11-15: a proof run in the background with its output sent to a file (`… > proof-run.out 2>&1; echo
// "exit $?" >> proof-run.out`) showed the stop hook none of its lines, so its passing green run never counted
// as a test run after the last edit: the stop asked for one three times in one task. Such a run now leaves
// <state>/proof/runs/<start ms>-<pid>.json when it ends, however it ends: its arguments, its folder, its start
// and end times, its exit code, what its own lines say about green, and the tree (the working tree as git
// would commit it) at its start and, after a passing green run, at its end. The hook reads it only for a run
// whose result shows no line of the proof's own (hooks/lib/transcript-scan.js, "Red-proof runs"). It is no
// evidence receipt: the push guard still needs evidence.mjs. Records older than 7 days go when one is written.
import fs from 'node:fs';
import path from 'node:path';
import { proofDir } from './proof-record.mjs';

export function runRecordDir() { return path.join(proofDir(), 'runs'); }

// The proof stopped for a reason that is not the code under test: what it said about green does not count.
const STOPPED = /RED-PROOF: (?:SETUP|ENVIRONMENT|TIMEOUT|REMOTE-DOWN|RESTORE FAILED|failed —)/;
// What a run's own lines and exit code say about its green run: 'passed', 'failed', or 'none' (it did not
// run, or the proof stopped for another reason). Only exit 0 (proved) or 1 (NOT RED, a break not caught) can
// follow a passing green run.
export function greenOf(lines, code) {
  const text = lines.join('\n');
  if (/^\s*GREEN ✗/m.test(text)) return 'failed';
  return /^\s*GREEN ✓/m.test(text) && !STOPPED.test(text) && (code === 0 || code === 1) ? 'passed' : 'none';
}

// Called once, at the start of a run; the record is written when the process exits. said: the run's own
// lines, filled as it goes; tree(): the working tree's id now; startTree: that id at the start when the
// caller has it already (its --log line).
export function keepRunRecord({ argv, said, tree, startTree = '', keepDays = 7 }) {
  const started = new Date();
  const treeStart = startTree || tree();
  process.on('exit', (code) => {
    try {
      const green = greenOf(said, code);
      const record = { v: 1, argv: argv.map(String), cwd: process.cwd(), startedAt: started.toISOString(), endedAt: new Date().toISOString(),
        exit: code, green, treeStart, treeEnd: green === 'passed' ? tree() : '', verdict: [...said].reverse().find((l) => /^RED-PROOF: /.test(l)) || '' };
      const dir = runRecordDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${started.getTime()}-${process.pid}.json`), JSON.stringify(record, null, 2) + '\n');
      const old = Date.now() - keepDays * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(dir)) {
        const m = /^(\d+)-\d+\.json$/.exec(name);
        if (m && Number(m[1]) < old) fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch { /* the proof's own result stands; the stop hook then finds no record and asks for a check */ }
  });
}
