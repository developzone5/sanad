import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-19, one block per unverified change. Before, the stop gate blocked every new stop while the same
// change was unverified (21 identical blocks hit question turns in one day). Now it remembers the change it
// blocked: the same change again only warns, a new edit or a new failure blocks once again, a pass claim or a
// push command is still held by the claim lock, and no memory means a block (never a silent allow).
// The real stop-gate.js runs in a child process; each session has its own transcript file; state in a temp folder.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-once-')));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });
// Reviewer reports count from this time on (the notes lock's start time).
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
const memory = path.join(stateDir, 'review-notes-blocks.json');
// A folder that is a work tree (a .git folder): files in it are the project even below the temp folder.
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
const env = { ...process.env, SANAD_STATE_DIR: stateDir };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 19, 6, 0, 0) + (++seq) * 1000).toISOString();
const call = (id, name, input) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, content = '', toolUseResult, isError = false) => ({ type: 'user', cwd: repo, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...(toolUseResult ? { toolUseResult } : {}) });
const say = (text) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
// A message the user typed: a new turn.
const user = (text) => ({ type: 'user', cwd: repo, timestamp: at(), message: { role: 'user', content: text }, origin: { kind: 'human' }, userType: 'external', promptId: 'p' + seq });
const edit = (file) => { const id = 'e' + (++seq); return [call(id, 'Edit', { file_path: path.join(repo, file) }), done(id, 'File updated.')]; };
const shell = (command, output = '', error = false) => { const id = 'b' + (++seq); return [call(id, 'Bash', { command }), done(id, output, undefined, error)]; };
const PASS = ' Test Files  1 passed (1)\n      Tests  3 passed (3)';
const FAIL = ' Tests  2 failed | 1 passed (3)';
const PUSH = 'GATE: PASS\n\n```\ngit push -u origin fix/probe\n```';
const question = (q = 'what does this function do?', a = 'It maps the rows.') => [user(q), say(a)];

// One session: its own id and its own transcript file, which grows between stops.
let sessions = 0;
function session(name = 'once-' + (++sessions), file = path.join(root, name + '.jsonl')) {
  const entries = [];
  return {
    name, file,
    add(...more) { entries.push(...more.flat()); return this; },
    stop({ last, active = false, runEnv = env } = {}) {
      fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
      const input = { hook_event_name: 'Stop', session_id: name, transcript_path: file, cwd: repo, stop_hook_active: active };
      if (last !== undefined) input.last_assistant_message = last;
      const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], { input: JSON.stringify(input), env: runEnv, cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const o = out.trim() ? JSON.parse(out) : {};
      return { decision: o.decision || 'allow', text: String(o.reason || o.systemMessage || '') };
    },
  };
}
const blocked = (s, opts, why) => { const r = s.stop(opts); assert.equal(r.decision, 'block', why || r.text); return r; };
const passed = (s, opts, why) => { const r = s.stop(opts); assert.equal(r.decision, 'allow', (why ? why + ': ' : '') + r.text); return r; };
// A session whose one unverified edit was already blocked once.
const blockedOnce = () => { const s = session().add(edit('src/App.ts')); blocked(s, { last: 'I changed App.ts.' }); return s; };

test('an unverified change is blocked once; the same change at a later stop only warns', () => {
  const s = session().add(edit('src/App.ts'));
  const first = blocked(s, { last: 'I changed App.ts.' });
  assert.match(first.text, /^Code files were edited this session \(last edit: App\.ts\) but no build\/test has run since the last edit\./);
  // The host's own second stop of the same turn: the warning, as before.
  assert.match(passed(s, { last: 'Tests have not run yet.', active: true }).text, /NOT verified/);
  // A new user turn with a plain answer: no block again, the warning text.
  s.add(question());
  const second = passed(s, { last: 'It maps the rows.' }, 'the same change must not block twice');
  assert.equal(second.text, '⛔ Gate NOT verified: code changed after the last passing build/test. Run /gate before shipping.');
  s.add(question('and this one?', 'It sorts them.'));
  assert.match(passed(s, { last: 'It sorts them.' }).text, /NOT verified/);
  // Without the host's final text (an older host) the same holds.
  s.add(question('and the third?', 'It saves them.'));
  assert.match(passed(s).text, /NOT verified/);
});

