// ts-parser.mjs — the cheap, run-free syntax check of JavaScript and TypeScript source the proof needs (2026-11-23, owner).
//
// syntaxProblem: does a file parse? A break whose text does not parse is refused before any test runs (run 3 of the
// small task: two breaks with an unbalanced `.catch(` cost two full proof runs). Syntax only: a missing name or a type
// error is NOT caught; the caller says so in its output.
//
// Plain JavaScript (.js, .cjs, .mjs) is checked by Node itself (`node --check`, as the run reads it). TypeScript files
// are parsed by TypeScript, loaded from the repository: the file's own package (node_modules/typescript), else the same
// package folder in another work tree of the repository (a task's own work tree usually has no node_modules). With no
// TypeScript found, Node's own TypeScript stripper parses .ts/.mts/.cts; .tsx and .jsx are left unparsed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

export const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const loaded = new Map();

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// The folder of the nearest package.json at or above `dir`, inside `top`; '' when there is none.
function packageDirOf(top, dir) {
  let at = path.resolve(dir);
  const root = path.resolve(top);
  for (;;) {
    if (fs.existsSync(path.join(at, 'package.json'))) return at;
    if (at === root) return '';
    const up = path.dirname(at);
    if (up === at || !up.toLowerCase().startsWith(root.toLowerCase())) return '';
    at = up;
  }
}

/** TypeScript for a file of the repository `top`, or null. Cached per package folder. */
export function loadTypeScript(top, file) {
  const pkg = packageDirOf(top, path.dirname(path.resolve(top, file)));
  const rel = pkg ? path.relative(path.resolve(top), pkg) : '';
  if (loaded.has(rel + '|' + top)) return loaded.get(rel + '|' + top);
  const tries = [pkg || path.resolve(top)];
  for (const line of git(top, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    const m = /^worktree (.+)$/.exec(line);
    if (m) tries.push(path.join(m[1], rel));
  }
  let ts = null;
  for (const dir of tries) {
    const entry = path.join(dir, 'node_modules', 'typescript', 'package.json');
    if (!fs.existsSync(entry)) continue;
    try { ts = createRequire(entry)('typescript'); if (ts && typeof ts.createSourceFile === 'function') break; ts = null; } catch { ts = null; }
  }
  loaded.set(rel + '|' + top, ts);
  return ts;
}

const kindOf = (ts, file) => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
};

/**
 * '' when `text` parses as the file `file` would; the first syntax error ("line N: message") when it does not; null
 * when no parser fits (the caller names the file as not parsed). Syntax only.
 */
export function syntaxProblem(top, file, text) {
  if (!SCRIPT_FILE.test(file)) return null;
  // Plain JavaScript is parsed by Node itself, as the run reads it (re-check, 2026-11-23: `const x;` parsed for
  // TypeScript and failed in Node).
  if (/\.[cm]?js$/i.test(file)) return nodeCheck(top, file, text);
  const ts = loadTypeScript(top, file);
  if (ts) {
    // The syntactic diagnostics of a one-file program: the parse errors and the syntax a file of this kind cannot hold.
    // No lib, no imports read: syntax only.
    const name = '/sanad-break/' + path.basename(file);
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kindOf(ts, file));
    const host = { getSourceFile: (n) => (n === name ? sf : undefined), getDefaultLibFileName: () => '/lib.d.ts', writeFile: () => {}, getCurrentDirectory: () => '/',
      getDirectories: () => [], fileExists: (n) => n === name, readFile: (n) => (n === name ? text : undefined), getCanonicalFileName: (n) => n,
      useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
    const program = ts.createProgram([name], { allowJs: true, checkJs: false, noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve }, host);
    const d = [...(sf.parseDiagnostics || []), ...program.getSyntacticDiagnostics(sf)][0];
    if (!d) return '';
    const { line } = sf.getLineAndCharacterOfPosition(d.start || 0);
    return `line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  }
  // No TypeScript: Node's own stripper parses .ts (no JSX); JSX files are left unparsed.
  if (/\.[cm]?tsx$|\.jsx$/i.test(file)) return null;
  try {
    const strip = createRequire(import.meta.url)('node:module').stripTypeScriptTypes;
    if (typeof strip !== 'function') return null;
    const quiet = process.emitWarning;
    // An enum or a namespace is not plain type syntax: the strip mode refuses it, the transform mode reads it (re-check 3).
    const read = (mode) => { process.emitWarning = () => {}; try { strip(text, { mode }); } finally { process.emitWarning = quiet; } };
    try { read('strip'); } catch (e) { if (e && e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') read('transform'); else throw e; }
    return '';
  } catch (e) {
    return e && e.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ? String(e.message || 'invalid syntax').split(/\r?\n/)[0] : null;
  }
}

// `node --check` of a JavaScript text, in a temporary folder whose package.json gives the file's own module type.
function nodeCheck(top, file, text) {
  let dir = '';
  try {
    const pkg = packageDirOf(top, path.dirname(path.resolve(top, file)));
    let type = 'commonjs';
    try { type = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).type === 'module' ? 'module' : 'commonjs'; } catch { /* commonjs */ }
    // A plain .js file may be read either way (a bundler reads `export` in a package with no type): it parses if
    // either form parses. .cjs and .mjs have one form each.
    const forms = /\.cjs$/i.test(file) ? ['commonjs'] : /\.mjs$/i.test(file) ? ['module'] : [type, type === 'module' ? 'commonjs' : 'module'];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-break-check-'));
    const temp = path.join(dir, path.basename(file));
    fs.writeFileSync(temp, text);
    let r = null;
    for (const form of forms) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: form }));
      const run = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (run.status === 0) return '';
      if (!r) r = run;
    }
    const m = /:(\d+)\r?\n[\s\S]*?(SyntaxError: [^\r\n]+)/.exec(r.stderr || '');
    return m ? `line ${m[1]}: ${m[2]}` : (String(r.stderr || '').split(/\r?\n/).find((l) => /Error/.test(l)) || 'node --check failed').trim();
  } catch { return null; }
  finally { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } }
}
