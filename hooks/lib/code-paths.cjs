/*
 * code-paths.cjs — the one rule of WHAT kind of file is code (2026-11-18).
 *
 * The push guard and the scanner disagreed: the push guard called every file that is not prose code, the
 * scanner only listed extensions and exempted any folder named specs, memory or .claude. So an edit of
 * index.html, nginx.conf, data/seed.json, Makefile or Infrastructure/Memory/TokenCache.cs after the review
 * left REVIEW: PASS valid. Now both read this module.
 *
 *  - isProsePath(p): plain prose, which obliges no check: .md .rst .adoc, images (.png .jpg .jpeg .gif
 *    .webp), .pdf, a notes-kind name (README, CHANGELOG, CHANGES, LICENSE, NOTICE, AUTHORS, NOTES, TODO)
 *    with no extension or as a .txt file. .mdx and every other .txt are code (2026-11-18).
 *  - isCodePath(p): everything else is code, EXCEPT the places that are never the project: the temp folder
 *    (unless a git work tree lives in it), node_modules, .git, .codex, device files, and the state folders
 *    of ~/.claude. The folders specs, memory and .claude are exempt only for prose files (a file in them
 *    that is not prose, such as .claude/hooks/guard.js or specs/Foo.cs, is code).
 *
 * Deterministic, no side effects. Used by transcript-scan.js (stop gate) and policy-guard.js (push guard).
 */
'use strict';

const fs = require('fs');

