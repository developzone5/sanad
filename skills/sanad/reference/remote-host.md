# Work on another PC (remote Orca host)

Read before the first command that runs on another machine through Orca (`--environment <name>`) or SSH. The session that talks to the user stays the watcher and approver; the remote host runs builds, tests, containers and agents. Per-machine facts (paths, accounts, ports, signed-in tools) live in the project's `memory/`, not here.

## Split every round into parallel parts (user rule 2026-10-28)

The remote host is there to work in parallel, not in sequence. Every build or fix round with more than one item is split by files into up to 4 parts, one helper each, every helper in its own worktree (keep spare worktrees with dependencies installed, so a part starts at once). Give each part its own brief that names its items and the files it must not touch, and its own build output folder. Items that share a file go in the same part. When all parts report, join them in one merge, run the final checks once on the joined tree, then one re-check of the changed lines. Reviews in a round also start together (loop.md Step 3.5). A single helper doing a whole list one item after another is the exception, named with its reason.

Each part follows loop.md's **Fast test loop** (Step 3) and is re-checked as soon as it reports (**Review finished parts early**, Step 3.5), in its own worktree.

## Start agents only through the launcher

`bash ~/.claude/scripts/remote/orca-launch.sh --role <role> <environment> <remote-worktree> <remote-brief> ["one-line note"]`

- Every launch names its role, so the remote uses the same models as Sanad here (user rule 2026-10-29): `code` and `risk-review` (Pass A, fresh-eyes) → Opus 5.5; `review` (Pass B), `recheck` (changed lines after a fix) and `chore` (tests, logs, test data, design comparison) → Sonnet 5.5; `judge` → Fable 5.1. All at xhigh. The launcher checks the terminal banner and prints `MODEL MISMATCH` when the model is wrong.
- If SSH cannot connect, the launcher checks the brief through Orca instead.

- Write the brief as a file first and copy it to the remote (`scp`); the prompt only points at it. Write every brief with the file tool, one file per brief, never with a shell heredoc, `printf` or `sed` loop: Windows paths mixed with shell variables get mangled (`\U`, `\r`, `\E`, a literal `$wt`). Before copying, check each brief's path lines by eye. The launcher refuses `$` and backticks: a shell variable in a prompt arrives literally and the agent stops to ask which file was meant.
- The launcher starts the prompt with the engine line (`Engine: Claude (already chosen; do not ask).`), so a remote Sanad never opens its engine picker, and ends it with `Do not push.`
- It reads the new terminal back and prints `LAUNCHED`, `STUCK` (the agent is showing a question) or `NOT SEEN` (prompt not echoed yet). Never assume a launch worked; never loop launches in one command.
- Typing into a remote agent terminal may be blocked. A stuck agent is closed (`orca terminal close --environment <env> --terminal <handle>`) and relaunched with a fixed brief.

## Wait only through the waiter

`bash ~/.claude/scripts/remote/wait-files.sh <ssh-host> <remote-file> [<remote-file> ...]` in the background. It prints `READY` only when every file exists, reports a lost connection without giving up, and stops with `TIMEOUT` after `WAIT_MAX_SECONDS` (default 10800). Do not hand-write `if exist … & exit` one-liners: cmd folds the `&` into the `if` and the wait ends at once.

## Builds and containers on the remote

- A host build must never write into a tree that a container bind-mounts: send build and test output outside it (for .NET, `--artifacts-path <outside folder>`). Before starting the stack, check the project's build folders for host paths and remove them if found.
- Containers start with images already on the machine (`compose up -d --no-build --pull never`); an SSH session often cannot reach the desktop credential store to pull or build.
- After a remote reboot, the container engine and Orca may be off, and every remote agent is gone. A desktop app cannot be started from SSH: ask the user for that one click. Then check `git status`, `git log` and the handoff reports before relaunching anything; work is resumed from commits, not from memory.
- Copied environment files keep the other machine's paths; fix them per machine before the first start.

## Moving code and publishing

- If git over SSH to the remote fails, move commits with `git bundle create <file> <base>..<branch>` (always name the branch), copy it, `git bundle verify`, then fetch it into a named ref. Compare the fetched tree id with the one the remote tested before reusing its evidence.
- Pushing stays the user's yes after the ship brief, on whichever machine has the credentials.

## Accounts and models

- A remote Claude may sign in through an environment token that overrides its stored login; usage then lands on the token's account. Check with `claude auth status --text` on the remote; never print a token.
- Confirm the model and effort from the remote terminal's banner after launch; a remote default is not proof.
- A tool signed in only on this machine (for example Codex) runs here: fetch the remote's commits as a bundle into a local worktree first, and write its brief with this machine's paths. Its report is copied to the remote handoff folder when remote agents need it.

## Reporting to the user

One short line per remote step (started, done, stuck, lost). A remote failure is reported with its real output and the next step; the user is asked only for what cannot be done remotely (a desktop click, a sign-in, a push).
