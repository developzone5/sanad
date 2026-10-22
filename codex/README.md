# Codex setup

Sanad uses one canonical workflow in `~/.claude/skills/`. The files in `codex/skills/` are Codex entrypoints that read those procedures. The six `codex/agents/sanad-*.toml` files define the Codex roles; every role pins xhigh.

The root `install.ps1` installs Claude resources only. It does not install Codex roles, edit Codex settings or connect these entrypoints.

## Prepare a release

For an existing setup, first copy the current files into an untouched base and a separate candidate. Preserve unrelated skills, agents and personal settings. For a new setup, include the canonical Claude resources in the candidate too; absent destination files have no entry in the base. Review the full candidate/base diff before installation.

| Bundle source | Candidate path | Installed destination |
|---|---|---|
| Root `CLAUDE.md`, `skills/`, `hooks/`, `agents/` and release script | `claude/<same relative path>` | `~/.claude/<same relative path>` |
| `codex/skills/` | `agents/skills/` | `~/.agents/skills/` |
| `codex/agents/sanad-*.toml` | `codex/agents/` | `~/.codex/agents/` |
| Selected settings from `config.example.toml` | Merge into `codex/config.toml` | `~/.codex/config.toml` |

`config.example.toml` is a minimal example, not a replacement for personal configuration. Merge its keys into the existing top-level and `[agents]` sections; do not create duplicate tables. Never publish a copied personal config. If Claude hook settings are included in a first setup, adapt their absolute paths for that machine.

Keep the current task's repository instructions. If Codex does not already enter Sanad, explicitly invoke the Sanad skill or add a pointer to the canonical workflow in the project's instructions; do not overwrite an existing `AGENTS.md`.

After the checks pass and the user approves, use the [versioned release installer](../scripts/workflow-install.sh). Use the bundled script path for a first installation, or the installed script for an update. Do not install by copying files over a live setup. The installer checks drift, backs up changed files and runs the suites. These relative wrappers assume the canonical resources live in `~/.claude`; a nondefault location needs corresponding reference changes in the candidate.

## Runtime and evidence

Follow [engines.md](../skills/sanad/reference/engines.md) for supported launch controls and role assignments. Confirm xhigh and the selected model in actual runtime metadata. If the host cannot activate a required role, report the gap; do not silently lower effort or change providers.

Claude hooks do not run automatically in Codex. Codex must collect real review results, verification evidence and publishing approval explicitly. Configuration changes apply to new sessions; editing a file does not switch the running parent.
