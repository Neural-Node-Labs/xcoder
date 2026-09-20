# xcoder UI — Test Scenario Catalog

Every scenario xcoder's UI is worth covering with an automated browser test, organized by
feature area. Each entry has an ID, a type, and an **Automated** column pointing at the spec
file that implements it — `—` means documented here as worth having, but not yet automated in
this pass (see "Not yet automated" at the bottom for why, area by area).

**Type key:**
- **Smoke** — the basic happy path; if this breaks, the feature is unusable. Run on every change.
- **Regression** — guards a specific bug that was found and fixed, or a specific security/role
  boundary that must never silently regress. Each one names the thing it protects.

See `README.md` in this folder for how to point the suite at a real running instance and what
accounts it expects to exist first.

---

## 1. Authentication

| ID | Type | Scenario | Automated |
|---|---|---|---|
| AUTH-01 | Smoke | First-run bootstrap: with zero users, the login screen shows "Create the first (admin) account" copy and registering signs the new admin straight in. | `auth.spec.ts` |
| AUTH-02 | Smoke | Valid username/password on an existing account logs in and lands on the app shell (sidebar + "Run a task" page). | `auth.spec.ts` |
| AUTH-03 | Regression | Wrong password shows an inline error ("Invalid username or password") and does **not** navigate away from the login screen. | `auth.spec.ts` |
| AUTH-04 | Regression | Logging out clears the session — the sidebar disappears and the login screen reappears; reloading the app does not silently re-authenticate. | `auth.spec.ts` |
| AUTH-05 | Regression | A stale/invalid token in localStorage (e.g. from a previous server restart, which wipes xcoder's in-memory token store) is force-cleared back to the login screen before the app shell ever renders, with a notice explaining that the session ended. | `auth.spec.ts` |
| AUTH-07 | Regression | The inverse of AUTH-05: a **valid** restored token survives a reload untouched — no login screen, no expiry notice. Guards against "fixing" stale sessions by distrusting every restored token, which would sign out every returning user. | `auth.spec.ts` |
| AUTH-06 | Regression | Repeated failed logins against the same username eventually show a rate-limit error ("Too many login attempts"), not a generic failure. | — (needs 10+ rapid requests; documented, not automated to avoid tripping the real limiter against a shared instance) |

## 2. Navigation & role gating

| ID | Type | Scenario | Automated |
|---|---|---|---|
| NAV-01 | Smoke | Every non-admin-only sidebar item is clickable and renders its page's heading for a logged-in user. | `navigation.spec.ts` |
| NAV-02 | Regression | A regular ("user"-role) account never sees the **Users** or **Audit log** nav items — these are `adminOnly` in `Sidebar.tsx`'s NAV table. | `navigation.spec.ts` |
| NAV-03 | Smoke | An admin account sees and can open every nav item, including the Admin section (Users, Audit log, Settings). | `navigation.spec.ts` |
| NAV-04 | Regression | The active nav item is visually marked (`.nav-item.active`) and stays in sync as you click between pages. | `navigation.spec.ts` |

## 3. Dashboard — Task tab

| ID | Type | Scenario | Automated |
|---|---|---|---|
| TASK-01 | Smoke | The Task tab loads with a task form (engine/project selectors populated from the server) and **no** Hologram — the emblem is Chat-only, since on the Task tab it pushed the form below the fold. | `dashboard-task.spec.ts` |
| TASK-02 | Smoke | Submitting a task with plan mode "Never" runs immediately and renders a Result card with iteration count and output text. Also asserts the result text appears **exactly once** on the page — the regression guard for the duplicated-response problem. | `dashboard-task.spec.ts` |
| TASK-03 | Smoke | Submitting a task with plan mode "Always" shows a plan for review with an "Approve & run" button before anything executes. | — (needs a real or mocked planning LLM call; documented for a future mocked-backend pass) |
| TASK-04 | Regression | If the server is running with `XCODER_MOCK_LLM=true`, the amber "MOCK LLM" banner is visible on the Task tab — so nobody mistakes simulated output for a real run. | `dashboard-task.spec.ts` |
| TASK-05 | Regression | The Run button is disabled with an empty task field, and the "New task" reset button returns the form to its idle state. | `dashboard-task.spec.ts` |
| TASK-06 | Regression | A task-run error (e.g. backend unreachable) renders in the Result card as a red error badge, not a silent failure or a stuck spinner. | — (needs a way to force a backend error; documented for a future mocked-route pass) |

## 4. Dashboard — Chat tab

| ID | Type | Scenario | Automated |
|---|---|---|---|
| CHAT-01 | Smoke | Switching to the Chat tab shows the centered Hologram (status line only, no readout box), an empty-state prompt, and the pill-shaped input bar at the bottom. | `dashboard-chat.spec.ts` |
| CHAT-02 | Smoke | Sending a message adds a user bubble, shows a "thinking…" bubble while in flight, then replaces it with the assistant's reply. Asserts the reply appears **exactly once** — the Hologram no longer echoes it. | `dashboard-chat.spec.ts` |
| CHAT-05 | Smoke | The Chat tab's model picker is populated from `GET /api/v1/models` and pre-selects the server's configured default, so sending a message requires no model choice. Skips its assertions when the server offers only one model. | `dashboard-chat.spec.ts` |
| CHAT-03 | Regression | Enter sends the message; Shift+Enter inserts a newline instead of sending. | `dashboard-chat.spec.ts` |
| CHAT-04 | Regression | On a failed send, the optimistic user bubble is rolled back and the typed text is restored to the input rather than silently vanishing. | — (needs a forced backend error; documented for a future mocked-route pass) |

## 5. Projects

| ID | Type | Scenario | Automated |
|---|---|---|---|
| PROJ-01 | Smoke | Creating a project by name adds it to "Your projects" and it becomes selectable elsewhere (Workspace, Task form, CodeGraph). | `projects.spec.ts` |
| PROJ-02 | Smoke | Clicking a project row expands a detail panel showing its ID, full path, created date, and "included in tasks" status. | `projects.spec.ts` |
| PROJ-03 | Smoke | "Index for CodeGraph" on a project's detail panel shows a result badge (success or a clear error) after running. | `projects.spec.ts` |
| PROJ-04 | Regression | A regular user's project list never shows an "View all users" toggle — that control only renders for `role === "admin"`. | `projects.spec.ts` |
| PROJ-05 | Regression | Removing a project asks for confirmation before it disappears from the list. | `projects.spec.ts` |

## 6. Workspace file browser

| ID | Type | Scenario | Automated |
|---|---|---|---|
| WS-01 | Smoke | Selecting a project lists its root files/folders; folders sort before files, alphabetically within each group. | `workspace.spec.ts` |
| WS-02 | Smoke | Creating a new file adds it to the listing and opens it in the editor pane immediately. | `workspace.spec.ts` |
| WS-03 | Smoke | Editing a file's content and clicking Save persists it — reopening the file (or another session) shows the saved content, and the "unsaved" badge clears. | `workspace.spec.ts` |
| WS-04 | Smoke | Creating a folder and navigating into it updates the breadcrumb trail; "Up" and clicking an earlier breadcrumb both navigate back out correctly. | `workspace.spec.ts` |
| WS-05 | Smoke | Deleting a file (after the confirm dialog) removes it from the listing; if it was open in the editor, the editor pane closes. | `workspace.spec.ts` |
| WS-06 | Regression | `node_modules`, `.git`, `dist`, `build`, and other excluded directories never appear in the file listing, even if they exist on disk. | `workspace.spec.ts` |
| WS-07 | Regression | The Save button stays disabled until the content actually differs from what was loaded (the "unsaved" badge and disabled state track real dirtiness, not just focus). | `workspace.spec.ts` |
| WS-08 | Smoke | Uploading a `.zip` extracts its contents into the current directory — nested folders are created, files land in the listing, and a result banner reports how many files/folders were extracted. | `workspace.spec.ts` |
| WS-09 | Regression | A zip whose contents include `node_modules`/`.git` extracts everything else normally and the result banner reports those entries as skipped, rather than the whole upload failing. | `workspace.spec.ts` |
| WS-10 | Regression | Selecting a non-`.zip` file for upload is rejected client-side with a clear error, before any request is sent. | `workspace.spec.ts` |

## 7. CodeGraph Explorer

| ID | Type | Scenario | Automated |
|---|---|---|---|
| CG-01 | Smoke | The CodeGraph tab loads its status/embedded panel without a client-side error, and shows a project picker populated from the user's projects. | `codegraph.spec.ts` |
| CG-02 | Regression | "Index this workspace" indexes whichever project is selected in the new dropdown — not silently whatever project happens to be globally "active" — and reports a per-run result badge. | `codegraph.spec.ts` |

## 8. Security Ops (Blue Team / Red Team) — the focus of this pass

| ID | Type | Scenario | Automated |
|---|---|---|---|
| SEC-01 | Smoke | The Security Ops page loads with the Blue Team tab selected by default, a populated "Check" dropdown, and the Target allowlist panel showing at least `localhost` as "always allowed". | `security-ops.spec.ts` |
| SEC-02 | Smoke | Switching to the Red Team tab swaps the "Check" dropdown to red-team tools and resets any in-progress form/result. | `security-ops.spec.ts` |
| SEC-03 | Smoke | Selecting a different check swaps the form fields shown (e.g. Blue Team's "Log scan" vs "Port audit" have different fields) and shows that tool's description. | `security-ops.spec.ts` |
| SEC-04 | Smoke | Running a local, offline Blue Team check (e.g. **Port audit** against `localhost`) returns a result with a level badge (OK/WARN/ERR) and readable output text. | `security-ops.spec.ts` |
| SEC-05 | Regression | Running a Red Team network check (e.g. **Port scanner**) against a target that is **not** on the allowlist is refused — the UI shows an ERR-level result whose text contains "REFUSED", proving the server-side `TARGET_ALLOWLIST` gate is actually reachable and visible from the UI, not just from a unit test. | `security-ops.spec.ts` |
| SEC-06 | Regression | **Phishing simulation sender** always renders as a disabled "Not implemented" button — never a runnable form — regardless of team/tool switching. | `security-ops.spec.ts` |
| SEC-07 | Regression | As an **admin**, the allowlist panel shows an "Add target" form and a "Remove" button next to every non-protected entry; adding a hostname makes it appear in the list immediately. | `security-ops.spec.ts` |
| SEC-08 | Regression | As a **non-admin**, the allowlist panel shows no "Add target" form and no "Remove" buttons — read-only, with a note to ask an admin — even though the same non-admin CAN still run checks. | `security-ops.spec.ts` |
| SEC-09 | Regression | `localhost`, `127.0.0.1`, and `::1` always show an "always allowed" badge instead of a Remove button, for every role — they can't be removed via the UI. | `security-ops.spec.ts` |

## 9. Audit log

| ID | Type | Scenario | Automated |
|---|---|---|---|
| AUD-01 | Smoke | As an admin, performing an audited action elsewhere (e.g. updating the Security Ops allowlist) causes a matching entry to appear on the Audit log page — actor, action tag, and a human-readable summary. | `audit-log.spec.ts` |
| AUD-02 | Regression | The filter box narrows the visible entries by actor/action/summary text without an extra network round-trip (client-side filter). | `audit-log.spec.ts` |
| AUD-03 | Regression | (Covered by NAV-02, restated here for emphasis) A non-admin never sees the Audit log nav item, so the audit trail of admin actions is never visible to a non-admin account. | `navigation.spec.ts` |

## 10. Settings

| ID | Type | Scenario | Automated |
|---|---|---|---|
| SET-01 | Smoke | The LLM provider card loads with the server's actual current provider selected (Ollama by default on a fresh install) and its model/base URL fields populated. | `settings.spec.ts` |
| SET-02 | Smoke | Choosing a different known provider (e.g. OpenAI) from the dropdown pre-fills that provider's known default model/base URL/API-key-env fields. | `settings.spec.ts` |
| SET-03 | Regression | Saving a provider change shows a success message confirming it takes effect on the next request **without** telling the user to restart the server — this specifically guards against the "requires a restart" claim that was investigated and found false; see `STATUS.md` §13. | `settings.spec.ts` |
| SET-04 | Regression | As a non-admin, attempting to save a provider change surfaces the server's 403 as a visible error rather than silently no-opping or crashing the page. | `settings.spec.ts` |
| SET-05 | Smoke | Setting and then removing the LLM API key updates the "Key configured" / "No key stored" badge accordingly. | `settings.spec.ts` |

## 11. Users (admin)

| ID | Type | Scenario | Automated |
|---|---|---|---|
| USR-01 | Smoke | An admin can create a new local user, see it appear in the list, edit its role, and delete it. | `users.spec.ts` |
| USR-02 | Regression | (Covered by NAV-02) The Users page itself is unreachable via the UI for a non-admin account — no nav entry exists to open it. | `navigation.spec.ts` |

---

## Not yet automated, and why

A handful of scenarios above are marked `—` rather than a spec file. Grouped by the reason,
since it's the same few reasons repeating:

- **Needs a forced backend failure** (TASK-06, CHAT-04): reliably triggering a real network/LLM
  error from the outside, without a request-mocking layer in front of this suite, isn't something
  worth faking through the real UI — these deserve either a Playwright `route.abort()`/`fulfill()`
  layer or a dedicated "break the backend on purpose" test hook, neither of which exists yet.
- **Needs a mocked LLM planning response** (TASK-03): plan mode's happy path depends on what a
  real model actually returns for a given task, which isn't deterministic enough to assert on
  without `XCODER_MOCK_LLM` returning a fixed, known plan shape — worth adding once that
  contract is confirmed.
- **Would deliberately trip a shared rate limiter** (AUTH-06): automating this against a real,
  possibly-shared instance risks locking out other real users/tests hitting the same limiter;
  it's better covered by the unit tests already in `src/api/__tests__/auth.test.ts`, which test
  the limiter directly without needing a browser.

None of these are missing because they don't matter — they're the ones that need either a mocking
layer this suite doesn't have yet, or a dedicated non-destructive way to trigger them.
