// Imported first by a test file whose tools read the owner's switches (git config sanad.*): the tests then see the
// switches at their defaults, whatever the owner set on this machine (2026-11-20: with sanad.testsOnlyLane true in
// the owner's global config, 12 gate tests failed during an install, because their tests-only fixtures skipped the
// evidence check). The owner's global config is still read (name, email, line endings, the test machine); only the
// switches below are put back to their defaults. A switch a test sets in its own repository still wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let real = process.env.GIT_CONFIG_GLOBAL || '';
if (!real) {
  try {
    real = execFileSync('git', ['config', '--global', '--list', '--show-origin'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(l => /^file:(.+?)\t/.exec(l)?.[1]).find(Boolean) || '';
  } catch { real = ''; }
}
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-git-global-')), 'gitconfig');
const include = real ? `[include]\n\tpath = ${real.replace(/\\/g, '/')}\n` : '';
fs.writeFileSync(file, include + [
  '[sanad]',
  '\tstopRound = 3',
  '\ttestsOnlyLane = false',
  '\tdesignChoice = false',
  '\tcarryDecision = false',
  '\treplayBlocks = false',
  '\tlateCheckLines = true',
  '\tstrictEvidence = true',
  '',
].join('\n'));
process.env.GIT_CONFIG_GLOBAL = file;
