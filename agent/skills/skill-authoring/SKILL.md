---
name: skill-authoring
role: meta
description: Author new role skills for xcoder's own hot-pluggable skill system (agent/skills/<name>/SKILL.md) — correct frontmatter, well-scoped triggers, and a body that actually changes agent behavior instead of restating generic advice.
triggers:
  - "create a skill"
  - "new skill"
  - "add a skill"
  - "author a skill"
  - "build a skill"
  - "skill for"
  - "write a skill"
  - "skill.md"
  - "skill registry"
version: "1.0.0"
requires_tools:
  - read_tool
  - write_edit_tool
  - glob_tool
  - grep_tool
composes_with:
  - ui-ux-design
  - task-planning
---

## Purpose

This skill is for when the task is to extend xcoder itself — adding a new role skill so future
tasks route to specialized instructions instead of the generic base ReAct loop. It is a meta-skill:
it does not solve the user's underlying problem, it produces a well-formed `SKILL.md` that will.

## How xcoder actually loads skills (read this before writing anything)

`src/core/skillRegistry.ts` is the source of truth — re-read it if this ever drifts:

- Skills live at `agent/skills/<name>/SKILL.md` (one directory per skill; the directory name
  doesn't have to match `name` in the frontmatter, but keep them identical to avoid confusion).
- The file MUST match `^---\n(yaml)\n---\n(body)$` — a YAML frontmatter block bounded by `---`
  lines, then a markdown body. `loadHeaders()` parses ONLY the frontmatter (cheap, called often);
  `loadSkill()` parses frontmatter + body (only when a skill is actually selected).
- `route(taskDescription)` lowercases the task text and, for every skill, counts how many of its
  `triggers` are substrings of it. Skills with score > 0 are returned sorted by score descending.
  Multiple skills can and do fire for the same task — that's intentional (`composes_with` documents
  which skills are expected to be selected together).
- There is no dedup, no stemming, no fuzzy match. `"deploy"` will not match `"deployment"` unless
  you also list `"deployment"`. Write triggers as the literal substrings a real task description
  would contain, including short synonyms and common phrasings — but not words so short/common
  they'd false-positive on unrelated tasks (a bad trigger like `"add"` or `"fix"` will make a skill
  fire on nearly everything).

## The frontmatter schema (exact — matches `SkillHeader` in `src/core/types.ts`)

```yaml
name: kebab-case-unique-id       # must be unique across agent/skills/*
role: short-noun-phrase          # e.g. "design", "planning", "meta", "devops" — used for display
description: one sentence, third person, states what the skill is for and when it applies
triggers:
  - "phrase one"
  - "phrase two"                 # lowercase; substring match against the lowercased task text
version: "1.0.0"                 # semver as a string
requires_tools:                  # tool names this skill's instructions assume are available
  - some_tool
composes_with:                   # names of OTHER skills this one is commonly selected alongside
  - other-skill-name
```

All seven keys are required by the `SkillHeader` interface — an omitted key will still parse as
YAML but will be `undefined` at runtime and can break anything that reads it (e.g. `role` showing
as `undefined` in `xcoder --skills`). Fill in every field even if a list is empty (`[]`).

## Writing a body that changes behavior (the part that's easy to get wrong)

A skill body that just restates domain knowledge the model already has adds tokens without adding
value. A good skill body encodes the things that are true of *this specific codebase or workflow*
that the model can't otherwise infer:

- **Concrete conventions**: exact file paths, exact tool names, exact naming patterns this project
  uses (e.g. "phase reports go to `tasks/<slug>-phase-<N>.md`", not "save your progress somewhere").
- **Decision rules tied to how the agent is actually scored or evaluated** — if there's a scoring
  or validation mechanism (see the `task-planning` skill for this project's health-score system),
  reference it by name and describe the specific behaviors it rewards/penalizes, not generic
  "write good code" advice.
- **Failure patterns worth naming** — a skill earns its keep by preventing a mistake the model
  would otherwise make on this exact class of task.

Recommended section structure (matches the `LoadedSkill.body` doc comment — "Process / Strategies
/ Instructions / Planning / Experience" — use the subset that's actually useful, don't pad):

```markdown
## Process
The concrete step order for this kind of task.

## Instructions
Non-negotiable rules — the things that are wrong if skipped.

## Strategies
Judgment calls / tradeoffs / "prefer X over Y when...".

## Experience
Known failure modes and how to recognize/avoid them.
```

## Checklist before considering a new skill done

1. Frontmatter has all 7 keys, `name` is unique, `triggers` are realistic lowercase substrings.
2. `requires_tools` lists only tools that actually exist (check `src/tools/toolSchemas.ts` — grep
   for `"_tool"` to get the current list rather than assuming).
3. `composes_with` references skills that actually exist under `agent/skills/`.
4. The body contains at least one thing a generalist model would NOT already know or would get
   wrong without it. If you can't identify that thing, the task probably doesn't need a new skill.
5. Sanity-check by running `xcoder --skills` (uses `loadHeaders()`) to confirm it parses and shows
   up with the right role/triggers, and test that the intended task phrasing actually routes to it
   via `SkillRegistry.route(...)` logic (substring match, case-insensitive).

## Common mistakes

- Triggers that are single common words (`"design"`, `"plan"`) with no accompanying context words —
  causes the skill to fire on unrelated tasks and dilutes routing quality for everything else.
- Forgetting `version`/`requires_tools`/`composes_with` because they "don't seem important" — they
  parse fine as `undefined` and the failure only shows up later, somewhere else.
- A body that's a generic essay instead of project-specific, actionable instructions.
- Copy-pasting another skill's triggers "just in case" — this makes two skills fire together on
  tasks that only need one, bloating the context sent to the LLM for no benefit.
