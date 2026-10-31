# Choose the task engine (user choice 2026-10-12)

## Ask once per new task

Before starting a new actionable task (implementation, review, workflow edit, docs work or standalone braintrust), ask **"Which engine for this task?"** Offer **the engine the user is currently chatting with first, marked Recommended**, then the other engine: Codex or Claude. Use the host's choice tool when available. The recommendation is not consent: wait for the reply before dependent work. Read-only orientation may continue. If the host cannot show a picker, ask the same short question in text.

An explicit `engine=codex`, `engine=claude`, or clear natural-language choice already answers the question. A bare "yes" accepts the explicitly offered current-engine default. Do not infer the engine from a model mentioned for comparison, a quoted prompt, the repo name or a previous unrelated task. If the host is unknown, offer both without inventing a default. Questions, explanations, status requests and corrections within an active task reuse its choice; they do not open another picker. A new task gets a new choice. Delegated children inherit their task's engine and never ask again or reroute the whole task.

Save `engine`, `host`, model/effort and the answered choice in the existing task record. Carry them through `/braintrust`, `/gate`, `/ship`, compaction, resumptions and handoffs. A requested mid-task switch preserves completed evidence and decisions; stop or collect owned work before switching, then resume only unfinished work. Never fall back to the other provider because of quota, timeout or missing tools. Report that condition and ask for the alternative.

## Role assignments

These assignments control all Sanad roles. Claude retains its existing setup. **Every Codex role uses `xhigh`, including routing, explanations, mechanical work and re-checks.** The braintrust `effort=` dial only sizes the panel; it never lowers Codex reasoning effort or adds seats just because runtime effort is xhigh.

| Role | Claude | Codex |
|---|---|---|
| Main executor | existing Claude session; Opus 5.5 for behavior code | current Codex-family session / xhigh; GPT-6.1 Sol for a new launch |
| Boss / extra gap reviewer | `routing-boss`: Fable 5.1 / xhigh | `sanad-boss`: `gpt-6-astra` / xhigh |
| Pass A, risk files | `independent-reviewer`: Opus 5.5 / xhigh | `sanad-risk-reviewer`: `gpt-6-astra` / xhigh |
| Pass B, whole diff and re-check | `routine-reviewer`: Sonnet 5.5 / xhigh | `sanad-reviewer`: `gpt-6.1-sol` / xhigh |
| Deep-risk expert (Architect, Skeptic, Database, Security, Authenticity, added domain) | `braintrust-expert`: Opus 5.5 / xhigh | `sanad-expert`: `gpt-6-astra` / xhigh |
| Practical expert (Pragmatist, Performance, Product) | `braintrust-expert-sonnet`: Sonnet 5.5 / xhigh | `sanad-practical-expert`: `gpt-6.1-sol` / xhigh |
| Mechanical worker / test-only items / narrow fact or evidence chore | `sonnet-worker`: Sonnet 5.5 / medium | `sanad-worker`: `gpt-6-luna` / xhigh |

Bosses, experts and reviewers are read-only and do not spawn children. A worker receives exact files/commands and returns its diff/evidence to the main executor; it never owns behavior changes or publishing. All existing scope, independence, two-pass review, security, verification and publishing controls still apply.

## Activate the real runtime

- **Claude host + Claude choice:** use the existing pinned `~/.claude/agents/*.md` types. Preserve Claude's medium routing/teaching and xhigh implementation effort. Verify the actual model in run metadata. If an alias resolves to another version, use the requested explicit ID (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`).
- **Codex host + Codex choice:** use the pinned `~/.codex/agents/sanad-*.toml` roles where supported. If the available native spawn tool takes a model rather than an agent type, read that role file, pass its instructions, explicit `model` and `reasoning_effort: "xhigh"`, and use fresh context (`fork_turns: "none"`). Include the compact assignment/evidence pack, not the conversation. Do not rely on the selected model's default effort. Keep the actual agent ID and completion result. Read-only roles use a read-only sandbox when supported; otherwise their assignment forbids edits and state-changing commands, and the host permission boundary remains in force. Do not widen it.
- **Choice differs from the current host:** a prompt cannot change providers or turn Claude's native Agent tool into Codex. Hand off the whole task to the selected engine before implementation or delegation. Use a supported native handoff if available; otherwise prepare a small handoff file containing the verbatim ask, selected engine, workspace, current stage, approved decisions and evidence paths. Give the user the verified CLI launch command in the same workspace, with a prompt to read that file. New Codex launches use `codex -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"'`; Claude launches use `claude`. Append the handoff prompt as one safely quoted argument. Do not spawn a hidden autonomous implementation session or leave two executors editing the same files. State that the handoff is pending until the chosen engine actually starts.

Config changes apply to new sessions/agents. They do not change a running parent. Verify the parent's runtime effort through the host's model/effort controls; if it is not xhigh, use a supported control or tell the user the exact required switch. Never claim a text label, skill frontmatter or a config edit changed the running model. An unavailable required model/effort is incomplete, not permission to silently downgrade.

Claude's native hooks do not run automatically in Codex. Codex must explicitly preserve the same completed reviews, source-bound verification and approval; never fabricate a Claude tool event or receipt. Cross-provider review under a Claude executor is not this mode: hand off the complete task so its native review evidence stays consistent.
