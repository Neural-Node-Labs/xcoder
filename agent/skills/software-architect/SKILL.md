---
name: software-architect
role: architecture
description: System-level design for new services/features/migrations — explicit tradeoffs, failure-mode analysis, and documented decisions instead of implementing the first design that occurs to you.
triggers:
  - "architecture"
  - "design a system"
  - "system design"
  - "design doc"
  - "how should we structure"
  - "scalability"
  - "microservice"
  - "migrate"
  - "migration plan"
  - "architecture decision record"
  - "tech stack"
version: "1.0.0"
requires_tools:
  - read_tool
  - grep_tool
  - glob_tool
  - write_edit_tool
composes_with:
  - workspace-context
  - task-planning
  - software-engineer
  - docker
  - kubernetes
---

## Process

1. Establish the actual constraints before designing: expected scale (requests/sec, data volume,
   team size), consistency requirements, latency budget, and what already exists that this must
   integrate with. A design without stated constraints is a guess, not an architecture.
2. Identify 2–3 genuinely distinct approaches (not one approach and two straw men) and name the
   real tradeoff each makes — write these down even in an informal design doc; "we considered X"
   without the tradeoff is not useful to a future reader.
3. Design for the failure modes, not just the happy path: what happens when a downstream service
   is slow, unavailable, or returns bad data; what's the blast radius of one component failing;
   what's recoverable automatically vs. needs a human.
4. Draw the boundary between services/modules along data ownership and change-rate, not
   convenience — two things that change together for unrelated reasons are a sign of a missing
   boundary; two things that always change together are a sign of an unnecessary one.
5. Record the decision (an ADR-style note: context, options considered, decision, consequences) so
   the reasoning survives past the current conversation — a design that only exists as an
   unexplained set of files is a maintenance liability.

## Instructions — non-negotiable

- Never propose a distributed/microservices architecture to solve a problem a monolith handles
  fine — the complexity cost (network calls, partial failure, deployment coordination) needs to be
  justified by an actual scaling or team-boundary need, not defaulted to.
- State the consistency model explicitly for any design involving more than one data store
  (eventual vs. strong, and what happens during the inconsistency window) — "it'll sync eventually"
  without specifying how is not a complete design.
- Any design that introduces a new external dependency (a new database, queue, cloud service)
  should name what it replaces or what it enables that wasn't possible before — dependencies are
  not free.

## Strategies

- Prefer boring, well-understood technology for the parts of the system that aren't the actual
  differentiator — save novel/complex choices for where they earn their keep.
- Design for the current known scale plus a reasonable margin, not for a hypothetical 100x that may
  never materialize — premature scaling design has a real cost in complexity today.
- When a migration is involved, design the rollback path with the same rigor as the forward path —
  "we'll just roll back if it fails" is not a plan unless you've specified how.

## Experience

- The most common architecture failure isn't picking the wrong technology, it's an unstated
  assumption about consistency, ownership, or failure handling that only surfaces in production —
  make those assumptions explicit in the design doc even when they seem obvious.
- Boundaries that map to team/ownership structure tend to survive; boundaries that only reflect a
  snapshot of current code organization tend to get redrawn — factor in who will maintain each
  piece, not just how the code happens to be organized today.
