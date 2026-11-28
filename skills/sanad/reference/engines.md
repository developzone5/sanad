# Choose the task engine (user choice 2026-10-12)

## Ask once per new task

Before starting a new actionable task (implementation, review, workflow edit, docs work or standalone braintrust), ask **"Which engine for this task?"** Offer **the engine the user is currently chatting with first, marked Recommended**, then the other engine: Codex or Claude. Use the host's choice tool when available. The recommendation is not consent: wait for the reply before dependent work. Read-only orientation may continue. If the host cannot show a picker, ask the same short question in text.

An explicit `engine=codex`, `engine=claude`, or clear natural-language choice already answers the question. A bare "yes" accepts the explicitly offered current-engine default. Do not infer the engine from a model mentioned for comparison, a quoted prompt, the repo name or a previous unrelated task. If the host is unknown, offer both without inventing a default. Questions, explanations, status requests and corrections within an active task reuse its choice; they do not open another picker. A new task gets a new choice. Delegated children inherit their task's engine and never ask again or reroute the whole task.

Save `engine`, `host`, model/effort and the answered choice in the existing task record. Carry them through `/braintrust`, `/gate`, `/ship`, compaction, resumptions and handoffs. A requested mid-task switch preserves completed evidence and decisions; stop or collect owned work before switching, then resume only unfinished work. Never fall back to the other provider because of quota, timeout or missing tools. Report that condition and ask for the alternative.

## Role assignments

These assignments control all Sanad roles. Claude retains its existing setup. **Every Codex role uses `xhigh`, including routing, explanations, mechanical work and re-checks.** The braintrust `effort=` dial only sizes the panel; it never lowers Codex reasoning effort or adds seats just because runtime effort is xhigh.

| Role | Claude | Codex |
|---|---|---|
| Main executor | existing Claude session; Opus (newest) for behavior code | current Codex-family session / xhigh; a new launch runs on the default of `~/.codex/config.toml` |
| Boss / extra gap reviewer | `routing-boss`: Fable (newest) / xhigh | `sanad-boss`: Astra / xhigh |
| Pass A, risk files | `independent-reviewer`: Opus (newest) / xhigh | `sanad-risk-reviewer`: Astra / xhigh |
| Pass B, whole diff (Big; a Codex task only since 2026-11-28) | `routine-reviewer`: Sonnet (newest) / xhigh — no task round launches it; the reviewer test and the PC 2 `review` role still do | `sanad-reviewer`: Sol / xhigh |
| Re-check after a fix | `recheck-reviewer`: Sonnet (newest) / high | `sanad-reviewer`: Sol / xhigh |
| Second look (`siblings.mjs`) | `second-look`: Opus (newest) / high | `sanad-expert`: Astra / xhigh |
| Note check (`note-check.mjs`) | `note-checker`: Opus (newest) / high | `sanad-expert`: Astra / xhigh |
| Deep-risk expert (Architect, Skeptic, Database, Security, Authenticity, Client state, added domain) | `braintrust-expert`: Opus (newest) / xhigh | `sanad-expert`: Astra / xhigh |
| Practical expert (Pragmatist, Performance, Product, Test designer) | `braintrust-expert-sonnet`: Sonnet (newest) / high | `sanad-practical-expert`: Sol / xhigh |
| Mechanical worker / test-only items / narrow fact or evidence chore | `sonnet-worker`: Sonnet (newest) / medium | `sanad-worker`: Sol / xhigh |

The Codex column names a model family, never a version (2026-11-19): the exact model of each role is the `model` line of its `~/.codex/agents/<role>.toml`, and the default for a new session is the `model` line of `~/.codex/config.toml`. A new Codex model is an edit of those settings and nothing else.

Bosses, experts and reviewers are read-only and do not spawn children. A worker receives exact files/commands and returns its diff/evidence to the main executor; it never owns behavior changes or publishing. All existing scope, independence, two-pass review, security, verification and publishing controls still apply.

## Activate the real runtime

- **Claude host + Claude choice:** use the existing pinned `~/.claude/agents/*.md` types. Preserve Claude's medium routing/teaching and xhigh implementation effort. Verify the actual model in run metadata. Every Claude role names a family alias — `fable`, `opus`, `sonnet` — which always means the newest model of that family, here and on the remote (agent files, `orca-launch.sh`); no file names a Claude version (user rule 2026-11-10: "for all models to use latest model"). Codex has no such alias: its model names live only in `~/.codex/config.toml` and `~/.codex/agents/*.toml`. No rule file, script or launch command names a Codex version; a generated review launch reads its role's model from the role file when the plan is written.
- **Codex host + Codex choice:** use the pinned `~/.codex/agents/sanad-*.toml` roles where supported. If the available native spawn tool takes a model rather than an agent type, read that role file, pass its instructions, explicit `model` and `reasoning_effort: "xhigh"`, and use fresh context (`fork_turns: "none"`). Include the compact assignment/evidence pack, not the conversation. Do not rely on the selected model's default effort. Keep the actual agent ID and completion result. Read-only roles use a read-only sandbox when supported; otherwise their assignment forbids edits and state-changing commands, and the host permission boundary remains in force. Do not widen it.
- **Choice differs from the current host:** a prompt cannot change providers or turn Claude's native Agent tool into Codex. Hand off the whole task to the selected engine before implementation or delegation. Use a supported native handoff if available; otherwise prepare a small handoff file containing the verbatim ask, selected engine, workspace, current stage, approved decisions and evidence paths. Give the user the verified CLI launch command in the same workspace, with a prompt to read that file. New Codex launches use `codex -c 'model_reasoning_effort="xhigh"'` (no `-m`: the model is the default of `~/.codex/config.toml`); Claude launches use `claude`. Append the handoff prompt as one safely quoted argument. Do not spawn a hidden autonomous implementation session or leave two executors editing the same files. State that the handoff is pending until the chosen engine actually starts.

Config changes apply to new sessions/agents. They do not change a running parent. Verify the parent's runtime effort through the host's model/effort controls; if it is not xhigh, use a supported control or tell the user the exact required switch. Never claim a text label, skill frontmatter or a config edit changed the running model. An unavailable required model/effort is incomplete, not permission to silently downgrade.

The review launch plan follows the task's engine (2026-11-18): `review-brief.mjs --engine claude|codex` writes `launch.md` with the engine in its first lines (a Codex task's own reviewers are `codex exec` launches of the `sanad-*` roles, and Claude is the one other engine on a Big task, as a `claude -p --agent independent-reviewer` shell line); pass `--engine` on the first run, which saves it in `engine.txt` in the notes folder: later runs without the option keep it, and a different value is refused. `codex exec` has no option that loads a role file, so each Codex seat gets its role by name in the prompt, and its launch line passes `-m` with the model read from that role's `.toml` (2026-11-19); when the role file cannot be read the line passes no model and the plan says so. `orca-launch.sh --engine codex` is refused, because remote launches support Claude tasks only (its options go before the positional arguments).

Claude's native hooks do not run automatically in Codex. A Codex task follows the steps `sanad.mjs next` prints, and `sanad.mjs ready` is its check where no hook runs: every required item, done or not done, read from the saved records. Codex must explicitly preserve the same completed reviews, source-bound verification and approval; never fabricate a Claude tool event or receipt. Cross-provider review under a Claude executor is not this mode: hand off the complete task so its native review evidence stays consistent.
