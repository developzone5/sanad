# Commands, regressions and smoke evidence

Run setup, the check, and cleanup as separate commands. For red-before-green,
use `scripts/red-proof.mjs` (it swaps in the old fix files, runs the test once and
restores them byte for byte; its own exit is 0 for RED, so no failed check is left
behind), then run the test itself after the fix.
Never repeat a stash/pop bundle to satisfy a hook. An opaque old bundle stays
unverified until its actual failed steps are understood; a green unrelated test
cannot clear it. ESLint warnings with native exit 0 are warnings, not command
errors; enforce any zero-warning policy separately.

For publishing evidence, use `scripts/evidence.mjs`. It starts one native executable with
an argv array (`shell:false`), saves stdout/stderr before summarizing, and returns
the native failure exit. It records command, cwd, timing, exit/signal and log paths, and computes the
Git content tree before and after execution. Publishing requires both trees to
match the outgoing commit in the same repository. A caller-supplied `source`
label cannot establish that identity. Keep check specifications and output outside
the repository so evidence files do not alter the checked tree.

Create an external JSON specification with `executable`, `args`, absolute `cwd`
and `outputRoot`, optionally `timeoutMs`, `maxBytes`, and `secrets` to
mask. Use a native executable; Windows `.cmd` scripts need their native runner.
On Windows, use the verified `node.exe` path as `executable`, with the installed
`node_modules/npm/bin/npm-cli.js` followed by `run`, `build` (or the actual check)
in `args`; for TypeScript use `node_modules/typescript/bin/tsc` followed by
`--noEmit`, `--project`, and the actual app config. Resolve these paths locally.
These package entrypoints are recognized; arbitrary Node scripts are not checks.
Do not put credentials in the specification or command arguments. Known secret
environment values and common credential fields are masked. Logs have an 8 MB
default per-stream ceiling; exceeding it fails the check instead of certifying
truncated evidence. Summarize the saved logs only after collecting completion.

```powershell
node ~/.claude/skills/gate/scripts/evidence.mjs --spec "<absolute path to>/gate-check.json"
```

The Stop/push scanner recognizes the installed helper's standalone completion
receipt for build/test commands. The publishing guard also requires matching
source identity in that collected receipt; direct terminal checks alone cannot
authorize a push or draft PR. Red and green specifications can be different
files: matching uses the executed cwd and argv. A missing receipt, nonzero native
exit, pending result, another test or another directory cannot supply a pass.

For HTTP smoke scripts, import `assertHttp` and `withCleanup` from the same module.
`assertHttp` requires `url` and `expectedStatus`. Pass `options` for the real verb,
content type and body, `expectedCode`/`codePath` for the API error code, and an
`assertState` callback that asserts the independently read-back persisted state.
It rejects transport failures, redirects, wrong statuses/codes, invalid JSON and
oversize bodies. A denial test can expect 404; HTTP 000 or 415 is not equivalent.
The callback must assert the real result; a no-op callback is not evidence.

Provider checks must run as standalone commands whose failures reach the tool.
For successful HTTP probes put `--fail-with-body` (or `--fail`) first after `curl`; plain curl
can exit zero on HTTP 500 and earns no provider credit. For expected 401/403/404,
run a standalone `node ...smoke.mjs` (or another supported smoke-script runner)
using `assertHttp` and propagate its failure exit. Do not pipe the command into
a display utility or append a successful cleanup command. Collect background
completion before writing the gate verdict. Failed provider identities remain
unresolved until the same check succeeds; an unrelated health check cannot
erase them. Quote the running build/migration identity as well as the business
result: a localhost response alone cannot establish which version served it.
Use an asserted smoke script for curl config files, multiple transfers or
options that turn failure checking off; those shapes receive no direct credit.
Direct curl credit covers one explicit local HTTP(S) URL without URL globbing
and common separately spelled options. Unsupported forms use an asserted smoke
script. PowerShell probes must not suppress HTTP errors; `-ErrorAction Stop`
is supported, while `-SkipHttpErrorCheck` (including switch-value forms) is not.

### Recover a check that cannot be retried

The guard intentionally retains failed command identities and uncollected
launches; a typo corrected into a different command does not erase the original
failure. First collect or cancel the owned process and establish that it exited.
Never rerun destructive setup just to clear a marker. If the original command
cannot legitimately succeed (a typo, an obsolete target), retire it in the same
session with one plain line at line start, in a text-only message:

`CHECK RETIRED: {"failed":"<exact failed command>","replacement":"<exact replacement command>","reason":"<why it cannot pass>"}`

Then run the replacement. The guards clear that failure only when the named
replacement passes after the line; a still-running check, a malformed line or a
replacement that never passes retires nothing. Retire only a command whose
failure you understand; a genuine failure is fixed, never retired. Redact
credentials from both commands.
Use [promotion.md](../../ship/reference/promotion.md) to verify reuse of an
already completed successful review for unchanged committed content; session
recovery alone does not require another paid review. Never copy a receipt as new
execution evidence or silently discard an unresolved failure.

Wrap owned fixture cleanup in `withCleanup(action, cleanup)`. Both a failed probe
and failed cleanup remain failures, including when both fail. Never end a script
with an unconditional successful cleanup/print that hides the probe's failure.

For side-effect regressions, use recording fakes, mock call verification, or
persisted readback. Cite the trigger, assertion, and observation mechanism. A
no-op cache/search mock proves neither a call nor the absence of a call.
