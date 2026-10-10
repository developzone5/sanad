import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import guard from '../lib/verification-target.cjs';

const { invalidVerificationTarget: invalid, isInspection, verificationTarget } = guard;

test('empty referenced TypeScript roots are rejected for implicit and explicit projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-target-'));
  try {
    const project = path.join(root, 'project with spaces');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '\uFEFF{\n// root project\n"files": [], /* no source */ "references": [{"path":"./app",},],\n}');
    const rejected = [
      ['tsc', ['--noEmit'], project],
      ['tsc', ['--noEmit', '-p', '.'], project],
      ['npx.cmd', ['tsc', '--project', project, '--noEmit'], root],
      ['npx', ['--yes', 'tsc', '--project=project with spaces/tsconfig.json'], root],
      ['npm.cmd', ['exec', '--', 'tsc', '--project', './project with spaces/tsconfig.json'], root],
      ['pnpm', ['exec', 'tsc', '-p=project with spaces'], root],
      ['C:/tools/tsc.cmd', ['--project', 'tsconfig.json'], project],
    ];
    for (const [exe, args, cwd] of rejected) assert.match(invalid(exe, args, cwd), /no source files/, JSON.stringify([exe, args]));
    assert.equal(invalid('tsc', ['-b'], project), '');
    assert.equal(invalid('tsc', ['--build', '.'], project), '');
    assert.equal(invalid('tsc', ['--noEmit', 'src.ts'], project), '');
    assert.equal(invalid('node', ['--test'], project), '');
    fs.writeFileSync(path.join(project, 'tsconfig.app.json'), '{"include":["src/**/*.ts"],"compilerOptions":{"baseUrl":"https://example.test/a//b"},}');
    assert.equal(invalid('tsc', ['-p', 'tsconfig.app.json'], project), '');
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"extends":"./tsconfig.app.json", "files":[], "references":[{"path":"./app"}]}');
    assert.equal(invalid('tsc', ['-p', '.'], project), '');
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('verification-target-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inventory is permitted for inspection but cannot establish verification evidence', () => {
  for (const flag of ['--listFilesOnly', '--showConfig', '--help', '--version', '-h', '-v']) {
    assert.equal(isInspection([flag]), true);
    assert.match(invalid('npx', ['tsc', flag], process.cwd()), /does not verify/);
  }
  assert.equal(isInspection(['--noEmit']), false);
  assert.deepEqual(verificationTarget('npm.cmd', ['exec', '--', 'tsc', '-p', 'a b']), { executable: 'tsc', args: ['-p', 'a b'] });
});
