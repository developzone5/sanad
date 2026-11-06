import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse, readStack } from '../scripts/stack.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function repoWith(files) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); }
  git('add', '-A'); git('commit', '-qm', 'fixture');
  return { repo, git };
}

const csproj = (tfm, pkgs) => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework></PropertyGroup><ItemGroup>${pkgs.map(([n, v]) => `<PackageReference Include="${n}"${v ? ` Version="${v}"` : ''} />`).join('')}</ItemGroup></Project>`;

test('.NET with MySQL, React and Vite: versions come from the files', () => {
  const s = parse([
    ['Api/Api.csproj', csproj('net9.0', [['Microsoft.EntityFrameworkCore', '9.0.1'], ['Pomelo.EntityFrameworkCore.MySql', '9.0.0']])],
    ['Api.Tests/Api.Tests.csproj', csproj('net9.0', [['xunit', '2.9.0']])],
    ['web/package.json', JSON.stringify({ dependencies: { react: '^19.2.0' }, devDependencies: { vite: '^7.1.2', vitest: '^3.0.0' } })],
    ['docker-compose.yml', 'services:\n  db:\n    image: mysql:8.4\n'],
  ]);
  assert.equal(s.line, '.NET 9 · EF Core 9 · MySQL 8.4 · React 19 + Vite 7 · tests: xUnit, Vitest');
});

test('SQL Server through central package versions, and PostgreSQL through Npgsql', () => {
  const sql = parse([
    ['Directory.Packages.props', '<Project><ItemGroup><PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.0" /></ItemGroup></Project>'],
    ['App/App.csproj', csproj('net10.0', [['Microsoft.EntityFrameworkCore.SqlServer', '']])],
    ['compose.yaml', 'services:\n  sql:\n    image: "mcr.microsoft.com/mssql/server:2022-latest"\n'],
  ]);
  assert.equal(sql.line, '.NET 10 · EF Core 10 · SQL Server 2022');
  const pg = parse([['App/App.csproj', csproj('net8.0', [['Npgsql.EntityFrameworkCore.PostgreSQL', '8.0.4']])], ['docker-compose.yml', 'services:\n  pg:\n    image: postgres:16-alpine\n']]);
  assert.equal(pg.line, '.NET 8 · EF Core 8 · PostgreSQL 16');
});

test('Next.js with Prisma on PostgreSQL', () => {
  const s = parse([
    ['package.json', JSON.stringify({ dependencies: { next: '15.1.0', react: '19.0.0', '@prisma/client': '6.0.0' }, devDependencies: { prisma: '6.0.0', '@playwright/test': '1.49.0' } })],
    ['prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n'],
  ]);
  assert.equal(s.line, 'Prisma · PostgreSQL · Next.js 15 (React 19) · tests: Playwright');
  assert.deepEqual(s.frontends, ['Next.js']);
});

test('a repository is read once, then again only when a stack file changes', () => {
  const { repo, git } = repoWith({ 'package.json': JSON.stringify({ dependencies: { react: '18.3.1' } }), 'src/a.js': 'x\n' });
  const first = readStack(repo);
  assert.equal(first.line, 'React 18');
  assert.equal(first.cached, false);
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'y\n');
  assert.equal(readStack(repo).cached, true, 'a code edit keeps the saved line');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }));
  const changed = readStack(repo);
  assert.equal(changed.cached, false);
  assert.equal(changed.line, 'React 19', 'an uncommitted stack edit is read');
  git('add', '-A'); git('commit', '-qm', 'bump');
  assert.equal(readStack(repo).line, 'React 19');
});

test('vendored folders and broken files are ignored', () => {
  const { repo } = repoWith({ '.claude/skills/x/package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }), 'package.json': '{ not json', 'README.md': 'x' });
  assert.equal(readStack(repo, { fresh: true }).line, 'no known stack files');
});
