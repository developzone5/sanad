'use strict';

const fs = require('fs');
const path = require('path');

function executableName(value) {
  return String(value || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

// Native Windows execution cannot spawn .cmd shims without a shell. Recognize
// only the package-owned Node entrypoints, never a similarly named user script.
function nativeVerificationTarget(executable, args = []) {
  let name = executableName(executable);
  let rest = args.map(String);
  if (name === 'node' && rest.length) {
    const script = rest[0].replace(/\\/g, '/');
    if (/(?:^|\/)node_modules\/typescript\/(?:bin\/tsc|lib\/tsc\.js)$/i.test(script)) {
      name = 'tsc'; rest.shift();
    } else if (/(?:^|\/)node_modules\/vitest\/vitest\.mjs$/i.test(script)) {
      // A pinned Node (e.g. the build image's major) runs vitest directly: npm's .cmd shims
      // would pick whatever `node` is first on PATH instead.
      name = 'vitest'; rest.shift();
    } else {
      const npm = /(?:^|\/)node_modules\/npm\/bin\/(npm|npx)-cli\.js$/i.exec(script);
      if (npm) { name = npm[1].toLowerCase(); rest.shift(); }
    }
  }
  return { executable: name, args: rest };
}

// Work on argument arrays so project paths containing spaces remain intact.
function verificationTarget(executable, args = []) {
  const native = nativeVerificationTarget(executable, args);
  let name = native.executable;
  let rest = native.args;
  if (name === 'npx') {
    while (rest.length && rest[0].startsWith('-')) {
      const option = rest.shift();
      if (option === '--') break;
      if (/^(?:-p|--package|--cache|--userconfig)$/.test(option)) rest.shift();
    }
    name = executableName(rest.shift());
  } else if (/^(?:npm|pnpm|yarn|bun)$/.test(name) && /^(?:exec|dlx|x)$/.test(rest[0] || '')) {
    rest.shift();
    while (rest.length && rest[0].startsWith('-')) {
      const option = rest.shift();
      if (option === '--') break;
      if (/^(?:-p|--package)$/.test(option)) rest.shift();
    }
    name = executableName(rest.shift());
  }
  return { executable: name, args: rest };
}

function isInspection(args) {
  return args.some(value => /^(?:--listFilesOnly|--showConfig|--help|--version|-h|-v)(?:=|$)/i.test(value));
}

// JSONC comments and trailing commas are permitted in tsconfig, but never
// evaluate configuration as JavaScript or remove text inside quoted strings.
function parseJsonc(text) {
  let clean = '', quoted = false, escaped = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; clean += ch; }
    else if (ch === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      clean += ' ';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated JSONC comment');
      i = end + 1; clean += ' ';
    } else clean += ch;
  }
  let result = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; result += ch; }
    else if (ch !== ',' || !/^\s*[}\]]/.test(clean.slice(i + 1))) result += ch;
  }
  return JSON.parse(result);
}

function invalidVerificationTarget(executable, args, cwd) {
  const target = verificationTarget(executable, args);
  if (target.executable !== 'tsc') return '';
  if (isInspection(target.args)) return 'TypeScript inventory/help output does not verify source files.';
  if (target.args.some(value => /^(?:-b|--build)(?:=|$)/i.test(value))) return '';
  let project = 'tsconfig.json', explicit = false;
  const sourceArgs = [];
  for (let i = 0; i < target.args.length; i++) {
    const value = target.args[i];
    if (/^(?:-p|--project)$/i.test(value)) { project = target.args[++i]; explicit = true; }
    else if (/^(?:-p|--project)=/i.test(value)) { project = value.slice(value.indexOf('=') + 1); explicit = true; }
    else sourceArgs.push(value);
  }
  if (!explicit && sourceArgs.some(value => /\.[cm]?tsx?$/i.test(value))) return '';
  if (!project) return 'The TypeScript project argument is missing.';
  let config;
  try {
    let filename = path.resolve(cwd, project);
    if (fs.statSync(filename).isDirectory()) filename = path.join(filename, 'tsconfig.json');
    config = parseJsonc(fs.readFileSync(filename, 'utf8'));
  } catch (_) { return ''; } // Native tsc reports unreadable or malformed configs.
  if (config && typeof config === 'object' &&
      Array.isArray(config.files) && config.files.length === 0 &&
      (!config.include || (Array.isArray(config.include) && config.include.length === 0)) &&
      !config.extends && Array.isArray(config.references) && config.references.length > 0) {
    return 'This tsconfig has no source files; tsc --project does not check its referenced projects. ' +
      'Use the repository build command, tsc --build, or --project <actual-app-config>.';
  }
  return '';
}

module.exports = { invalidVerificationTarget, isInspection, verificationTarget, nativeVerificationTarget };
