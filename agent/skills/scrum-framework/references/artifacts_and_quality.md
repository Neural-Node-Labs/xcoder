# Artifacts, Quality Gates, and Anti-Patterns

## The three artifacts

### Product Backlog — owned by the Product Owner, commitment: Product Goal
The single, ordered list of everything known to be needed in the product. Dynamic — always exists as long as the product does, never "complete." The PO alone is responsible for its content, availability, and ordering.

A good Product Backlog Item (PBI) contains:
- User Story (As a / I want / So that)
- Acceptance Criteria (Given/When/Then)
- Story Points estimate
- Priority / business value
- Epic linkage (if applicable)
- Definition of Ready status

### Sprint Backlog — owned by the Developers, commitment: Sprint Goal
The Sprint Goal, the PBIs selected for the Sprint, and an actionable delivery plan. A highly visible, real-time snapshot of the Developers' plan. Only Developers modify it during the Sprint.

Components: Sprint Goal (the "why") · Selected PBIs (the "what") · Task breakdown ≤1 day each (the "how") · daily updates reflecting actual remaining work · burndown showing progress to goal.

### Increment — owned by the Developers, commitment: Definition of Done
A concrete, usable stepping stone toward the Product Goal. Additive to all prior Increments, verified working. Multiple Increments may be created within a single Sprint. Delivered at Sprint Review, not merely demoed.

Quality gates for an Increment:
- Meets Definition of Done without exception
- All acceptance criteria verified by the PO
- Integrates cleanly with previous Increments
- Deployable to production at any time
- No known defects above the agreed threshold

## Definition of Ready (DoR) — gate before Sprint Planning
A story is Ready when it has: Title · Description · Acceptance Criteria · Estimate · No open questions. Stories that skip this gate derail Sprint Planning.

## Definition of Done (DoD) — gate before a story counts as Done
A formal, team-agreed quality bar. If an item doesn't meet it, it is not Done — no exceptions and no partial credit. A representative DoD:
- Code reviewed and approved
- Unit tests written and passing (commonly ≥80% coverage)
- Integration tests passing
- No new linting or type errors
- Deployed to staging environment
- Acceptance criteria verified by the PO

When reviewing a real story against DoD, list the specific unmet items rather than a pass/fail verdict — e.g. "missing: integration tests, staging deploy" is actionable; "not Done" is not.

## The Three Commitments

- **Product Goal** — commits the team to a long-term vision (backs the Product Backlog).
- **Sprint Goal** — commits the team to what they'll achieve this Sprint (backs the Sprint Backlog).
- **Definition of Done** — commits the team to the quality standard applied to every Increment.

These give the artifacts context and prevent misinterpretation — Scrum's transparency only works if all three are explicit and shared.

## INVEST — evaluating story quality

Score each criterion individually rather than giving one aggregate pass/fail; name the specific gap.

- **Independent** — can be built and delivered without hard dependency on another unscheduled story
- **Negotiable** — describes outcome, not a rigid spec; room for the how to be worked out
- **Valuable** — delivers value to a user or the business, not just a technical task
- **Estimable** — the team has enough clarity to size it
- **Small** — fits comfortably within a single Sprint (common flag: >13 points signals a split is needed)
- **Testable** — has clear, verifiable acceptance criteria (Given/When/Then is the standard structure)

When a story fails a criterion, suggest a concrete rewrite rather than just naming the failure — e.g. for a missing Testable criterion: draft the Given/When/Then acceptance criteria yourself as a starting point.

## Common Scrum anti-patterns to watch for and name

- **Zombie sprints** — sprints that continue in form (events happen) but have lost real inspect-and-adapt substance; teams go through the motions without changing behavior based on what they learn.
- **Sprint padding** — inflating estimates or scope to guarantee an easy "success," which erodes the value of velocity as a planning signal.
- **Cargo-cult Scrum** — following the mechanics (standups, sprints, boards) without understanding or honoring the underlying purpose (transparency, inspection, adaptation).
- **Silent carryover** — unfinished work rolling to the next sprint without being explicitly returned to and re-prioritized in the Product Backlog.
- **Status-report Daily Scrum** — reporting to a manager instead of replanning as a team.
- **PO absentee** — Developers making value/priority calls the PO should own, or accepting their own work.
- **Scope creep endangering the Sprint Goal** — adding work mid-sprint without evaluating impact on the committed goal.
- **Task-list Sprint Goals** — a Sprint Goal that's just an enumerated list of ticket IDs, giving no flexibility or "why."

## Scaled Scrum (brief context only)

For organizations running multiple Scrum teams on one product, common scaling frameworks include **Nexus**, **LeSS** (Large-Scale Scrum), and **SAFe** (Scaled Agile Framework). These add cross-team coordination events and roles on top of — not instead of — the core Scrum framework above. Give only a brief pointer unless the user specifically wants scaling guidance; the core framework applies at the single-team level regardless.
