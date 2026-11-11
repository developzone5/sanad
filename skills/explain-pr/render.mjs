#!/usr/bin/env node
// render.mjs — turn a PR story (JSON) into the lessons page and open it in the browser.
// Usage: node render.mjs <story.json> [--out <dir>] [--no-open]
// The page is one self-contained local file (three.js is inlined for the journey): no network, no upload.
// It is bilingual: Arabic by default (`defaultLang`), English one click away, so every sentence in the story
// comes as { "ar": …, "en": … }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = ['feature', 'fix', 'cleanup'];
const RESULTS = ['pass', 'fail', 'not run'];
// middleware and filter (2026-11-11): the checks a request passes before the controller, in order.
const LAYERS = ['frontend', 'middleware', 'filter', 'api', 'service', 'database', 'test', 'other'];
const TONES = ['good', 'bad', 'warn', 'neutral'];
const MARKER = '"__STORY_JSON__"';
const THREE_MARKER = '/*__THREE_JS__*/';
// Limits keep every lesson easy to read: short sentences, small code, a few cases.
export const LIMITS = {
  title: 9, summary: 24, chapters: 12, name: 5, short: 6, sentence: 26, mockRows: 5, mockText: 7, badge: 3, mockTitle: 6,
  stations: 5, station: 3, item: 4, snippets: 3, snippetTitle: 16, codeLines: 16, note: 16, inputs: 4, cases: 6, cell: 5,
  test: 12, gwt: 14, proof: 10, notes: 3, line: 12, takeaway: 14, why: 8, question: 22, options: 4, option: 8, explain: 22, labInputs: 4,
  walkSteps: 9, walkLines: 12, does: 18, passes: 10, checks: 20, checkDoes: 12, checkSkip: 8,
};

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'empty', 'set'];
const INPUT_TYPES = ['choice', 'time', 'number'];

