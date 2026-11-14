import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
