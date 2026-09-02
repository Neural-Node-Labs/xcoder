import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface StoredProject {
  id: string;
  userId: string;
  name: string;
  path: string;
  active: boolean;
  includeInLlm: boolean;
  createdAt: string;
}

const STORE_PATH = process.env.DEVNULL_PROJECTS_STORE || path.join(os.homedir(), ".devnull", "projects.json");

/**
 * Every project workspace lives under this single, guaranteed-writable root instead of
 * wherever the user happened to type. Letting people type an arbitrary path (an absolute
 * Windows path copied from their own machine, a host path that doesn't exist inside the
 * container, a directory the process's user doesn't own, etc.) is exactly what produced
 * "unauthorized to create directory" errors. Now a project only ever needs a name — the
 * folder is always created at PROJECTS_ROOT/<userId>/<slug>.
 *
 * Multi-user isolation: every user gets their own subdirectory under PROJECTS_ROOT
 * (PROJECTS_ROOT/<userId>/...), so two users can both create a project named "backend" without
 * their workspace folders colliding, and — just as importantly — so a bug anywhere else in the
 * stack that forgets to filter by userId still can't make one user's files physically reachable
 * through another user's project path. The metadata layer (below) enforces ownership on every
 * read/write; the directory layout enforces it again at the filesystem level as a second,
 * independent line of defense.
 *
 * Override with DEVNULL_PROJECTS_ROOT if projects should live somewhere else (e.g. a mounted
 * volume in production). Defaults to ./workspace relative to the server's cwd.
 */
export const PROJECTS_ROOT = path.resolve(
  process.env.DEVNULL_PROJECTS_ROOT || path.join(process.cwd(), "workspace")
);

/** The root directory for a single user's projects: PROJECTS_ROOT/<userId>. */
export function userWorkspaceRoot(userId: string): string {
  return path.join(PROJECTS_ROOT, userId);
}

function ensureUserWorkspaceRoot(userId: string): void {
  fs.mkdirSync(userWorkspaceRoot(userId), { recursive: true });
}

/** Turns a project name into a filesystem-safe folder name: lowercase, anything that isn't
 *  a-z/0-9 collapsed to a single hyphen, leading/trailing hyphens trimmed. Falls back to
 *  "project" if nothing usable survives (e.g. a name that's all emoji/punctuation). */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** Appends -2, -3, ... until the folder name doesn't collide with another of this same user's
 *  stored project folders or a directory already sitting on disk from a previous run. Only
 *  checks within the user's own workspace root — two different users can both have a "backend"
 *  slug with no conflict, since they live under different PROJECTS_ROOT/<userId>/ trees. */
function uniqueSlug(userId: string, base: string, taken: Set<string>): string {
  const isFree = (candidate: string) => !taken.has(candidate) && !fs.existsSync(path.join(userWorkspaceRoot(userId), candidate));
  if (isFree(base)) return base;
  let n = 2;
  while (!isFree(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function load(): StoredProject[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return []; // corrupt store shouldn't take the whole API down
  }
}

function save(projects: StoredProject[]): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(projects, null, 2), "utf-8");
}

/**
 * Lists projects. For a regular user, always pass their own `userId` — this is the sole
 * enforcement point for "a user can only see their own projects" at the list level, so every
 * caller (route handler) must supply it rather than optionally omitting it.
 *
 * `opts.allProjects` (admin-only capability, gated by the caller checking role) returns every
 * user's projects unfiltered — used by the admin-facing project oversight view.
 */
export function listProjects(userId: string, opts?: { allProjects?: boolean }): StoredProject[] {
  const all = load();
  return opts?.allProjects ? all : all.filter((p) => p.userId === userId);
}

/**
 * Gets a single project by id, scoped to `userId` — returns undefined (not the project) if the
 * project exists but belongs to someone else, so callers can return a uniform 404 without
 * leaking whether the id exists at all. Pass `opts.allowAnyOwner: true` for admin-only routes
 * that are allowed to reach any user's project.
 */
export function getProject(id: string, userId: string, opts?: { allowAnyOwner?: boolean }): StoredProject | undefined {
  const project = load().find((p) => p.id === id);
  if (!project) return undefined;
  if (!opts?.allowAnyOwner && project.userId !== userId) return undefined;
  return project;
}

export interface AddProjectResult {
  project?: StoredProject;
  error?: string;
  /** True when the directory didn't exist yet and was created as part of this call, so callers
   *  can tell the user rather than silently creating folders on their filesystem. In practice
   *  this is now always true for a brand-new project, since the folder is freshly minted under
   *  PROJECTS_ROOT every time. */
  created?: boolean;
}

