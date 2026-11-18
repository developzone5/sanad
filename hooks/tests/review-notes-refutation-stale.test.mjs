import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-18 (audit 3 repair round): a note closed as refuted holds only while no content change follows the launch of
// the closing check (any non-prose edit, a git move, git apply or patch), whether the author writes the line before or
// after that change; a SendMessage never moves the launch; a fenced CONFIRMED still withdraws; a note that asks the
// user to decide is never refutable.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realRequire = createRequire(import.meta.url);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-notes-stale-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
const SINCE = '2026-01-01T00:00:00.000Z';
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), SINCE + '\n');
const scan = realRequire(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = 'C:/repos/example';
const at = (n) => new Date(Date.UTC(2026, 10, 18, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const shell = (id, command, content, n) => [call(id, 'Bash', { command }, n), result(id, content, n)];
const say = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const userSays = (text, n) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: at(n), origin: { kind: 'human' }, userType: 'external', promptId: 'p' + n });
const lines = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
const handBack = (id, report, n) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true,
  origin: { kind: 'peer', from: id, senderTaskId: id, name: 'x' },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const notice = (id, n, report) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
const launch = (id, n, input) => [call(id + '-call', 'Agent', { description: 'x', run_in_background: true, ...input }, n),
  result(id + '-call', 'Async agent launched successfully.', n, false, { isAsync: true, status: 'async_launched', agentId: id })];
const arrive = (id, n, report) => [handBack(id, report, n), notice(id, n, report)];
const run = (id, n, input, report) => [...launch(id, n, input), ...arrive(id, n + 1, report)];
const REVIEWER = { subagent_type: 'independent-reviewer', prompt: 'You are the independent reviewer (read-only). Review the diff.' };
const CHECKER = { subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Note check. Try to refute each open note. Read-only.' };
const GAP = 'RECOMMEND: FAIL\n- Gap — Upload.cs:9 — the error text is not translated';
const EV = 'ar.json:12 already holds upload.errorTooBig, so the text is translated';
const REFUTED = 'REFUTED 1 — ' + EV;
const REF = 'NOTE 1: refuted — ' + EV;
let k = 0;
const edit = (n, file = repo + '/src/Upload.cs') => { k++; return [call('e' + k, 'Edit', { file_path: file }, n), result('e' + k, 'File updated.', n)]; };
const pass = (n) => { k++; return shell('t' + k, 'dotnet test', 'Passed!  - Failed:     0, Passed:     3', n); };
const send = (to, n) => { k++; return [call('s' + k, 'SendMessage', { to, message: 'check again' }, n), result('s' + k, 'queued', n)]; };
const proseEdit = (n) => edit(n, repo + '/docs/readme.md');
let files = 0;
function write(entries) { const f = path.join(root, 't' + (++files) + '.jsonl'); fs.writeFileSync(f, lines(entries)); return f; }
const scanOf = (entries) => scan.scanTranscript(write(entries));
function fullScan(file) {
  const saved = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = fs.mkdtempSync(path.join(root, 'fresh-'));
  fs.writeFileSync(path.join(process.env.SANAD_STATE_DIR, 'review-notes-since'), SINCE + '\n');
  try { return scan.scanTranscript(file); } finally { process.env.SANAD_STATE_DIR = saved; }
}
const outcomes = (r) => r.reviewNotes.map((n) => n.outcome);
const gap = () => run('rv1', 1, REVIEWER, GAP);

test('1: a refutation closed before a code change is reopened by the change', () => {
  const closed = [...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7)];
  assert.deepEqual(outcomes(scanOf(closed)), ['refuted'], 'control: no change');
  const r = scanOf([...closed, ...edit(9), ...pass(10)]);
  assert.deepEqual(outcomes(r), [null]);
  assert.deepEqual(r.refutedNotes, []);
  assert.match(r.reviewNotes[0].problem, /run the note check again/);
  assert.equal(scan.openNotesAfter(r, REF).length, 1, 'the old line cannot close it again');
  const unsure = scanOf([...closed, ...edit(9), ...pass(10), ...run('nc2', 12, CHECKER, 'UNSURE 1 — Upload.cs was changed, the role line is gone')]);
  assert.deepEqual(outcomes(unsure), [null]);
  assert.deepEqual(outcomes(scanOf([...closed, ...proseEdit(9)])), ['refuted'], 'a prose edit keeps it');
  assert.deepEqual(outcomes(scanOf([...closed, ...edit(9), ...run('nc2', 12, CHECKER, REFUTED), say(REF, 15)])), ['refuted'], 'a new check after the change closes it again');
  const user = scanOf([...gap(), userSays('leave the translation as it is for now', 5), say('NOTE 1: user — "leave the translation as it is"', 6), ...edit(9)]);
  assert.deepEqual(outcomes(user), ['user'], 'a user closure stays');
});

const MOVES = ['git merge origin/staging', 'git pull', 'git stash', 'git stash pop', 'git checkout feature/open-access -- src/Upload.cs', 'git checkout -- src/Upload.cs',
  'git reset --hard HEAD~1', 'git cherry-pick abc1234', 'git restore --source=HEAD~3 src/Upload.cs', 'git switch other-branch', 'git apply open-access.patch', 'patch -p1 < open-access.diff',
  "sed -i 's/Admin/Any/' src/Upload.cs", 'cp /tmp/open.cs src/Upload.cs', 'sed -i s/a/b/ locales/ar.json', 'cp /tmp/x.json data/ar.json'];
test('2: a content change with no known path, or of a file the note or the evidence names, cancels the refutation (guard)', () => {
  for (const command of MOVES) {
    const r = scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...shell('m' + (++k), command, 'done', 7), say(REF, 9)]);
    assert.deepEqual(outcomes(r), [null], command);
    assert.match(r.reviewNotes[0].problem, /run the note check again/, command);
  }
  // the evidence names ar.json (a locale file): an edit of it cancels, whatever the folder
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, repo + '/eduquest-frontend/public/locales/ar/ar.json'), say(REF, 9)])), [null], 'the file of the evidence');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, 'C:\\repos\\example\\SRC\\UPLOAD.CS'), say(REF, 9)])), [null], 'no case, backslashes');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7), ...shell('m' + (++k), 'git pull', 'done', 8)])), [null], 'after the line');
});
test('2: must not change: reads, a formatter run, a prose write and a change of a file nobody cites keep the refutation', () => {
  for (const command of ['git status', 'git log --oneline -3', 'git diff', 'ls src', 'npx prettier --write src/Upload.ts', "sed -i 's/a/b/' notes.md", 'sed -i s/a/b/ config/app.settings', 'cp /tmp/x.txt data/rows.csv']) {
    assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...shell('m' + (++k), command, 'ok', 7), say(REF, 9)])), ['refuted'], command);
  }
  for (const file of ['EduQuest.Api/Resources/Messages.ar.resx', 'src/Other.cs', 'docs/readme.md']) {
    assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, repo + '/' + file), say(REF, 9)])), ['refuted'], file);
  }
});

