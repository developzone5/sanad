import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, build, readThree, labRun, LIMITS } from '../render.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(dir, '..', 'render.mjs');
const template = fs.readFileSync(path.join(dir, '..', 'template.html'), 'utf8');
const example = JSON.parse(fs.readFileSync(path.join(dir, '..', 'story.example.json'), 'utf8'));
const three = readThree();
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'explain-pr-test-'));
const copy = () => JSON.parse(JSON.stringify(example));
const has = (problems, start) => problems.some((p) => p.startsWith(start));
const long = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');

test('the example story is valid', () => {
  assert.deepEqual(validate(example), []);
});

test('missing or wrong fields are each named', () => {
  assert.deepEqual(validate([]), ['the story must be a JSON object']);
  const s = copy(), c = s.chapters[0];
  s.title = { ar: '', en: 'x' }; s.defaultLang = 'fr'; s.risks = 'one'; s.proof[0].result = 'ok';
  c.kind = 'chore';
  delete c.cause;
  delete c.short;
  c.test.result = 'green';
  c.cases = { inputs: ['a'], rows: [{ values: ['1', '2'], old: { text: 'x', ok: true }, now: { text: 'y', ok: true } }] };
  c.mock.before.rows[0].tone = 'purple';
  c.journey.changeAt = 9;
  c.journey.stations[0].layer = 'cloud';
  const problems = validate(s);
  for (const p of ['title.ar:', 'defaultLang:', 'risks:', 'proof[0].result', 'chapters[0].kind', 'chapters[0].cause', 'chapters[0].short',
    'chapters[0].test.result', 'chapters[0].cases.rows[0].values', 'chapters[0].mock.before.rows[0].tone', 'chapters[0].journey.changeAt',
    'chapters[0].journey.stations[0].layer']) assert.ok(has(problems, p), p);
  assert.ok(has(validate({ title: { ar: 'س', en: 'x' }, files: ['a'], chapters: [] }), 'chapters:'));
});

test('every sentence comes in Arabic and English; short values may be one string', () => {
  const s = copy();
  s.chapters[0].problem = 'English only';
  s.chapters[0].idea = { en: 'English only' };
  const problems = validate(s);
  assert.ok(problems.includes('chapters[0].problem: needs both languages, as { "ar": "…", "en": "…" }'));
  assert.ok(problems.includes('chapters[0].idea.ar: required text'));
  // A number or code reads the same in both languages.
  assert.equal(typeof example.chapters[0].journey.stations[1].label, 'string');
});

test('the lab runs its old and new rules like the page does', () => {
  const lab = example.chapters[0].lab, byId = Object.fromEntries(lab.inputs.map((i) => [i.id, i]));
  const run = (side, failed) => labRun(lab[side], { failed: String(failed) }, byId);
  assert.equal(run('old', 5).en, 'open');
  assert.equal(run('new', 5).en, 'locked');
  assert.equal(run('old', 11).en, 'locked');
  assert.equal(run('new', 4).en, 'open');
  // A time input compares as hours and minutes, and an empty optional time never matches a comparison.
  const t = { closeAt: { id: 'closeAt', type: 'time', allowEmpty: true }, now: { id: 'now', type: 'time' } };
  const side = { rules: [{ when: [{ a: 'closeAt', op: 'le', b: 'now' }], then: 'ended' }], default: 'open' };
  assert.equal(labRun(side, { closeAt: '9:59', now: '10:00' }, t), 'ended');
  assert.equal(labRun(side, { closeAt: '10:01', now: '10:00' }, t), 'open');
  assert.equal(labRun(side, { closeAt: '', now: '10:00' }, t), 'open');
});

