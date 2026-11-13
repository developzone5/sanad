# Boss chooses the implementation route

Use the saved task engine and role assignments in [engines.md](engines.md). The role names below are logical roles; launch their Claude or Codex counterpart.

Every request still enters Sanad. Teaching, explanations, lesson status, checking work without implementation, standalone review and documentation-only work remain direct; do not call the boss for those. Equivalent promotions and unchanged task continuations reuse their completed decisions and evidence.

**Self-route Small and Medium work.** The executor routes it without the boss and shows one `▸ size: ...` line (Sanad Reporting contract): `direct` for a text-only edit, `review` for a Small or Medium task (route rules below). Call the boss when the size check says Big, or when scope, risk or approach is uncertain. In doubt → boss. Self-routing changes who decides, not the proof: the six rules of [loop.md](loop.md) apply on every route.

**Size from facts.** Before the size line, run `node ~/.claude/skills/gate/scripts/size-check.mjs --repo <repo> --files <planned files, comma-separated>` and put its size and the stack line on the size line. The script maps what the change touches to tiny, small, medium or big by fixed rules: access rules, database schema or queries, money, files and URLs, concurrency, dependencies, the shared API contract, server and page code in one change, callers of changed functions, and the size of the change. Size up from the script freely; never down, except on the user's verbatim words. Then: tiny (text only) → `direct`; small → `review` as Small; medium → `review` as Medium, with the seats the script names; big → the boss routes (braintrust when the open questions need seats). `pre-review` runs it again on the real change: `SIZE GREW` (exit 1) adds what the larger size needs before review starts, and its callers list goes into every review brief.

**The places list comes with the size.** The size line carries the count from the places list (loop.md Step 1): `▸ size: small — <reason> · places: 6`. More than 10 places is never Small: size it Medium, or call the boss when the approach is unclear.

## The boss assessment (uncertain or sensitive work)

The executor gathers a compact factual packet once: original request, directly affected source and callers, intended behavior, known DB/security/shared-state boundaries, material uncertainty and existing valid evidence. Read enough to support routing; no full-repository scan, test run or panel solely to classify the request. Reuse this packet in later stages.

While the boss reads, start what every route needs anyway: the test-machine preflight, the ticket lines file and the places list (loop.md Step 1). They never wait for the route.

Launch one separate read-only Boss using the engine map (Claude `routing-boss`, Fable (newest) / xhigh; Codex `sanad-boss`, GPT-6 Astra / xhigh), verifying the model and effort in actual run metadata. The parent retains its engine's routing effort; do not change global effort. Use the existing host agent mechanism and preserve the returned agent/session ID. The boss may inspect targeted cited source or request one missing fact that changes routing. It does not implement, run a second audit or spawn specialists during this assessment. A named material unknown is a reason for the braintrust route, not an unbounded discovery loop. Missing requested behavior still needs user clarification.

Return at most four short lines:

`ROUTE: direct | review | braintrust — reason and supporting source`
`CHECKS: required proof and reviewer risk: routine | sensitive (or not applicable)`
`PANEL: none | risk dial + required expert roles`
`OPEN: none | named uncertainty`

## Route rules

- **direct:** a bounded cosmetic or mechanical edit with no application behavior, access, data or shared-contract change. Implement — or delegate the named files and exact change to the selected engine's mechanical worker and read its whole diff as your own — self-review the diff and perform relevant visual/static checks. No panel is needed for implementation. Existing user-owned browser acceptance applies. Before publishing any code or configuration, collect one completed independent review (the Sanad Step 3.5 reviewer) and source-bound verification through the evidence helper, then apply the gate and approval rules. Only ordinary documentation-only diffs can omit code review; cosmetic or mechanical wording cannot waive it. Mark genuinely irrelevant checks not applicable rather than building everything.
- **review:** a Small or Medium task: an understood, reversible behavior fix or addition, with a proven local cause and approach and no big signal. Write the lines file, the places list and the check lines; implement; prove each new test red on the old code; run the one fresh-eyes review of Step 3.5 and the evidence gate. No specialist panel, except one Database optimizer seat before coding when a query's shape changes (loop.md Step 2). Reuse completed checks.
- **braintrust:** complex or substantial scope, unresolved design/cause uncertainty, or material auth/tenant/session, DB migration/transaction/locking/concurrency, money, file/URL trust-boundary, dependency, infrastructure, shared-contract or data-loss risk. Convene the panel under braintrust's seat rules (experts chosen for the open questions; Database and Security sit when their domain is touched), then implement, review and gate. Specialists run at xhigh: deep-risk and practical seats on the selected engine's assigned models (braintrust owns the seat split). Sensitive or unresolved cross-component implementation gets the Step 3.5 review at `sensitive` risk; non-sensitive design complexity alone may stay `routine`. Extra implementation boss-model review still requires a named gap under Sanad Step 3.5. A query-shape change on its own (a new, split or merged query, a changed aggregate) is not a braintrust trigger: it takes the `review` route with the one Database seat (loop.md Step 2).

Route from impact and uncertainty, not diff length or the words bug, frontend or simple. A one-line authorization change requires braintrust. Explicit requests for braintrust always convene it. Preserve approval requirements for dependencies, destructive operations and publishing on every route. An unavailable boss is an incomplete routing step: report it, do independent read-only work where useful, and do not fabricate a decision or silently substitute another model.

## Reuse the boss and evidence

Save the route, reason, checks, source identity and boss ID in the existing task record. Show one plain `▸ size: ...` line per the Sanad Reporting contract. The boss does not need to approve each edit, test or continuation. On the braintrust route, the executor launches the selected specialists once, then resumes this same boss with their reports and the original assessment for the final design verdict. Its later report review is required; its initial route is not a substitute. If resumption is unavailable, preserve and hand the saved assessment to one replacement and disclose that fact, without repeating completed work.

If later evidence reveals a sensitive boundary or invalidates scope/approach, pause dependent edits and ask the same boss to reassess that changed fact; preserve unaffected work. No repeated routing for unchanged requests. Independent implementation review remains independent of the design boss. Skill improvements from boss feedback stay after PR opening and task handoff under braintrust/reference/expert-learning.md.

Routing examples for checking the instructions (not live execution evidence): spacing/color adjustment -> direct (self-routed); proven local click-handler wiring bug without a trust-boundary change -> review (self-routed); tenant check change or database migration -> braintrust/deep review; new multi-step flow with unsettled design -> braintrust; explain a component -> direct explanation without boss; unchanged continuation -> reuse its saved route and boss.
