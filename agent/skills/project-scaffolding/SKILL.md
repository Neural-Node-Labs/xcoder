---
name: project-scaffolding
role: scaffolding
description: Turns an existing design document into a scaffolded, runnable repository — directory layout, package manifest, config, CI/dev-entry-point skeleton, and an initial git checkpoint — then hands off to implementation, one component at a time. Bridges software-architect/architect's design output and programmer/software-engineer's implementation work; neither of those covers the "zero to running skeleton" step.
triggers:
  - "scaffold"
  - "scaffold the project"
  - "scaffold a repository"
  - "scaffold the repository"
  - "bootstrap the project"
  - "bootstrap a project"
  - "project skeleton"
  - "repo skeleton"
  - "repository skeleton"
  - "initialize the repository"
  - "set up the repository"
  - "greenfield project"
  - "from the design document"
  - "from the design doc"
  - "implement the design document"
  - "build from the design"
version: "1.0.0"
requires_tools:
  - read_tool
  - glob_tool
  - grep_tool
  - write_edit_tool
  - run_command_tool
  - github_tool
composes_with:
  - software-architect
  - architect
  - programmer
  - software-engineer
  - task-planning
  - git-vcs
  - devops
  - workspace-context
---

## Process

1. **Read the design document in full before creating anything.** `glob_tool` for the likely
   names first if not given a path — `design.md`, `DESIGN.md`, `blueprint.md`,
   `solution-design.md`, `docs/design/**/*.md`, `plan/*.md`. Extract, concretely: the chosen
   tech stack (language/runtime/framework/versions if stated), the component/module list, the
   external dependencies (databases, queues, third-party APIs), and any explicitly stated
   directory-layout or naming conventions. If the design doc is silent on a structural
   decision (e.g. monorepo vs. multi-package, test framework choice), pick the ecosystem's
   own convention for the stated language rather than inventing one — don't ask the user for
   things a design doc this detailed should already imply.
2. **Compose with `task-planning` before writing files** if the component list has more than a
   few items — turn the design into a WBS (one task per component/config artifact) so the run
   gets scored on decisive, forward-moving steps instead of one undifferentiated "build
   everything" action.
3. **Scaffold structure and config first, implementation code second, in that order** — and
   validate the skeleton actually installs/builds before writing a single line of feature code:
   - Directory layout matching the design doc's module boundaries.
   - Package manifest (`package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`/etc.) with the
     dependencies the design doc names — not extras "just in case."
   - `.gitignore` scoped to the actual stack (build output, dependency caches, local env
     files) — not a generic copy-paste that ignores files the project actually needs tracked.
   - A minimal entry point that runs/compiles with no real logic yet (e.g. a "hello world"
     server route, an empty test that passes) — this is the checkpoint that proves the
     scaffold itself works before any component logic is layered on.
   - Run the install/build command (`run_command_tool`) and read the Observation. A scaffold
     that "looks right" but was never actually installed/built is not validated — don't skip
     this step even though it feels like overhead for boilerplate.
4. **Commit the bare scaffold before implementing anything** (compose with `git-vcs`): `git
   init` (if not already a repo) and one commit for the working skeleton. This is a direct
   lesson from this project's own incident history (PM-2026-07-25-001's own P3 finding: "no git
   history... impossible to trace when truncation first occurred or what changed") — a
   scaffold with no checkpoint means any later mistake has no rollback point, and root-causing
   it later has nothing to bisect against.
5. **Implement component by component from the WBS, validating each one before moving to the
   next** — write the code for one component, run its tests/linter/build (Validation phase),
   then move on. Writing every component's code first and validating once at the end defeats
   the point of incremental verification and produces a pile of unvalidated changes that are
   hard to attribute a failure to.

## Instructions — non-negotiable

- **One file per `write_edit_tool` call, not one call dumping the whole scaffold.** Every file
  this skill creates (manifest, config, source stub) should be its own `write_edit_tool` call
  with `mode='write'`. This project's own `agent/config/llm.yaml` sizes `max_tokens` at 16384
  (~57KB) specifically so that any single completion has a real ceiling — a single response
  trying to emit an entire multi-file scaffold as one giant blob risks hitting
  `finish_reason: "length"` mid-generation. `truncationGuard.ts` will now catch that and force a
  clean retry instead of silently writing a truncated file (the actual root cause of
  PM-2026-07-25-001), but relying on that safety net for routine scaffolding work is strictly
  worse than just not generating oversized single completions in the first place.
- **Check before you scaffold**: `glob_tool`/`grep_tool` for an existing manifest, `.git/`
  directory, or non-empty target directory before treating this as greenfield. Scaffolding on
  top of an existing project silently overwrites config — confirm the directory is actually
  empty (or that overwriting specific named files is intended) before writing.
- **Never invent a directory layout the design doc doesn't imply.** If the design doc specifies
  module boundaries, the directory structure should map onto them directly — restructuring
  "for cleanliness" beyond what's specified is scope creep on a scaffolding task and makes the
  result harder to review against the doc it's supposed to implement.
- **Config values that are secrets (API keys, DB credentials, tokens) go in a `.env.example`
  with placeholder values and documentation, never a real `.env` with invented-looking real
  values** — a scaffold's `.env.example` is a template, not a place to guess at credentials.

## Strategies

- Batch tightly-related, small config values into one file (e.g. `tsconfig.json`,
  `.eslintrc`) rather than one `write_edit_tool` call per config key — the one-file-per-call
  rule above is about avoiding oversized *individual* completions, not about maximizing the
  number of tool calls for its own sake.
- If the target ecosystem has a standard scaffolding tool (e.g. `npm create vite@latest`,
  `cargo new`, `django-admin startproject`), prefer running it via `run_command_tool` over
  hand-writing the same boilerplate it would generate — less surface area for a hand-written
  config to drift from ecosystem convention, and it's a single verifiable command instead of
  several hand-authored files that could each have a typo.
- Prefer wiring cross-platform-safe entry points (a plain `npm start`/`make run`-style command
  that works without assuming a specific shell) over OS-specific scripts as the *primary*
  documented way to run the project, and only add OS-specific scripts (`.sh`/`.bat`) as
  secondary conveniences layered on top — this project's own scripts hit real, confirmed bugs
  from the opposite ordering (a heavy, POSIX-only script wired as the automatic entry point,
  breaking on every platform including Linux due to a line-ending issue). Don't repeat that
  shape in a new scaffold.

## Experience

- A design doc that names a tech stack but not exact versions is not license to pick whatever
  is newest — check for a stated minimum/target version first (engines field, runtime version
  file, CI config if the design doc references one); silently picking latest can introduce
  compatibility problems the design doc's author didn't anticipate.
- The most common scaffolding failure isn't a missing file, it's an unvalidated one — a
  manifest that lists a dependency that doesn't actually resolve, or an entry point that was
  never actually run. Always execute the install/build/run command and read its Observation
  before considering the scaffold step done, exactly as `devops`'s "Validate" step requires for
  a deploy pipeline — the same discipline applies here, just earlier in the lifecycle.
