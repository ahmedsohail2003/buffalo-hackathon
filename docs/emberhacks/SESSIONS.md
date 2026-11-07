# Session kickoff prompts

Open each builder as a new Claude Code session in the folder named. Paste the prompt verbatim.
Model: Fable. Effort as noted. The checker (this planning session, highest effort) runs only at the
four gates: 13:50, 14:40, 15:05, 15:30.

---

## Session A — Track A (arm, scene, App wiring, then docs)

Folder: `C:\Users\sohai\Documents\EmberHacks Hackathon\cell`
Effort: high for A1–A3, medium for A4–A7.

```
You are the Track A builder for a hackathon project with a hard deadline today at 4:00 PM EDT (build freeze 3:30 PM).
Read PLAN.md fully first: §1 (architecture), §2 (gates), §3 Track A steps A1–A7, §4 (fallbacks), §8 (protocol).
Then read PROGRESS.md. Step A0 is already done (commit 0 exists).

Execute A1 → A7 strictly in order. Do not start a step before the previous step's "done when" is green.
After every step: append your PROGRESS.md row with the exact command you ran and its observed output,
run `npx tsc --noEmit` and `npx vitest run`, then `git add -A` and show `git diff --cached --stat` and wait for my "yes" before committing.
If I don't answer, keep building; batch the commit at the next gate.

You own ONLY: src/arm/*, src/cell/*, src/app/*, src/components/{CellScene,CellPane,TelemetryStrip}.tsx, src/App.tsx, src/styles.css.
At the end (A7) you also do Track C's C1 and C2 (strings relabel, README sections, docs/SUBMISSION.md) since there is no separate C session.
Never read .env.local. Never print the API key. Never add attribution trailers to commits.
If a step runs 15 minutes over its box, take the fallback in §4, log it under "Fallbacks" in PROGRESS.md, and move on.
Report problems to me in one line as they happen; do not stop to ask unless the plan is genuinely ambiguous.
Start with A1 now.
```

---

## Session B — Track B (Gemini: smoke, clients, ER loop, Live voice, console)

Folder: `C:\Users\sohai\Documents\EmberHacks Hackathon\cell-b`  (git worktree on branch track-b; created by A0)
Effort: high for B0, B3, B5; medium for B1, B2, B4, B6, B7.

Before starting: copy the key file so the worktree has it.
```
Copy-Item "C:\Users\sohai\Documents\EmberHacks Hackathon\cell\.env.local" "C:\Users\sohai\Documents\EmberHacks Hackathon\cell-b\.env.local"
```

```
You are the Track B builder for a hackathon project with a hard deadline today at 4:00 PM EDT (build freeze 3:30 PM).
Read PLAN.md fully first: §1.6, §1.7, §1.8 (Live session, ER loop, on-screen trace), §2 (gates), §3 Track B steps B0–B7, §4 (fallbacks), §8 (protocol).
Then read PROGRESS.md.

Dependencies are already installed and the key is in .env.local. The checker already ran the first smoke pass; its results are in
PROGRESS.md "Smoke (B0)" (Flash PASS, ER-2 PASS, ER-1.6 gone, Live AUDIO-only PASS incl. tool calls and [CELL EVENT]).
See scripts/live_audio_smoke.mjs for the working Live pattern. B0 for you = only the remaining measurements listed under
"STILL TO MEASURE": responseJsonSchema on/off, function-response shape A/B, plan latency HIGH vs MEDIUM, browser Live.
Complete the DECISION line before writing any client code.
PROGRESS.md is single-sourced at C:\Users\sohai\Documents\EmberHacks Hackathon\cell\PROGRESS.md — append your rows THERE
(not to the copy in cell-b), so Track A and the checker see them.
After every step: append your PROGRESS.md row with the exact command and observed output, run `npx tsc --noEmit` and
`npx vitest run`, then `git add -A` and show `git diff --cached --stat` and wait for my "yes" before committing.
If I don't answer, keep building; batch the commit at the next gate.

You own ONLY: src/gemini/*, src/telemetry/*, src/dev/*, the 3-line guard in src/main.tsx, src/components/{CoworkerPane,EgressBadge}.*, scripts/*.
Your dev server runs on port 5174: `npm run dev -- --port 5174`.
Read the key from .env.local only inside scripts/smoke.mjs and via import.meta.env in the app. Never print it, never commit it.
Never add attribution trailers to commits.
If a step runs 15 minutes over its box, take the fallback in §4, log it under "Fallbacks" in PROGRESS.md, and move on.
Report problems to me in one line as they happen.
Start with `npm ci` and B0 now.
```

---

## Checker session (this planning session, highest effort) — at each gate

```
Gate N check. Read PLAN.md §2 "GATE N" and PROGRESS.md. Run exactly the numbered checks, use the browser for the
visual ones, read only the files named in the oversight scan, and append the verdict to PROGRESS.md "Gate log" as
`GN HH:MM — check 1 PASS | check 2 FAIL (why) … — fixes: file:line (≤3) — risks for next block (≤3)`. Do not build.
```
