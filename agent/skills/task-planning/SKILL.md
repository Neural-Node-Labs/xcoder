---
name: task-planning
role: planning
description: Plan and sequence multi-step tasks to maximize xcoder's own health score (src/core/stepScorer.ts) — avoid the two things it penalizes heavily (tool errors, repeated no-op actions) and lean into what it rewards (verified, decisive, forward-moving actions), while using Plan Mode/phase structure correctly.
triggers:
  - "make a plan"
  - "plan the"
  - "plan for"
  - "project plan"
  - "planning"
  - "todo"
  - "break down"
  - "break this down"
  - "phases"
  - "wbs"
  - "work breakdown"
  - "approach this"
  - "strategy for"
  - "how should i tackle"
version: "1.0.0"
requires_tools:
  - read_tool
  - grep_tool
  - glob_tool
  - add_plan_task_tool
  - save_plan_tool
  - update_task_status_tool
  - subagent_tool
composes_with:
  - skill-authoring
  - ui-ux-design
---

## Purpose

xcoder scores every completed tool step 0–100 (`scoreStep` in `src/core/stepScorer.ts`) and tracks
a rolling average over the last 5 scored steps (`rollingHealth`). This isn't a quality judgment on
cleverness — it's a cheap, deterministic proxy for "did this step move the task forward." Planning
well means structuring work so it naturally produces high-scoring steps, not gaming the number.

## The exact scoring rule (know this precisely, don't approximate it)

Every step starts at a neutral baseline of **70**, then:

- **No error: +10.** **Error: −45.** This is the single biggest lever — errors are nearly 5x more
  costly than a clean step is rewarding. Verify before acting rather than acting and fixing errors
  after the fact: read a file before editing a specific line, check a variable/API actually exists
  before calling it, confirm a path exists before writing to it.
- **Exact duplicate action: −35.** This fires only when the *same tool with the same arguments*
  produces the *exact same observation* as an earlier call — i.e., genuinely nothing new was
  learned. It does **not** fire on legitimate re-runs where state changed in between (e.g. running
  a test suite again after fixing the code it tests — different observation, no penalty; running
  it again with nothing changed — penalized). The lesson for planning: after any action that
  fails or returns unclear results, change something (the approach, the inputs, what you inspect
  next) before repeating a similar action rather than retrying the identical call hoping for a
  different result.
- **`write_edit_tool` or `run_command_tool` succeeding: +10 bonus.** These represent concrete
  forward progress on a coding task (an actual change made, an actual command executed
  successfully) as opposed to read-only investigation, which is necessary but scores neutrally.
- If the rolling average drops **below 40** (with at least 2 scored steps and a cooldown since the
  last warning), xcoder injects a self-check nudge telling itself to re-read state, verify its last
  assumption, and try a genuinely different approach — a sign the plan itself, not just the last
  action, needs to change.

## Process — plan so the scoring rewards line up with real progress

1. **Investigate before committing to a plan.** Read the relevant files/config/schema first
   (`read_tool`/`grep_tool`/`glob_tool`) so the plan's first `write_edit_tool`/`run_command_tool`
   call is likely to succeed on the first try, instead of planning from assumption and discovering
   errors mid-execution.
2. **Sequence steps so each one is independently verifiable.** Prefer "make change → run the
   specific test/command that proves it → move on" over batching several unverified changes
   together — batching hides which change caused a later error, which invites repeated,
   undifferentiated retries (the exact pattern the duplicate-action penalty targets).
3. **Use Plan Mode's actual artifacts, not an ad-hoc list.** Write the plan to `tasks/todo.md`
   (via `save_plan_tool`/`add_plan_task_tool`), and update task status as you go
   (`update_task_status_tool`) — this keeps the plan and the actual execution state in sync, so a
   restart or a subagent picking up the work isn't re-deriving what's already done.
4. **For genuinely large tasks, prefer phase decomposition over one long flat loop.** Phases run as
   isolated sub-orchestrators with their own health tracking and iteration budget — a bad early
   assumption in phase 2 doesn't poison phase 4's context, and each phase's rolling average resets
   instead of compounding one long streak of penalized retries into a death spiral for the whole run.
5. **When a step fails, diagnose before retrying.** Read the actual error, form a specific
   hypothesis for why, and let the next action test that hypothesis. A retry that isn't informed by
   the failure is likely to reproduce it (error again, −45) or repeat it exactly (duplicate, −35) —
   either way it's the two worst outcomes in the scoring model, back to back.

## Strategies

- Order steps cheapest-to-verify first: a `read_tool`/`grep_tool` check that rules out a wrong
  assumption costs little and prevents a downstream `run_command_tool` failure.
- When genuinely uncertain between two approaches, do the minimum-cost investigation to
  disambiguate (read one more file, check one more config) rather than picking one and discovering
  via a failed `run_command_tool` call that it was wrong.
- If a task naturally has independent sub-parts (e.g. "fix the backend bug and update the UI for
  it"), consider `subagent_tool` for the more self-contained piece — isolates its context and its
  health tracking from the main task.
- Don't over-correct into excessive verification either — re-reading a file you just wrote
  unchanged, or re-running a command with literally nothing different, is itself heading toward the
  duplicate-action penalty. The goal is "verify before acting when there's real uncertainty," not
  "verify everything twice."

## Experience — failure patterns this scoring model specifically punishes

- **The retry loop**: an action fails, the same action is retried unchanged hoping for a different
  result. This is the worst pattern possible under this scoring model — likely to hit both the
  error penalty again and then the duplicate-action penalty once the identical failure repeats.
  Break out of it by changing at least one concrete thing (different tool, different args, or a
  preceding investigation step) before repeating anything similar.
- **Premature action**: writing/running before reading enough to know the change is correct. Shows
  up as a string of `write_edit_tool`/`run_command_tool` errors early in a run. Front-load
  read-only investigation instead.
- **Batched, unverified changes**: several edits before any verification, so when something breaks
  it's unclear which edit did it — the natural next move is broad, undifferentiated re-checking,
  which tends to reproduce duplicate or erroring calls rather than resolve the issue efficiently.
