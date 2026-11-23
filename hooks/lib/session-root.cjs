'use strict';
// session-root.cjs — is a transcript a real session's log? One rule for every hook that writes the user's state.
//
// The real path of the transcript must lie INSIDE one trusted root: ~/.claude/projects, the projects folder of
// CLAUDE_CONFIG_DIR, or <APPDATA>/orca/claude-profiles/<id>/home/projects. A folder of the same names anywhere else
// (a test fixture, a temp folder) is not a session.
// 2026-11-20: the scanner learned the Orca root (transcript-scan.js stateAllowed). 2026-11-22: the task timer
// (timer-idle.cjs) still read only .claude/projects, so every Orca session got its start mark and no stage at all.
// Both now ask this file.
const fs = require('fs');
const os = require('os');
const path = require('path');

function realPath(p) {
  let cur = path.resolve(String(p || '')), rest = '';
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), rest); } catch (e) { /* the file may not exist yet */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest = path.join(path.basename(cur), rest);
    cur = up;
  }
  return path.resolve(String(p || ''));
}
// Letter case is folded only where the file system folds it (Windows): on a case-sensitive system a folder that
// differs only by case is another folder, never a trusted root (attack, 2026-11-22).
const norm = (p) => { const s = realPath(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };

/** True when `transcriptPath` lies inside a trusted session root (see above). */
function inSessionRoot(transcriptPath, env = process.env) {
  if (!transcriptPath) return false;
  const file = norm(transcriptPath);
  const inside = (root) => file.startsWith(root + '/');
  let home = '';
  try { home = os.homedir(); } catch (e) { return false; }
  if (inside(norm(path.join(home, '.claude', 'projects')))) return true;
  if (env && env.CLAUDE_CONFIG_DIR && inside(norm(path.join(env.CLAUDE_CONFIG_DIR, 'projects')))) return true;
  const profiles = norm(path.join((env && env.APPDATA) || path.join(home, 'AppData', 'Roaming'), 'orca', 'claude-profiles'));
  if (!inside(profiles)) return false;
  return /^[^/]+\/home\/projects\/./.test(file.slice(profiles.length + 1));
}

module.exports = { inSessionRoot, realPath };
