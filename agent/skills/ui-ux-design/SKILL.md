---
name: ui-ux-design
role: design
description: Design and build professional, user-friendly interfaces — applies concrete visual-design heuristics (hierarchy, spacing, contrast, responsive behavior) instead of generic taste statements, and reuses an existing design-token system rather than inventing one-off styles per component.
triggers:
  - "ui design"
  - "ux design"
  - "ui/ux"
  - "user interface"
  - "user experience"
  - "design a"
  - "redesign"
  - "mockup"
  - "wireframe"
  - "page layout"
  - "responsive design"
  - "look professional"
  - "look and feel"
  - "polish the ui"
  - "component library"
  - "design system"
version: "1.0.0"
requires_tools:
  - read_tool
  - write_edit_tool
  - glob_tool
  - grep_tool
  - playwright_run_tool
composes_with:
  - task-planning
---

## Process

1. **Before writing a single style, find the existing design system.** `grep_tool` for a tokens
   file (`index.css`, `theme.ts`/`themes.ts`, `tailwind.config.*`, `tokens.*`) and for any shared
   component directory (commonly `components/ui/`). Reusing existing `--color-*`/`--space-*`
   tokens and primitives (`Card`, `Button`, `Badge`, etc.) is almost always correct; inventing a
   parallel set of ad-hoc inline styles is the single most common way UI work in an existing
   codebase ends up inconsistent. If no token system exists and the task is more than a one-off
   tweak, propose adding a minimal one (a handful of CSS custom properties for color/spacing/
   radius/typography) before styling individual components against it.
2. Identify the actual user and their primary task before laying out anything — a settings page
   optimized for "find the one toggle I need" looks different from a dashboard optimized for "scan
   everything at a glance". State this assumption explicitly if it isn't given.
3. Sketch the information hierarchy in words first (what's the single most important thing on this
   screen, what's secondary, what's tertiary/hidden-until-needed) — then map hierarchy to visual
   weight (size, color, position), not the other way around.
4. Build with the smallest reusable primitives first (buttons, cards, form fields, badges), then
   compose pages from them. A page-specific one-off style is a sign a primitive is missing.
5. Check responsive behavior and basic accessibility before calling it done (see checklists below).

## Instructions — non-negotiable

- **Never ship a broken asset reference.** If a component imports an image/logo/icon file, verify
  it exists on disk before referencing it (`glob_tool`/`read_tool`) — a missing asset silently
  renders as a broken image in production with no build error, and is one of the most common real
  defects in agent-generated UI work.
- **Use a real type scale and spacing scale, not arbitrary pixel values per component.** Pick (or
  reuse) a small fixed set — e.g. 4/8/12/16/24/32px spacing, 12/13/15/16/18/22/28px type — and use
  only those values. Arbitrary one-off values (`17px`, `23px`, `margin-top: 11px`) are a strong
  signal of an unplanned, inconsistent UI.
- **Never rely on color alone to convey state.** Error/success/warning states need an icon, label,
  or shape change in addition to color, for colorblind users and low-contrast displays.
- **Maintain WCAG AA contrast** (4.5:1 body text, 3:1 large text/UI components) for text against
  its background — this is checkable, not a matter of taste. When choosing an accent/brand color
  on a colored background, verify contrast rather than eyeballing it.
- **Design the empty, loading, and error states, not just the happy path.** A UI that only renders
  correctly with a full dataset present is unfinished. This is the single most common gap between
  demo-quality and production-quality UI work.
- **Test at least one narrow-viewport breakpoint** (≈375px) for anything that will be viewed on
  mobile, or explicitly scope the task to desktop-only if that's the actual constraint.

## Strategies — judgment calls

- Prefer subtraction over addition when a screen feels unpolished: remove borders/shadows/colors
  that aren't carrying hierarchy information before adding more visual elements to "fix" it.
- Motion should communicate state change (something opened, something loaded, something was
  confirmed), not decorate. A hover transition on an interactive element is worth it; a bouncing
  animation on page load usually isn't.
- Default to the platform's native form controls and interaction patterns unless there's a
  specific reason to customize — reinventing a `<select>` or checkbox as a custom component adds
  accessibility and cross-browser risk for little visual gain.
- When a design decision is genuinely subjective (exact accent hue, illustration style), make a
  reasonable choice and move forward rather than presenting the user with an open-ended menu of
  options — but do surface the assumption ("I picked a blue-based palette for X reason") so it's
  cheap to override.
- For dashboards/data-heavy screens: group related numbers into cards with a clear label and unit,
  avoid more than ~3 distinct accent colors on one screen, and default to showing trend/comparison
  (vs. yesterday, vs. target) rather than a bare number where that context is available.

## Verification checklist before calling UI work done

1. No hardcoded one-off colors/spacing that duplicate an existing token — search for the raw hex
   values or pixel numbers you just wrote and confirm they don't already exist as a token.
2. Every image/icon/font reference resolves to a real file or a real, reachable URL.
3. Loading, empty, and error states exist for anything that fetches data.
4. Keyboard navigation reaches every interactive element in a sensible order; nothing is
   mouse-hover-only for critical information.
5. If a build step exists (`vite build`, `npm run build`, etc.), run it — a UI change that doesn't
   build is not done, regardless of how it looks in a dev server.

## Experience — failure patterns worth naming

- Agent-authored UI frequently over-uses emoji as icons and gradient backgrounds as a substitute
  for actual visual hierarchy — both read as unpolished/template-like rather than professional.
  Prefer a small, consistent icon set (or none) and a restrained, mostly-neutral palette with one
  clear accent color.
- "Looks fine in isolation, inconsistent across pages" is the most common failure — it comes from
  styling each page independently instead of against shared tokens/primitives. Always check at
  least one other page in the app for whether the same visual decision was already made differently.
- Placeholder/gimmick copy and branding left over from a template or an earlier draft (mismatched
  product names, joke text, "Lorem ipsum") ships far more often than it should — grep for the
  product/brand name across UI source before finishing to make sure it's consistent everywhere.
