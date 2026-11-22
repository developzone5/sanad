import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-20, stop gate P4 (the "promote students" task). The same failed proof blocked the stop on every reply:
//  1. The gate remembers a blocked change only for a transcript under .claude/projects. An Orca session keeps its
//     transcript under claude-profiles/<id>/home/projects, so it had no memory (6 blocks, one failure).
//  2. A command with an empty assignment before the program (`NAME= node red-proof.mjs ...`) was not read as a
//     verify run, so the proof that passed was never credited.
//  3. A replacement check that failed itself, then a second CHECK RETIRED for the original check with a passing
//     replacement, left the second failure open.
// The real stop-gate.js runs in a child process; the state lives in a temp home folder.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-env-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const appdata = path.join(root, 'appdata');
// The real Orca place of a profile's transcripts (APPDATA/orca/claude-profiles/<id>/home/projects).
const orca = (id, name) => path.join(appdata, 'orca', 'claude-profiles', id, 'home', 'projects', 'proj', name);
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
// No SANAD_STATE_DIR here: the gate decides by the transcript's own path, as it does for a real session.
const cleanEnv = () => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appdata };
  delete e.SANAD_STATE_DIR; delete e.CLAUDE_CONFIG_DIR;
  return e;
};

let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 20, 6, 0, 0) + (++seq) * 1000).toISOString();
const call = (id, name, input) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, content = '', isError = false) => ({ type: 'user', cwd: repo, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const say = (text) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const user = (text) => ({ type: 'user', cwd: repo, timestamp: at(), message: { role: 'user', content: text }, origin: { kind: 'human' }, userType: 'external', promptId: 'p' + seq });
const edit = (file) => { const id = 'e' + (++seq); return [call(id, 'Edit', { file_path: path.join(repo, file) }), done(id, 'File updated.')]; };
const shell = (command, output = '') => { const id = 'b' + (++seq); return [call(id, 'Bash', { command }), done(id, output)]; };
const PASS = ' Test Files  1 passed (1)\n      Tests  3 passed (3)';
const FAIL = ' Tests  2 failed | 1 passed (3)';

function session(file, env) {
  const entries = [];
  const s = {
    add(...more) { entries.push(...more.flat()); return s; },
    stop(last) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
      const input = { hook_event_name: 'Stop', session_id: path.basename(file), transcript_path: file, cwd: repo, stop_hook_active: false, last_assistant_message: last };
      const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], { input: JSON.stringify(input), env, cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const o = out.trim() ? JSON.parse(out) : {};
      return { decision: o.decision || 'allow', text: String(o.reason || o.systemMessage || '') };
    },
  };
  return s;
}

test('a session whose transcript is in an Orca profile folder keeps the one-block memory', () => {
  const file = orca('p1', 'orca-session.jsonl');
  const s = session(file, cleanEnv()).add(edit('src/App.ts'), shell('npx vitest run', FAIL));
  assert.equal(s.stop('The tests fail.').decision, 'block', 'the first stop blocks');
  s.add(user('what now?'), say('Waiting.'));
  const again = s.stop('Waiting.');
  assert.equal(again.decision, 'allow', 'the same failure must not block again: ' + again.text);
  assert.match(again.text, /NOT verified/);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'state', 'review-notes-blocks.json')), 'the memory was written in the home state folder');
});

test('a transcript outside any known session folder keeps no memory and never writes the user state', () => {
  const file = path.join(root, 'elsewhere', 'plain.jsonl');
  const s = session(file, cleanEnv()).add(edit('src/App.ts'));
  assert.equal(s.stop('Changed.').decision, 'block');
  assert.equal(s.add(user('and?'), say('Waiting.')).stop('Waiting.').decision, 'block', 'no memory: the base rule of a block each time');
});

test('the config folder named by CLAUDE_CONFIG_DIR counts as a session folder', () => {
  const config = path.join(root, 'custom-config');
  const file = path.join(config, 'projects', 'proj', 'custom.jsonl');
  const s = session(file, { ...cleanEnv(), CLAUDE_CONFIG_DIR: config }).add(edit('src/App.ts'));
  assert.equal(s.stop('Changed.').decision, 'block');
  assert.equal(s.add(user('and?'), say('Waiting.')).stop('Waiting.').decision, 'allow');
});

test('a verify command behind empty assignments (NAME= node ...) is a verify run', () => {
  const scan = path.join(hooks, 'lib', 'transcript-scan.js');
  const run = `const s=require(${JSON.stringify(scan)});
    const c=['GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0= node S/red-proof.mjs --repo W --then-green -- dotnet test X','A= dotnet test X','A= B=1 C= npx vitest run','A= echo dotnet test'];
    console.log(JSON.stringify(c.map((x)=>s.segmentIsVerify(x))));`;
  const got = JSON.parse(execFileSync(process.execPath, ['-e', run], { encoding: 'utf8' }));
  assert.deepEqual(got, [true, true, true, false]);
});

