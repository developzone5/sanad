# Boss chooses the implementation route

Every request still enters Sanad. Teaching, explanations, lesson status, checking work without implementation, standalone review and documentation-only work remain direct; do not call the boss for those. Equivalent promotions and unchanged task continuations reuse their completed decisions and evidence.

**Self-route clearly bounded work (user choice 2026-09-28).** The executor routes it without the boss and shows one `▸ route: direct|review — reason` line: `direct` for a cosmetic or mechanical edit, `review` for a small understood behavior fix (both per the route rules below). Call the boss only when scope, risk or approach is uncertain, or when the change touches any sensitive boundary listed under `braintrust`. In doubt → boss. Self-routing changes who decides, not the proof: tests, the independent review and the gate still apply.

## The boss assessment (uncertain or sensitive work)

The executor gathers a compact factual packet once: original request, directly affected source and callers, intended behavior, known DB/security/shared-state boundaries, material uncertainty and existing valid evidence. Read enough to support routing; no full-repository scan, test run or panel solely to classify the request. Reuse this packet in later stages.

Launch one separate read-only Boss with `subagent_type: "routing-boss"` (`~/.claude/agents/routing-boss.md` pins Fable 5.1 at xhigh; the Agent tool cannot set effort per call), verifying the model in actual run metadata. The parent remains at Sanad's routing effort; do not change global effort. Use the existing host agent mechanism and preserve the returned agent/session ID. The boss may inspect targeted cited source or request one missing fact that changes routing. It does not implement, run a second audit or spawn specialists during this assessment. A named material unknown is a reason for the braintrust route, not an unbounded discovery loop. Missing requested behavior still needs user clarification.

Return at most four short lines:

`ROUTE: direct | review | braintrust — reason and supporting source`
`CHECKS: required proof and reviewer risk: routine | sensitive (or not applicable)`
`PANEL: none | risk dial + required expert roles`
`OPEN: none | named uncertainty`

## Route rules

- **direct:** a bounded cosmetic or mechanical edit with no application behavior, access, data or shared-contract change. Implement — or delegate the named files and exact change to the `sonnet-worker` agent (Sonnet 5.5) and read its whole diff as your own — self-review the diff and perform relevant visual/static checks. No panel is needed for implementation. Existing user-owned browser acceptance applies. Before publishing any code or configuration, collect one completed independent review (the Sanad Step 3.5 Claude reviewer) and source-bound verification through the evidence helper, then apply the gate and approval rules. Only ordinary documentation-only diffs can omit code review; cosmetic or mechanical wording cannot waive it. Mark genuinely irrelevant checks not applicable rather than building everything.
- **review:** a small, understood, reversible behavior fix or addition, with a proven local cause/approach, limited callers and no sensitive boundary or material design uncertainty. Record the approach, Done means and affected paths; implement, prove the behavior (red-before-green for bugs), run one routine Step 3.5 Claude review and the evidence gate. No specialist panel. Reuse completed checks.
- **braintrust:** complex or substantial scope, unresolved design/cause uncertainty, or material auth/tenant/session, DB/query/migration/concurrency, money, file/URL trust-boundary, dependency, infrastructure, shared-contract or data-loss risk. Convene the panel under braintrust's seat rules (experts chosen for the open questions; Database and Security sit when their domain is touched), then implement, review and gate. Specialists run at xhigh: deep-risk seats on Opus 5.5, practical seats (Pragmatist, Performance, Product advocate) on Sonnet 5.5 (braintrust owns the seat split). Sensitive or unresolved cross-component implementation gets the Step 3.5 Claude review at `sensitive` risk; non-sensitive design complexity alone may stay `routine`. Extra implementation Fable review still requires a named gap under Sanad Step 3.5.

Route from impact and uncertainty, not diff length or the words bug, frontend or simple. A one-line authorization change requires braintrust. Explicit requests for braintrust always convene it. Preserve approval requirements for dependencies, destructive operations and publishing on every route. An unavailable boss is an incomplete routing step: report it, do independent read-only work where useful, and do not fabricate a decision or silently substitute another model.

## Reuse the boss and evidence

Save the route, reason, checks, source identity and boss ID in the existing task record. Show one concise `▸ route: ...` line. The boss does not need to approve each edit, test or continuation. On the braintrust route, the executor launches the selected specialists once, then resumes this same boss with their reports and the original assessment for the final design verdict. Its later report review is required; its initial route is not a substitute. If resumption is unavailable, preserve and hand the saved assessment to one replacement and disclose that fact, without repeating completed work.

If later evidence reveals a sensitive boundary or invalidates scope/approach, pause dependent edits and ask the same boss to reassess that changed fact; preserve unaffected work. No repeated routing for unchanged requests. Independent implementation review remains independent of the design boss. Skill improvements from boss feedback stay after PR opening and task handoff under braintrust/reference/expert-learning.md.

Routing examples for checking the instructions (not live execution evidence): spacing/color adjustment -> direct (self-routed); proven local click-handler wiring bug without a trust-boundary change -> review (self-routed); tenant check change or database migration -> braintrust/deep review; new multi-step flow with unsettled design -> braintrust; explain a component -> direct explanation without boss; unchanged continuation -> reuse its saved route and boss.