test('after the one block, a pass claim or a push command is blocked every time, as in the base', () => {
  const claims = ['GATE: PASS', 'REVIEW: PASS', 'All done.\nREVIEW: PASS\nGATE: PASS', PUSH, 'Done. Now run git push origin HEAD:fix/probe to publish.',
    'Run `git push origin HEAD:fix/probe`', 'Run:\n```\ngit push\n```', '**gh pr create --draft --base staging**', 'done, it works.\n\nGATE: PASS'];
  for (const last of claims) {
    const s = blockedOnce().add(user('is it done?'), say(last));
    const again = blocked(s, { last }, 'not held: ' + last);
    assert.match(again.text, /^Code files were edited this session/, last);
    assert.match(again.text, /\(SG-UNVERIFIED\)$/, last);
    assert.match(blocked(s, { last, active: true }).text, /^The final text claims a pass/, 'and on the host second stop');
  }
  // An older host sends no final text: this turn's own verdict line holds the stop.
  const old = blockedOnce().add(user('is it done?'), say('GATE: PASS'));
  assert.match(blocked(old).text, /^Code files were edited this session/);
});
test('after the one block, plain words pass with the warning and no claim rides along', () => {
  const s = blockedOnce().add(user('is it done?'), say('done, it works'));
  assert.match(passed(s, { last: 'done, it works' }).text, /NOT verified/);
  s.add(user('sure?'), say('done, it works.\n\n```\ngit push -u origin fix/probe\n```'));
  blocked(s, { last: 'done, it works.\n\n```\ngit push -u origin fix/probe\n```' });
});
test('a claim takes the main block on every repeated stop, with no 6th pass-through', () => {
  const s = blockedOnce().add(user('is it done?'), say(PUSH));
  const got = [];
  for (let i = 0; i < 7; i++) got.push(s.stop({ last: PUSH }).decision);
  assert.deepEqual(got, Array(7).fill('block'));
});
test('plain text passes with the warning after the one block, a claim never does', () => {
  const s = blockedOnce().add(user('how is it?'), say('Not tested yet.'));
  assert.match(passed(s, { last: 'Not tested yet.' }).text, /NOT verified/);
  for (const last of ['GATE: PASS', 'REVIEW: PASS']) {
    s.add(user('and now?'), say(last));
    assert.match(blocked(s, { last }, last).text, /\(SG-UNVERIFIED\)$/);
  }
  s.add(user('again?'), say('Still not tested.'));
  assert.match(passed(s, { last: 'Still not tested.' }).text, /NOT verified/);
});

