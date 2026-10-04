# SDLC Scenario Run Report

Generated 2026-10-03T14:45:54.586Z — **ALL SCENARIOS AS EXPECTED** (8/8)

**Real:** SdlcEngine, LeanEngine sub-agents, tool dispatcher (files written, shell commands run), command Validation Gates (real `node`/`bash` exit codes), checkpoints, rejection reports, OpenTelemetry spans & metrics.
**Scripted:** the developer LLM (no API key available). Its healing attempts are *reactive* — they apply the right fix only if the real gate-failure text reached them through the engine's healing prompt. LLM token figures are synthetic and omitted here.

| # | Input | Scenario | Pipeline | Per-stage attempts | Outcome | Time | Expected? |
|---|---|---|---|---|---|---|---|
| 1 | Requirement | New feature from a requirement | `requirements>design>code>test` | requirements×1, design×1, code×2, test×1 | completed | 2.3s | ✅ |
| 2 | Design | Implement an approved design | `code>test` | code×1, test×1 | completed | 0.5s | ✅ |
| 3 | Codes | Existing code needs real tests | `test` | test×2 | completed | 2.1s | ✅ |
| 4 | Defect | Defect report against existing code | `fix_defect>test` | fix_defect×1, test×1 | completed | 1.0s | ✅ |
| 5 | Failed test | Failing tests (agent first tries to cheat; gate catches it) | `fix_defect>test` | fix_defect×2, test×1 | completed | 1.0s | ✅ |
| 6 | UI/UX design | Implement a UI/UX design with accessibility gates | `ui_ux>test` | ui_ux×2, test×1 | completed | 0.7s | ✅ |
| 7 | Failed deployment | Failed deployment with two stacked root causes | `fix_deployment>deploy` | fix_deployment×2, deploy×1 | completed | 0.6s | ✅ |
| 8 | Defect (agent cannot fix) | Unfixable failure halts cleanly (report + checkpoint, no crash) | `fix_defect>test` | fix_defect×2, test×0 | partial_completion | 0.1s | ✅ |

## Requirement — New feature from a requirement

Task: _Build a shopping-cart library: totals for line items with discount codes SAVE10 and FLAT5_

- **requirements** → completed after 1 attempt(s)
  - attempt 1: passed
- **design** → completed after 1 attempt(s)
  - attempt 1: passed
- **code** → completed after 2 attempt(s)
  - attempt 1: failed — `node scripts/acceptance-cart.cjs` exited 1
--- output tail ---
FAIL SAVE10 rounding: expected total 5397 got 5398
  - attempt 2: passed
- **test** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=requirements>design>code>test (2256ms)
  sdlc.stage requirements status=completed attempts=1 (1650ms)
    sdlc.attempt requirements #1 (1603ms) [2 events]
    sdlc.validate requirements pass=true (44ms)
  sdlc.stage design status=completed attempts=1 (54ms)
    sdlc.attempt design #1 (12ms) [2 events]
    sdlc.validate design pass=true (42ms)
  sdlc.stage code status=completed attempts=2 (205ms)
    sdlc.attempt code #1 (53ms) [4 events]
    sdlc.validate code pass=false (45ms) ✗
    sdlc.attempt code #2 (60ms) [3 events]
    sdlc.validate code pass=true (46ms)
  sdlc.stage test status=completed attempts=1 (335ms)
    sdlc.attempt test #1 (174ms) [3 events]
    sdlc.validate test pass=true (161ms)
```

## Design — Implement an approved design

Task: _Implement the approved token-bucket rate limiter design in docs/design.md_

- **code** → completed after 1 attempt(s)
  - attempt 1: passed
- **test** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=code>test (494ms)
  sdlc.stage code status=completed attempts=1 (112ms)
    sdlc.attempt code #1 (64ms) [3 events]
    sdlc.validate code pass=true (48ms)
  sdlc.stage test status=completed attempts=1 (378ms)
    sdlc.attempt test #1 (188ms) [3 events]
    sdlc.validate test pass=true (189ms)
```

## Codes — Existing code needs real tests

Task: _Write unit tests for the slugify module_

- **test** → completed after 2 attempt(s)
  - attempt 1: failed — `node scripts/mutation-check.cjs src/slugify.cjs` exited 1
--- output tail ---
FAIL weak tests: mutants SURVIVED (not detected): no-edge-trim, no-collapse-runs
  - attempt 2: passed

Trace:
```
sdlc.run outcome=completed pipeline=test (2136ms)
  sdlc.stage test status=completed attempts=2 (2134ms)
    sdlc.attempt test #1 (185ms) [3 events]
    sdlc.validate test pass=false (922ms) ✗
    sdlc.attempt test #2 (168ms) [3 events]
    sdlc.validate test pass=true (857ms)
```

## Defect — Defect report against existing code

Task: _Defect: the dashboard shows NaN when a user has no data — average([]) returns NaN, it should return 0_

- **fix_defect** → completed after 1 attempt(s)
  - attempt 1: passed
