import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import scan from '../lib/transcript-scan.js';
import target from '../lib/verification-target.cjs';
import { runCommand } from '../../skills/gate/scripts/evidence.mjs';

// A real TypeScript install is machine-specific: WORKFLOW_TYPESCRIPT_RUNNER names <any>/node_modules/typescript/bin/tsc
// (CI sets it; workflow-install.sh finds one under ~/source/repos). The recognition test needs only the path shape.
const tsc = process.env.WORKFLOW_TYPESCRIPT_RUNNER || '';
const tscShape = tsc || 'C:/work/app/node_modules/typescript/bin/tsc';
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const quote = words => words.map(word => '"' + word + '"').join(' ');
const message = (role, content) => ({ type: role, message: { role, content } });

test('native Node package entrypoints are recognized without accepting arbitrary scripts', () => {
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape, '--noEmit', '-p', 'app config.json'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, npm, 'run', 'check'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, npm.replace('npm-cli.js', 'npx-cli.js'), 'tsc', '--noEmit'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape.replace('/bin/tsc', '/lib/tsc.js'), '--noEmit'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape, '--listFilesOnly'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/tsc.js', '--noEmit'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/npm-cli.js', 'run', 'check'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, '-e', 'process.exit(0)', 'run', 'check'])), false);
  // A pinned Node running the package's own vitest entrypoint is a test run; a lookalike script is not.
  assert.equal(scan.segmentIsVerify(quote(['C:/tools/node-v20/node.exe', 'node_modules/vitest/vitest.mjs', 'run'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'C:/work/app/node_modules/vitest/vitest.mjs', 'run', 'src/a.test.tsx'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/vitest.mjs', 'run'])), false);
  assert.deepEqual(target.nativeVerificationTarget('node.exe', ['node_modules\\vitest\\vitest.mjs', 'run']), { executable: 'vitest', args: ['run'] });
});

// Needs a real TypeScript install; point WORKFLOW_TYPESCRIPT_RUNNER at <any>/node_modules/typescript/bin/tsc.
const noTsc = tsc && fs.existsSync(tsc) ? false : 'set WORKFLOW_TYPESCRIPT_RUNNER to an installed node_modules/typescript/bin/tsc';
test('installed native TypeScript and npm runners produce usable source-bound receipts', { skip: noTsc }, async t => {
  assert.ok(fs.existsSync(npm), 'Installed npm Node entrypoint is required.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runner-proof-'));
  const repo = path.join(scratch, 'project with spaces');
  fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.writeFileSync(path.join(repo, 'source.ts'), 'export const value: number = 1;\n');
    fs.writeFileSync(path.join(repo, 'app config.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['source.ts'] }));
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './app config.json' }] }));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'native-runner-fixture', private: true, scripts: { check: 'node --check check.cjs' } }));
    fs.writeFileSync(path.join(repo, 'check.cjs'), 'module.exports = 1;\n');
    git(['init', '--initial-branch=staging']); git(['config', 'user.name', 'developzone5']); git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
    git(['add', '--', 'source.ts', 'app config.json', 'tsconfig.json', 'package.json', 'check.cjs']); git(['commit', '-m', 'test: native runners fixture']);
    const empty = execFileSync(process.execPath, [tsc, '--noEmit', '-p', '.'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(empty, '', 'Native tsc really exits zero without examining referenced source.');
    assert.match(target.invalidVerificationTarget(process.execPath, [tsc, '--noEmit', '-p', '.'], repo), /no source files/);
    for (const [label, args] of [['empty-typescript', [tsc, '--noEmit', '-p', '.']], ['typescript', [tsc, '--noEmit', '-p', 'app config.json']], ['npm', [npm, 'run', 'check']]]) {
      const record = await runCommand({ executable: process.execPath, args, cwd: repo, outputRoot: path.join(scratch, 'checks') });
      assert.equal(record.status, 'passed', record.reason);
      assert.equal(record.nativeExitCode, 0);
      assert.equal(record.source.treeBefore, record.source.treeAfter);
      const transcript = path.join(scratch, label + '.jsonl');
      fs.writeFileSync(transcript, [
        message('assistant', [{ type: 'tool_use', name: 'Bash', id: label, input: { command: 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json' } }]),
        message('user', [{ type: 'tool_result', tool_use_id: label, content: 'CHECK_COMPLETED ' + JSON.stringify(record), is_error: false }]),
      ].map(JSON.stringify).join('\n'));
      const observed = scan.scanTranscript(transcript, repo);
      if (label === 'empty-typescript') {
        assert.equal(observed.completedCheck, null, 'Native zero-source success must not establish verification.');
        assert.ok(observed.lastFailedVerify >= 0);
        t.diagnostic('Empty TypeScript root: native exit 0, source-bound receipt rejected as verification.');
        continue;
      }
      assert.equal(observed.completedCheck?.runId, record.runId, label + ' native receipt must count as completed verification.');
      assert.equal(observed.lastFailedVerify, -1);
      t.diagnostic(label + ': native exit 0, unchanged source tree, completed source-bound receipt recognized.');
    }
  } finally {
    assert.equal(path.dirname(scratch).toLowerCase(), os.tmpdir().toLowerCase());
    assert.ok(path.basename(scratch).startsWith('native-runner-proof-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
