#!/usr/bin/env node
/*
 * precommit-guard.js — PreToolUse(Bash) hook.
 * Blocks a `git commit` / `git push` that carries hardcoded secrets,
 * AI attribution, or a staged .env file. Deterministic, no LLM.
 *
 * Self-gating: exits 0 (allow) for anything that is not a git commit/push.
 * Fail-OPEN: any error (no git, parse failure, missing script) → allow.
 * Only ever DENIES on a high-confidence match, so it cannot brick the shell.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip a UTF-8 BOM if present
    return s;
  } catch (e) { return ''; }
}

function git(args) {
  try {
    return execSync('git ' + args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e) { return ''; }
}

let cmd = '';
try {
  const data = JSON.parse((readStdin().replace(/^﻿/, '').trim()) || '{}');
  cmd = (data.tool_input && data.tool_input.command) || '';
} catch (e) { allow(); }

const isCommit = /\bgit\s+commit\b/.test(cmd);
const isPush = /\bgit\s+push\b/.test(cmd);
if (!isCommit && !isPush) allow();

// Gather the content being introduced.
let diff = '';
let files = '';
try {
  if (isCommit) {
    diff = git('diff --cached --unified=0');
    files = git('diff --cached --name-only');
  } else {
    const upstream = git('rev-parse --abbrev-ref --symbolic-full-name @{u}').trim();
    if (upstream) {
      diff = git('diff ' + upstream + '..HEAD --unified=0');
      files = git('diff ' + upstream + '..HEAD --name-only');
    }
  }
} catch (e) { allow(); }

// Only the ADDED lines (skip "+++" file headers).
const added = diff
  .split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .join('\n');

// 1) AI attribution — in the commit message (from -m) or in the added content.
const attribution = /Co-Authored-By:\s*Claude|Generated with \[?Claude Code/i;
if (attribution.test(cmd) || attribution.test(added)) {
  deny('Blocked: AI attribution (Co-Authored-By: Claude / "Generated with Claude Code") detected. Remove it before committing.');
}

// 2) Staged credential file (allow .env.example / .env.template / .env.sample).
const envFile = files
  .split('\n')
  .map((f) => f.trim())
  .find((f) => f && /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.(example|template|sample)$/.test(f));
if (envFile) {
  deny('Blocked: a credential file is staged (' + envFile + '). Add it to .gitignore and keep secrets out of git.');
}

// 3) High-confidence secret patterns in the added lines.
const patterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSL |PGP |DSA )?PRIVATE KEY-----/, 'a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/(?:server|data source|host)\b[^\n]{0,80}?\b(?:password|pwd)\s*=\s*[^;\s"'){}<]{4,}/i, 'a connection string with an inline password'],
  [/(?:secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|apikey)["']?\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/i, 'a hardcoded secret / API key'],
];
for (let i = 0; i < patterns.length; i++) {
  if (patterns[i][0].test(added)) {
    deny('Blocked: ' + patterns[i][1] + ' appears in the staged changes. Move it to user-secrets / a secret store and remove the literal value.');
  }
}

allow();
