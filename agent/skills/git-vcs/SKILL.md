---
name: git-vcs
role: devops
description: Git workflow discipline — clean, atomic commits, safe branching/merging/rebasing, and the correct recovery command for common "I broke my git state" situations, using this project's github_tool (clone/fetch/pull/status/commit/push).
triggers:
  - "git repo"
  - "git log"
  - "git status"
  - "using git"
  - "commit"
  - "branch"
  - "merge conflict"
  - "rebase"
  - "pull request"
  - "git history"
  - "revert"
  - "cherry-pick"
version: "1.0.0"
requires_tools:
  - github_tool
  - run_command_tool
composes_with:
  - workspace-context
  - software-engineer
---

## Process

1. Before committing, check `status` and the actual diff (not just the file list) — stage exactly
   the intended changes. `files` defaults to `['.']` in this project's `github_tool`, which stages
   everything in the working tree; be deliberate about that when unrelated changes exist locally.
2. Write commit messages that state *why*, not just *what* — the diff already shows what changed;
   the message's job is the reasoning a diff can't express (why this approach, what it fixes, what
   it doesn't cover).
3. Keep commits atomic: one logical change per commit. A commit that mixes an unrelated formatting
   pass with a real fix makes `git blame`/`git bisect` far less useful later.
4. Pull/rebase onto the latest target branch before starting new work when working against a
   shared branch, to minimize conflict surface discovered at the end instead of the start.
5. Before pushing, re-read the actual diff being pushed (not just recall what you intended to
   change) — catches accidental debug code, unintended file inclusions, or leftover conflict markers.

## Instructions — non-negotiable

- Never force-push (`push --force`) to a shared/main branch — if history needs rewriting on a
  shared branch, coordinate explicitly or use `--force-with-lease` on a branch confirmed to be
  exclusively yours.
- Never commit secrets, credentials, or `.env` files — if one is committed by mistake, rotating the
  credential is required; removing it from a later commit does not remove it from history that's
  already been pushed/shared.
- Never resolve a merge conflict by blindly accepting "ours" or "theirs" wholesale without reading
  both sides — conflicts often mean both changes are needed, merged correctly, not one discarded.
- Never rewrite (rebase/amend) commits that have already been pushed and pulled by others, without
  explicit coordination.

## Strategies

- Prefer `rebase` for keeping a feature branch current with its base (linear, readable history) and
  `merge` for combining a completed feature branch back into a shared branch (preserves the actual
  point-in-time context of when work merged) — know which one the project's convention expects.
- Prefer small, frequent commits over one large commit at the end of a task — easier to review,
  easier to revert just the problematic part if something's wrong.
- When a change touches generated files (lockfiles, build output) alongside source, commit them
  together only if the project tracks generated files at all — check `.gitignore` first.

## Recovery commands for common situations

- Committed to the wrong branch, not yet pushed: `git reset --soft HEAD~1` on the wrong branch,
  switch to the correct branch, commit there.
- Need to undo a pushed commit without rewriting shared history: `git revert <sha>` (creates a new
  commit undoing it) rather than resetting/force-pushing.
- Merge conflict mid-rebase and want to abandon: `git rebase --abort` restores the pre-rebase state
  cleanly — always safe to bail out this way rather than trying to force through a confusing
  conflict state.
- Need one specific commit from another branch without merging everything: `git cherry-pick <sha>`.
- Accidentally staged something that shouldn't be committed: `git restore --staged <file>` (unstages
  without discarding the actual edit).

## Experience

- Most "git broke" panics have a clean, low-risk recovery command (see above) — resist the urge to
  delete and re-clone the repo, which loses any uncommitted local work.
- A conflict that reappears identically after a previous "resolution" usually means the resolution
  wasn't actually committed/staged correctly, not that the conflict is unresolvable — verify with
  `status` after resolving.
