#!/usr/bin/env node
// stack.mjs — read a repository's stack from its own project files, once, and remember it.
//
// Sanad covers several stacks (.NET, React, Next.js; MySQL, SQL Server, PostgreSQL), and no
// rule names a version: versions come from the repository, never from memory. This reads the
// project files (.csproj, Directory.Packages.props, package.json, docker compose files,
// prisma/schema.prisma) and prints one stack line, e.g. ".NET 9 · EF Core 9 · MySQL 8.4 ·
// React 19 + Vite 7 · tests: xUnit, Vitest". The result is saved per repository and read again
// only when one of those files changes (their git blob ids or their uncommitted edits).
//
// Usage: node stack.mjs --repo <path> [--json] [--fresh]
// Exit 0 with the line (or JSON); 2 when the path is not a git repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

export const STACK_FILE = /(?:^|\/)(?:[^/]+\.csproj|Directory\.Packages\.props|package\.json|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml|schema\.prisma)$/i;
const SKIP = /(?:^|\/)(?:node_modules|\.claude|\.agents|\.codex|vendor|dist|build|bin|obj)\//i;

export function cacheDir() { return process.env.SANAD_STATE_DIR ? path.join(process.env.SANAD_STATE_DIR, 'stack') : path.join(os.homedir(), '.claude', 'state', 'stack'); }

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
}

const major = v => { const m = /(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? m[1] : ''; };
const majorMinor = v => { const m = /(\d+)\.(\d+)/.exec(String(v || '')); return m ? m[1] + '.' + m[2] : major(v); };

// The database a package, an image or a prisma provider names.
const DB_PACKAGES = [
  [/^Pomelo\.EntityFrameworkCore\.MySql$|^MySql\.EntityFrameworkCore$|^MySqlConnector$|^mysql2?$/i, 'MySQL'],
  [/^Microsoft\.EntityFrameworkCore\.SqlServer$|^Microsoft\.Data\.SqlClient$|^mssql$|^tedious$/i, 'SQL Server'],
  [/^Npgsql(?:\.EntityFrameworkCore\.PostgreSQL)?$|^pg$|^postgres$/i, 'PostgreSQL'],
  [/^Microsoft\.EntityFrameworkCore\.Sqlite$|^better-sqlite3$|^sqlite3$/i, 'SQLite'],
];
const DB_IMAGES = [
  [/^(?:mysql|mariadb)(?::|$)/i, 'MySQL'], [/mssql\/server(?::|$)|azure-sql-edge/i, 'SQL Server'],
  [/^(?:postgres|postgis\/postgis|bitnami\/postgresql)(?::|$)/i, 'PostgreSQL'],
];
const PRISMA = { mysql: 'MySQL', sqlserver: 'SQL Server', postgresql: 'PostgreSQL', sqlite: 'SQLite', cockroachdb: 'PostgreSQL' };
const TEST_PACKAGES = [[/^xunit$/i, 'xUnit'], [/^NUnit$/i, 'NUnit'], [/^MSTest\.TestFramework$|^MSTest$/i, 'MSTest'], [/^vitest$/, 'Vitest'], [/^jest$/, 'Jest'], [/^@playwright\/test$/, 'Playwright'], [/^cypress$/, 'Cypress']];

export function parse(files) {
  const out = { dotnet: [], ef: '', databases: new Map(), frontends: [], orms: new Set(), tests: new Set() };
  const central = new Map();
  for (const [name, text] of files) if (/Directory\.Packages\.props$/i.test(name)) {
    for (const m of text.matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/gi)) central.set(m[1].toLowerCase(), m[2]);
  }
  const dbAdd = (db, version) => { if (!out.databases.has(db) || (!out.databases.get(db) && version)) out.databases.set(db, version || ''); };
  for (const [name, text] of files) {
    if (/\.csproj$/i.test(name)) {
      for (const m of text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/gi)) {
        for (const tfm of m[1].split(';')) { const v = /^net(\d+)\.\d+/i.exec(tfm.trim()); if (v && Number(v[1]) >= 5) out.dotnet.push(Number(v[1])); }
      }
      for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
        const pkg = m[1]; const version = m[2] || (/<Version>([^<]+)<\/Version>/i.exec(m[3] || '') || [])[1] || central.get(pkg.toLowerCase()) || '';
        // EF Core itself, or a provider package that brings it (Pomelo, Npgsql, SqlServer, Sqlite).
        if (/(?:^|\.)EntityFrameworkCore(?:\.|$)/i.test(pkg) && !out.ef && major(version)) out.ef = major(version);
        if (/^Dapper$/i.test(pkg)) out.orms.add('Dapper');
        for (const [re, db] of DB_PACKAGES) if (re.test(pkg)) dbAdd(db, '');
        for (const [re, t] of TEST_PACKAGES) if (re.test(pkg)) out.tests.add(t);
      }
    } else if (/package\.json$/i.test(name)) {
      let pkg; try { pkg = JSON.parse(text); } catch { continue; }
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) out.frontends.push({ name: 'Next.js', version: major(deps.next), react: major(deps.react) });
      else if (deps.react) out.frontends.push({ name: 'React', version: major(deps.react), build: deps.vite ? 'Vite ' + major(deps.vite) : '' });
      if (deps.prisma || deps['@prisma/client']) out.orms.add('Prisma');
      if (deps['drizzle-orm']) out.orms.add('Drizzle');
      if (deps.typeorm) out.orms.add('TypeORM');
      for (const dep of Object.keys(deps)) {
        for (const [re, db] of DB_PACKAGES) if (re.test(dep)) dbAdd(db, '');
        for (const [re, t] of TEST_PACKAGES) if (re.test(dep)) out.tests.add(t);
      }
    } else if (/schema\.prisma$/i.test(name)) {
      const p = /provider\s*=\s*"(\w+)"/.exec(text.slice(text.search(/datasource\s+\w+\s*\{/) >= 0 ? text.search(/datasource\s+\w+\s*\{/) : 0));
      if (p && PRISMA[p[1]]) dbAdd(PRISMA[p[1]], '');
    } else {
      for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gim)) {
        const image = m[1].replace(/^docker\.io\/(?:library\/)?/i, '');
        for (const [re, db] of DB_IMAGES) if (re.test(image)) {
          const tag = image.split(':')[1] || '';
          dbAdd(db, /^\d/.test(tag) ? (db === 'SQL Server' ? major(tag) : majorMinor(tag)) : '');
        }
      }
    }
  }
  const parts = [];
  if (out.dotnet.length) parts.push('.NET ' + Math.max(...out.dotnet));
  if (out.ef) parts.push('EF Core ' + out.ef);
  for (const orm of out.orms) parts.push(orm);
  for (const [db, v] of out.databases) parts.push(db + (v ? ' ' + v : ''));
  const seen = new Set();
  for (const f of out.frontends) {
    const label = f.name === 'Next.js' ? 'Next.js ' + f.version + (f.react ? ' (React ' + f.react + ')' : '') : 'React ' + f.version + (f.build ? ' + ' + f.build : '');
    if (!seen.has(label)) { seen.add(label); parts.push(label); }
  }
  if (out.tests.size) parts.push('tests: ' + [...out.tests].join(', '));
  return {
    line: parts.join(' · ') || 'no known stack files',
    backend: out.dotnet.length ? { name: '.NET', version: String(Math.max(...out.dotnet)), ef: out.ef } : null,
    databases: [...out.databases.keys()],
    frontends: [...new Set(out.frontends.map(f => f.name))],
    orms: [...out.orms], tests: [...out.tests],
  };
}

