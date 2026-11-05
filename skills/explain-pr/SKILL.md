---
name: explain-pr
description: Explain a whole pull request (or the current branch) so anyone can understand it — one easy lesson page per feature or fix, in a teacher's order — a short 3D animation of one example travelling through the app (page → API → service → database) and changing at the exact station the PR touches, then the problem (with a small picture of the screen), why it happened, the fix, the code with a plain meaning beside each line, a table of cases before and after, and the test that proves it. Arabic by default, English one click away. Opens locally in the browser; a private claude.ai link only on request. Or, in chat mode, teaches the PR step by step in the chat — one layer per message (page → API → service → database → test), the real lines and plain words for each, waiting for "next". Use when the user types /explain-pr, or asks to explain, present, teach, learn or walk someone through a PR or branch.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /explain-pr — a whole PR as easy lessons

**Usage:** `/explain-pr <PR number>` · `/explain-pr` (current branch against the integration branch) · `/explain-pr <PR number> chat` (learn it step by step in the chat, see "Learn in the chat")

Read-only: never edits code, never comments on the PR, never pushes. The page is one local HTML file (three.js r159 is inlined from `vendor/`, MIT), so it works offline. It opens in **Arabic** (right to left); the button at the top switches to English and is remembered.

**Short, clear, the core first.** Each feature or fix is ONE short page: the sentence to remember → the core (the 3D path with the lab under it: change the values, see the old and new result) → the story in three lines (problem, cause, fix) with the screen before and after → **follow the code**: the request's path through the code, page → API → service → database → test, one step per layer with its real file and lines and a meaning beside each important line (a station in the 3D path opens its step) → one line of proof → one quiz question. Plain words first, code second. Short sentences, no jargon without a meaning.

**Learn the code by following it (user ask 2026-11-05: "page to api to service … i want to learn the code by this").** The walk is the main way a reader learns the code, so every lesson whose request passes through more than one layer gets one.

## 1. Get the whole change

- **PR number:** `gh pr view <n> --json number,title,author,headRefName,baseRefName,body,commits,files,mergeCommit`, `gh pr diff <n>`, and `gh pr checks <n>`. The full file list is `gh pr view <n> --json files --jq '.files[].path'`. Read code at the PR head (or its merge commit once merged: `git show <oid>:<path>`) so line numbers match.
- **No number:** the integration branch is `git config sanad.integration`, else the first of `staging` → `develop` → `dev` → `main` on `origin`. Files = `git diff --name-only origin/<base>...HEAD`, plus `git diff --name-only HEAD` and `git ls-files --others --exclude-standard` when the tree is dirty. If the branch changes while you read it, say so and stop — explain a stable PR instead.

## 2. One lesson per feature or fix

- `kind` = `feature`, `fix` or `cleanup`. Read commits, the PR body and the diff, then open the code. Every line number, name and value comes from code opened in this session.
- Tests, i18n, styles and type mirrors join the lesson they serve. A file may belong to several lessons. A file that fits nowhere is its own `cleanup` lesson — never drop one.

## 3. Write each lesson

- `name` (≤ 5 words) and `short` `{ before, after }` (a few words each, for the overview cards).
- `takeaway` (recommended) — the ONE sentence to remember, shown first ("Published + Close At passed = Closed everywhere").
- `problem` — what the user saw go wrong, as they would say it. `cause` — why, in plain words (the real root cause in the code). `idea` — what the fix does, as one rule a person can remember.
- `mock` (optional, recommended) — a small picture of the screen: `before` / `after` each `{ title, rows: [{ text, badge?, tone? }] }` (tone `good` | `bad` | `warn` | `neutral`). Use the product's real labels.
- `journey` (optional, recommended when a value travels through layers) — 2–5 `stations` `{ layer: frontend|api|service|database|test|other, label }` in the order the request runs, `changeAt` = index of the station the PR changes, `item` = the example (e.g. "Math Quiz"), `before` / `after` = `{ badge, tone, why }` the item carries; `why` (≤ 8 words) is the check that station makes, phrased so it is true for every case ("Has Close At passed?"), shown in a bubble while the card waits there. When the lesson also has `cases`, each case becomes a button under the 3D view that sends those values through. Skip the journey when nothing travels (a text-only change).
- `walk` (recommended; required in spirit whenever the request passes through more than one layer) — 2–7 steps in the order the request really runs, usually page → API → service → database → test: `{ layer, label, file, line, does, passes?, changed?, lines }`. `layer` as in the journey (a station opens the first step of its layer); `label` ≤ 3 words; `does` (≤ 18 words) = what this layer does with the lesson's example, in plain words; `passes` (≤ 10 words, optional) = what it hands to the next step (a value, a DTO, a row); `changed: true` on every step the PR changes (at least one). `lines` (1–12) uses the `code` line format with at least one note. A changed step shows the `+`/`-` lines; an unchanged step shows the few real lines the request passes through (the call, the route, the query), read from the code at the PR head, so the reader sees the whole path. Follow the real calls: open each file in this session and quote the lines the request actually runs, never a made-up path. With a walk, `code` is optional (0–3 extra snippets, shown folded under the walk).
- `code` — 1–3 snippets `{ file, line, title?, lines }` (0–3 when the lesson has a `walk`). `line` is the first line number (new file). Each entry of `lines` is a code string (`+` added, `-` removed, space unchanged) or `{ "c": "<code>", "note": { ar, en } }`. Explain the lines that matter — at least one note per snippet; ≤ 16 lines; show only what is needed.
- `lab` (recommended whenever the change is a rule) — a small copy of the changed rule the reader can play with; it sits under the 3D view and sends its values through it. `inputs` (1–4): `{ id, label, type: choice|time|number, options? [{ value, label }], allowEmpty? (time), min/max/step? (number) }`. `old` and `new`: `{ rules: [{ when: [{ a, op, b }], then }], default }` — first matching rule wins; `op` is `eq ne lt le gt ge empty set` (a choice compares only with `eq`/`ne`); `b` is another input's id or a value; `then`/`default` is text or `{ "input": id }` (that input's value). `presets` (1–6): `{ values: { id: value } }` — the case the fix is about, a case that did not change, an edge case ("" = no value). The renderer runs the rules on every preset and refuses a lab where no preset changes. Copy the rule faithfully from the code; the page labels it a simplified copy.
- `cases` (only when a lab cannot express it) — `{ inputs, rows: [{ values, old: { text, ok }, now: { text, ok } }] }`: shown as presets under the 3D view, or as a small table when there is no 3D view.
- `quiz` (recommended) — one question that checks the lesson landed: `{ q, options: [{ text, correct }], explain }`, 2–4 options, exactly one correct. Ask about a case the reader can now predict, not a fact to recall.
- `test` — `{ name, result, given, when, then, file }` in plain words. `pass` only for a test run in this session or covered by a CI check read now (`gh pr checks <n>` — confirm what that job runs); otherwise `not run`.