test('a passing run behind an empty assignment clears the stop', () => {
  const s = session(orca('p2', 'empty.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('FLAG= npx vitest run', PASS));
  const r = s.stop('Done.');
  assert.equal(r.decision, 'allow', r.text);
  assert.match(r.text, /completed successfully/);
});

test('a replacement that failed itself is retired by a later CHECK RETIRED with a passing replacement', () => {
  const retire = (failed, replacement) => say('CHECK RETIRED: ' + JSON.stringify({ failed, replacement, reason: 'environment, not the code' }));
  const s = session(orca('p3', 'chain.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), retire('npx vitest run old', 'npx vitest run first'),
      shell('npx vitest run first', FAIL));
  assert.equal(s.stop('Retired.').decision, 'block', 'the failed replacement is still a failure');
  s.add(retire('npx vitest run old', 'FLAG= npx vitest run second'), shell('FLAG= npx vitest run second', PASS));
  const r = s.stop('Passes now.');
  assert.equal(r.decision, 'allow', r.text);
  assert.match(r.text, /completed successfully/);
});

test('a CHECK RETIRED line for another check does not retire an unrelated failure', () => {
  const s = session(orca('p4', 'other.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run alpha', FAIL), shell('npx vitest run beta', FAIL),
      say('CHECK RETIRED: ' + JSON.stringify({ failed: 'npx vitest run alpha', replacement: 'npx vitest run gamma', reason: 'x' })),
      shell('npx vitest run gamma', PASS));
  const r = s.stop('Done.');
  assert.equal(r.decision, 'block', 'beta stays failed');
  assert.match(r.text, /FAILED/);
});

// ---- fix round 1 (2026-11-20) ----------------------------------------------------------------------------------------
const retireLine = (failed, replacement) => say('CHECK RETIRED: ' + JSON.stringify({ failed, replacement, reason: 'environment, not the code' }));

test('B1: a failure named as a replacement only AFTER it failed is not cleared by another check passing', () => {
  const s = session(orca('b1a', 'order.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), shell('npx vitest run other', FAIL),
      // "other" is named as a replacement only now, after its own failure; then a second line with a passing replacement.
      retireLine('npx vitest run old', 'npx vitest run other'),
      retireLine('npx vitest run old', 'npx vitest run second'), shell('npx vitest run second', PASS));
  const r = s.stop('Done.');
  assert.equal(r.decision, 'block', 'the failure of "other" must stay open: ' + r.text);
  assert.match(r.text, /npx vitest run other/);
});

test('B1: the real session order clears (retire 1, replacement fails, retire 2 with a new replacement, it passes)', () => {
  const s = session(orca('b1b', 'real.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), retireLine('npx vitest run old', 'npx vitest run first'),
      shell('npx vitest run first', FAIL), retireLine('npx vitest run old', 'npx vitest run second'), shell('npx vitest run second', PASS));
  const r = s.stop('Done.');
  assert.equal(r.decision, 'allow', r.text);
});

test('B2: a fixture under temp folders with the Orca or .claude folder names keeps no memory and writes no user state', () => {
  const fixtures = [
    path.join(root, 'fx1', 'claude-profiles', 'p', 'home', 'projects', 'proj', 'fixa.jsonl'),
    path.join(root, 'fx2', '.claude', 'projects', 'proj', 'fixb.jsonl'),
    path.join(root, 'fx3', 'orca', 'claude-profiles', 'p', 'home', 'projects', 'proj', 'fixc.jsonl'),
  ];
  for (const file of fixtures) {
    const s = session(file, cleanEnv()).add(edit('src/App.ts'));
    assert.equal(s.stop('Changed.').decision, 'block');
    assert.equal(s.add(user('and?'), say('Waiting.')).stop('Waiting.').decision, 'block', 'no memory for ' + file);
  }
  const kept = path.join(home, '.claude', 'state', 'review-notes-blocks.json');
  assert.ok(!fs.existsSync(kept) || !/fix[abc]\.jsonl/.test(fs.readFileSync(kept, 'utf8')), 'no fixture key in the user state');
});

test('B2: the real ~/.claude/projects folder is trusted', () => {
  const s = session(path.join(home, '.claude', 'projects', 'proj', 'home-session.jsonl'), cleanEnv()).add(edit('src/App.ts'));
  assert.equal(s.stop('Changed.').decision, 'block');
  assert.equal(s.add(user('and?'), say('Waiting.')).stop('Waiting.').decision, 'allow');
});

test('B3: a program that only STARTS with a runner name is not a verify run, with or without a prefix', () => {
  const scan = path.join(hooks, 'lib', 'transcript-scan.js');
  const run = `const s=require(${JSON.stringify(scan)});
    const bad=['dotnetfoo test','X= dotnetfoo test','X= npx vitest-ish','npx vitest-ish','X= vitest-ish','X= pytest-foo','X= make tests','X= docker buildx bake','X= jestfoo','X= mvnfoo','X= gradlefoo','X= phpunitx','X= cargo-foo test','X= go testing'];
    const good=['X= dotnet test A.csproj','X= npx vitest run','X= vitest','X= pytest tests/','X= make test','X= docker build .','X= npm run build:prod','X= npm test -- a','X= cargo test','X= go test ./...','X= mvn -q test','X= tsc --noEmit'];
    console.log(JSON.stringify({bad:bad.map((x)=>s.segmentIsVerify(x)),good:good.map((x)=>s.segmentIsVerify(x))}));`;
  const got = JSON.parse(execFileSync(process.execPath, ['-e', run], { encoding: 'utf8' }));
  assert.ok(got.bad.every((x) => x === false), 'a lookalike was credited: ' + JSON.stringify(got.bad));
  assert.ok(got.good.every((x) => x === true), 'a real runner was refused: ' + JSON.stringify(got.good));
});

test('B4: a BACKGROUND proof that failed (nothing ran) blocks once, also with reviewer reports between the stops', () => {
  const out = path.join(root, 'bg-proof.output');
  fs.writeFileSync(out, 'RED-PROOF: ENVIRONMENT x - the database on the test machine is not ready (DOCKER-DOWN); nothing ran.\n');
  const command = 'node C:/Users/Asus/.claude/skills/gate/scripts/red-proof.mjs --breaks b.json --then-green --log p.log -- dotnet test X.csproj';
  const bgCall = 'bg' + (++seq);
  const notice = (task) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification>\n<task-id>' + task + '</task-id>\n<status>failed</status>\n<summary>Background command "proof" failed (exit code 6)</summary>\n<output-file>' + out + '</output-file>\n</task-notification>' } });
  const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
  const report = (id, text) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, origin: { kind: 'peer', from: id },
    prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n  ' + text + '\n</agent-message>' } });
  const launch = (id) => [call(id + '-call', 'Agent', { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.', run_in_background: true }),
    done(id + '-call', 'Async agent launched successfully.')];
  const s = session(orca('b4', 'background.jsonl'), cleanEnv()).add(edit('src/App.ts'),
    call(bgCall, 'Bash', { command, run_in_background: true }), done(bgCall, 'Command running in background with ID: bgproof'), notice('bgproof'));
  const first = s.stop('The proof did not run.');
  assert.equal(first.decision, 'block', 'the failed background proof blocks once: ' + first.text);
  s.add(user('what now?'), say('Waiting for the database.'));
  assert.equal(s.stop('Waiting for the database.').decision, 'allow', 'same failure, no new edit or run');
  s.add(launch('rev1'), report('rev1', 'RECOMMEND: PASS Nothing found in the diff.'));
  s.add(user('and the review?'), say('The review is in.'));
  const again = s.stop('The review is in.');
  assert.equal(again.decision, 'allow', 'a reviewer report between stops must not make it another change: ' + again.text);
  assert.match(again.text, /NOT verified/);
  // A new run that fails again is another change.
  const bg2 = 'bg' + (++seq);
  s.add(call(bg2, 'Bash', { command, run_in_background: true }), done(bg2, 'Command running in background with ID: bgproof2'), notice('bgproof2'));
  assert.equal(s.stop('Run again.').decision, 'block', 'a new failed run blocks once more');
});

test('F2: a replacement that fails for real after a NEW EDIT is not the retired check', () => {
  const s = session(orca('f2a', 'edit.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), retireLine('npx vitest run old', 'npx vitest run'),
      edit('src/App.ts'), shell('npx vitest run', FAIL),
      retireLine('npx vitest run old', 'npx vitest run gamma'), shell('npx vitest run gamma', PASS));
  const r = s.stop('Done.');
  assert.equal(r.decision, 'block', 'the real failure after the edit must stay open: ' + r.text);
  assert.match(r.text, /FAILED/);
});

test('R2: a docs edit (README.md) after the retirement keeps the link; a code edit in the same place ends it', () => {
  const run = (file, id) => session(orca(id, 'docs.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), retireLine('npx vitest run old', 'npx vitest run'),
      edit(file), shell('npx vitest run', FAIL),
      retireLine('npx vitest run old', 'npx vitest run gamma'), shell('npx vitest run gamma', PASS)).stop('Done.');
  const docs = run('README.md', 'r2a');
  assert.equal(docs.decision, 'allow', 'a README edit does not end the link: ' + docs.text);
  assert.equal(run('src/App.ts', 'r2b').decision, 'block', 'a code edit still ends the link');
});

test('F2: a replacement that already passed once is no longer linked when it fails again', () => {
  const s = session(orca('f2b', 'passed.jsonl'), cleanEnv())
    .add(edit('src/App.ts'), shell('npx vitest run old', FAIL), retireLine('npx vitest run old', 'npx vitest run first'),
      shell('npx vitest run first', PASS), shell('npx vitest run first', FAIL),
      retireLine('npx vitest run old', 'npx vitest run gamma'), shell('npx vitest run gamma', PASS));
  assert.equal(s.stop('Done.').decision, 'block', 'the later failure of a replacement that had passed stays open');
});
