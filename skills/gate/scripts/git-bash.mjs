// git-bash.mjs — the bash that runs Sanad's shell scripts (remote-sync.sh, remote-preflight.sh).
//
// 2026-11-15 (release 6 on the test machine): on Windows, `bash` on PATH can be the WSL launcher
// (C:\Windows\System32\bash.exe). Over ssh it came first, Git's usr\bin was not on PATH, and every script run
// through plain `bash` failed (exit 1) without reaching its first line. Git's own bash is used instead, with its
// tools (sed, grep, ssh) put first on PATH for that run. Elsewhere, or with no Git for Windows, plain `bash`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let found;
export function gitBash() {
  if (found) return found;
  found = { exe: 'bash', tools: '' };
  if (process.platform !== 'win32') return found;
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const tools = path.resolve(exec, '..', '..', '..', 'usr', 'bin');
    if (fs.existsSync(path.join(tools, 'bash.exe'))) found = { exe: path.join(tools, 'bash.exe'), tools };
  } catch { /* no git on PATH: plain bash */ }
  return found;
}

// The environment for one script run: `env` with Git's tools first on PATH (Windows names it Path or PATH).
export function bashEnv(env = process.env) {
  const { tools } = gitBash();
  if (!tools) return env;
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  out[key] = tools + path.delimiter + (out[key] || '');
  return out;
}
