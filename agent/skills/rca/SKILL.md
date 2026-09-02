---
name: rca
role: Root Cause Analysis
description: >
  Investigates incidents/bugs to find the actual root cause, not just the symptom. Load
  whenever the task involves an incident, an unexplained failure, "why did this happen", or a
  bug whose fix isn't obvious from the surface report.
triggers: [rca, "root cause", incident, postmortem, "why did this fail", "why is this happening", outage]
version: 1.0
requires_tools: [read_tool, grep_tool, run_command_tool]
composes_with: [tester, performance-tester, secops, programmer]
---

## Role
Owns finding the actual causal chain behind a failure — not the first plausible explanation —
and distinguishing root cause from contributing factors and symptoms.

## Process
1. **Establish the timeline** — what changed and when, correlated with when the symptom
   started (deploys, config changes, traffic shifts, dependency updates).
2. **Reproduce if possible** — a reproduced failure is far stronger evidence than log
   inference alone.
3. **Ask "why" iteratively** — keep pushing past the first answer until you reach something
   actionable and structural, not just the proximate trigger.
4. **Verify the hypothesis** — the true root cause should, when reverted/fixed, make the
   symptom go away (Validation phase) and its absence should explain why the incident
   wasn't happening before.
5. **Separate root cause from contributing factors** — e.g., "no rate limit" (root) vs.
   "traffic spike" (trigger) are different things; name both, fix the root.

## Strategies
- Prefer evidence (logs, metrics, repro) over plausible-sounding narrative.
- Check "what changed recently" first — most incidents correlate with a recent change.
- Consider multiple causal chains before committing to one; don't stop at the first fit.
- Distinguish trigger (what set it off) from root cause (what made the system vulnerable to
  that trigger).

## Planning Approach
- Timebox investigation phases: timeline reconstruction → hypothesis generation → hypothesis
  verification, rather than open-ended digging.
- Write the postmortem as you go (running notes), not reconstructed from memory afterward.

## Instructions for This Task Type
- Never present a hypothesis as the root cause without verification evidence.
- Always produce a timeline and explicitly list contributing factors alongside the root
  cause, plus a corrective action for each.

## Experience / Common Pitfalls
- Stopping at the proximate cause ("the server crashed") instead of the structural cause
  ("no memory limit + unbounded cache growth") leads to recurrence.
- Blame-oriented framing ("who broke this") derails RCA from its purpose — focus on system
  and process gaps.

## Output Artifacts
- Timeline
- Root cause + contributing factors
- Corrective actions (with owners/priority if known)
- Postmortem doc
