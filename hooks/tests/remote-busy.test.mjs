// remote-busy.mjs: who holds the test machine's clone right now?
// 2026-11-12: the first version compared folders as text. On the CI machine the temp folder has two
// spellings (C:\Users\RUNNER~1\… and C:\Users\runneradmin\…): a folder's own check then read as another
// task's, and its own sync was refused with REMOTE-BUSY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'remote', 'remote-busy.mjs');
const REMOTE = 'C:/repos/App';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-busy-'));
  const state = path.join(root, 'state'), mine = path.join(root, 'my-task-folder-with-a-long-name'), other = path.join(root, 'another-task-folder');
  for (const d of [state, mine, other]) fs.mkdirSync(d);
  const ask = (top) => spawnSync(process.execPath, [script, top, 'pc2', REMOTE], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SANAD_STATE_DIR: state, SANAD_CHECK_LOCK_DIR: '' } }).stdout.trim();
  const lock = (toplevel, over = {}) => {
    const dir = path.join(state, 'check-locks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, Math.random().toString(16).slice(2) + '.json'), JSON.stringify({ toplevel, pid: process.pid, startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(), command: 'ssh.exe -o BatchMode=yes pc2 cd /d C:\\repos\\App\\Server && dotnet test', ...over }));
  };
  return { root, state, mine, other, ask, lock };
}
// Another spelling of the same folder. A short 8.3 name exists only on some drives, so the test uses a
// link to the folder (a junction on Windows needs no special right): both names are one folder on disk.
function otherSpelling(dir) {
  const link = path.join(path.dirname(dir), 'link-to-' + path.basename(dir));
  if (!fs.existsSync(link)) fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

test("another folder's live check in the clone is named; a free clone prints nothing", () => {
  const { root, mine, other, ask, lock } = setup();
  try {
    assert.equal(ask(mine), '');
    lock(other);
    assert.match(ask(mine), /^a check of .*another-task-folder is running in pc2:C:\/repos\/App/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("this folder's own check never counts, whatever spelling names the folder", () => {
  const { root, mine, ask, lock } = setup();
  try {
    const spelled = otherSpelling(mine);
    assert.notEqual(spelled, mine);
    lock(spelled);
    assert.equal(ask(mine), '', `own check written as ${spelled}`);
    assert.equal(ask(spelled), '', 'and asked with the other spelling');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("this folder's own browser-check app never counts, whatever spelling names the folder; another folder's does", () => {
  const { root, state, mine, other, ask } = setup();
  try {
    fs.writeFileSync(path.join(state, 'remote-web-pc2.link'), `1 ${process.pid} 3000 5050\n`);
    fs.writeFileSync(path.join(state, 'remote-web-pc2.owner'), otherSpelling(mine) + '\n');
    assert.equal(ask(mine), '');
    fs.writeFileSync(path.join(state, 'remote-web-pc2.owner'), other + '\n');
    assert.match(ask(mine), /^the browser-check app of .*another-task-folder is served from pc2:C:\/repos\/App/);
    fs.writeFileSync(path.join(state, 'remote-web-pc2.link'), '1 999999 3000 5050\n');
    assert.equal(ask(mine), '', 'a link that is gone holds nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