// 2026-11-18 (scoped staleness): the documented flow (loop-rare-cases.md): the check is launched in the same message as
// the first fixes of plainly right notes; a refuted note is then closed without running the check again.
test('S1: the documented flow: a plainly right note in another file is fixed while the check runs', () => {
  const two = 'RECOMMEND: FAIL\n- Gap — Upload.cs:9 — the error text is not translated\n- Bug — Policy.cs:4 — the policy ignores the school id';
  const flow = [...run('rv1', 1, REVIEWER, two), ...launch('nc1', 4, CHECKER), ...edit(5, repo + '/src/Policy.cs'), ...pass(6), ...arrive('nc1', 8, REFUTED + '\nCONFIRMED 2 — Policy.cs:4 has no school filter')];
  const r = scanOf([...flow, say(REF + '\nNOTE 2: fixed — added the school filter and PolicyTests.FiltersSchool', 11)]);
  assert.deepEqual(outcomes(r), ['refuted', 'fixed']);
  assert.deepEqual(outcomes(scanOf([...flow, ...edit(10, repo + '/src/Policy.cs'), say(REF, 11)])), ['refuted', null], 'a change of the other file after the answer too');
  assert.deepEqual(outcomes(scanOf([...flow, say(REF, 11), ...edit(12, repo + '/src/Policy.cs')])), ['refuted', null], 'and after the line');
});