// The lab's rule engine, the same as the page's: first matching rule wins, else `default`.
const minutes = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); return m ? +m[1] * 60 + +m[2] : NaN; };
function labTest(cond, vals, byId) {
  const inp = byId[cond.a] || {}, a = vals[cond.a], blank = (x) => x === '' || x == null;
  if (cond.op === 'empty') return blank(a);
  if (cond.op === 'set') return !blank(a);
  const b = typeof cond.b === 'string' && byId[cond.b] ? vals[cond.b] : cond.b;
  if (blank(a) || blank(b)) return false;
  if (inp.type === 'choice') return cond.op === 'eq' ? String(a) === String(b) : cond.op === 'ne' ? String(a) !== String(b) : false;
  const x = inp.type === 'time' ? minutes(a) : parseFloat(a), y = inp.type === 'time' ? minutes(b) : parseFloat(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return { eq: x === y, ne: x !== y, lt: x < y, le: x <= y, gt: x > y, ge: x >= y }[cond.op] === true;
}
export function labRun(side, vals, byId) {
  for (const r of side?.rules ?? []) if ((r.when ?? []).every((c) => labTest(c, vals, byId))) return r.then;
  return side?.default;
}
function labShow(out, vals, byId, lang) {
  if (out && typeof out === 'object' && out.input) {
    const v = vals[out.input], opt = (byId[out.input]?.options ?? []).find((o) => String(o.value) === String(v));
    const label = opt ? opt.label : v;
    return label && typeof label === 'object' ? label[lang] : String(label ?? '');
  }
  return out && typeof out === 'object' ? out[lang] : String(out ?? '');
}

export function validate(story) {
  const problems = [];
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  const bilingual = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // A sentence: { ar, en }, both written, each within the word limit.
  const text = (where, v, max, required = true) => {
    if (v == null && !required) return;
    if (!bilingual(v)) { problems.push(`${where}: needs both languages, as { "ar": "…", "en": "…" }`); return; }
    for (const l of ['ar', 'en']) {
      if (!str(v[l])) problems.push(`${where}.${l}: required text`);
      else if (words(v[l]) > max) problems.push(`${where}.${l}: ${words(v[l])} words, at most ${max}`);
    }
  };
  // A short value: one string for both languages (a number, a time, code), or { ar, en } when it is words.
  const value = (where, v, max, required = true) => {
    if (v == null && !required) return;
    const parts = bilingual(v) ? [['.ar', v.ar], ['.en', v.en]] : [['', v]];
    for (const [suffix, s] of parts) {
      if (!str(s)) problems.push(`${where}${suffix}: required text`);
      else if (words(s) > max) problems.push(`${where}${suffix}: ${words(s)} words, at most ${max}`);
    }
  };
  const list = (where, v, min, max) => {
    if (!Array.isArray(v)) { problems.push(`${where}: must be a list`); return false; }
    if (v.length < min || v.length > max) { problems.push(`${where}: ${v.length} items, ${min}–${max} allowed`); return v.length > 0; }
    return true;
  };
  const tone = (where, t) => { if (t != null && !TONES.includes(t)) problems.push(`${where}: one of ${TONES.join(', ')}`); };
  const result = (where, r) => { if (!RESULTS.includes(r)) problems.push(`${where}: one of ${RESULTS.join(', ')}`); };

  if (!story || typeof story !== 'object' || Array.isArray(story)) return ['the story must be a JSON object'];
  text('title', story.title, LIMITS.title);
  text('summary', story.summary, LIMITS.summary, false);
  if (story.defaultLang != null && !['ar', 'en'].includes(story.defaultLang)) problems.push('defaultLang: ar or en (ar when left out)');
  const files = Array.isArray(story.files) ? story.files : null;
  if (!files || files.length === 0 || !files.every(str)) problems.push('files: the full list of changed files is required');
  if (!Array.isArray(story.chapters) || story.chapters.length === 0) { problems.push('chapters: at least one feature or fix is required'); return problems; }
  if (story.chapters.length > LIMITS.chapters) problems.push(`chapters: ${story.chapters.length}, at most ${LIMITS.chapters}`);

  const covered = new Set();
  story.chapters.forEach((c, i) => {
    const at = `chapters[${i}]`;
    if (!c || typeof c !== 'object') { problems.push(`${at}: must be an object`); return; }
    if (!KINDS.includes(c.kind)) problems.push(`${at}.kind: one of ${KINDS.join(', ')}`);
    text(`${at}.name`, c.name, LIMITS.name);
    // The lesson in a teacher's order: what went wrong, why, what the fix does.
    for (const k of ['problem', 'cause', 'idea']) text(`${at}.${k}`, c[k], LIMITS.sentence);
    text(`${at}.takeaway`, c.takeaway, LIMITS.takeaway, false);
    if (!c.short || typeof c.short !== 'object') problems.push(`${at}.short: { before, after } — a few words each, for the overview`);
    else { text(`${at}.short.before`, c.short.before, LIMITS.short); text(`${at}.short.after`, c.short.after, LIMITS.short); }
    if (!Array.isArray(c.files) || c.files.length === 0) problems.push(`${at}.files: the files this change touches`);
    else c.files.forEach((f) => {
      covered.add(f);
      if (files && !files.includes(f)) problems.push(`${at}.files: "${f}" is not in the top-level files list`);
    });

    if (c.mock != null) {
      const m = c.mock;
      for (const side of ['before', 'after']) {
        const screen = m[side] || {};
        value(`${at}.mock.${side}.title`, screen.title, LIMITS.mockTitle);
        if (!list(`${at}.mock.${side}.rows`, screen.rows, 1, LIMITS.mockRows)) continue;
        screen.rows.forEach((r, k) => {
          const rat = `${at}.mock.${side}.rows[${k}]`;
          value(`${rat}.text`, r && r.text, LIMITS.mockText);
          value(`${rat}.badge`, r && r.badge, LIMITS.badge, false);
          tone(`${rat}.tone`, r && r.tone);
        });
      }
    }

    if (c.journey != null) {
      const j = c.journey, jat = `${at}.journey`;
      if (list(`${jat}.stations`, j.stations, 2, LIMITS.stations)) {
        j.stations.forEach((s, k) => {
          if (!s || !LAYERS.includes(s.layer)) problems.push(`${jat}.stations[${k}].layer: one of ${LAYERS.join(', ')}`);
          value(`${jat}.stations[${k}].label`, s && s.label, LIMITS.station);
        });
        if (!Number.isInteger(j.changeAt) || j.changeAt < 0 || j.changeAt >= j.stations.length) problems.push(`${jat}.changeAt: the index of the station where the change acts (0–${j.stations.length - 1})`);
      }
      value(`${jat}.item`, j.item, LIMITS.item);
      for (const side of ['before', 'after']) {
        if (!j[side] || typeof j[side] !== 'object') { problems.push(`${jat}.${side}: { badge, tone }`); continue; }
        value(`${jat}.${side}.badge`, j[side].badge, LIMITS.badge);
        tone(`${jat}.${side}.tone`, j[side].tone);
        // The check the changed station makes, shown in a bubble when the card arrives there.
        text(`${jat}.${side}.why`, j[side].why, LIMITS.why, false);
      }
    }

    if (c.lab != null) {
      const lab = c.lab, lat = `${at}.lab`, byId = {};
      const okValue = (inp, v) => {
        if (v === '' || v == null) return inp.type === 'number' || (inp.type === 'time' && inp.allowEmpty === true);
        if (inp.type === 'choice') return (inp.options ?? []).some((o) => String(o.value) === String(v));
        if (inp.type === 'time') return !Number.isNaN(minutes(v));
        return !Number.isNaN(parseFloat(v));
      };
      if (list(`${lat}.inputs`, lab.inputs, 1, LIMITS.labInputs)) {
        lab.inputs.forEach((inp, k) => {
          const iat = `${lat}.inputs[${k}]`;
          if (!inp || !/^[A-Za-z][\w]*$/.test(inp.id ?? '')) { problems.push(`${iat}.id: a short name of letters and digits`); return; }
          if (byId[inp.id]) problems.push(`${iat}.id: "${inp.id}" is used twice`);
          byId[inp.id] = inp;
          value(`${iat}.label`, inp.label, LIMITS.station);
          if (!INPUT_TYPES.includes(inp.type)) { problems.push(`${iat}.type: one of ${INPUT_TYPES.join(', ')}`); return; }
          if (inp.type === 'choice' && list(`${iat}.options`, inp.options, 2, 8)) {
            inp.options.forEach((o, m) => {
              if (!o || o.value == null || String(o.value) === '') problems.push(`${iat}.options[${m}].value: required`);
              value(`${iat}.options[${m}].label`, o && o.label, LIMITS.station);
            });
          }
          if (inp.value != null && !okValue(inp, inp.value)) problems.push(`${iat}.value: "${inp.value}" is not a valid ${inp.type}`);
        });
      }
      const output = (where, out) => {
        if (out && typeof out === 'object' && 'input' in out) { if (!byId[out.input]) problems.push(`${where}.input: "${out.input}" is not an input id`); }
        else value(where, out, LIMITS.cell);
      };
      for (const side of ['old', 'new']) {
        const sd = lab[side], sat = `${lat}.${side}`;
        if (!sd || typeof sd !== 'object') { problems.push(`${sat}: { rules, default }`); continue; }
        output(`${sat}.default`, sd.default);
        if (sd.rules == null) continue;
        if (!list(`${sat}.rules`, sd.rules, 0, 8)) continue;
        sd.rules.forEach((r, k) => {
          const rat = `${sat}.rules[${k}]`;
          if (!r || !list(`${rat}.when`, r.when, 1, 4)) return;
          r.when.forEach((cd, m) => {
            const cat = `${rat}.when[${m}]`;
            if (!cd || !byId[cd.a]) { problems.push(`${cat}.a: an input id`); return; }
            if (!OPS.includes(cd.op)) { problems.push(`${cat}.op: one of ${OPS.join(', ')}`); return; }
            if (cd.op !== 'empty' && cd.op !== 'set') {
              if (cd.b == null || cd.b === '') problems.push(`${cat}.b: another input's id or a value`);
              else if (!(typeof cd.b === 'string' && byId[cd.b]) && !okValue(byId[cd.a], cd.b)) problems.push(`${cat}.b: "${cd.b}" is not a valid ${byId[cd.a].type}`);
              if (byId[cd.a].type === 'choice' && !['eq', 'ne'].includes(cd.op)) problems.push(`${cat}.op: a choice compares with eq or ne`);
            }
          });
          output(`${rat}.then`, r.then);
        });
      }
      if (list(`${lat}.presets`, lab.presets, 1, LIMITS.cases)) {
        let changes = 0;
        lab.presets.forEach((p, k) => {
          const pat = `${lat}.presets[${k}]`, vals = {};
          if (!p || typeof p.values !== 'object') { problems.push(`${pat}.values: { inputId: value }`); return; }
          for (const inp of Object.values(byId)) {
            const v = p.values[inp.id];
            if (v === undefined) problems.push(`${pat}.values.${inp.id}: missing`);
            else if (!okValue(inp, v)) problems.push(`${pat}.values.${inp.id}: "${v}" is not a valid ${inp.type}`);
            vals[inp.id] = v == null ? '' : String(v);
          }
          if (p.label != null) value(`${pat}.label`, p.label, LIMITS.cell);
          const a = labShow(labRun(lab.old, vals, byId), vals, byId, 'en'), b = labShow(labRun(lab.new, vals, byId), vals, byId, 'en');
          if (!a || !b) problems.push(`${pat}: the old or new rules give no result for these values`);
          if (a !== b) changes++;
        });
        // A lab where nothing changes teaches nothing.
        if (changes === 0) problems.push(`${lat}.presets: at least one preset must give a different old and new result`);
      }
    }

    if (c.quiz != null) {
      const q = c.quiz, qat = `${at}.quiz`;
      text(`${qat}.q`, q.q, LIMITS.question);
      text(`${qat}.explain`, q.explain, LIMITS.explain);
      if (list(`${qat}.options`, q.options, 2, LIMITS.options)) {
        q.options.forEach((o, k) => {
          value(`${qat}.options[${k}].text`, o && o.text, LIMITS.option);
          if (!o || typeof o.correct !== 'boolean') problems.push(`${qat}.options[${k}].correct: true or false`);
        });
        if (q.options.filter((o) => o && o.correct === true).length !== 1) problems.push(`${qat}.options: exactly one option must be correct`);
      }
    }

    // A piece of code: its file, its first line number, and lines with at least one plain note.
    const snippetOk = (sat, s, maxLines) => {
      if (!s || typeof s !== 'object') { problems.push(`${sat}: must be an object`); return; }
      if (!str(s.file)) problems.push(`${sat}.file: required`);
      if (!(Number.isInteger(s.line) && s.line > 0)) problems.push(`${sat}.line: the first line number is required`);
      if (!list(`${sat}.lines`, s.lines, 1, maxLines)) return;
      let notes = 0;
      s.lines.forEach((ln, m) => {
        const lat = `${sat}.lines[${m}]`;
        if (typeof ln === 'string') return;
        if (!ln || typeof ln.c !== 'string') { problems.push(`${lat}: a code string, or { "c": "<code>", "note": { ar, en } }`); return; }
        if (ln.note != null) { notes++; text(`${lat}.note`, ln.note, LIMITS.note); }
      });
      if (notes === 0) problems.push(`${sat}.lines: explain at least one line with a note`);
    };

    // The code walk: the request's path through the code, one step per layer, in the order it runs.
    if (c.walk != null && list(`${at}.walk`, c.walk, 2, LIMITS.walkSteps)) {
      c.walk.forEach((w, k) => {
        const wat = `${at}.walk[${k}]`;
        if (!w || typeof w !== 'object') { problems.push(`${wat}: must be an object`); return; }
        if (!LAYERS.includes(w.layer)) problems.push(`${wat}.layer: one of ${LAYERS.join(', ')}`);
        value(`${wat}.label`, w.label, LIMITS.station);
        text(`${wat}.does`, w.does, LIMITS.does);
        // What this step hands to the next one: words ({ ar, en }) or code that reads the same in both.
        value(`${wat}.passes`, w.passes, LIMITS.passes, false);
        if (w.changed != null && typeof w.changed !== 'boolean') problems.push(`${wat}.changed: true or false`);
        // Middleware and filters (user 2026-11-11: "if there is steps before controller for example middleware its
        // ok to tell me every step to understand the whole picture"): every check the request passes, in the
        // real order, one plain line each with the line that adds it. A check the PR changed is marked; a check
        // that does not act on this request says why in a few words. The code lines are optional here.
        if (w.layer === 'middleware' || w.layer === 'filter' || w.checks != null) {
          if (list(`${wat}.checks`, w.checks, 1, LIMITS.checks)) {
            w.checks.forEach((ck, m) => {
              const cat = `${wat}.checks[${m}]`;
              if (!ck || typeof ck !== 'object') { problems.push(`${cat}: must be an object`); return; }
              if (!str(ck.name)) problems.push(`${cat}.name: required (the middleware or filter as the code names it)`);
              if (!(Number.isInteger(ck.line) && ck.line > 0)) problems.push(`${cat}.line: the line that adds it is required`);
              text(`${cat}.does`, ck.does, LIMITS.checkDoes);
              text(`${cat}.skip`, ck.skip, LIMITS.checkSkip, false);
              if (ck.changed != null && typeof ck.changed !== 'boolean') problems.push(`${cat}.changed: true or false`);
            });
            if (w.checks.some((ck) => ck && ck.changed === true) && w.changed !== true) problems.push(`${wat}.changed: a step with a changed check is changed too`);
          }
          if (!str(w.file)) problems.push(`${wat}.file: required`);
          if (!(Number.isInteger(w.line) && w.line > 0)) problems.push(`${wat}.line: the first line number is required`);
          if (w.lines != null) snippetOk(wat, w, LIMITS.walkLines);
        } else snippetOk(wat, w, LIMITS.walkLines);
      });
      if (!c.walk.some((w) => w && w.changed === true)) problems.push(`${at}.walk: mark the step the PR changes with "changed": true`);
    }

    // With a walk, the code is already shown step by step; other snippets are optional extras.
    if (list(`${at}.code`, c.code ?? (c.walk ? [] : undefined), c.walk ? 0 : 1, LIMITS.snippets)) {
      (c.code ?? []).forEach((s, k) => {
        snippetOk(`${at}.code[${k}]`, s, LIMITS.codeLines);
        if (s && typeof s === 'object') text(`${at}.code[${k}].title`, s.title, LIMITS.snippetTitle, false);
      });
    }

    if (c.cases != null) {
      const cs = c.cases;
      const inputsOk = list(`${at}.cases.inputs`, cs.inputs, 1, LIMITS.inputs);
      if (inputsOk) cs.inputs.forEach((h, k) => value(`${at}.cases.inputs[${k}]`, h, LIMITS.cell));
      if (list(`${at}.cases.rows`, cs.rows, 1, LIMITS.cases)) {
        cs.rows.forEach((r, k) => {
          const rat = `${at}.cases.rows[${k}]`;
          if (!r || !Array.isArray(r.values) || (inputsOk && r.values.length !== cs.inputs.length)) problems.push(`${rat}.values: one value per input`);
          else r.values.forEach((v, m) => value(`${rat}.values[${m}]`, v, LIMITS.cell));
          for (const side of ['old', 'now']) {
            if (!r || !r[side] || typeof r[side].ok !== 'boolean') problems.push(`${rat}.${side}: { text, ok: true|false }`);
            else value(`${rat}.${side}.text`, r[side].text, LIMITS.cell);
          }
        });
      }
    }

    if (c.test != null) {
      const t = c.test;
      if (typeof t !== 'object') problems.push(`${at}.test: must be an object`);
      else {
        text(`${at}.test.name`, t.name, LIMITS.test);
        result(`${at}.test.result`, t.result);
        for (const k of ['given', 'when', 'then']) text(`${at}.test.${k}`, t[k], LIMITS.gwt);
      }
    }
  });
  // The whole PR, not a part of it: every changed file belongs to a feature or fix.
  if (files) files.filter((f) => !covered.has(f)).forEach((f) => problems.push(`files: "${f}" is not explained by any chapter`));

  if (story.proof != null) {
    if (!Array.isArray(story.proof)) problems.push('proof: must be a list');
    else story.proof.forEach((p, i) => {
      if (!p || typeof p !== 'object') { problems.push(`proof[${i}]: must be an object`); return; }
      text(`proof[${i}].name`, p.name, LIMITS.proof);
      result(`proof[${i}].result`, p.result);
    });
  }
  for (const key of ['risks', 'notDone']) {
    if (story[key] == null) continue;
    if (!Array.isArray(story[key])) { problems.push(`${key}: must be a list`); continue; }
    if (story[key].length > LIMITS.notes) problems.push(`${key}: ${story[key].length} items, at most ${LIMITS.notes}`);
    story[key].forEach((t, i) => text(`${key}[${i}]`, t, LIMITS.line));
  }
  return problems;
}

// Line and paragraph separators, built from their codes so no editor or tool turns them into raw characters.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

// JSON inside <script> must not be able to close the tag or start a comment.
export function embed(story) {
  return JSON.stringify(story)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LS).join('\\u' + '2028')
    .split(PS).join('\\u' + '2029');
}