test('a new edit after the first block blocks once more', () => {
  const s = blockedOnce().add(question());
  passed(s, { last: 'It maps the rows.' });
  // The same file again, another file, a move, a formatter and a git move: each is a new change.
  for (const change of [edit('src/App.ts'), edit('src/Other.ts'), shell('mv src/Other.ts src/Other2.ts'), shell('npx prettier --write src/App.ts'), shell('git mv src/App.ts src/App2.ts')]) {
    s.add(change);
    assert.match(blocked(s, { last: 'Changed it.' }, 'a new change must block').text, /\(SG-UNVERIFIED\)$/);
    s.add(question());
    passed(s, { last: 'It maps the rows.' }, 'and then only warns');
  }
  // Two tiny edits one after the other: each stop sees a new last edit.
  for (const file of ['src/A.ts', 'src/B.ts', 'src/A.ts', 'src/B.ts']) blocked(s.add(edit(file)), { last: 'Changed it.' });
});
test('a failing test after a "no test" block blocks once more, and so does each new failing run', () => {
  const s = blockedOnce().add(shell('npx vitest run', FAIL));
  const failed = blocked(s, { last: 'The tests fail.' }, 'a new failure must block');
  assert.match(failed.text, /^The last build\/test run after your code edit FAILED/);
  const retire = /CHECK RETIRED: (\{.*\})$/m.exec(failed.text);
  assert.ok(retire, 'the CHECK RETIRED line still ends its own line');
  assert.equal(JSON.parse(retire[1]).failed, 'npx vitest run');
  assert.match(failed.text, /\n\(SG-FAILED\)$/);
  s.add(question());
  assert.equal(passed(s, { last: 'It maps the rows.' }).text, '⛔ Gate NOT verified: the last build/test after your code edit FAILED. Run /gate before shipping.');
  blocked(s.add(user('done?'), say('GATE: PASS')), { last: 'GATE: PASS' }, 'a claim over a failed run is held');
  // The same command fails again: a new failure.
  s.add(shell('npx vitest run', FAIL));
  blocked(s, { last: 'Still failing.' }, 'a new failing run must block');
  passed(s.add(question()), { last: 'It maps the rows.' });
  // It passes: verified. The next edit is a new change.
  s.add(shell('npx vitest run', PASS));
  assert.match(passed(s, { last: 'GATE: PASS' }).text, /completed successfully/);
  assert.match(blocked(s.add(edit('src/App.ts')), { last: 'One more change.' }).text, /\(SG-UNVERIFIED\)$/);
});
test('a check whose result was never collected blocks once, then warns', () => {
  const s = blockedOnce().add(call('bg-lost', 'Bash', { command: 'dotnet test', run_in_background: true }));
  const lost = blocked(s, { last: 'The tests run.' }, 'a lost check is a new state');
  assert.match(lost.text, /result was never collected.*: `dotnet test`/);
  assert.match(lost.text, /\(SG-PENDING\)$/);
  s.add(question());
  assert.match(passed(s, { last: 'It maps the rows.' }).text, /result was never collected/);
});

test('a missing, broken or unwritable state file: a block every time, never a silent allow', () => {
  const s = blockedOnce();
  const key = s.name + '#once';
  const again = (why) => blocked(s.add(question()), { last: 'It maps the rows.' }, why);
  for (let i = 0; i < 2; i++) { fs.rmSync(memory, { force: true }); again('a deleted file'); }
  const broken = ['', '{not json', 'null', '[]', '5', JSON.stringify({ [key]: 5 }), JSON.stringify({ [key]: null }), JSON.stringify({ [key]: 'x' }),
    JSON.stringify({ [key]: {} }), JSON.stringify({ [key]: { change: 'another change', at: Date.now() } }), JSON.stringify({ [key]: [] }), JSON.stringify({ ['other#once']: { change: 'x' } })];
  for (const text of broken) { fs.writeFileSync(memory, text); again('a broken file: ' + text); }
  // A folder in the file's place can be neither read nor written.
  fs.rmSync(memory, { force: true });
  fs.mkdirSync(memory);
  for (let i = 0; i < 3; i++) again('an unreadable, unwritable file');
  fs.rmSync(memory, { recursive: true, force: true });
  // A file that holds an older change and cannot be written: the new change is blocked at every stop.
  again('the file is back');
  passed(s.add(question()), { last: 'It maps the rows.' });
  fs.chmodSync(memory, 0o444);
  let writable = true;
  try { fs.accessSync(memory, fs.constants.W_OK); } catch (e) { writable = false; }
  try {
    if (!writable) { s.add(edit('src/New.ts')); for (let i = 0; i < 3; i++) again('a read-only file'); }
  } finally { fs.chmodSync(memory, 0o666); }
});
test('with no state folder for the transcript, the gate blocks every time, as before', () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bare = { ...process.env, USERPROFILE: home, HOME: home };
  delete bare.SANAD_STATE_DIR;
  const s = session().add(edit('src/App.ts'));
  for (let i = 0; i < 3; i++) { blocked(s, { last: 'It maps the rows.', runEnv: bare }, 'no memory: block'); s.add(question()); }
  assert.equal(fs.existsSync(path.join(home, '.claude', 'state', 'review-notes-blocks.json')), false, 'nothing is written for a test transcript');
});