test('S2: an edit of a file the note names, or the evidence names (a .cs file and a README.md), after the launch cancels it', () => {
  const cited = (file, text) => scanOf([...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — ' + text), ...edit(7, repo + '/' + file), say('NOTE 1: refuted — ' + text, 9)]);
  assert.deepEqual(outcomes(cited('src/Policy.cs', 'Policy.cs:4 filters the school id before the upload')), [null], 'the evidence names a .cs file');
  assert.deepEqual(outcomes(cited('README.md', 'README.md:1 says the upload text is translated by the API')), [null], 'the evidence names README.md');
  assert.deepEqual(outcomes(cited('docs/README.md', 'README.md:1 says the upload text is translated by the API')), [null], 'a bare file name matches the end of the path');
  assert.deepEqual(outcomes(cited('src/Upload.cs', 'Policy.cs:4 filters the school id before the upload')), [null], 'the file the note names');
  assert.deepEqual(outcomes(cited('src/Other.cs', 'Policy.cs:4 filters the school id before the upload')), ['refuted'], 'a file nobody names');
  assert.deepEqual(outcomes(cited('README.md', 'Policy.cs:4 filters the school id before the upload')), ['refuted'], 'a prose file nobody names');
  // a refutation already closed reopens only for such a change
  const closed = [...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7)];
  assert.deepEqual(outcomes(scanOf([...closed, ...edit(9, repo + '/src/Other.cs')])), ['refuted']);
  assert.deepEqual(outcomes(scanOf([...closed, ...edit(9, repo + '/locales/ar.json')])), [null]);
  // a shell write to a named file
  const shellWrite = (command) => scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...shell('m' + (++k), command, 'ok', 7), say(REF, 9)]);
  assert.deepEqual(outcomes(shellWrite("sed -i 's/a/b/' locales/ar.json")), [null]);
  assert.deepEqual(outcomes(shellWrite("sed -i 's/a/b/' locales/en.json")), ['refuted']);
});

test('S3: a change after the launch cancels with no known path (git merge) but a read-only git command does not', () => {
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...shell('m' + (++k), 'git merge origin/staging', 'Merge made', 7), say(REF, 9)])), [null]);
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...shell('m' + (++k), 'git fetch origin', 'ok', 7), say(REF, 9)])), ['refuted']);
});

test('4: a SendMessage to the checker does not move its launch', () => {
  const one = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), ...edit(7), ...send('nc1', 8), ...arrive('nc1', 9, REFUTED), say(REF, 12)]);
  assert.deepEqual(outcomes(one), [null], 'form 1');
  const two = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...edit(6), ...send('nc1', 7), ...arrive('nc1', 8, REFUTED), say(REF, 12)]);
  assert.deepEqual(outcomes(two), [null], 'form 2');
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...send('nc1', 6), ...arrive('nc1', 8, REFUTED), say(REF, 12)])), ['refuted'], 'control: no edit');
  const follow = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, 'UNSURE 1 — Upload.cs:9 not read'), ...send('nc1', 6), ...arrive('nc1', 7, REFUTED), say(REF, 9)]);
  assert.deepEqual(outcomes(follow), ['refuted'], 'the answer to the follow-up is read once more');
});

test('5: a CONFIRMED inside a code block still withdraws or reopens', () => {
  const fenced = 'BRIEF 12345678\n```\nCONFIRMED 1 — Upload.cs:9 has no role check\n```';
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), ...run('nc2', 6, CHECKER, fenced), say(REF, 9)])), [null], 'open note');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 7), ...run('nc2', 9, CHECKER, fenced)])), [null], 'closed note');
  assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, '```\nREFUTED 1 — ' + EV + '\n```'), say(REF, 9)])), [null], 'a fenced REFUTED counts for nothing');
});

test('8: a Gap that asks the user to decide is never refutable', () => {
  const asks = 'RECOMMEND: FAIL\n- Gap — Upload.cs:9 — the limit is 50 here and 100 in the ticket: you decide which one.';
  const r = scanOf([...run('rv1', 1, REVIEWER, asks), ...run('nc1', 4, CHECKER, REFUTED), say(REF, 8)]);
  assert.equal(r.reviewNotes[0].kind, 'Gap');
  assert.deepEqual(outcomes(r), [null]);
  assert.deepEqual(r.reviewRefutable, []);
  assert.match(r.reviewNotes[0].problem, /closed only by the words the user typed/);
});

