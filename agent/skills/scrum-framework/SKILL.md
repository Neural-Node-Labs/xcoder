---
name: scrum-framework
role: Scrum Coach / Framework Reference
description: >
  Reference and coaching knowledge for Scrum — the four roles (Product Owner, Scrum Master,
  Developers, Architect), the five events (Sprint Planning, Daily Scrum, Backlog Refinement,
  Sprint Review, Retrospective), the three artifacts and commitments (Product Backlog/Product
  Goal, Sprint Backlog/Sprint Goal, Increment/Definition of Done), sprint rules, INVEST story
  quality, and Definition of Ready/Done. Load whenever the task involves explaining or coaching
  Scrum roles and accountabilities, running or facilitating a Scrum event, writing or critiquing
  a Sprint Goal or user story, checking a story against INVEST or Definition of Ready/Done,
  evaluating "is this good Scrum" or spotting anti-patterns, or drafting product backlog items,
  acceptance criteria, or facilitation agendas.
triggers: [scrum, sprint, "product backlog", "sprint goal", "user story", "acceptance criteria", invest, "definition of done", "definition of ready", retrospective, "daily scrum", "sprint planning", "sprint review", "product owner", "scrum master"]
version: 1.0
requires_tools: []
composes_with: [scrum-master-agent]
---


# Scrum Framework

Reference knowledge for coaching, explaining, and applying Scrum correctly. Ground every answer in accountability: each role owns exactly one thing and cannot delegate it, each artifact carries exactly one commitment, and every event is a timeboxed inspect-and-adapt opportunity, not a status meeting.

## When to go deeper

- Full role responsibilities, sprint cycle, and event-by-event agendas: `references/roles_and_events.md`
- Artifacts, commitments, DoR/DoD, INVEST, and Scrum anti-patterns: `references/artifacts_and_quality.md`

Read the relevant reference file before writing detailed coaching content (e.g. a full Sprint Planning agenda, a DoD checklist, or an INVEST review) — don't reconstruct these from memory alone, since the specifics (timeboxes, question sets, checklist items) matter.

## Core mental model

**Four roles, one accountability each** (Architect is not a canonical Scrum Guide role but is commonly added in technical/CBD-style teams):
- **Product Owner** — accountable for the *value* of the product. Owns the Product Backlog: content, ordering, clarity. Says what and why, never how.
- **Scrum Master** — accountable for the *effectiveness of the Scrum Team*. Servant-leader: facilitates events, removes impediments, coaches — not a project manager and has no authority over the backlog or the team's work.
- **Developers** — accountable for a *usable Increment* every Sprint. Self-organizing, cross-functional, own the Sprint Backlog and estimation collectively.
- **Architect** (non-canonical, common in technical orgs) — owns the technical blueprint/design decisions and architectural review; not a source of process authority.

No one holds more than one primary accountability, and accountabilities are non-transferable — don't recommend workarounds that blur them (e.g. a Scrum Master accepting stories, or a PO estimating).

**Five events, each with a hard timebox (a maximum, not a target):**
1. Sprint Planning (≤8 hrs/4-wk sprint) — produces the Sprint Goal + Sprint Backlog
2. Daily Scrum (15 min, daily) — inspects progress, replans next 24h; not a status report
3. Backlog Refinement (≤10% of sprint capacity, continuous, not a formal timeboxed event) — gets items to "Ready"
4. Sprint Review (≤4 hrs/4-wk sprint) — demonstrates the *working* Increment, gathers stakeholder feedback
5. Sprint Retrospective (≤3 hrs/4-wk sprint) — produces 1–3 specific, owned improvement actions for the next sprint

**Three artifacts, three commitments:**
| Artifact | Owner | Commitment |
|---|---|---|
| Product Backlog | Product Owner | Product Goal |
| Sprint Backlog | Developers | Sprint Goal |
| Increment | Developers | Definition of Done |

## Non-negotiable sprint rules

- Only the PO can cancel a Sprint, and only if the Sprint Goal becomes obsolete — this is rare.
- No scope changes that endanger the Sprint Goal mid-sprint.
- Sprint length is fixed; never extend to finish late work.
- Unfinished stories return openly to the Product Backlog — never silently carried over.
- If an item doesn't meet the Definition of Done, it is not Done. No partial credit.

## Writing a good Sprint Goal

A Sprint Goal answers "why are we doing this Sprint?" and gives Developers flexibility in *what exactly* they build to get there.
- Good: "Enable customers to check out via Stripe so we can launch payments to beta users."
- Bad: "Complete stories SP-142, SP-144, SP-145, SP-147." (a task list, not a goal — gives no room to adapt)

## Quick answers vs. deep answers

For a simple factual question ("what's the Daily Scrum timebox?", "who owns the Sprint Backlog?") answer directly and briefly from the core mental model above — no need to open the reference files.

For anything requiring a full checklist, agenda, or scored evaluation (drafting a Sprint Planning agenda, checking a story against DoR/DoD, scoring INVEST, listing anti-patterns), open the relevant reference file first so specifics are accurate rather than reconstructed from memory.
