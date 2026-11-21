// change-set.mjs — the one list of what a task changed, for every tool that asks.
//
// 2026-11-19: four tools each built this list themselves (pre-review.mjs changedFiles and allChangedPaths,
// size-check.mjs readDiff, review-brief.mjs main), each a little differently: one left deleted files out, one
// read git's quoted names (an Arabic file name came back as "\330\271…" and was dropped as "not there"), and
// none looked at how many untracked files it was about to read. That day another session's folder sat
// untracked in the repository: 1,498 "changed" files, and one check before review took 852 s reading each of
// them line by line. Two callers that ask about the same repository state now get the same answer from here.
//
//   changeSet(repo, base)          today's list: every tracked path that differs from the merge base with
//                                  <base> (committed, staged or only edited; deleted ones too), then every
//                                  untracked file git does not ignore.
//   changeSet(repo, base, { at })  a pinned commit: only the paths that differ between the merge base and
//                                  <at>. Work that is not in that commit is never dropped in silence: untracked
//                                  files come back in `untracked`, edited or staged tracked files in
//                                  `uncommitted`, and the caller names them.
//
// The answer is { mergeBase, at, files, deleted, untracked, uncommitted, foreign }:
//   mergeBase    the commit the change is compared with
//   at           the pinned commit's full id, '' with no pin
//   files        the list above, paths from the repository's top, `/` between folders, as git names them
//   deleted      the paths of `files` that are gone (a deleted path that is on disk again, untracked, is not here)
//   untracked    every untracked file git does not ignore; a folder that is its own repository is one name
//                with a `/` at its end, as git prints it
//   uncommitted  tracked paths whose content in the work folder is not the pinned commit's (HEAD's with no pin)
//   foreign      folders that are most likely not this task's: [{ dir, count, repo, exclude }]. Empty: go on.
//
// FOREIGN? guard. `foreign` is filled when more than 200 untracked files are not ignored, or when an untracked
// folder is its own repository (another session's work tree, a clone). It is decided from git's two listings
// alone: this file reads no file and no folder itself, so a caller can stop before it reads one. With more than
// 200 files the largest folders are named, until 200 or fewer are left (at most three; past that, `./` once with
// the whole count). foreignLine() is the one text every tool prints for it.
//
// A renamed file is in `files` under its new name only, as `git diff` shows it today. A git failure is an Error
// with git's own first line, never an empty list.
//
// This file imports no other gate script: red-proof.mjs copies itself to the test machine by following
// './x.mjs' imports (proofScripts), so a tool there gets this file and nothing else with it.
import { execFileSync } from 'node:child_process';

// More untracked files than this is not a task's own new work until the author says so (commit or exclude).
export const FOREIGN_LIMIT = 200;
const MAX_NAMED = 3;

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  } catch (error) {
    const said = String(error.stderr || '').trim().split(/\r?\n/)[0] || error.code || '';
    throw new Error(`git ${args[0]} failed in ${repo}${said ? ': ' + said : ''}`);
  }
}

// Names come NUL-separated (-z): a space, a quote, a line break or Arabic letters in a name stay as they are.
const names = (text) => text.split('\0').filter(Boolean);

// `git diff --name-status -z`: a status, then one path; a rename or copy has two (old, then new).
function trackedChanges(repo, range) {
  const tokens = names(git(repo, ['diff', '--name-status', '-z', '--find-renames', ...range, '--']));
  const files = [], deleted = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (/^[RC]/.test(status)) { i += 2; if (tokens[i] !== undefined) files.push(tokens[i]); continue; }
    const name = tokens[++i];
    if (name === undefined) break;
    files.push(name);
    if (status[0] === 'D') deleted.push(name);
  }
  return { files, deleted };
}

