# Execute the agreed scope once

Read once per substantive task. Keep a short task record outside application source: selected engine/host and model/effort, requested behavior, `Done means` with the proof type per line (test name / request + status / user browser check) and its result once collected, accepted decisions, affected files, current revision/diff, completed evidence and unresolved findings. Reviewers, the gate and the ship brief all read this one list; a line without proof blocks the push. Reuse an existing spec/handoff; do not create competing ledgers.

## Scope and decisions

- Every changed file must serve the request or its required correctness/security proof. Do not add optional URLs, recovery features, settings, abstractions or preventive cleanup merely because a reviewer suggests them. Queue them for later. A small condition change can still need caller and negative tests; do not expand its product behavior by default.
- Supply all reviewers the same original request, accepted decisions with evidence, supported optional/empty states, and prior finding dispositions. External guarantees remain assumptions until verified. An accepted risk is not proof that the external system is safe.
- When reviewers disagree, decide once using the required behavior and concrete evidence. Do not automatically implement the latest opinion. A new fact that invalidates the decision warrants a scoped reassessment.
- Read an existing file before editing it. Use targeted edits, inspect removed lines/assertions, and finish formatting/comment cleanup before verification and review. Passing tests do not detect tests accidentally deleted.

## Synchronize before final verification

Before final tests and review, fetch the configured remote, discover the integration branch, and check the current PR state. If it is merged, use a fresh feature branch; if integration advanced, incorporate it into the feature branch and resolve conflicts before freezing source. Never merge into a shared branch or rebase a pushed branch. Record the integration commit. Recheck freshness before publishing; unchanged inputs reuse evidence, while later integration changes require affected verification and the review scope selected by the helper. An unavailable remote is an explicit gap; a local workflow without a remote records this step as not applicable.

## Review once, follow up on the fix

- Assign one owner to each review scope. Distinct mandated specialists may run
  together when their responsibilities differ; a replacement must not duplicate
  an obsolete reviewer still running on the same gap. Collect or explicitly cancel
  that owned run first. On timeout preserve findings, checked scope, logs and run ID;
  hand off only unfinished/changed work under the helper's required scope. A new
  review is not a reason to repeat unchanged builds, tests or completed design.
  After a timeout, record the cause and the concrete correction before retrying.
  Allow one retry for that diagnosed condition; if it repeats, stop that retry loop
  and report the remaining gap while continuing independent work. A new attempt
  needs a changed condition or approach; an incomplete report never authorizes shipping.

