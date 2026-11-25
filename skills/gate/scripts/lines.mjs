#!/usr/bin/env node
// lines.mjs — the task's lines file (loop.md Step 1.2), written from the ticket text as it is.
//
// 2026-11-13: the lines file was typed by hand at the start of every task (copy each ticket line, number it
// T1..Tn), and a task with no ticket also had to be told to the commit check by hand. This copies the
// ticket text, line by line, without changing a word:
//   - every non-empty line becomes `T<n>. <the line>`; a line that is only a heading mark (`#`, `##`) or a
//     list bullet keeps its words, without the mark
//   - the ticket text itself is copied next to it as ticket.md (review-brief.mjs --ticket reads it)
//   --no-ticket: the user said the task has no ticket. The text is then the user's own words, and the commit
//   check stops asking for a ticket ID on this branch: `git config branch.<branch>.sanadNoTicket true` in
//   --repo (check-commits.mjs reads it). Said once by the user, never asked again.
//
// 2026-11-19: a ticket line the user dropped was taken out by hand, every later line got a new number, and each
// check line and test quote that named a number was typed again.
//   --drop T3 --words "<the user's words>" --out <notes>/lines.md (or --notes <dir>)
//       Rewrites that one line in place as `T3. [dropped by the user: "<words>"] <the line>`. No line gets a new
//       number. Refused: words under 8 characters, a line that is dropped already, the last line that is left.
//   --drop T2 --go "<the owner's go, quoted>" --out <notes>/lines.md
//       2026-11-25 (owner, test 4: a line of background had no check line and failed two checks): a sentence that is only
//       background is shown in the plan as `T2: background, no check`, and the owner's go on that plan is the words that
//       drop it: `[dropped by the user: "background, no check; the owner's go on the plan: <go>"]`. No extra question.
//   --seed-check <notes>/check.md [--out <notes>/lines.md | --notes <dir>]   (or: --seed-check --notes <dir>)
//       Writes a first check file, one `- [T<n>] <the line>` per ticket line that is not dropped. Each one is then
//       rewritten as the result the change must prove. A check file that exists is never overwritten.
//
// Usage: node lines.mjs --from <ticket text file> --out <notes>/lines.md [--no-ticket --repo <path>]
//        node lines.mjs --drop T<n> --words "<the user's words>" --out <notes>/lines.md
//        node lines.mjs --seed-check <notes>/check.md [--out <notes>/lines.md]
// Exit 0: written. 2: usage error (no such file, no line in it, --no-ticket outside a branch, a refused drop).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';
import { readLines, droppedOf } from './check-ticket-lines.mjs';

const MIN_WORDS = 8;

