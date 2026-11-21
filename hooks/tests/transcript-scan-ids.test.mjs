import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const scan = createRequire(import.meta.url)('../lib/transcript-scan.js');

test('humanWords is exported and reads a human prompt', () => {
  assert.equal(typeof scan.humanWords, 'function');
  assert.equal(scan.humanWords({ type: 'user', message: { role: 'user', content: 'hello' } }), 'hello');
  assert.equal(scan.humanWords({ type: 'assistant' }), null);
});

test('the open notes text ends with SG-NOTES', () => {
  const m = scan.openNotesMessage([{ n: 1, kind: 'Gap', text: 'x' }]);
  assert.match(m, /\(SG-NOTES\)$/);
});
