---
name: braintrust
effort: xhigh
description: Convene independent specialists and a separate boss using the task's selected Claude or Codex engine. Use for a Sanad-selected panel or an explicit braintrust request. All Codex roles and panel advisors use xhigh; the deliberation dial selects seat count and risk coverage, not runtime effort.
argument-hint: "<question> [engine=claude|codex] [effort=low|medium|high|xhigh|max] [advisors=N]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /braintrust - shared workflow entrypoint

Canonical workflow: [braintrust/SKILL.md](~/.claude/skills/braintrust/SKILL.md).

Read that file in full before applying this skill. It is the single source of workflow instructions for Claude and Codex; this entrypoint deliberately contains no duplicate procedure. Resolve its relative references against its own directory, and load sibling workflow skills from ~/.claude/skills/.

If the canonical file or a required referenced resource cannot be read, report the exact missing path and stop the dependent stage. Do not silently use an older copy or invent a successful result.

Host adaptation: use the task engine selected under Sanad and the role/model/runtime rules in ~/.claude/skills/sanad/reference/engines.md. Reuse that choice through this stage; all Codex roles stay xhigh. Use only available native tools and collect actual completion with saved agent IDs. A different engine needs a real handoff, never a prompt-only provider switch. Claude hooks do not run automatically in Codex, so apply the same review, verification and approval requirements explicitly without claiming automatic enforcement. User instructions and repository rules retain their normal precedence.
