import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// projectStore.ts reads XCODER_PROJECTS_ROOT / XCODER_PROJECTS_STORE at module load time, so
// both must be set before the first import. A fresh temp dir per test file run keeps this
// completely isolated from the real ~/.xcoder and from any other test file's workspace.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-projectstore-"));
process.env.XCODER_PROJECTS_ROOT = path.join(tmpRoot, "workspace");
process.env.XCODER_PROJECTS_STORE = path.join(tmpRoot, "projects.json");

const {
  PROJECTS_ROOT,
  userWorkspaceRoot,
  listProjects,
  getProject,
  addProject,
  updateProject,
  setActiveProject,
  getActiveProject,
  deleteProject,
} = await import("../projectStore.js");

const USER_A = "user-a-11111111";
const USER_B = "user-b-22222222";

function resetStore() {
  fs.rmSync(process.env.XCODER_PROJECTS_STORE!, { force: true });
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
}

beforeEach(resetStore);

describe("per-user isolation: workspace directories", () => {
  it("creates each user's projects under their own PROJECTS_ROOT/<userId> subtree", () => {
    const a = addProject(USER_A, "backend");
    const b = addProject(USER_B, "backend"); // same name, different owner — must not collide

    expect(a.project?.path).toBe(path.join(userWorkspaceRoot(USER_A), "backend"));
    expect(b.project?.path).toBe(path.join(userWorkspaceRoot(USER_B), "backend"));
    expect(a.project?.path).not.toBe(b.project?.path);
    expect(fs.existsSync(a.project!.path)).toBe(true);
    expect(fs.existsSync(b.project!.path)).toBe(true);
  });

  it("two different users CAN have identically-named projects with no error", () => {
    const a = addProject(USER_A, "shared-name");
    const b = addProject(USER_B, "shared-name");
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
  });

  it("the SAME user CANNOT create two projects with the same name", () => {
    addProject(USER_A, "backend");
    const dup = addProject(USER_A, "backend");
    expect(dup.error).toMatch(/already exists/);
  });
});

describe("per-user isolation: listProjects", () => {
  it("only returns the requesting user's own projects by default", () => {
    addProject(USER_A, "a1");
    addProject(USER_A, "a2");
    addProject(USER_B, "b1");

    const aList = listProjects(USER_A);
    const bList = listProjects(USER_B);

    expect(aList.map((p) => p.name).sort()).toEqual(["a1", "a2"]);
    expect(bList.map((p) => p.name)).toEqual(["b1"]);
  });

  it("returns every user's projects when allProjects is requested (admin oversight)", () => {
    addProject(USER_A, "a1");
    addProject(USER_B, "b1");
    const all = listProjects(USER_A, { allProjects: true });
    expect(all.map((p) => p.name).sort()).toEqual(["a1", "b1"]);
  });
});

describe("per-user isolation: getProject", () => {
  it("returns undefined for another user's project (looks identical to a nonexistent id)", () => {
    const a = addProject(USER_A, "secret-project");
    const asOwner = getProject(a.project!.id, USER_A);
    const asOther = getProject(a.project!.id, USER_B);
    const asNonexistent = getProject("00000000-0000-0000-0000-000000000000", USER_B);

    expect(asOwner?.id).toBe(a.project!.id);
    expect(asOther).toBeUndefined();
    expect(asNonexistent).toBeUndefined();
  });

  it("allowAnyOwner lets an admin-scoped call reach any user's project", () => {
    const a = addProject(USER_A, "secret-project");
    const asAdmin = getProject(a.project!.id, USER_B, { allowAnyOwner: true });
    expect(asAdmin?.id).toBe(a.project!.id);
  });
});

describe("per-user isolation: updateProject", () => {
  it("cannot rename another user's project (reports not-found, not a permission error)", () => {
    const a = addProject(USER_A, "original-name");
    const result = updateProject(a.project!.id, USER_B, { name: "hijacked" });
    expect(result.error).toBe("Project not found");
    expect(getProject(a.project!.id, USER_A)?.name).toBe("original-name");
  });

  it("owner can rename their own project", () => {
    const a = addProject(USER_A, "original-name");
    const result = updateProject(a.project!.id, USER_A, { name: "renamed" });
    expect(result.project?.name).toBe("renamed");
  });

  it("name-collision check is scoped per-user, not global", () => {
    addProject(USER_A, "taken");
    const b = addProject(USER_B, "other");
    // USER_B renaming to "taken" is fine — USER_A having that name doesn't block USER_B.
    const result = updateProject(b.project!.id, USER_B, { name: "taken" });
    expect(result.error).toBeUndefined();
    expect(result.project?.name).toBe("taken");
  });

  it("admin allowAnyOwner can update another user's project", () => {
    const a = addProject(USER_A, "original-name");
    const result = updateProject(a.project!.id, USER_B, { name: "admin-renamed" }, { allowAnyOwner: true });
    expect(result.project?.name).toBe("admin-renamed");
  });
});

