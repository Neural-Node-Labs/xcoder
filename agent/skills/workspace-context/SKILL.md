---
name: workspace-context
role: context
description: How to use the automatically-refreshed workspace snapshot (file tree, tech stack, git status, package manifest) that's already in context at the start of every task, and when to explicitly re-trigger a refresh mid-task via workspace_info_tool. Relevant to essentially every engineering task, not just ones that mention "workspace" by name.
triggers:
  - "unfamiliar codebase"
  - "explore the codebase"
  - "understand this codebase"
  - "understand this repo"
  - "workspace structure"
  - "project structure"
  - "codebase overview"
  - "what does this repo"
  - "what tech stack"
  - "refresh workspace"
  - "workspace snapshot"
version: "1.0.0"
requires_tools:
  - workspace_info_tool
  - glob_tool
  - grep_tool
  - read_tool
composes_with:
  - software-engineer
  - software-architect
  - qa-engineer
  - docker
  - kubernetes
  - git-vcs
  - kafka
  - aws
  - azure
  - ubuntu
  - redhat
  - rosa
  - openshift
---

## What this actually is

A `### Workspace context` block is injected into your system prompt automatically, once, at the
start of every top-level task (see `refreshWorkspaceInfo`/`buildSystemPrompt` in
`src/core/orchestrator.ts`) — file tree (capped at 400 entries), detected languages, package
manager(s), frameworks, whether the project is containerized/has CI configured, git branch/remote/
dirty-state, and `package.json` name/version/scripts/dependencies if present. **You do not need
to call any tool to see this** — it's already in front of you before your first action. This
skill is about knowing what's already there and when the one thing that *isn't* automatic
(re-checking after you change something) is actually needed.

## Process

1. Before exploring with `glob_tool`/`grep_tool`/`read_tool`, check what's already in the
   `### Workspace context` block — it usually answers "what language/framework is this," "is
   there a Dockerfile," "what's the current git branch," and "what are the build/test scripts"
   without spending a tool call on any of them.
2. Use the workspace context to choose which skill(s)/approach apply — e.g. `containerized: yes`
   and a language match are a strong signal to also consult the relevant DevOps skill (`docker`,
   `kubernetes`, etc.); a detected framework should shape how you search for relevant code
   (React project → look for `.tsx`/`.jsx` component files; Django → look for `models.py`/`views.py`).
3. Only call `workspace_info_tool(refresh=true)` when you've done something the automatic
   snapshot can't know about **yet**, specifically:
   - Installed or removed a dependency (`npm install`, `pip install`, etc.)
   - Created, deleted, or moved files/directories
   - Switched git branches or made a commit you need reflected (e.g. checking "is this now clean")
   - The task is long-running/multi-phase and significant time has passed since the initial snapshot
4. Don't call `workspace_info_tool` speculatively "just to check" with no state change since the
   last read — that's the exact duplicate/no-new-information pattern the health-scoring system
   penalizes (see `task-planning` skill) if the result comes back identical.

## Instructions — non-negotiable

- Never assume the initial snapshot is still accurate after you've made changes that could affect
  it (new files, new deps, branch switch) — re-check with `refresh=true` before making a
  decision that depends on current state (e.g. "is the working tree clean," "does this dependency
  exist yet").
- The file tree is capped (400 entries) and will say so when truncated — for a specific
  subdirectory's full contents, use `glob_tool` with a scoped pattern rather than assuming the
  capped tree is exhaustive for a large repo.
- The snapshot is structural/metadata only — it does not include file contents. For actual code
  content, use `read_tool`/`grep_tool`/`indexing_tool`, not `workspace_info_tool`.

## Strategies

- For a "get familiar with this codebase" style task, start from the workspace context's detected
  frameworks/package manager to decide where to look first, rather than a blind top-down `glob_tool`
  scan of the whole tree.
- When a task spans multiple phases (see `task-planning`), the workspace snapshot is refreshed
  once at the top level and shared by every phase/subagent via the same cache — you don't need to
  (and shouldn't) refresh it again at the start of each phase unless that specific phase changed
  workspace state itself.
- If `git.dirty` is true at task start and the task involves committing, decide explicitly whether
  those pre-existing uncommitted changes are in-scope for your commit or should be left alone —
  don't silently sweep unrelated changes into your commit.

## Experience

- The most common miss is not the automatic snapshot being wrong — it's forgetting to refresh
  after a dependency install and then reasoning ("this package isn't in dependencies") from stale
  data. If you just ran an install command, refresh before making any claim about what's installed.
- `frameworks`/`packageManagers` detection is heuristic (based on `package.json` deps and marker
  files), not exhaustive — treat an empty or surprising result as "not detected," not
  authoritative proof the framework isn't in use, and confirm with a targeted `read_tool`/`grep_tool`
  check if it matters for the task.