- **test** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=fix_defect>test (1026ms)
  sdlc.stage fix_defect status=completed attempts=1 (542ms)
    sdlc.attempt fix_defect #1 (240ms) [4 events]
    sdlc.validate fix_defect pass=true (301ms)
  sdlc.stage test status=completed attempts=1 (480ms)
    sdlc.attempt test #1 (225ms) [2 events]
    sdlc.validate test pass=true (254ms)
```

## Failed test — Failing tests (agent first tries to cheat; gate catches it)

Task: _The price parser tests are failing after the last merge — fix it_

- **fix_defect** → completed after 2 attempt(s)
  - attempt 1: failed — `node scripts/tests-intact.cjs && node --test tests/*.test.cjs` exited 1
--- output tail ---
FAIL tests/price.test.cjs was modified — the failing tests are the specification; fix the source, not the tests
  - attempt 2: passed
- **test** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=fix_defect>test (980ms)
  sdlc.stage fix_defect status=completed attempts=2 (580ms)
    sdlc.attempt fix_defect #1 (159ms) [3 events]
    sdlc.validate fix_defect pass=false (64ms) ✗
    sdlc.attempt fix_defect #2 (171ms) [4 events]
    sdlc.validate fix_defect pass=true (186ms)
  sdlc.stage test status=completed attempts=1 (397ms)
    sdlc.attempt test #1 (188ms) [2 events]
    sdlc.validate test pass=true (209ms)
```

## UI/UX design — Implement a UI/UX design with accessibility gates

Task: _Build the sign-in screen from the attached UI/UX design_

- **ui_ux** → completed after 2 attempt(s)
  - attempt 1: failed — `node scripts/a11y-lint.cjs public/index.html && node scripts/acceptance-validate.cjs` exited 1
--- output tail ---
a11y violations (9):
 - <html> needs a lang attribute
 - missing responsive <meta name="viewport">
 - missing <main> landmark
 - input #email ha
  - attempt 2: passed
- **test** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=ui_ux>test (653ms)
  sdlc.stage ui_ux status=completed attempts=2 (235ms)
    sdlc.attempt ui_ux #1 (49ms) [5 events]
    sdlc.validate ui_ux pass=false (50ms) ✗
    sdlc.attempt ui_ux #2 (53ms) [4 events]
    sdlc.validate ui_ux pass=true (82ms)
  sdlc.stage test status=completed attempts=1 (415ms)
    sdlc.attempt test #1 (193ms) [3 events]
    sdlc.validate test pass=true (221ms)
```

## Failed deployment — Failed deployment with two stacked root causes

Task: _Our deployment failed — fix the deploy and redeploy_

- **fix_deployment** → completed after 2 attempt(s)
  - attempt 1: failed — `bash deploy/deploy.sh && node scripts/verify-release.cjs` exited 1
--- output tail ---
FATAL: APP_PORT is required
  - attempt 2: passed
- **deploy** → completed after 1 attempt(s)
  - attempt 1: passed

Trace:
```
sdlc.run outcome=completed pipeline=fix_deployment>deploy (635ms)
  sdlc.stage fix_deployment status=completed attempts=2 (369ms)
    sdlc.attempt fix_deployment #1 (57ms) [4 events]
    sdlc.validate fix_deployment pass=false (54ms) ✗
    sdlc.attempt fix_deployment #2 (104ms) [4 events]
    sdlc.validate fix_deployment pass=true (154ms)
  sdlc.stage deploy status=completed attempts=1 (262ms)
    sdlc.attempt deploy #1 (101ms) [2 events]
    sdlc.validate deploy pass=true (160ms)
```

## Defect (agent cannot fix) — Unfixable failure halts cleanly (report + checkpoint, no crash)

Task: _Defect: average([]) returns NaN_

- **fix_defect** → escalated after 2 attempt(s)
  - attempt 1: failed — `node scripts/repro-defect.cjs` exited 1
--- output tail ---
FAIL repro: average([]) still NaN — depends on upstream data service
  - attempt 2: failed — `node scripts/repro-defect.cjs` exited 1
--- output tail ---
FAIL repro: average([]) still NaN — depends on upstream data service
- **test** → pending after 0 attempt(s)

Trace:
```
sdlc.run outcome=partial_completion pipeline=fix_defect>test (111ms) ✗
  sdlc.stage fix_defect status=escalated attempts=2 (109ms) ✗
    sdlc.attempt fix_defect #1 (4ms) [2 events]
    sdlc.validate fix_defect pass=false (54ms) ✗
    sdlc.attempt fix_defect #2 (5ms) [2 events]
    sdlc.validate fix_defect pass=false (44ms) ✗
```

## Metrics recorded

- `xcoder.llm.tokens`
- `xcoder.sdlc.escalations`
- `xcoder.sdlc.healing.attempts`
- `xcoder.sdlc.runs`
- `xcoder.sdlc.stage.duration`
- `xcoder.sdlc.stage.outcomes`
- `xcoder.sdlc.validation.outcomes`