// The ticket's lines, in order: one per sentence, a heading or bullet mark taken off, the words untouched.
// 2026-11-25 (owner, run 3): a ticket sentence wrapped over four lines became T2 to T4, each cut mid-sentence. A line
// break inside a paragraph is no longer a new line: the paragraph is read as sentences. A heading, a bullet or a numbered
// item, a blank line, a table row and a fenced code line still end a line; a sentence ends at . ! ? … or ؟ (closing quotes
// and brackets kept with it) before a space and a capital letter, a digit, an opening quote or a letter with no case
// (Arabic). After a short abbreviation (e.g., i.e., etc., vs., Dr.) or a one-letter initial it does not end.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St|No|[A-Za-z])\.$/i;
export function sentencesOf(paragraph) {
  const text = String(paragraph).replace(/\s+/g, ' ').trim();
  const out = [];
  let from = 0;
  for (const m of text.matchAll(/[.!?…؟]+["'”’»)\]]*(?= (?=[\p{Lu}\p{Lo}\p{N}"'“‘«(\[]))/gu)) {
    const end = m.index + m[0].length;
    // A numbered item's own number (`1. Press Next`) is no sentence.
    if (ABBREVIATION.test(text.slice(from, m.index + 1)) || /^\d+\.$/.test(text.slice(from, m.index + 1).trim())) continue;
    // Inside an open double quote (a quoted message of two sentences) the sentence goes on.
    if ((text.slice(from, end).match(/["“”]/g) || []).length % 2) continue;
    out.push(text.slice(from, end).trim());
    from = end;
  }
  out.push(text.slice(from).trim());
  return out.filter(Boolean);
}
export function ticketLines(text) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push(...sentencesOf(para.join(' '))); para = []; };
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    if (/^#{1,6}\s+/.test(l)) { flush(); out.push(l.replace(/^#{1,6}\s+/, '').trim()); continue; }
    if (/^(?:\||```|~~~)/.test(l)) { flush(); out.push(l); continue; }
    if (/^(?:[-*•]|\d+[.)])\s+/.test(l)) { flush(); para.push(l.replace(/^[-*•]\s+/, '').trim()); }
    // Install suite (2026-11-25): a title with no stop ("Fix the title") joined the next line. A line goes on the one
    // before it only when it starts with a small letter, as a wrapped sentence does; anything else starts a new line.
    else if (para.length && /^\p{Ll}/u.test(l)) para.push(l);
    else { flush(); para.push(l); }
    // Review (2026-11-25): a line that ends with . ! ? … or ؟ (closing quotes and brackets after it) ends its sentence,
    // whatever word stands before it ("Part A.", "etc."): only a line broken mid-sentence joins the next one.
    if (/[.!?…؟]["'”’»)\]]*$/.test(l)) flush();
  }
  flush();
  return out.filter(Boolean);
}

export function renderLines(lines, { noTicket = false, date = new Date() } = {}) {
  const day = date.toISOString().slice(0, 10);
  const head = noTicket ? `# Lines (no ticket: the user's own words, ${day})` : `# Lines (the ticket, verbatim, ${day})`;
  return [head, '', ...lines.map((l, i) => `T${i + 1}. ${l}`), ''].join('\n');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Marks the current branch of `repo` as a task without a ticket; returns the branch name.
export function markNoTicket(repo) {
  let branch = '';
  try { branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']); } catch { /* detached */ }
  if (!branch) throw new Error(`--no-ticket needs a branch checked out in ${repo} (HEAD is detached)`);
  git(repo, ['config', `branch.${branch}.sanadNoTicket`, 'true']);
  return branch;
}

// The lines file with line T<n> marked as dropped by the user, in place: { text, n, words }. Every other byte of
// the file stays, so T4 is still T4. Throws with the reason when the drop is refused.
export function dropLine(text, which, words) {
  const m = /^T(\d+)$/i.exec(String(which || '').trim());
  if (!m) throw new Error('--drop needs one line number, e.g. --drop T3');
  const n = Number(m[1]);
  // The user's words on one line; `"]` would end the mark early, so it gets a space.
  const said = String(words === undefined || words === true ? '' : words).replace(/\s+/g, ' ').replace(/"\]/g, '" ]').trim();
  if (said.length < MIN_WORDS) throw new Error(`--drop needs --words "<the user's words>" (at least ${MIN_WORDS} characters): only the user drops a ticket line`);
  const rows = String(text).split('\n');
  // The file's lines that count, in the order readLines numbers them.
  const at = rows.map((row, i) => ({ row: row.replace(/\r$/, ''), i })).filter(({ row }) => row.trim() && !row.trim().startsWith('#'));
  const all = readLines(text);
  if (at.length !== all.length) throw new Error('the lines file cannot be read line by line: write it again with --from');
  if (n < 1 || n > at.length) throw new Error(`T${n} is not in the lines file (it has T1..T${at.length})`);
  const target = at[n - 1];
  const numbered = new RegExp(`^(\\s*T${n}[.:]\\s+)(.*)$`, 'i').exec(target.row);
  if (!numbered) throw new Error(`line ${n} of the lines file does not start with "T${n}.": the file is not numbered in order, write it again with --from`);
  if (droppedOf(all[n - 1])) throw new Error(`T${n} is dropped already`);
  if (all.filter((l) => !droppedOf(l)).length === 1) throw new Error(`T${n} is the last ticket line left: a task with no line has nothing to prove`);
  rows[target.i] = `${numbered[1]}[dropped by the user: "${said}"] ${numbered[2].trim()}` + (rows[target.i].endsWith('\r') ? '\r' : '');
  return { text: rows.join('\n'), n, words: said };
}

// A first check file: one line per ticket line that is not dropped, each naming its own T number.
export function seedCheck(linesText, { date = new Date() } = {}) {
  const live = readLines(linesText).map((l, i) => ({ n: i + 1, l })).filter(({ l }) => !droppedOf(l));
  const lines = live.map(({ n, l }) => `- [T${n}] ${l.replace(/^T\d+:\s*/i, '')}`);
  return { count: lines.length, numbers: live.map((x) => x.n), text: [`# Check lines (seeded from the ticket lines, ${date.toISOString().slice(0, 10)}): rewrite each as the result the change must prove`, '', ...lines, ''].join('\n') };
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const from = opt('--from'), out = opt('--out'), noTicket = argv.includes('--no-ticket'), repo = opt('--repo');
  const notes = opt('--notes');
  if (argv.includes('--drop') || argv.includes('--seed-check')) {
    if (from) throw new Error('--drop and --seed-check change an existing notes folder: no --from');
    if (argv.includes('--drop') && argv.includes('--seed-check')) throw new Error('give --drop or --seed-check, not both');
    // --seed-check <file>, or --seed-check alone with --notes <dir> (or --out <lines.md>): check.md of that folder.
    const named = argv.includes('--seed-check') && opt('--seed-check') && !opt('--seed-check').startsWith('--') ? opt('--seed-check') : '';
    const file = out || opt('--lines') || (notes ? path.join(notes, 'lines.md') : named ? path.join(path.dirname(path.resolve(named)), 'lines.md') : '');
    if (!file) throw new Error('give the lines file: --out <notes>/lines.md or --notes <dir>');
    if (!fs.existsSync(file)) throw new Error('no such lines file: ' + file);
    const text = fs.readFileSync(file, 'utf8');
    const seed = argv.includes('--seed-check') ? named || path.join(notes || path.dirname(path.resolve(file)), 'check.md') : '';
    if (seed) {
      const made = seedCheck(text);
      if (!made.count) throw new Error(`${file} has no ticket line left to check`);
      // Written only when it does not exist: a check file the author has worked on is never replaced.
      try { fs.writeFileSync(path.resolve(seed), made.text, { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`${seed} exists: it is not overwritten`); throw error; }
      process.stdout.write(`CHECK LINES: ${made.count} seeded (${made.numbers.map((n) => 'T' + n).join(', ')}) — ${path.resolve(seed)}; rewrite each as the result the change must prove\n`);
      return;
    }
    const go = argv.includes('--go') ? String(opt('--go') ?? '').replace(/\s+/g, ' ').trim() : null;
    if (go !== null && argv.includes('--words')) throw new Error('give --words or --go, not both');
    if (go !== null && (!go || go.startsWith('--'))) throw new Error("--go needs the owner's go on the plan, quoted");
    // Review (2026-11-25): `--go "No."` closed a ticket line. The quoted go must say yes: go, yes, ok, okay or approved.
    if (go !== null && !/(?<![\p{L}])(?:go|yes|ok|okay|approved?)(?![\p{L}])/iu.test(go)) throw new Error(`--go "${go}" holds no go (go, yes, ok or approved): only the owner's go on the plan closes a background sentence`);
    const dropped = dropLine(text, opt('--drop'), go !== null ? `background, no check; the owner's go on the plan: ${go}` : opt('--words'));
    fs.writeFileSync(file, dropped.text);
    process.stdout.write(`LINES: T${dropped.n} dropped by the user: "${dropped.words}" — ${path.resolve(file)}; no line has a new number\n`);
    return;
  }
  if (!from || !out) throw new Error('give --from <ticket text file> and --out <notes>/lines.md');
  if (noTicket && !repo) throw new Error('--no-ticket needs --repo <path> (the branch is marked there)');
  if (!fs.existsSync(from)) throw new Error('no such file: ' + from);
  const text = fs.readFileSync(from, 'utf8');
  const lines = ticketLines(text);
  if (!lines.length) throw new Error(`${from} has no line of text`);
  const dir = path.dirname(path.resolve(out));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.resolve(out), renderLines(lines, { noTicket }));
  const ticket = path.join(dir, 'ticket.md');
  if (path.resolve(from) !== path.resolve(ticket)) fs.writeFileSync(ticket, text);
  const branch = noTicket ? markNoTicket(path.resolve(repo)) : '';
  process.stdout.write(`LINES: ${lines.length} line(s) T1..T${lines.length} — ${path.resolve(out)}; ticket text in ${ticket}\n`);
  process.stdout.write(`BACKGROUND: a sentence with nothing to prove goes in the plan as "T<n>: background, no check"; after the owner's go on that plan: node ${path.resolve(process.argv[1] || 'lines.mjs').split(path.sep).join('/')} --drop T<n> --go "<the owner's go, quoted>" --out ${out}\n`);
  // No ticket ID in the text and no --no-ticket: tell the author how to mark a task that has no ticket.
  if (!noTicket && !/\b[A-Z][A-Z0-9]+-\d+\b/.test(text)) {
    const me = path.resolve(process.argv[1] || 'lines.mjs').split(path.sep).join('/');
    process.stdout.write(`NOTE: no ticket ID in the text — if this task has no ticket, run: node ${me} --from ${from} --out ${out} --no-ticket --repo ${repo || '<the repository>'}
`);
  }
  if (branch) process.stdout.write(`NO TICKET: branch ${branch} — the commit check asks for no ticket ID\n`);
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write('LINES: ' + error.message + '\nUsage: node lines.mjs --from <ticket text file> --out <notes>/lines.md [--no-ticket --repo <path>]\n' +
      '       node lines.mjs --drop T<n> --words "<the user\'s words>" --out <notes>/lines.md\n' +
      '       node lines.mjs --drop T<n> --go "<the owner\'s go on the plan, quoted>" --out <notes>/lines.md\n' +
      '       node lines.mjs --seed-check <notes>/check.md [--out <notes>/lines.md]\n');
    process.exitCode = 2;
  }
}