## 4. The story JSON

Write it to the session scratchpad (fallback: the OS temp folder), never into the repo. Shape: [story.example.json](story.example.json). Top level: `title`, `summary`, `pr`, `source`, `defaultLang` (`ar` unless the user asks for English first), `files` (the full list from step 1), `chapters` (the lessons), `proof` (CI checks), `risks`, `notDone`.

- **Two languages, always.** Every sentence is `{ "ar": "…", "en": "…" }`. Short values (a cell, a badge, a station label, a var) are one string when they read the same in both (a time, a number, code) and `{ ar, en }` when they are words. Code, file names and symbols are never translated.
- Arabic: simple Modern Standard Arabic, short sentences; use the product's own Arabic labels (read its Arabic i18n file, e.g. منشور / مغلق / منتهي); keep code names in Latin letters.
- Limits (enforced, per language): title 9 words · summary 24 · lesson name 5 · short 6 · problem / cause / idea 26 · line note 16 · case cell 5 · badge 3 · station label 3 · walk step label 3 · walk `does` 18 · walk `passes` 10 · test fields 14 · risk / not-done 12, at most 3 of each.
- Never copy a secret, token, password, connection string or personal data into `code`, a note or a case; replace the value with `***`.

## 5. Render, open and self-check

```bash
node ~/.claude/skills/explain-pr/render.mjs "<story.json>"
node ~/.claude/skills/explain-pr/check.mjs "<printed page path>"
```

`render.mjs` checks the story — every problem is printed (a file no lesson explains, a sentence missing a language, a snippet with no explained line, a text over its limit); fix the JSON and rerun. It writes `<temp>/explain-pr/<pr>-<time>.html`, prints the path and opens the browser (`--no-open` skips it; `--out <dir>` picks the folder). `check.mjs` clicks through every page in headless Chrome (with software WebGL, so the 3D runs), in both languages, at laptop and phone size, presses a case button and a quiz answer on each lesson, and fails on a script error, a dead or covered click, a quiz with no feedback, a language switch that does not stick, or a page wider than the screen. Report its line as printed; if it says NOT RUN, say so.

## 6. A claude.ai link — only when asked

The local page is the default. When the user asks for a link: say once that the page holds PR code and goes to claude.ai as a **private** page that only they can open until they share it, then publish the rendered file with the Artifact tool (load the `artifact-design` skill first, as that tool requires; icon `code`). Give the link. Never publish without the ask.

## Learn in the chat — step by step, one layer per message

Use this instead of the page when the user asks to learn or understand a PR in the chat, "step by step", or types `/explain-pr <n> chat` (user ask 2026-11-05: "no need for image, lets make it step as learning and talking for each one, in the chat"). No page, no screenshots, no images: the chat is the lesson.

1. Read the whole change and split it into lessons exactly as in steps 1–2. Then build each lesson's walk as in step 3 (`walk`): the real path the request runs, page → API → service → database → test, with every file opened in this session at the PR head, the changed steps and the unchanged ones the request passes through. Never invent a path or a line.
2. Start with one line: how many lessons, and the steps of the first one (`Lesson 1 of 2 — Page → API → Service → Database → Test`).
3. **One message per step, then stop and wait for the user.** Each step message, in the user's reply rules (short sentences, plain words, no tables):
   - `Step n of N — <Layer>: <label>` and `Where: <file>:<line>`.
   - One sentence: what this layer does with the lesson's example.
   - The real lines in a code block (at most 12; `+` / `-` on changed lines).
   - At most 3 short points: what to notice in these lines; why this layer exists; on a changed step, what was wrong before and what the new line does.
   - `Passes on:` what this step hands to the next one.
   - The last line: `Say "next" for step n+1 (<label>).` On the changed step, ask one quick question about it first.
4. After a lesson's last step: the one sentence to remember, then one quiz question (as in step 3 `quiz`); wait, then say right or wrong and why in one line.
5. A question in between is answered at once, in the same shape, then the walk goes on from the same step. "skip" moves to the next lesson; "page" renders the page for the same PR.
6. Write in the chat's language (English unless the user writes in Arabic). The same safety rule applies: no secret, token, password, connection string or personal data in a code block.

## 7. Reply

One line: what the page explains (how many features and fixes, how many files), its path or link, and the self-check line. Name any fact you could not confirm (for example "frontend tests not run"). Do not repeat the page in chat.
