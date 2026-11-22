// pre-review.mjs otherTaskOnRemote: another task's check lock counts only while the process that wrote it
// still holds its id. 2026-11-14: the id alone was asked here, so an id handed to a later process kept a
// stale lock "alive", and the sync (and with it lint and types on the test machine) was skipped. The
// start-time check of check-lock-guard.js (hooks/lib/process-start.cjs) now decides here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'pre-review.mjs');
const remote = { host: 'pc2', repo: 'C:/r/App', node: 'node' };
// When this process started, as evidence.mjs records its own start in a lock.
const ownStart = () => Date.now() - process.uptime() * 1000;
const iso = (ms) => new Date(ms).toISOString();
// A process id no system hands out (above Linux's pid_max limit, macOS's 99999 and any Windows id in use).
const NO_PROCESS = 2147483644;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-lock-start-'));
const mine = path.join(root, 'mine'), other = path.join(root, 'other');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// One lock of another task whose check runs on pc2, in a fresh lock folder; `pidStartedAt` left out writes
// the old lock format (no start time). Returns what otherTaskOnRemote of `file` says for this task.
async function ask(over = {}, file = script) {
  const { otherTaskOnRemote } = await import(pathToFileURL(file).href);
  const dir = fs.mkdtempSync(path.join(root, 'locks-'));
  fs.writeFileSync(path.join(dir, 'run-1.json'), JSON.stringify({ toplevel: other, pid: process.pid, startedAt: iso(Date.now()),
    expiresAt: iso(Date.now() + 600000), command: 'C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes pc2 cd /d C:\\r\\App && dotnet test', ...over }));
  const before = process.env.SANAD_CHECK_LOCK_DIR;
  process.env.SANAD_CHECK_LOCK_DIR = dir;
  try { return otherTaskOnRemote(mine, remote); } finally {
    if (before === undefined) delete process.env.SANAD_CHECK_LOCK_DIR; else process.env.SANAD_CHECK_LOCK_DIR = before;
  }
}

test('same id, later start: the lock is stale and no other task runs on the test machine', async () => {
  assert.equal(await ask({ pidStartedAt: iso(ownStart() - 3600000) }), '');
});

test('same id, same start: the other task still runs and is named', async () => {
  assert.equal(await ask({ pidStartedAt: iso(ownStart()) }), other);
});

test('a lock in the old format (no start time) keeps the id check alone', async () => {
  assert.equal(await ask(), other, 'a live id counts, as before');
  assert.equal(await ask({ pid: NO_PROCESS }), '', 'a gone id does not, as before');
});

// Every gate script a script loads: its './x.mjs' imports, and theirs, the way proofScripts (red-proof.mjs) follows
// them (`import … from`, `export … from` and `import('./x.mjs')`). 2026-11-19: this test copied a fixed list of six
// names, so each new import of pre-review.mjs, or of a script it imports, broke it with "Cannot find module".
function gateImports(dir, first) {
  const list = [first];
  for (let i = 0; i < list.length; i++) {
    const text = fs.readFileSync(path.join(dir, list[i]), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]\.\/([\w.-]+\.mjs)['"]|\bimport\s*\(\s*['"]\.\/([\w.-]+\.mjs)['"]\s*\)/gm)) {
      const name = m[1] || m[2];
      if (!list.includes(name)) list.push(name);
    }
  }
  return list;
}

// Without its helper (an install that missed hooks/lib), the check keeps the id alone and still answers:
// the sync is never let through over a check that may still run.
test('without the helper: the id check alone, never a crash', async () => {
  const copy = path.join(root, 'copy', 'skills', 'gate', 'scripts', 'pre-review.mjs');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  // The gate scripts pre-review imports go with it (the missing helper is hooks/lib, outside this folder).
  const scripts = gateImports(path.dirname(script), 'pre-review.mjs');
  for (const f of scripts) fs.copyFileSync(path.join(path.dirname(script), f), path.join(path.dirname(copy), f));
  assert.equal(await ask({ pidStartedAt: iso(ownStart() - 3600000) }, copy), other);
  // The copied folder holds every './x.mjs' file that any copied script names, and nothing of hooks/lib.
  const copied = new Set(fs.readdirSync(path.dirname(copy)));
  for (const f of scripts) for (const needed of gateImports(path.dirname(script), f)) assert.ok(copied.has(needed), `${f} needs ${needed}`);
  for (const f of ['size-check.mjs', 'stack.mjs', 'check-ticket-lines.mjs', 'is-main.mjs', 'git-bash.mjs', 'pre-review-cache.mjs']) assert.ok(copied.has(f), `${f} is still copied`);
  assert.equal(fs.existsSync(path.join(root, 'copy', 'hooks')), false);
});

test('the import follower reads static, re-export and dynamic imports, each once', () => {
  const dir = fs.mkdtempSync(path.join(root, 'imports-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), "import fs from 'node:fs';\nimport { b } from './b.mjs';\nexport { c } from './c.mjs';\nconst d = await import('./d.mjs');\n// import { no } from './comment-only.mjs' is not at a line start\n");
  fs.writeFileSync(path.join(dir, 'b.mjs'), "import {\n  c,\n} from './c.mjs';\nimport { a } from './a.mjs';\nexport const b = 1;\n");
  fs.writeFileSync(path.join(dir, 'c.mjs'), 'export const c = 1;\n');
  fs.writeFileSync(path.join(dir, 'd.mjs'), "import { e } from '../outside/e.mjs';\nexport const d = 1;\n");
  assert.deepEqual(gateImports(dir, 'a.mjs'), ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']);
});