test('two sessions on one repository: one session\'s memory does not quiet the other', () => {
  const a = blockedOnce();
  const b = session().add(edit('src/App.ts'));
  blocked(b, { last: 'I changed App.ts.' }, 'the other session gets its own block');
  passed(a.add(question()), { last: 'It maps the rows.' }, 'and it does not block the first one again');
  passed(b.add(question()), { last: 'It maps the rows.' });
  // The same session id with another transcript is another record: its change is not the remembered one.
  const c = session(a.name, path.join(root, a.name + '-other.jsonl')).add(edit('src/App.ts'));
  blocked(c, { last: 'I changed App.ts.' });
});
test('the memory of a session keeps the counts of the notes lock and the claim lock in the same file', () => {
  const s = blockedOnce().add(user('is it done?'), say(PUSH));
  blocked(s, { last: PUSH });
  const kept = JSON.parse(fs.readFileSync(memory, 'utf8'));
  assert.equal(kept[s.name + '#claim'], undefined, 'a claim takes the main block and never the claim count');
  assert.equal(typeof kept[s.name + '#once'].change, 'string');
  // A memory older than 30 days is dropped at the next write; a count is never touched.
  kept['old-session#once'] = { change: 'x', at: Date.now() - 31 * 24 * 60 * 60 * 1000 };
  kept['other-session#claim'] = 3;
  fs.writeFileSync(memory, JSON.stringify(kept));
  blockedOnce();
  const after = JSON.parse(fs.readFileSync(memory, 'utf8'));
  assert.equal(after['old-session#once'], undefined);
  assert.equal(after['other-session#claim'], 3);
  assert.equal(typeof after[s.name + '#once'].change, 'string');
});

// A reviewer report with one open note (the shapes of stop-gate-promise.test.mjs).
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
const handBack = (id, report) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, origin: { kind: 'peer', from: id },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const launch = (id) => [call(id + '-call', 'Agent', { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.', run_in_background: true }),
  done(id + '-call', 'Async agent launched successfully.', { isAsync: true, status: 'async_launched', agentId: id })];
const notice = (id, report) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
const GAP = 'RECOMMEND: PASS\n- Gap — Upload.cs:9 — the error text is not translated';
// The open-notes list carries the id SG-NOTES at its end.
test('a block reason carries its rule id; the notes lock is not changed by the memory', () => {
  const s = blockedOnce().add(launch('rev-once'), handBack('rev-once', GAP), notice('rev-once', GAP));
  // A plain question about the notes passes, with the warning.
  s.add(user('what did the reviewer say?'), say('One gap. Do you want it fixed?'));
  assert.match(passed(s, { last: 'One gap. Do you want it fixed?' }).text, /NOT verified/);
  // A verdict with the note open: the claim lock and the notes lock both hold, each part with its id.
  s.add(user('ok'), say('REVIEW: PASS'));
  const both = blocked(s, { last: 'REVIEW: PASS' });
  assert.match(both.text, /^Code files were edited[\s\S]*\(SG-UNVERIFIED\)\n\nReviewer notes without an outcome[\s\S]*NOTE 1 \(Gap\)[\s\S]*A note is never closed by the author's own judgement\. \(SG-NOTES\)$/);
  // The first block of a change with the note open: the unverified part with its id, then the notes part.
  s.add(edit('src/App.ts'), say('REVIEW: PASS'));
  assert.match(blocked(s, { last: 'REVIEW: PASS' }).text, /^Code files were edited[\s\S]*\(SG-UNVERIFIED\)\n\nReviewer notes without an outcome[\s\S]*judgement\. \(SG-NOTES\)$/);
  // A joined block has two parts, each with exactly one id as the last thing of that part:
  // the first part SG-CLAIM or SG-FAILED, the notes part SG-NOTES (which also ends the whole text).
  for (const text of [both.text, blocked(s.add(shell('npx vitest run', FAIL)), { last: 'REVIEW: PASS' }).text]) {
    const [first, ...rest] = text.split('\n\nReviewer notes');
    assert.equal(first.match(/\(SG-[A-Z]+\)/g).length, 1, text);
    assert.match(first, /\(SG-(?:UNVERIFIED|FAILED)\)$/);
    assert.equal(rest.length, 1, text);
    const second = 'Reviewer notes' + rest[0];
    assert.equal(second.match(/\(SG-[A-Z]+\)/g).length, 1, text);
    assert.match(second, /\(SG-NOTES\)$/);
  }
});