function stripQuotes(s) { return String(s || '').replace(/^["']+|["']+$/g, ''); }

// `a/b/../c` is `a/c`: a name that climbs out of an exempt folder is judged where it lands.
function collapseDots(p) {
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '.') continue;
    const last = parts[parts.length - 1];
    if (part === '..' && parts.length && last !== '..' && last !== '' && !/^[A-Za-z]:$/.test(last)) { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

// 2026-11-18: .mdx is executable (it holds JSX and imports) and a .txt file is often a dependency or build
// manifest (requirements.txt, constraints.txt, CMakeLists.txt), so neither is plain prose by its ending.
// A .txt file is prose only when its name is a notes kind: README, CHANGELOG, CHANGES, LICENSE, NOTICE,
// AUTHORS, NOTES or TODO, with any ending after the word (README.txt, NOTES-2026.txt, LICENSE.third-party.txt).
// 2026-11-18 (real commands replayed): media and font files are assets like images: removing a rendered video
// or copying a recording asked for a test run. Archives and binaries (.zip .jar .dll .exe) stay code: a push
// of one is not a docs-only push.
const PROSE_EXT = /\.(?:md|rst|adoc|png|jpe?g|gif|webp|bmp|ico|pdf|mp4|mov|webm|mkv|avi|mp3|wav|ogg|m4a|ttf|otf|woff2?|eot)$/i;
// 2026-11-18: .log is output, never product code or input; a rotated name (run.log.1, .old, .bak) is the same file.
// A .log under a test-data folder is a test's input and stays code (it asks for a re-test).
const LOG_END = /\.log(?:\.(?:\d+|old|bak))?$/i;
const TEST_DATA_DIR = /(?:^|[/\\])(?:tests?|fixtures|testdata|__fixtures__)[/\\]/i;
const NOTES_KIND = '(?:README|CHANGELOG|CHANGES|LICENSE|NOTICE|AUTHORS|NOTES|TODO)';
const PROSE_NAME = new RegExp('(?:^|[/\\\\])' + NOTES_KIND + '$', 'i');
const PROSE_TXT = new RegExp('(?:^|[/\\\\])' + NOTES_KIND + '(?![A-Za-z0-9])[^/\\\\]*\\.txt$', 'i');
function isProsePath(p) {
  p = stripQuotes(p).replace(/[),;]+$/, '');
  if (!p) return false;
  if (LOG_END.test(p)) return !TEST_DATA_DIR.test(p);
  return PROSE_EXT.test(p) || PROSE_NAME.test(p) || PROSE_TXT.test(p);
}

// Never the project, whatever the file is: tool config of the other engine, vendored and VCS-internal
// trees, device files, the temp folder named literally or by its variable, and the state folders of ~/.claude
// (session state, memory of projects, scan caches, file backups).
const NEVER_PROJECT = /(?:(?:^|[/\\])\.codex(?:[/\\]|$)|(?:^|[/\\])node_modules[/\\]|(?:^|[/\\])\.git[/\\]|^\/tmp\/|^\/private\/tmp\/|^\/(?:private\/)?var\/folders\/|^\$\{?(?:TEMP|TMP|TMPDIR)\}?[/\\]|^\$env:(?:TEMP|TMP)[/\\]|^%(?:TEMP|TMP)%[/\\]|^\/dev\/|^\/proc\/|(?:^|[/\\])\.claude[/\\](?:state|projects|file-history|todos|shell-snapshots|plans|tasks|sessions|logs|backups|cache|ide|statsig)(?:[/\\]|$))/i;
// specs, memory and .claude are not listed above on purpose: a prose file in them is prose (isProsePath),
// any other file in them is code.
// The Windows temp folder is exempt only outside a git work tree: real worktrees live there too, and
// edits in them never counted (2026-11-12, audit H3: no check asked, no timer).
const TEMP_DIR = /AppData\/Local\/Temp/i;
const workTreeDirs = new Map(); // folder -> inside a work tree rooted below the temp folder (for this process)
function inTempWorkTree(p) {
  const local = p.replace(/^\/([A-Za-z])\//, '$1:/');   // Git Bash spells C:/ as /c/
  const m = TEMP_DIR.exec(local);
  if (!m) return false;
  const top = local.slice(0, m.index + m[0].length);
  // Walk up from the file's folder to the temp folder; a folder that does not exist yet has no .git,
  // so the nearest existing parent decides.
  const seen = [];
  let dir = local.replace(/\/+$/, '').replace(/\/[^/]*$/, ''), inside = false;
  while (dir.length > top.length) {
    if (workTreeDirs.has(dir)) { inside = workTreeDirs.get(dir); break; }
    seen.push(dir);
    let found = false;
    try { found = fs.existsSync(dir + '/.git'); } catch (e) { found = false; }
    if (found) { inside = true; break; }
    dir = dir.replace(/\/[^/]*$/, '');
  }
  for (const d of seen) workTreeDirs.set(d, inside);
  return inside;
}

// 2026-11-18 (the old and the new scanner were run over 19 real sessions): "everything but prose is code" is
// the rule INSIDE a repository. Two things had become code edits that asked for a test and are not:
//  - a string that is no file name at all (a browser tool's input, "evaluate('document...scrollWidth > ...')");
//  - a file outside every repository with no known code ending (~/.ssh/config).
// So a text with a character no file name holds is never code, and a file whose folder exists on disk with no
// .git folder above it is code only when it is a known code kind (the list the scanner had before this
// module). A path that cannot be judged on disk (a folder that does not exist, a relative path) stays code.
const NOT_A_PATH = /['"<>|;=\r\n]/;   // a glob (*.sh, file?.ts) is still a file name: sed -i over scripts/*.sh is an edit
const KNOWN_CODE_EXT = new RegExp('\\.(' +
  'cs|csproj|vbproj|fsproj|razor|cshtml|ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|' +
  'py|ipynb|go|rb|php|java|kt|kts|rs|swift|scala|dart|lua|ex|exs|fs|fsx|vb|groovy|pl|' +
  'c|cc|cpp|cxx|h|hpp|sh|bash|ps1|psm1|sln|props|targets|yaml|yml|toml|xml|config|ini|sql|css|scss|less' +
  ')$', 'i');
const KNOWN_CODE_NAME = /(^|[/\\])(dockerfile[^/\\]*|(appsettings[^/\\]*|tsconfig[^/\\]*|launchSettings)\.json|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/\\]*\.txt|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|global\.json)$/i;
const knownCode = (p) => KNOWN_CODE_EXT.test(p) || KNOWN_CODE_NAME.test(p) || /(^|[/\\])src[/\\].*\.json$/i.test(p);
const outsideDirs = new Map(); // folder -> it exists and no folder above it holds .git (for this process)
function outsideEveryRepository(p) {
  let local = p.replace(/^\/([A-Za-z])\//, '$1:/');   // Git Bash spells C:/ as /c/
  if (/^~\//.test(local)) local = require('os').homedir().replace(/\\/g, '/') + local.slice(1);
  if (!/^(?:[A-Za-z]:\/|\/)/.test(local)) return false;            // a relative path: cannot judge
  const start = local.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  if (outsideDirs.has(start)) return outsideDirs.get(start);
  let outside = false;
  try {
    if (start && fs.statSync(start).isDirectory()) {
      outside = true;
      for (let dir = start; ; ) {
        if (fs.existsSync(dir + '/.git')) { outside = false; break; }
        const up = dir.replace(/\/[^/]*$/, '');
        if (!up || up === dir || /^[A-Za-z]:$/.test(dir)) break;
        dir = /^[A-Za-z]:$/.test(up) ? up : up;
      }
    }
  } catch (e) { outside = false; }                                  // the folder does not exist: cannot judge
  outsideDirs.set(start, outside);
  return outside;
}

// The user's own Claude folder (C:/Users/<name>/.claude, ~/.claude) is the installed workflow, not a project:
// it stays exempt as a whole, as before this module (changes there ship through the installer). A .claude
// folder INSIDE a repository is different: only its prose is exempt (see NEVER_PROJECT above).
const HOME_CLAUDE = /^(?:(?:[A-Za-z]:|\/[A-Za-z])?\/(?:Users|home)\/[^/]+|~|\$\{?(?:HOME|USERPROFILE)\}?|\$env:USERPROFILE|%USERPROFILE%)\/\.claude\//i;

function isCodePath(p) {
  p = stripQuotes(p).replace(/[),;]+$/, '');
  if (!p) return false;
  if (NOT_A_PATH.test(p)) return false;
  // Claude-managed worktrees contain application code, even though their
  // absolute path starts inside .claude. Apply exemptions within that checkout.
  p = collapseDots(p.replace(/\\/g, '/')).replace(/^.*(?:^|\/)\.claude\/worktrees\/[^/]+\//i, '');
  if (NEVER_PROJECT.test(p) || HOME_CLAUDE.test(p)) return false;
  if (isProsePath(p)) return false;
  if (TEMP_DIR.test(p) && !inTempWorkTree(p)) return false;
  if (!TEMP_DIR.test(p) && outsideEveryRepository(p) && !knownCode(p)) return false;
  return true;
}

module.exports = { isProsePath, isCodePath, collapseDots, inTempWorkTree, TEMP_DIR, stripQuotes };