const others = (repo, extra = []) => names(git(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name', ...extra, '--', ':/']));

// The folders to name for the FOREIGN? guard, from the untracked listing alone.
function foreignOf(repo, untracked) {
  const repos = untracked.filter(n => n.endsWith('/'));
  const loose = untracked.filter(n => !n.endsWith('/'));
  const found = repos.map(dir => ({ dir, count: null, repo: true }));
  if (loose.length > FOREIGN_LIMIT) {
    // A folder with no tracked file in it is one name in git's --directory listing: that is the folder to name.
    // A new file in a tracked folder is counted under its own folder.
    let whole = new Set();
    try { whole = new Set(others(repo, ['--directory']).filter(n => n.endsWith('/') && !repos.includes(n))); } catch { /* every file under its own folder */ }
    const counts = new Map();
    for (const name of loose) {
      const parts = name.split('/');
      let key = '';
      for (let i = 0, dir = ''; i < parts.length - 1 && !key; i++) { dir += parts[i] + '/'; if (whole.has(dir)) key = dir; }
      if (!key) key = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : './';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const groups = [...counts].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count || (a.dir < b.dir ? -1 : 1));
    const named = [];
    let left = loose.length;
    for (const g of groups) {
      if (left <= FOREIGN_LIMIT || named.length === MAX_NAMED) break;
      named.push(g); left -= g.count;
    }
    for (const g of left > FOREIGN_LIMIT ? [{ dir: './', count: loose.length }] : named) found.push({ ...g, repo: false });
  }
  if (found.length) {
    // The exclude file by its full path: in a linked work tree it is not under this folder's .git, and the
    // same path is printed from any folder of the repository.
    let exclude = '';
    try { exclude = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim().split(/\r?\n/).pop().replace(/\\/g, '/'); } catch { /* the usual name */ }
    for (const f of found) f.exclude = /info\/exclude$/.test(exclude) ? exclude : '.git/info/exclude';
  }
  return found;
}

export function changeSet(repo, base, { at = '' } = {}) {
  for (const [name, value] of [['the base', base], ['--at', at]]) {
    if (typeof value !== 'string' || value.startsWith('-') || (name === 'the base' && !value)) throw new Error(`${name} must be a git ref, not ${JSON.stringify(value)}`);
  }
  let pin = '';
  if (at) {
    try { pin = git(repo, ['rev-parse', '--verify', '--quiet', at + '^{commit}']).trim(); } catch { /* no such commit */ }
    if (!pin) throw new Error(`--at ${at} is not a commit in ${repo}`);
  }
  let mergeBase = '';
  try { mergeBase = git(repo, ['merge-base', base, pin || 'HEAD']).trim(); } catch { /* no common commit, or no repository */ }
  if (!mergeBase) throw new Error(`no merge base with ${base}`);
  const tracked = trackedChanges(repo, pin ? [mergeBase, pin] : [mergeBase]);
  const untracked = others(repo);
  const uncommitted = names(git(repo, ['diff', '--name-only', '-z', '--find-renames', pin || 'HEAD', '--']));
  if (pin) return { mergeBase, at: pin, files: tracked.files, deleted: tracked.deleted, untracked, uncommitted, foreign: foreignOf(repo, untracked) };
  const known = new Set(tracked.files), back = new Set(untracked);
  return {
    mergeBase, at: '',
    files: [...tracked.files, ...untracked.filter(n => !known.has(n))],
    deleted: tracked.deleted.filter(n => !back.has(n)),
    untracked, uncommitted, foreign: foreignOf(repo, untracked),
  };
}

// The one FOREIGN? text. Takes one item of `foreign`, the whole list, or a change set; '' when nothing is foreign.
export function foreignLine(foreign) {
  const list = Array.isArray(foreign) ? foreign : foreign && Array.isArray(foreign.foreign) ? foreign.foreign : foreign ? [foreign] : [];
  return list.map((f) => {
    const exclude = f.exclude || '.git/info/exclude';
    return f.repo
      ? `FOREIGN? ${f.dir} is its own repository: add it to ${exclude} if it is another session's, else move it out or add it as a submodule`
      : `FOREIGN? ${f.dir} holds ${f.count} untracked files: add it to ${exclude} if it is another session's, else commit it`;
  }).join('\n');
}