test('a lab is checked: real inputs, known operators, valid presets, and at least one change', () => {
  const s = copy(), lab = s.chapters[0].lab;
  lab.old.rules[0].when[0].a = 'ghost';
  lab.new.rules[0].when[0].op = 'like';
  lab.presets.push({ values: {} });
  const problems = validate(s);
  assert.ok(has(problems, 'chapters[0].lab.old.rules[0].when[0].a: an input id'));
  assert.ok(has(problems, 'chapters[0].lab.new.rules[0].when[0].op'));
  assert.ok(has(problems, 'chapters[0].lab.presets[3].values.failed: missing'));
  const t = copy();
  t.chapters[0].lab.new = t.chapters[0].lab.old;
  assert.ok(validate(t).includes('chapters[0].lab.presets: at least one preset must give a different old and new result'));
  const u = copy();
  u.chapters[0].lab.inputs.push({ id: 'pick', label: 'x', type: 'choice', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  u.chapters[0].lab.new.rules.push({ when: [{ a: 'pick', op: 'lt', b: 'a' }], then: 'x' });
  assert.ok(has(validate(u), 'chapters[0].lab.new.rules[1].when[0].op: a choice compares with eq or ne'));
});

test('code lines never show ligatures (the font shorthand must not turn them back on)', () => {
  const rule = /\n\.cl \{[^}]*\}/.exec(template)[0];
  assert.ok(rule.indexOf('font-variant-ligatures: none') > rule.indexOf('font:'), rule);
});

test('a quiz has exactly one right answer; the station check and the takeaway stay short', () => {
  const s = copy(), c = s.chapters[0];
  c.quiz.options.forEach((o) => { o.correct = true; });
  c.journey.after.why = { ar: long(LIMITS.why + 1), en: 'ok' };
  c.takeaway = { ar: 'ok', en: long(LIMITS.takeaway + 1) };
  const problems = validate(s);
  assert.ok(problems.includes('chapters[0].quiz.options: exactly one option must be correct'));
  assert.ok(has(problems, 'chapters[0].journey.after.why.ar'));
  assert.ok(has(problems, 'chapters[0].takeaway.en'));
  const t = copy();
  t.chapters[0].quiz.options = [t.chapters[0].quiz.options[0]];
  assert.ok(has(validate(t), 'chapters[0].quiz.options:'));
  const u = copy();
  delete u.chapters[0].quiz.options[1].correct;
  assert.ok(has(validate(u), 'chapters[0].quiz.options[1].correct'));
});

test('the whole PR must be explained: every file belongs to a chapter', () => {
  const s = copy();
  s.files.push('web/src/forgotten.ts');
  assert.ok(validate(s).includes('files: "web/src/forgotten.ts" is not explained by any chapter'));
  const t = copy();
  t.chapters[0].files.push('not/in/the/pr.ts');
  assert.ok(has(validate(t), 'chapters[0].files: "not/in/the/pr.ts" is not in the top-level files list'));
});

test('code is explained line by line', () => {
  const s = copy();
  s.chapters[0].code[0].lines = s.chapters[0].code[0].lines.map((l) => (typeof l === 'string' ? l : l.c));
  assert.ok(has(validate(s), 'chapters[0].code[0].lines: explain at least one line with a note'));
  const t = copy();
  t.chapters[0].code[0].lines.push({ note: { ar: 'س', en: 'x' } });
  assert.ok(has(validate(t), 'chapters[0].code[0].lines[4]: a code string'));
  const u = copy();
  delete u.chapters[0].code[0].line;
  assert.ok(has(validate(u), 'chapters[0].code[0].line: the first line number'));
  // Without a code walk the lesson needs its key snippet; with one, the walk shows the code.
  const v = copy();
  delete v.chapters[0].walk;
  v.chapters[0].code = [];
  assert.ok(has(validate(v), 'chapters[0].code:'));
  const w = copy();
  delete w.chapters[0].code;
  assert.deepEqual(validate(w), []);
});

test('a code walk follows the request layer by layer, each step explained, one step changed', () => {
  const s = copy(), walk = s.chapters[0].walk;
  assert.deepEqual(walk.map((x) => x.layer), ['frontend', 'api', 'service', 'database', 'test']);
  walk[0].layer = 'browser';
  walk[1].lines = walk[1].lines.map((l) => (typeof l === 'string' ? l : l.c));
  delete walk[2].does;
  walk[3].line = 0;
  walk[4].passes = { ar: long(LIMITS.passes + 1), en: 'ok' };
  walk[4].changed = 'yes';
  const problems = validate(s);
  for (const p of ['chapters[0].walk[0].layer: one of', 'chapters[0].walk[1].lines: explain at least one line', 'chapters[0].walk[2].does:',
    'chapters[0].walk[3].line: the first line number', 'chapters[0].walk[4].passes.ar:', 'chapters[0].walk[4].changed: true or false']) assert.ok(has(problems, p), p);
  const t = copy();
  t.chapters[0].walk.forEach((x) => { delete x.changed; });
  assert.ok(has(validate(t), 'chapters[0].walk: mark the step the PR changes'));
  const u = copy();
  u.chapters[0].walk = u.chapters[0].walk.concat(u.chapters[0].walk);
  assert.ok(has(validate(u), 'chapters[0].walk: 10 items, 2–7 allowed'));
  const v = copy();
  v.chapters[0].walk[2].lines = v.chapters[0].walk[2].lines.concat(Array(LIMITS.walkLines).fill(' x'));
  assert.ok(has(validate(v), 'chapters[0].walk[2].lines:'));
});

test('the page draws the code walk and lets a station open its step', () => {
  for (const needle of ['function walkView(', "'wstep'", 'onStation.can', 'goable(lb, i, onStation)', 'goable(st, i, onStation)', 'walkTitle:']) assert.ok(template.includes(needle), needle);
  // Both languages name every layer the walk can show.
  for (const l of ['frontend', 'api', 'service', 'database', 'test', 'other']) assert.equal(template.split(`L_${l}:`).length, 3, l);
});

test('limits keep every lesson short', () => {
  const s = copy(), c = s.chapters[0];
  s.title = { ar: long(LIMITS.title + 1), en: 'ok' };
  c.name = { ar: 'ok', en: long(LIMITS.name + 1) };
  c.problem = { ar: long(LIMITS.sentence + 1), en: 'ok' };
  c.code[0].lines[0].note = { ar: long(LIMITS.note + 1), en: 'ok' };
  c.code[0].lines = c.code[0].lines.concat(Array(LIMITS.codeLines).fill(' x'));
  c.lab.new.default = { ar: long(LIMITS.cell + 1), en: 'ok' };
  c.journey.stations = c.journey.stations.concat(c.journey.stations);
  s.risks = Array(LIMITS.notes + 1).fill({ ar: 'س', en: 'x' });
  const problems = validate(s);
  for (const p of ['title.ar:', 'chapters[0].name.en', 'chapters[0].problem.ar', 'chapters[0].code[0].lines[0].note.ar', 'chapters[0].code[0].lines:',
    'chapters[0].lab.new.default.ar', 'chapters[0].journey.stations:', 'risks:']) assert.ok(has(problems, p), p);
});

test('story text cannot break out of the script tag', () => {
  const s = copy(), sep = String.fromCharCode(0x2028);
  s.title = { ar: '</script><script>alert(1)</script><!--', en: 'x' };
  s.chapters[0].code[0].lines[0].c = '+</script>&amp;' + sep;
  const html = build(s, template, three);
  const start = html.indexOf('<script id="story"'), json = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
  assert.doesNotMatch(json, new RegExp('[<>&' + sep + ']'));
  const back = JSON.parse(json);
  assert.equal(back.title.ar, s.title.ar);
  assert.equal(back.chapters[0].code[0].lines[0].c, s.chapters[0].code[0].lines[0].c);
});

test('replacement patterns in the story stay literal', () => {
  const s = copy();
  s.source = "costs $& and $' and $1";
  // `&` is escaped for the script tag; `$'` and `$1` would expand if the template used a string replacement.
  assert.ok(build(s, template, three).includes("costs $\\u0026 and $' and $1"));
});

test('three.js is inlined once; nothing loads from the network; text is never written as HTML', () => {
  const html = build(example, template, three);
  assert.ok(!html.includes('/*__THREE_JS__*/'));
  assert.equal(html.split('Copyright 2010-2023 Three.js Authors').length, 2);
  assert.doesNotMatch(template, /<(script|link|img|iframe)[^>]+(src|href)=["']?https?:/i);
  assert.match(template, /default-src 'none'/);
  assert.doesNotMatch(template, /innerHTML/);
  assert.throws(() => build(example, template, 'x</script>y'), /cannot be inlined/);
});

test('cli writes one page and prints its path', () => {
  const out = tmp(), input = path.join(out, 'story.json');
  fs.writeFileSync(input, String.fromCharCode(0xfeff) + JSON.stringify(example));
  const r = run(input, '--out', out, '--no-open');
  assert.equal(r.status, 0, r.stderr);
  const file = r.stdout.trim();
  assert.match(path.basename(file), /^pr-123-\d{8}-\d{6}\.html$/);
  const html = fs.readFileSync(file, 'utf8');
  assert.ok(!html.includes('"__STORY_JSON__"'));
  assert.ok(html.includes('Lock accounts after five wrong passwords'));
});

test('cli rejects a bad story and writes nothing', () => {
  const out = tmp(), input = path.join(out, 'story.json');
  const s = copy();
  s.files.push('missing.ts');
  fs.writeFileSync(input, JSON.stringify(s));
  const r = run(input, '--out', out, '--no-open');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"missing\.ts" is not explained by any chapter/);
  assert.deepEqual(fs.readdirSync(out), ['story.json']);
});

test('cli explains usage and unreadable input', () => {
  assert.equal(run().status, 2);
  const r = run(path.join(tmp(), 'missing.json'), '--no-open');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cannot read the story/);
});