describe("per-user isolation: active project", () => {
  it("each user's active project is independent of every other user's", () => {
    const a1 = addProject(USER_A, "a1");
    const a2 = addProject(USER_A, "a2");
    const b1 = addProject(USER_B, "b1");

    expect(getActiveProject(USER_A)?.id).toBe(a1.project!.id); // first project defaults active
    expect(getActiveProject(USER_B)?.id).toBe(b1.project!.id);

    setActiveProject(a2.project!.id, USER_A);

    expect(getActiveProject(USER_A)?.id).toBe(a2.project!.id);
    // Activating user A's second project must NOT have touched user B's active project at all.
    expect(getActiveProject(USER_B)?.id).toBe(b1.project!.id);
  });

  it("cannot activate another user's project", () => {
    const b1 = addProject(USER_B, "b1");
    const result = setActiveProject(b1.project!.id, USER_A);
    expect(result.error).toBe("Project not found");
  });

  it("admin allowAnyOwner can activate on behalf of another user", () => {
    const b1 = addProject(USER_B, "b1");
    const b2 = addProject(USER_B, "b2");
    setActiveProject(b2.project!.id, USER_A, { allowAnyOwner: true });
    expect(getActiveProject(USER_B)?.id).toBe(b2.project!.id);
  });
});

describe("per-user isolation: deleteProject", () => {
  it("cannot delete another user's project", () => {
    const a = addProject(USER_A, "keep-me");
    const result = deleteProject(a.project!.id, USER_B);
    expect(result.deleted).toBe(false);
    expect(getProject(a.project!.id, USER_A)).toBeDefined();
  });

  it("deleting the active project promotes another of the SAME owner's projects, never another user's", () => {
    const a1 = addProject(USER_A, "a1"); // becomes active
    addProject(USER_A, "a2");
    const b1 = addProject(USER_B, "b1"); // becomes active for B independently

    deleteProject(a1.project!.id, USER_A);

    const remainingA = listProjects(USER_A);
    expect(remainingA).toHaveLength(1);
    expect(remainingA[0].active).toBe(true);
    expect(remainingA[0].name).toBe("a2");
    // User B's active project must be completely unaffected.
    expect(getActiveProject(USER_B)?.id).toBe(b1.project!.id);
  });

  it("admin allowAnyOwner can delete another user's project", () => {
    const b1 = addProject(USER_B, "b1");
    const result = deleteProject(b1.project!.id, USER_A, { allowAnyOwner: true });
    expect(result.deleted).toBe(true);
  });
});

describe("CRUD completeness (create, read, update, delete, activate)", () => {
  it("supports the full lifecycle for a single user across multiple projects", () => {
    // Create
    const p1 = addProject(USER_A, "alpha");
    const p2 = addProject(USER_A, "beta");
    expect(p1.error).toBeUndefined();
    expect(p2.error).toBeUndefined();

    // Read (list + single)
    expect(listProjects(USER_A)).toHaveLength(2);
    expect(getProject(p1.project!.id, USER_A)?.name).toBe("alpha");

    // Update
    const updated = updateProject(p1.project!.id, USER_A, { name: "alpha-renamed", includeInLlm: true });
    expect(updated.project?.name).toBe("alpha-renamed");
    expect(updated.project?.includeInLlm).toBe(true);

    // Activate
    setActiveProject(p2.project!.id, USER_A);
    expect(getActiveProject(USER_A)?.name).toBe("beta");

    // Delete
    const del = deleteProject(p1.project!.id, USER_A);
    expect(del.deleted).toBe(true);
    expect(listProjects(USER_A)).toHaveLength(1);
    expect(listProjects(USER_A)[0].name).toBe("beta");
  });
});
