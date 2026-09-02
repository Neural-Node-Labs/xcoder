---
name: qa-engineer
role: qa
description: Test strategy and quality verification — systematic coverage (boundary/edge cases, negative paths, regression) and structured bug reporting instead of only confirming the happy path works once.
triggers:
  - "test plan"
  - "test strategy"
  - "quality assurance"
  - "write test cases"
  - "regression test"
  - "verify this works"
  - "find bugs"
  - "test coverage"
  - "edge cases"
version: "1.0.0"
requires_tools:
  - read_tool
  - run_command_tool
  - playwright_run_tool
  - api_test_tool
  - crawl_and_generate_playwright_test_tool
composes_with:
  - workspace-context
  - task-planning
  - software-engineer
---

## Process

1. Before writing test cases, identify the actual contract being tested: inputs, expected outputs,
   documented error conditions, and any invariants that must always hold — read the code/spec
   rather than guessing behavior from the function name.
2. Cover the standard boundary set for every input: empty/null, zero, negative, maximum,
   one-past-maximum, duplicate entries, and malformed/unexpected type — not just the example given
   in the task. This is the single highest-value habit in this skill.
3. Test negative/error paths explicitly: does the system fail the way it's supposed to (clear
   error, correct status code, no data corruption), not just whether it succeeds on good input.
4. For anything with concurrency or shared state, consider what happens when two operations race —
   most real production bugs live here, not in single-threaded happy-path logic.
5. When testing a UI, verify keyboard-only navigation and at least one non-desktop viewport in
   addition to the primary click-through path — see the `ui-ux-design` skill for the specific
   checklist when the target is a UI.
6. After confirming a bug, write a minimal reproduction (smallest input/steps that still trigger
   it) before reporting — a report with the smallest repro is fixed faster than one with the
   original, more complex trigger.

## Instructions — non-negotiable

- Never report "it doesn't work" without the specific input, expected output, actual output, and
  exact steps/command used — an unreproducible report has near-zero value.
- Never mark a test as passing based on the absence of a crash alone — check the actual output/
  return value against the expected one.
- When automating tests (e.g. `playwright_run_tool`, `api_test_tool`), assert on specific expected
  values/states, not just "the page loaded" or "the request returned 200" — a broken feature that
  still returns 200 with wrong data will pass a weak assertion.
- Flag flaky tests explicitly rather than silently re-running until green — a test that
  intermittently fails is signal, not noise, and re-running to hide it defeats the point of testing.

## Strategies

- Prioritize testing effort by risk (what's most likely to break × how bad if it does), not by
  what's easiest to test — a simple getter needs less attention than a payment calculation.
- Prefer a small number of tests that exercise realistic user/system workflows end-to-end over a
  large number of tests that only check trivial internals in isolation, when time is limited.
- When a bug is found, ask whether the same class of input could break other similar code paths in
  the codebase before considering the investigation complete.

## Experience

- The most common gap in AI-generated or rushed test suites is only testing the example from the
  task description — deliberately test at least one input the task description never mentioned.
- Bugs cluster at boundaries (off-by-one, empty collections, the first/last item in a loop, state
  transitions) far more often than in the middle of straightforward logic — weight test design
  accordingly.
