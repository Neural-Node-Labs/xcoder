# Roles, Sprint Cycle, and Event Detail

## Roles — full responsibility lists

### Product Owner — Value Maximiser
The single voice of the customer. Owns the Product Backlog's content, ordering, and clarity.
- Define and communicate the Product Goal
- Create, refine, and order Product Backlog Items
- Write acceptance criteria for every story
- Accept or reject completed Sprint work (formal acceptance is the PO's alone)
- Manage stakeholder expectations and feedback
- Prioritise by business value, risk, and dependencies
- Attend Sprint Review and provide direction
- Ensure the backlog is transparent and understood by everyone

### Scrum Master — Process Guardian
The servant-leader. Coaches on Scrum, removes impediments, protects team focus. Not a project manager.
- Facilitate all five Scrum events
- Remove blockers and impediments daily
- Coach the team on Scrum theory and practice
- Protect the team from external interruptions
- Coach the PO on backlog management
- Identify and escalate organisational impediments
- Track sprint health and surface risks early
- Foster a culture of continuous improvement

### Developers — Increment Builders
Anyone who creates any aspect of a usable Increment — not just coders; testers, designers, analysts are Developers in Scrum. Own the Sprint Backlog collectively.
- Create the Sprint Backlog plan in Sprint Planning
- Deliver a Done Increment each Sprint
- Adapt the daily plan at the Daily Scrum
- Hold each other accountable as professionals
- Refine Product Backlog items with the PO
- Estimate stories using the team's agreed pointing scale
- Uphold the Definition of Done
- Collaborate — no silos within the team

### Architect — Technical Authority (non-canonical but common in technical orgs)
Owns the blueprint, makes technical design decisions, reviews stories for architectural compliance.
- Produce and maintain the Master Blueprint
- Review all architectural components for compliance
- Define and approve all interface/schema contracts
- Write Architecture Decision Records (ADRs)
- Identify and schedule technical debt stories
- Advise on risk levels for components
- Set and enforce the technical-quality bar within Definition of Done
- Lead Sprint Planning discussion for technical stories

## The Sprint Cycle (heartbeat of Scrum)

A Sprint is a fixed-length container (≤1 month, commonly 2 weeks) holding all other events and all the work. You cannot skip a Sprint or extend one without effectively starting over.

| Day | Event | Purpose |
|---|---|---|
| Day 1 | Sprint Planning | Select stories, define Sprint Goal, create Sprint Backlog |
| Days 2–N | Development | Daily Scrum each morning; build, test, integrate daily |
| Every day | Daily Scrum | 15-min sync: inspect progress, adapt next-24h plan |
| Mid-sprint | Backlog Refinement | PO + Devs sharpen upcoming stories, re-estimate |
| Last day | Sprint Review | Demo the Done Increment to stakeholders |
| Last day | Retrospective | Team reflects on process, plans improvements |

There is no gap between sprints — the day after the Retrospective is Day 1 of the next Sprint.

## Event-by-event detail

### 1. Sprint Planning — ≤8 hrs / 4-week sprint
Answers three questions: *Why* is this Sprint valuable? *What* can be Done? *How* will it get Done?
- **Attends:** PO, Scrum Master, all Developers, Architect (if role exists)
- **Outputs:** Sprint Goal, Sprint Backlog, initial task breakdown
- **Sample agenda (2-week sprint, 4 hrs total):**
  1. 0:00–0:30 — PO presents Sprint Goal and top backlog items
  2. 0:30–1:00 — Team reviews capacity (leaves, meetings, last velocity)
  3. 1:00–2:30 — Team selects items, clarifies acceptance criteria with PO
  4. 2:30–3:30 — Developers break selected items into tasks (≤1 day each)
  5. 3:30–4:00 — Confirm Sprint Goal wording, finalize Sprint Backlog

### 2. Daily Scrum — 15 minutes, every day
For Developers, to inspect progress toward the Sprint Goal and adapt the next 24 hours. Not a status report to management.
- **Attends:** all Developers; Scrum Master optional
- **Format:** classic 3-question format, or "walk the board" — team's choice
- **Three questions:** (1) What did I complete yesterday that contributed to the Sprint Goal? (2) What will I work on today? (3) Any impediment blocking me or the team?
- **Common mistake to flag:** treating the Daily Scrum as the only sync point. Deep problem-solving belongs in separate "after-standup" sessions with only the people who need to be there.

### 3. Backlog Refinement — ≤10% of sprint capacity, ongoing
Not a formal timeboxed Scrum event, but essential. Adds detail, estimates, and order to backlog items. Stories entering Sprint Planning without being "Ready" derail the meeting.
- **Attends:** PO, key Developers, Architect
- **Definition of Ready:** Title, Description, Acceptance Criteria, Estimated, No open questions
- **Activities:** Split (break stories >13 pts into independently deliverable pieces), Clarify (PO answers open questions), Estimate (Planning Poker or relative sizing), Order (PO re-orders by value/risk/dependencies)

### 4. Sprint Review — demonstrate the Increment
Team demonstrates all Done stories to stakeholders on the last day. Working software only — no slides, no "almost done." Stakeholders interact with the product and give feedback; PO updates the Product Backlog based on what's learned. This is the inspect-and-adapt loop for the *product*.
- **Attends:** whole team, PO hosts, stakeholders
- **Outputs:** stakeholder feedback, updated Product Backlog, revised Product Goal

### 5. Sprint Retrospective — continuous improvement
Immediately after the Review, the team reflects on how they worked (not what they built). SM facilitates. Output is 1–3 specific, actionable improvements with named owners, added to the very next Sprint Backlog. Closes the inspect-and-adapt loop for the *process*.
- **Attends:** whole team, SM facilitates
- **Outputs:** improvement action items, updated team agreements

## Workflow through a story's life (board states)

`To Do → In Progress → In Review → Done`

- **Code Review / peer or architectural gate:** when a task is marked Done, a peer (and, in technical orgs, an Architect) review is triggered before it can advance. A failed check sends the task back to In Progress.
- **Definition of Done verification:** before a story moves to Done on the board, the full DoD is checked. The PO verifies acceptance criteria — this is formal acceptance, not just a technical check. A story not meeting DoD returns to In Progress.