- Use the two-pass independent review defined in [Sanad Step 3.5](loop.md) (read-only subagents launched in one message on frozen source: the selected engine's risk reviewer as Pass A on the risk files with a trace list, its whole-diff reviewer as Pass B (assignments in [engines.md](engines.md))). Together they own bug hunting, requirements coverage and relevant DB/security analysis. Add a separate boss-model/xhigh reviewer only for a named unresolved issue or expertise gap; record the question and scope first. Extra review covers that gap and necessary interactions, not the whole change. A security-only report does not replace requirements coverage. Before every push of code, the FRESH EYES whole-PR review in Step 3.5 runs last, with no author framing.
- Collect both reports, dedupe, reconcile, then fix the agreed in-scope issues together. For the re-check supply the earlier findings with dispositions, the fix diff, affected callers and new proof, and ask for the actual range checked.
- The re-check after a fix round is a **fresh Pass B launch** on the files changed since the last pass plus their callers (a new agent; a SendMessage continuation is not the re-check). A fix on a sensitive boundary also gets a fresh scoped Pass A. Completed coverage carries forward regardless of round count; missing coverage, changed boundaries or an expanded request require full scope again. Any extra boss-model reviewer checks only its named gap against the same source identity. A reviewer may expand scope, never narrow a required full review. Keep every reviewer ID and checked scope in the task record.
- Reviewers inspect source and supplied evidence. They must not independently rebuild the same output tree, recreate known probes, start services, or rediscover completed tests without an identified evidence gap. Runtime verification stays with the author.
- If user steering requires edits during a review, stop the owned obsolete review when possible. Retain useful scoped findings; do not treat its original snapshot as certification of the new source.
- Use available reporting tools only. If a requested reporting tool is absent, return the required structure as text; do not repeatedly search for it. Never assume a launch is completion.
- Trace both sides of a changed condition and downstream consumers of statuses/ownership. Check callers, sibling paths, roles/locales, and deleted tests. Distinguish newly introduced code from pre-existing code made newly reachable.
- For shared entity/model changes, enumerate every writer, including unrelated login/profile updates, jobs and bulk SQL. For exception handlers trace a non-matching failure, zero rows and failed retries; ensure a failed write cannot trigger a success side effect. For every new API error code inspect both EN and AR dictionaries and its consumer.
- Browser acceptance is user-owned under [behavior-proof.md](../../gate/reference/behavior-proof.md). Carry the standing user choice, checklist and actual result/pending status into the review request. Do not require new browser automation for a browser-only fix.
- Before the first review, include required automated regression source in the frozen snapshot and attach its exact red/green commands/results; scratch-only tests cannot satisfy source-backed evidence. Manual browser acceptance stays separately attributed.
- Convert each relevant automated missed-bug CLASS/CATCH into a named executable regression with an observable assertion. Record the real failing command/result before a fix, then the passing result, in the task evidence. A logged warning or a test-name list alone does not close the class. An unrelated class gets a concrete non-applicability reason; do not add unrelated application tests.
- Missing required proof or an unresolved confirmed blocker means FAIL. Draft status and review fatigue do not convert it to PASS. Follow-up debt and accepted product choices do not automatically restart review.

## Collect actual completion

- Use the tool's returned task ID and real completion notification/result. An agent's task and a shell task can have different output formats: do not poll an empty file for an assumed `type: result` marker. No unrelated sleep jobs as completion timers. Read a delivered report promptly.
- Keep long-running output visible. Use short bounded status checks if a result is not yet available, and report meaningful progress at least once a minute. Do not rerun a task because its output has not yet been collected.
- Start development services in the background with a retained PID and a bounded readiness probe. A healthy server is supposed to keep running; do not wait for its normal process exit. Reuse the working runner's environment and content root.
- Stop only the process/service this task owns and restore any deliberately paused development service after all rework. Do not restart a shared-output watcher between build/test rounds.

## Evidence that can be reused

- Record command, cwd, native exit status, output/log path, source revision/diff and relevant inputs. Source, dependency, config, toolchain or test-data changes invalidate the checks they affect. Passing unrelated commands cannot clear a failed or pending check.
- Use focused checks while editing and the full relevant suite **exactly once** per task (user rule 2026-10-06; a suite that runs in well under a minute also runs once right after the first build, user rule 2026-10-26): after the last edit and commit, run through `gate/scripts/evidence.mjs` so that single run is also the push receipt — never a bare full run first and a receipt run second. An environment-only failure in that run is not a reason to repeat it: retire it at once with `CHECK RETIRED` naming the filtered rerun of only the failed tests, then run that exact command text (no `cd` prefix; matching is by command text — display tails such as `| grep`, `| head`, `| tee` and redirections such as `2>&1` are ignored since 2026-10-12, so only the verify command, its environment prefix and any setup/cleanup segments must match). A backend-only delta does not require unchanged frontend lint; a frontend-only delta does not require unchanged backend tests. Run the required affected proof after real changes.
- Batch purely mechanical cleanup before the final checks. Existing hooks conservatively classify edits by file path; they do not prove that a C#/TS edit is comment-only. If a hook requires a fresh check, satisfy the cheapest applicable check and disclose reused proof. Never disable it or claim an unimplemented semantic exemption.
- Confirm a typecheck actually covers source. For referenced TypeScript projects use the named application config or the repository build command; listing files is only a way to inspect coverage.
- Preserve the compiler/test process exit code. Prefer standalone commands with the tool's structured exit status. If output must be redirected, save the native exit before any display command; do not infer it from the last process in a pipeline.
- Use [command-evidence.md](../../gate/reference/command-evidence.md) for saved native
  exits, red/green matching and HTTP/state assertions. Separate setup/check/cleanup;
  never rerun stash/pop merely to match an old compound command in the hook.
- Use one build-output owner. Reuse compatible binaries for `--no-build` tests/probes only while relevant inputs and build options match. For .NET, use an isolated artifacts directory when compatible; if repository-path tests require in-tree output, pause the bind-mounted watcher for the entire verification window.
- Reuse a verified API runner with explicit API-project content root. Check effective non-secret configuration and readiness before treating runtime results as evidence. Silent/missing logs can mean wrong configuration, not buffering.

## Cheap discovery

- Search named source roots with `rg`; use `rg --files` to discover paths. Exclude dependencies/generated output and other worktrees before traversal, not with a filter after scanning them. Expand to additional named paths when needed.
- Read package scripts and the handoff's verified commands before inventing script names. Store useful project-specific commands in project memory, including working directory, output isolation and readiness/cleanup details; do not store tokens, credentials or ephemeral token values.
- Use UTF-8 message files for multiline commit/PR text (`git commit -F`, `gh ... --body-file`). Preserve the existing approval, integration-branch and no-merge rules.
