import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proofScripts } from '../scripts/red-proof.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// 2026-11-14: the proof copies itself to the test machine; is-main.mjs was missing from that hand-written list,
// and every proof there stopped with "Cannot find module".
test('the scripts copied to the test machine are red-proof and everything it imports, followed through their imports', () => {
  const list = proofScripts(scripts);
  assert.equal(list[0], 'red-proof.mjs');
  for (const f of ['proof-record.mjs', 'check-ticket-lines.mjs', 'is-main.mjs']) assert.ok(list.includes(f), f + ' is copied');
  for (const f of list) {
    assert.ok(fs.existsSync(path.join(scripts, f)), f + ' exists');
    const text = fs.readFileSync(path.join(scripts, f), 'utf8');
    for (const m of text.matchAll(/\bfrom\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) assert.ok(list.includes(m[1]), `${f} imports ${m[1]}, which must be copied too`);
  }
  assert.equal(new Set(list).size, list.length, 'each script once');
});

// 2026-11-19: red-proof now reads the shared change set (the FOREIGN? guard). The list copied into an empty folder,
// as the test machine gets it, must load there: a script that is imported and not copied stops every proof.
test('the copied list, alone in an empty folder, loads red-proof there (change-set.mjs included)', () => {
  const list = proofScripts(scripts);
  assert.ok(list.includes('change-set.mjs'), 'change-set.mjs is copied');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-scripts-'));
  try {
    for (const f of list) fs.copyFileSync(path.join(scripts, f), path.join(dir, f));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'red-proof.mjs')).href)}); console.log(typeof m.proofScripts, typeof m.buildFinished);`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'function function');
    // Run there as the test machine runs it: a usage error, not a missing module.
    const run = spawnSync(process.execPath, [path.join(dir, 'red-proof.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /^usage: red-proof\.mjs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