test('1/2: an incremental scan equals a from-zero scan across a reopen', () => {
  const steps = [gap(), run('nc1', 4, CHECKER, REFUTED), [say(REF, 7)], edit(9), send('nc1', 10), run('nc2', 12, CHECKER, REFUTED), [say(REF, 15)], shell('m1', 'git pull', 'ok', 17)];
  const file = path.join(root, 'grow.jsonl');
  fs.writeFileSync(file, '');
  for (let i = 0; i < steps.length; i++) {
    fs.appendFileSync(file, lines(steps[i]));
    assert.deepEqual(scan.scanTranscript(file), fullScan(file), 'step ' + (i + 1));
  }
  assert.deepEqual(outcomes(scan.scanTranscript(file)), [null]);
});

// 2026-11-18 (repair 1, 2): a cited file written as an absolute Windows path (backslashes or slashes), a leading slash, a diff
// prefix, a dot-dot folder, brackets, a plus or a space is matched against the changed file.
const closedOn = (cite) => [...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — ' + cite + ' filters the school id before the upload'), say('NOTE 1: refuted — ' + cite + ' filters the school id before the upload', 7)];
test('R1: an absolute Windows path in the evidence is cancelled by an edit of that file (guard), before or after the line', () => {
  const ev = ['C:\\repos\\example\\src\\Policy.cs:4', 'C:/repos/example/src/Policy.cs:4'];
  for (const cite of ev) {
    const text = 'REFUTED 1 — ' + cite + ' filters the school id before the upload', line = 'NOTE 1: refuted — ' + cite + ' filters the school id before the upload';
    assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, text), ...edit(7, repo + '/src/Policy.cs'), say(line, 9)])), [null], 'edit then line: ' + cite);
    assert.deepEqual(outcomes(scanOf([...closedOn(cite), ...edit(9, 'C:\\repos\\example\\src\\Policy.cs'), ...pass(10)])), [null], 'closed, then edit + test: ' + cite);
    assert.deepEqual(outcomes(scanOf([...closedOn(cite), ...edit(9, repo + '/src/Other.cs'), ...pass(10)])), ['refuted'], 'must not change: another file: ' + cite);
  }
  // the note text itself names the absolute path of its file
  const abs = 'RECOMMEND: FAIL\n- Gap — C:\\repos\\example\\src\\Upload.cs:9 — the error text is not translated';
  assert.deepEqual(outcomes(scanOf([...run('rv1', 1, REVIEWER, abs), ...run('nc1', 4, CHECKER, REFUTED), ...edit(7, repo + '/src/Upload.cs'), say(REF, 9)])), [null], 'the note names an absolute path');
});
test('R2: other normal citation shapes are matched too: leading slash, diff prefix, dot-dot, brackets, plus, space', () => {
  const shapes = [['/src/Policy.cs:4', '/src/Policy.cs'], ['b/src/Policy.cs:4', '/src/Policy.cs'], ['..\\src\\Policy.cs:4', '/src/Policy.cs'], ['app/[id]/page.tsx:4', '/app/[id]/page.tsx'],
    ['src/routes/+page.svelte:3', '/src/routes/+page.svelte'], ['src/My Policy.cs:4', '/src/My Policy.cs']];
  for (const [cite, file] of shapes) {
    assert.deepEqual(outcomes(scanOf([...closedOn(cite), ...edit(9, repo + file), ...pass(10)])), [null], cite);
    assert.deepEqual(outcomes(scanOf([...closedOn(cite), ...edit(9, repo + '/src/Unrelated.cs'), ...pass(10)])), ['refuted'], 'must not change: ' + cite);
  }
});
// 2026-11-18 (repair 3): a shell write or delete of a cited prose file cancels too, with any of these commands.
test('R3: a shell write or delete of a cited prose file cancels the refutation; a write to another file does not', () => {
  const prose = 'README.md:1 says the upload text is translated by the API';
  const closed = [...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — ' + prose), say('NOTE 1: refuted — ' + prose, 7)];
  const writes = ['echo "more" >> README.md', "printf 'x\\n' > README.md", "cat > README.md <<'EOF'\nmore text\nEOF", 'echo x | tee README.md', 'Add-Content README.md "more"', '"x" | Out-File README.md -Encoding utf8',
    'rm README.md', 'git rm README.md', 'del README.md', 'Remove-Item README.md'];
  for (const command of writes) {
    assert.deepEqual(outcomes(scanOf([...closed, ...shell('m' + (++k), command, 'ok', 9)])), [null], command);
    assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — ' + prose), ...shell('m' + (++k), command, 'ok', 7), say('NOTE 1: refuted — ' + prose, 9)])), [null], 'before the line: ' + command);
  }
  for (const command of ['echo "more" >> NOTES.md', 'rm other.md', 'cat README.md', 'cat README.md | grep upload > /dev/null', 'git rm --cached other.md', 'echo x | tee other.md']) {
    assert.deepEqual(outcomes(scanOf([...closed, ...shell('m' + (++k), command, 'ok', 9)])), ['refuted'], 'must not change: ' + command);
  }
});
// 2026-11-18 (repair 5): a checker reading is keyed by its text, not by the SendMessage number.
test('R5: a follow-up CONFIRMED reopens a refuted note whether the follow-up goes to an id, to a name, or is not seen', () => {
  const NAMED = { ...CHECKER, name: 'note-check' };
  const named = scanOf([...gap(), ...launch('nc1', 4, NAMED), ...arrive('nc1', 5, REFUTED), say(REF, 6), ...send('note-check', 7), ...arrive('nc1', 8, CONFIRMED)]);
  assert.deepEqual(outcomes(named), [null], 'a) a follow-up sent by name');
  const copy = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), say(REF, 6), ...send('nc1', 7), notice('nc1', 8, REFUTED), ...arrive('nc1', 9, CONFIRMED)]);
  assert.deepEqual(outcomes(copy), [null], 'b) a finish-notice copy of the first answer arrives before the follow-up answer');
  const unseen = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), say(REF, 6), ...arrive('nc1', 8, CONFIRMED)]);
  assert.deepEqual(outcomes(unseen), [null], 'c) a second, different answer with no SendMessage');
  // must not change: the same text again is a copy, also after a follow-up
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), say(REF, 6), ...arrive('nc1', 7, REFUTED)])), ['refuted'], 'the same answer twice');
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), say(REF, 6), ...send('nc1', 7), notice('nc1', 8, REFUTED)])), ['refuted'], 'only a copy after the follow-up');
  const inc = path.join(root, 'grow5.jsonl');
  fs.writeFileSync(inc, '');
  for (const step of [gap(), launch('nc1', 4, NAMED), arrive('nc1', 5, REFUTED), [say(REF, 6)], send('note-check', 7), arrive('nc1', 8, CONFIRMED)]) { fs.appendFileSync(inc, lines(step)); assert.deepEqual(scan.scanTranscript(inc), fullScan(inc)); }
});
// 2026-11-18 (repair 6): honest commands that change no file keep a refutation.
test('R6: a curl PATCH call, a grep for patch, a soft reset, a new branch and an index-only git command cancel nothing', () => {
  for (const command of ['curl -s -X PATCH http://localhost:5050/api/assignments/5 -d "{}"', 'grep -rn patch src', 'git reset --soft HEAD~2 && git commit -m "fix(upload): one commit"', 'git checkout -b fix/policy', 'git switch -c fix/policy',
    'git restore --staged src/Policy.cs', 'git reset HEAD src/Policy.cs', 'git apply --check x.patch', 'git apply --stat x.patch']) {
    assert.deepEqual(outcomes(scanOf([...closedOn('Policy.cs:4'), ...shell('m' + (++k), command, 'ok', 9)])), ['refuted'], 'after the line: ' + command);
    assert.deepEqual(outcomes(scanOf([...gap(), ...run('nc1', 4, CHECKER, 'REFUTED 1 — Policy.cs:4 filters the school id before the upload'), ...shell('m' + (++k), command, 'ok', 7), say('NOTE 1: refuted — Policy.cs:4 filters the school id before the upload', 9)])), ['refuted'], 'before the line: ' + command);
  }
  // must not change: a real patch, a real git apply, a hard reset, a checkout of a file, a restore of the work tree and a branch with a start point still cancel
  for (const command of ['patch -p1 < open-access.diff', 'git apply open-access.patch', 'git reset --hard HEAD~1', 'git checkout -- src/Policy.cs', 'git restore src/Policy.cs', 'git restore --staged --worktree src/Policy.cs', 'git checkout -b fix/x origin/staging', 'git switch other-branch']) {
    assert.deepEqual(outcomes(scanOf([...closedOn('Policy.cs:4'), ...shell('m' + (++k), command, 'ok', 9)])), [null], command);
  }
});

