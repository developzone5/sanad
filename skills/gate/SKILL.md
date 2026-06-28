---
name: gate
description: Run your Definition-of-Done and security gate against the current change, now, with real quoted command output. Use when the user types /gate, asks to "run the gate", "prove it works", or "verify before I ship", or before declaring a task done.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /gate — run the Definition of Done now

Execute the **"⛔ Definition of Done"** and **"🔒 Security gate"** sections of CLAUDE.md against the change you just made — rigorously, end to end, right now. Don't restate the checklist here; run the one in CLAUDE.md.

What makes this a gate and not a glance:

- **Real proof or no claim.** Every "builds / tests pass / works" line is backed by the actual command and its output **quoted in your reply**. No output = no claim — say "not run yet", never predict a pass.
- **No silent skips.** Run every step; name any you skip and why.
- **Bug fix → red before green.** Failing test first (quote expected vs actual), then fix to green, keep it as the regression guard.
- **Proof by change type:** endpoint → request + status + body + one negative case (401/403/404); query → generated SQL + row counts before/after; UI → rendered output per locale; job/migration → log lines start→finish + affected rows.

End with: what passed (with proof), what you skipped and why, what's still risky.
