// test-names.mjs — how a declared test title is read against a test's names (2026-11-25, owner: one reading, used by
// the proof and by the break plan check). Moved here from red-proof.mjs unchanged: the proof matches tests as before.

// A declared title against a failing test's own names; a title with placeholders (`${x}`, %s, $name)
// matches any text in their place.
export function titleMatches(title, own) {
  const t = String(title).toLowerCase();
  if (own.has(t)) return true;
  if (!/\$\{|%[sdifjoc#]|\$\w/.test(t)) return false;
  const re = new RegExp('^' + t.split(/\$\{[^}]*\}|%[sdifjoc#]|\$\w+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
  return [...own].some(n => re.test(n));
}