/** Creates a new project owned by `userId`. The workspace folder is always
 *  PROJECTS_ROOT/<userId>/<slug-of-name> — never a path the caller supplies, and always inside
 *  that user's own subtree — which is what makes this safe to call without any filesystem
 *  permissions surprises or cross-user path collisions. */
export function addProject(userId: string, name: string): AddProjectResult {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Project name is required" };

  const projects = load();
  const ownProjects = projects.filter((p) => p.userId === userId);
  if (ownProjects.some((p) => p.name.toLowerCase() === trimmedName.toLowerCase())) {
    return { error: `A project named "${trimmedName}" already exists` };
  }

  try {
    ensureUserWorkspaceRoot(userId);
  } catch (err) {
    return { error: `Could not create workspace directory for this user: ${err instanceof Error ? err.message : String(err)}` };
  }

  const takenSlugs = new Set(ownProjects.map((p) => path.basename(p.path)));
  const slug = uniqueSlug(userId, slugify(trimmedName), takenSlugs);
  const projectPath = path.join(userWorkspaceRoot(userId), slug);

  try {
    fs.mkdirSync(projectPath, { recursive: true });
  } catch (err) {
    return { error: `Could not create workspace directory: ${err instanceof Error ? err.message : String(err)}` };
  }

  const project: StoredProject = {
    id: crypto.randomUUID(),
    userId,
    name: trimmedName,
    path: projectPath,
    active: ownProjects.length === 0, // first project THIS USER adds becomes active for them
    includeInLlm: false,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  save(projects);
  return { project, created: true };
}

export interface UpdateProjectInput {
  name?: string;
  includeInLlm?: boolean;
}

/** Renaming a project only changes its display name — the workspace folder on disk keeps its
 *  original slug. (Renaming the folder too would mean rewriting `path` mid-run for anything
 *  that might currently be operating against it; safer to leave it put.)
 *
 *  Scoped to `userId` unless `opts.allowAnyOwner` (admin override): a project belonging to
 *  someone else is treated as not found, same as getProject(). */
export function updateProject(id: string, userId: string, updates: UpdateProjectInput, opts?: { allowAnyOwner?: boolean }): AddProjectResult {
  const projects = load();
  const project = projects.find((p) => p.id === id);
  if (!project || (!opts?.allowAnyOwner && project.userId !== userId)) return { error: "Project not found" };

  if (updates.name !== undefined) {
    const trimmedName = updates.name.trim();
    if (!trimmedName) return { error: "Project name is required" };
    if (projects.some((p) => p.id !== id && p.userId === project.userId && p.name.toLowerCase() === trimmedName.toLowerCase())) {
      return { error: `A project named "${trimmedName}" already exists` };
    }
    project.name = trimmedName;
  }
  if (updates.includeInLlm !== undefined) project.includeInLlm = updates.includeInLlm;

  save(projects);
  return { project };
}

/**
 * Marks a project active for its owner. "Active" is a per-user concept: activating one of
 * user A's projects only ever clears the active flag on user A's OTHER projects — it never
 * touches user B's active project, since each user independently has at most one active
 * project among their own.
 */
export function setActiveProject(id: string, userId: string, opts?: { allowAnyOwner?: boolean }): AddProjectResult {
  const projects = load();
  const target = projects.find((p) => p.id === id);
  if (!target || (!opts?.allowAnyOwner && target.userId !== userId)) return { error: "Project not found" };
  for (const p of projects) {
    if (p.userId === target.userId) p.active = p.id === id;
  }
  save(projects);
  return { project: target };
}

/** Returns the given user's active project, if they have one. Used to resolve "which workspace
 *  does this task run against" when the caller didn't specify a projectId explicitly — always
 *  scoped to the requesting user, never falling back to some other user's active project. */
export function getActiveProject(userId: string): StoredProject | undefined {
  return load().find((p) => p.userId === userId && p.active);
}

export function deleteProject(id: string, userId: string, opts?: { allowAnyOwner?: boolean }): { deleted: boolean; error?: string } {
  const projects = load();
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1 || (!opts?.allowAnyOwner && projects[index].userId !== userId)) {
    return { deleted: false, error: "Project not found" };
  }
  const [removed] = projects.splice(index, 1);
  // If the active project was removed, promote another one of THIS OWNER'S remaining projects
  // so there's always an active project per-user when they still have at least one left.
  if (removed.active) {
    const nextForOwner = projects.find((p) => p.userId === removed.userId);
    if (nextForOwner) nextForOwner.active = true;
  }
  save(projects);
  return { deleted: true };
}
