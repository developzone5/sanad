import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-18: honest commands of real sessions that the shell reader called code edits, and the real edits that
// must stay reported. One test per rule of the repair.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scan = require(path.join(hooks, 'lib', 'transcript-scan.js'));
const edits = (c) => scan.shellEditPaths(c);
const TMP = 'C:/Users/Asus/AppData/Local/Temp/claude/abc/def/scratchpad';

test('1: running a script is never an edit of the script (a word like "copy" in its text)', () => {
  assert.deepEqual(edits(`P=${TMP}/places.md; G=C:/Users/Asus/.claude/skills/gate/scripts/places.mjs; node $G --close $P --set "P18=none: an exam copy links the same ids" --set "P2=C2"`), []);
  assert.deepEqual(edits(`G=~/.claude/skills/gate/scripts; node $G/places.mjs --set "P1=a copy of x"; echo "- C4 mv the copy" > ${TMP}/check.md`), []);
});

test('2: a > inside a quoted string is no redirect, also with an escaped quote', () => {
  assert.deepEqual(edits('grep -n "\\.mov\\" =>" -B6 EduQuest.Infrastructure/Services/FileValidationHelper.cs'), []);
  assert.deepEqual(edits(`grep -n 'a => b' src/x.cs`), []);
  assert.deepEqual(edits('echo "a => b" > src/map.ts'), ['src/map.ts']);
});

test('3: a relative target after a cd into the temp folder is judged there', () => {
  assert.deepEqual(edits(`cd "${TMP}" && curl -s -o login.ts https://x/y`), []);
  assert.deepEqual(edits(`S="${TMP}"; cd "$S"; curl -o admin-login.ts https://x/y`), []);
  assert.deepEqual(edits(`cd ${TMP} && printf 'a' > check.cs`), []);
  assert.deepEqual(edits(`cd /c/Users/Asus/AppData/Local/Temp/claude/abc/scratchpad && curl -o l.ts https://x`), []);
  assert.deepEqual(edits(`cd ${TMP} && node -e "require('fs').writeFileSync('out.ts','x')"`), []);
  // a folder that is not temp changes nothing: the name stays a project file
  assert.deepEqual(edits('cd /repo/src && curl -o l.ts https://x'), ['l.ts']);
});

test('4: curl -o / wget -O count only for a source-file ending', () => {
  for (const c of ['curl -s -o login.json https://x', 'curl -fsSLo node.zip https://x', 'curl -o login.html https://x', 'wget -O data.json https://x']) assert.deepEqual(edits(c), [], c);
  assert.deepEqual(edits('curl -o src/app.ts https://x'), ['src/app.ts']);
  assert.deepEqual(edits('wget -O lib/x.py https://x'), ['lib/x.py']);
});

test('5: docker cp out of a container is no edit; a copy into the project is', () => {
  assert.deepEqual(edits(`docker cp kc:/opt/keycloak/lib/a.jar ${TMP}/jars/`), []);
  assert.deepEqual(edits('docker cp kc:/opt/x/a.jar C:/Users/Asus/AppData/Local/Temp/a.jar'), []);
  assert.deepEqual(edits('docker cp ./x.cs kc:/opt/x.cs'), []);
  assert.deepEqual(edits('docker cp kc:/opt/Foo.cs src/Foo.cs'), ['src/Foo.cs']);
});

test('6: an interpreter write with only literal non-code targets is no edit; unknown targets stay strict', () => {
  assert.deepEqual(edits(`node -e "require('fs').writeFileSync('${TMP}/out.json','{}')"`), []);
  assert.deepEqual(edits(`node -e "const fs=require('fs');fs.writeFileSync('notes.md','{}')"`), []);
  assert.deepEqual(edits(`node -e "const fs=require('fs');fs.writeFileSync('src/a.ts','{}')"`), ['<generated>']);
  assert.deepEqual(edits(`node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,'{}')"`), ['<generated>']);
  assert.deepEqual(edits(`node -e "const fs=require('fs');fs.readFileSync('a.ts')"`), []);
});

test('7: real edits stay reported', () => {
  assert.deepEqual(edits(`python - <<'PY'\nimport io\np = "src/i18n/locales/ar/takeExam.ts"\nraw = io.open(p, 'rb').read()\nio.open(p,'wb').write(raw)\nPY`), ['<generated>']);
  assert.deepEqual(edits(`cd /repo/src/pages/exams && node -e 'const fs=require("fs");const p="ExamsPage.tsx";fs.writeFileSync(p, "x")'`), ['<generated>']);
  assert.deepEqual(edits(`cat > EduQuest.Tests/Services/X.cs <<'EOF'\nclass X {}\nEOF`), ['EduQuest.Tests/Services/X.cs']);
  assert.deepEqual(edits(`sed -i 's/a/b/' scripts/remote/*.sh`), ['scripts/remote/*.sh']);
});