export function build(story, template, three) {
  if (!template.includes(MARKER)) throw new Error('template is missing the story marker');
  if (!template.includes(THREE_MARKER)) throw new Error('template is missing the three.js marker');
  if (/<\/script|<!--/i.test(three)) throw new Error('three.js text cannot be inlined into a script tag');
  return template.replace(THREE_MARKER, () => three).replace(MARKER, () => embed(story));
}

export function readThree() {
  return fs.readFileSync(path.join(here, 'vendor', 'three.min.js'), 'utf8');
}

function slugOf(story) {
  const pr = story.pr || {};
  const label = pr.number ? `pr-${pr.number}` : String(pr.branch || 'pr');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pr'}-${stamp}`;
}

function openInBrowser(file) {
  // Windows: cmd's `start` takes a window title first; the path is quoted (no `"` can appear in a Windows path).
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${file}"`]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', () => console.error('Could not open the browser. Open the file by hand.'));
  child.unref();
}

function main(argv) {
  const args = argv.slice(2);
  const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(os.tmpdir(), 'explain-pr');
  if (!input || (outIdx >= 0 && !outDir)) {
    console.error('Usage: node render.mjs <story.json> [--out <dir>] [--no-open]');
    return 2;
  }
  let story;
  try { story = JSON.parse(fs.readFileSync(input, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')); }
  catch (e) { console.error(`Cannot read the story: ${e.message}`); return 1; }
  const problems = validate(story);
  if (problems.length) { console.error('The story is not valid:\n- ' + problems.join('\n- ')); return 1; }
  story.generatedAt ??= new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const html = build(story, fs.readFileSync(path.join(here, 'template.html'), 'utf8'), readThree());
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.resolve(outDir, slugOf(story) + '.html');
  fs.writeFileSync(file, html, 'utf8');
  console.log(file);
  if (!args.includes('--no-open')) openInBrowser(file);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