function inputs(repo) {
  const tracked = git(repo, ['ls-files', '-s', '-z']).split('\0').filter(Boolean)
    .map(l => ({ id: l.split(/\s+/)[1], name: l.slice(l.indexOf('\t') + 1) })).filter(f => STACK_FILE.test(f.name) && !SKIP.test(f.name));
  const untracked = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(n => n && STACK_FILE.test(n) && !SKIP.test(n));
  const dirty = new Set(git(repo, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean));
  return { names: [...tracked.map(f => f.name), ...untracked], key: crypto.createHash('sha1').update(JSON.stringify([tracked, untracked, [...dirty].filter(n => STACK_FILE.test(n)).map(n => {
    try { return [n, crypto.createHash('sha1').update(fs.readFileSync(path.join(repo, n))).digest('hex')]; } catch { return [n, 'gone']; }
  })])).digest('hex') };
}

// The stack of a repository; reuses the saved result while its stack files are unchanged.
export function readStack(repoPath, { fresh = false } = {}) {
  const repo = path.resolve(git(path.resolve(repoPath), ['rev-parse', '--show-toplevel']).trim());
  const { names, key } = inputs(repo);
  const file = path.join(cacheDir(), crypto.createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 16) + '.json');
  if (!fresh) {
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.key === key && saved.stack) return { ...saved.stack, cached: true }; } catch { /* first read or changed */ }
  }
  const files = names.map(n => { try { return [n, fs.readFileSync(path.join(repo, n), 'utf8')]; } catch { return null; } }).filter(Boolean);
  const stack = parse(files);
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ repo, key, stack })); } catch { /* the line still prints */ }
  return { ...stack, cached: false };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--repo');
  try {
    if (at < 0 || !argv[at + 1]) throw new Error('--repo is required.');
    const stack = readStack(argv[at + 1], { fresh: argv.includes('--fresh') });
    process.stdout.write((argv.includes('--json') ? JSON.stringify(stack) : 'Stack: ' + stack.line) + '\n');
  } catch (error) {
    process.stderr.write('STACK: ' + String(error.message).split('\n')[0] + '\nUsage: node stack.mjs --repo <path> [--json] [--fresh]\n');
    process.exitCode = 2;
  }
}
