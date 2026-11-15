import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bashEnv, gitBash } from '../scripts/git-bash.mjs';
import { proofScripts } from '../scripts/red-proof.mjs';

// 2026-11-15: on the test machine, over ssh, `bash` was the WSL launcher, and every script run through it failed.
test('on Windows the scripts run with Git\'s own bash, and its tools come first on PATH for that run only', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const { exe, tools } = gitBash();
  assert.match(exe, /[\\/]usr[\\/]bin[\\/]bash\.exe$/i, exe);
  assert.ok(fs.existsSync(exe), exe);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  const env = bashEnv();
  assert.equal(env[key].split(path.delimiter)[0], tools);
  assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').length, 1, 'one PATH variable, never two spellings');
  assert.notEqual(process.env[key].split(path.delimiter)[0], tools, 'the process itself is unchanged');
});

test('the helper travels with the proof to the test machine', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts');
  assert.ok(proofScripts(dir).includes('git-bash.mjs'));
});
