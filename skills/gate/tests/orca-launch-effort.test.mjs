// 2026-11-25 (owner, effort by role): a remote re-check starts at high, as the recheck-reviewer agent file does;
// every other remote role keeps xhigh. ssh and orca are fakes: the fake orca saves its launch arguments and shows a
// screen with the brief's name and the banner of the effort it was asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitBash, bashEnv } from '../scripts/git-bash.mjs';

const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'remote', 'orca-launch.sh');

function launch(role) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-effort-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const args = path.join(root, 'args.txt').split(path.sep).join('/');
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'orca'), [
    '#!/usr/bin/env bash',
    `if [ "$1 $2" = "agent launch" ]; then printf '%s\\n' "$@" > "${args}"; echo "handle: term_fake"; exit 0; fi`,
    // The banner shows the effort the launch asked for, so a right launch is LAUNCHED, never MODEL MISMATCH.
    `if [ "$1 $2" = "terminal read" ]; then e=$(grep -A1 -x -- --effort "${args}" | tail -1); echo "b.md"; echo "Sonnet 5.5 with $e effort"; exit 0; fi`,
    'exit 0', ''].join('\n'), { mode: 0o755 });
  const env = bashEnv();
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const r = spawnSync(gitBash().exe, [launcher, '--role', role, 'env', 'C:/w', 'C:/b.md'], { encoding: 'utf8', windowsHide: true, env: { ...env, [key]: bin + path.delimiter + (env[key] || '') } });
  const sent = fs.existsSync(args) ? fs.readFileSync(args, 'utf8').split(/\r?\n/) : [];
  return { r, effort: sent[sent.indexOf('--effort') + 1] };
}

test('orca-launch.sh: a remote re-check runs at high; the whole-diff review keeps xhigh', () => {
  const recheck = launch('recheck');
  assert.equal(recheck.effort, 'high', recheck.r.stdout + recheck.r.stderr);
  assert.match(recheck.r.stdout, /^LAUNCHED term_fake \(engine claude, recheck: Sonnet 5\.5 with high effort\)/m);
  const review = launch('review');
  assert.equal(review.effort, 'xhigh', review.r.stdout + review.r.stderr);
  assert.match(review.r.stdout, /^LAUNCHED term_fake \(engine claude, review: Sonnet 5\.5 with xhigh effort\)/m);
});
