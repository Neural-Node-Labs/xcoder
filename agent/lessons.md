# Lessons

## Indexing: use byte offsets, not line numbers, for dump reconstruction
- **Pattern:** The workspace indexer (`src/indexing/indexer.ts`) originally stored
  `startLine`/`endLine` and reconstructed file content via `split("\n")`/`join("\n")`.
  This silently corrupted content: (1) off-by-one included the `<<< END: … <<<` marker,
  and (2) trailing newlines (and `\r` on CRLF files) were dropped.
- **Rule:** For any index/dump that must reconstruct original file bytes, store **byte
  offsets** and read back with `Buffer.slice(startByte, endByte).toString("utf-8")`.
  Never use `String.slice` with byte offsets — `String.slice` indexes UTF-16 code units
  and diverges on multi-byte UTF-8. Never rely on `split("\n")`/`join("\n")` for
  byte-exact round-trips.
- **Verification:** Always verify round-trip byte-exactness across *all* indexed files
  (not just a sample) after building an index.

## `.dockerignore` is NOT a workspace-index ignore source
- **Pattern:** `loadIgnoreRules` merged `.dockerignore` with `.gitignore`, which wrongly
  excluded `docs/`, `*.md` (incl. every SKILL.md), `scripts/`, `migrations/`, `LICENSE`
  from the workspace index. `.dockerignore` describes Docker *build-context* exclusions,
  not "what is not part of the project".
- **Rule:** For workspace indexing, `.gitignore` is the authoritative source for "not part
  of the project"; `.agent/.agentignore` is the agent-specific override. Do NOT merge
  `.dockerignore` into workspace-index ignore rules.
- **Verification:** After changing ignore rules, confirm the index still contains the
  files the agent needs (e.g. `.md` skill files) and excludes only genuine build
  artifacts/dependencies.

## The `indexing_tool` runs the agent's bundled code, not the workspace `dist/`
- **Pattern:** Calling `indexing_tool` (the MCP tool) regenerates the index using the
  agent runtime's own compiled copy of the indexer, which may be stale relative to
  `src/`/`dist/` edits made during the session.
- **Rule:** After fixing indexer source, verify the on-disk index actually reflects the
  fix (check `index.json` entry keys). If the tool still emits old-format output, run the
  corrected `dist/indexing/indexer.js` directly (`node --input-type=module -e "import { buildIndex } from './dist/indexing/indexer.js'; …"`).

## Verify "pre-existing" claims before asserting them
- **Pattern:** Claiming a build failure is "pre-existing" without checking git history is
  unverifiable. Confirm via `git diff HEAD -- <file>` that the offending lines are in
  uncommitted changes you did not author.
- **Rule:** When a build/test fails on code you didn't touch, run `git diff` to prove the
  failing region is not part of your changes before attributing it to pre-existing work.