// 2026-11-18 (scoped staleness, other engine): answers are ordered by (launch, then the order the answers completed): a later
// answer of the SAME checker (a follow-up to it) beats its earlier one; a newer checker still beats an older one.
const CONFIRMED = 'CONFIRMED 1 — Upload.cs:9 the text is still English';
test('4a: REFUTED, a follow-up to the same checker, then its CONFIRMED: the note reopens', () => {
  const first = [...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED)];
  const closed = scanOf([...first, say(REF, 6)]);
  assert.deepEqual(outcomes(closed), ['refuted'], 'control');
  const closedThenConfirmed = scanOf([...first, say(REF, 6), ...send('nc1', 7), ...arrive('nc1', 8, CONFIRMED)]);
  assert.deepEqual(outcomes(closedThenConfirmed), [null], 'closed, then the follow-up says CONFIRMED');
  assert.deepEqual(closedThenConfirmed.refutedNotes, []);
  assert.equal(scan.openNotesAfter(closedThenConfirmed, REF).length, 1, 'the old line cannot close it again');
  const openThenConfirmed = scanOf([...first, ...send('nc1', 7), ...arrive('nc1', 8, CONFIRMED), say(REF, 10)]);
  assert.deepEqual(outcomes(openThenConfirmed), [null], 'open, then the follow-up says CONFIRMED');
  assert.deepEqual(openThenConfirmed.reviewRefutable, []);
});
test('4a: must not change: a follow-up that refutes again, or a newer checker, keeps its place', () => {
  const first = [...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED)];
  assert.deepEqual(outcomes(scanOf([...first, ...send('nc1', 7), ...arrive('nc1', 8, REFUTED), say(REF, 10)])), ['refuted'], 'a follow-up that refutes again');
  assert.deepEqual(outcomes(scanOf([...first, say(REF, 6), ...send('nc1', 7), ...arrive('nc1', 8, REFUTED)])), ['refuted'], 'closed, and the follow-up refutes again');
  // CONFIRMED first, then a follow-up REFUTED: the later answer wins
  const flip = scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, CONFIRMED), ...send('nc1', 6), ...arrive('nc1', 7, REFUTED), say(REF, 9)]);
  assert.deepEqual(outcomes(flip), ['refuted'], 'the later answer of the same checker wins both ways');
  // a newer checker beats an older one whenever its answer arrives
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...launch('nc2', 5, CHECKER), ...arrive('nc2', 6, REFUTED), ...arrive('nc1', 7, CONFIRMED), say(REF, 9)])), ['refuted'], 'newer checker, older answer later');
  assert.deepEqual(outcomes(scanOf([...gap(), ...launch('nc1', 4, CHECKER), ...arrive('nc1', 5, REFUTED), ...launch('nc2', 6, CHECKER), ...arrive('nc2', 7, CONFIRMED), say(REF, 9)])), [null], 'newer checker CONFIRMED');
});
test('4a: an incremental scan equals a from-zero scan across a follow-up reopen', () => {
  const steps = [gap(), launch('nc1', 4, CHECKER), arrive('nc1', 5, REFUTED), [say(REF, 6)], send('nc1', 7), arrive('nc1', 8, CONFIRMED), [say(REF, 10)]];
  const file = path.join(root, 'grow4.jsonl');
  fs.writeFileSync(file, '');
  for (let i = 0; i < steps.length; i++) {
    fs.appendFileSync(file, lines(steps[i]));
    assert.deepEqual(scan.scanTranscript(file), fullScan(file), 'step ' + (i + 1));
  }
  assert.deepEqual(outcomes(scan.scanTranscript(file)), [null]);
});
