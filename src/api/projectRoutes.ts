import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import multer from "multer";
import {
  listProjects,
  getProject,
  addProject,
  updateProject,
  setActiveProject,
  deleteProject,
} from "./projectStore.js";
import { EXCLUDED, WORKSPACE_DIR_NAME } from "../core/workspaceManager.js";
import { ApiResponse } from "./types.js";


const require = createRequire(import.meta.url);
const archiver = require("archiver");

/** The authenticated caller, attached by authMiddleware (src/api/auth.ts) before any route in
 *  this file runs. Every handler below reads this rather than trusting anything in the request
 *  body/params — ownership is always resolved from the verified token, never a client-supplied
 *  userId, so there is no way to pass someone else's id and act as them. */
function authedUser(req: Request): { userId: string; isAdmin: boolean } {
  const user = (req as { user?: { userId: string; role: "admin" | "user" } }).user;
  // authMiddleware guarantees this is set for every route reachable from here (only /login,
  // /register, and /users/count skip it, none of which are project routes) — the fallback
  // below exists purely so a missing-auth bug fails closed (empty userId matches nothing)
  // rather than throwing a 500.
  return { userId: user?.userId ?? "", isAdmin: user?.role === "admin" };
}

/** Resolves the folder a project's file browser/download/delete operations act on: the
 *  isolated workspace-agent copy if one has been created by a run, otherwise the raw project
 *  path itself (e.g. a project that's never had a task run against it yet). */
function resolveWorkspaceRoot(projectPath: string): string {
  const isolated = path.join(projectPath, WORKSPACE_DIR_NAME);
  return fs.existsSync(isolated) ? isolated : projectPath;
}

interface WorkspaceFileEntry {
  name: string;
  path: string; // relative to the workspace root
  size: number;
  isDir: boolean;
}

function listDir(root: string, relSubPath: string): WorkspaceFileEntry[] {
  const dirPath = path.join(root, relSubPath);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => !EXCLUDED.has(e.name))
    .map((e) => {
      const entryRelPath = path.join(relSubPath, e.name);
      const fullPath = path.join(root, entryRelPath);
      const isDir = e.isDirectory();
      return {
        name: e.name,
        path: entryRelPath.split(path.sep).join("/"),
        size: isDir ? 0 : fs.statSync(fullPath).size,
        isDir,
      };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** Prevents a `path` query/body param like "../../etc/passwd" from escaping the workspace root. */
function safeResolve(root: string, relPath: string): string | null {
  const resolved = path.resolve(root, relPath || ".");
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) return null;
  return resolved;
}

export function registerProjectRoutes(router: Router): void {
  // Regular users see only their own projects. Admins can pass ?all=true to see every user's
  // projects for support/oversight purposes — never the default, so an admin's own dashboard
  // still shows just their own projects unless they explicitly ask for the oversight view.
  router.get("/projects", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const wantsAll = isAdmin && req.query.all === "true";
    const body: ApiResponse = { success: true, data: listProjects(userId, { allProjects: wantsAll }) };
    res.json(body);
  });

  // Projects only ever need a name now — the workspace folder is always created under this
  // user's own subtree of the forced ./workspace root (see PROJECTS_ROOT in projectStore.ts),
  // so there's no user-supplied path to fail with a permissions error, and no way to collide
  // with another user's workspace.
  router.post("/projects", (req: Request, res: Response) => {
    const { userId } = authedUser(req);
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: "'name' is required" } as ApiResponse);
      return;
    }
    const result = addProject(userId, name);
    if (result.error) {
      res.status(400).json({ success: false, error: result.error } as ApiResponse);
      return;
    }
    res.status(201).json({ success: true, data: result.project, created: result.created });
  });

  router.put("/projects/:id", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { name, includeInLlm } = req.body as { name?: string; includeInLlm?: boolean };
    const result = updateProject(String(req.params.id), userId, { name, includeInLlm }, { allowAnyOwner: isAdmin });
    if (result.error) {
      res.status(result.error === "Project not found" ? 404 : 400).json({ success: false, error: result.error } as ApiResponse);
      return;
    }
    res.json({ success: true, data: result.project, created: result.created });
  });

  router.post("/projects/:id/activate", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const result = setActiveProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (result.error) {
      res.status(404).json({ success: false, error: result.error } as ApiResponse);
      return;
    }
    res.json({ success: true, data: result.project } as ApiResponse);
  });

  router.delete("/projects/:id", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const result = deleteProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (!result.deleted) {
      res.status(404).json({ success: false, error: result.error } as ApiResponse);
      return;
    }
    res.json({ success: true, data: { deleted: true } } as ApiResponse);
  });

  // Browse workspace files. ?path=sub/dir to navigate into a subdirectory (defaults to root).
  router.get("/projects/:id/files", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const project = getProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (!project) {
      res.status(404).json({ success: false, error: "Project not found" } as ApiResponse);
      return;
    }
    const root = resolveWorkspaceRoot(project.path);
    const subPath = (req.query.path as string) || "";
    const resolved = safeResolve(root, subPath);
    if (!resolved) {
      res.status(400).json({ success: false, error: "Invalid path" } as ApiResponse);
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.json({ success: true, data: { files: [], workspaceRoot: root, path: subPath } } as ApiResponse);
      return;
    }
    try {
      const files = listDir(root, subPath);
      res.json({ success: true, data: { files, workspaceRoot: root, path: subPath } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // Delete a single file from the workspace.
  router.delete("/projects/:id/files", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const project = getProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (!project) {
      res.status(404).json({ success: false, error: "Project not found" } as ApiResponse);
      return;
    }
    const relPath = (req.body?.path as string) || (req.query.path as string);
    if (!relPath) {
      res.status(400).json({ success: false, error: "'path' is required" } as ApiResponse);
      return;
    }
    const root = resolveWorkspaceRoot(project.path);
    const resolved = safeResolve(root, relPath);
    if (!resolved || !fs.existsSync(resolved)) {
      res.status(404).json({ success: false, error: "File not found" } as ApiResponse);
      return;
    }
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      res.json({ success: true, data: { deleted: true, path: relPath } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // Real file upload into the workspace root (multipart/form-data, field name "file").
  // Optional "path" form field to upload into a subdirectory.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  router.post("/projects/:id/upload", upload.single("file"), (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const project = getProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (!project) {
      res.status(404).json({ success: false, error: "Project not found" } as ApiResponse);
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: "No file provided (expected multipart field 'file')" } as ApiResponse);
      return;
    }
    const root = resolveWorkspaceRoot(project.path);
    const subPath = (req.body?.path as string) || "";
    const targetDir = safeResolve(root, subPath);
    if (!targetDir) {
      res.status(400).json({ success: false, error: "Invalid target path" } as ApiResponse);
      return;
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const safeName = path.basename(req.file.originalname); // strip any path components from the filename itself
      const destPath = path.join(targetDir, safeName);
      fs.writeFileSync(destPath, req.file.buffer);
      const relPath = path.relative(root, destPath).split(path.sep).join("/");
      res.status(201).json({ success: true, data: { path: relPath, size: req.file.size } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // Deliverable download — zips the project's current workspace (isolated copy if one exists)
  // and streams it back as a real downloadable file.
  router.get("/projects/:id/download", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const project = getProject(String(req.params.id), userId, { allowAnyOwner: isAdmin });
    if (!project) {
      res.status(404).json({ success: false, error: "Project not found" } as ApiResponse);
      return;
    }
    const root = resolveWorkspaceRoot(project.path);
    if (!fs.existsSync(root)) {
      res.status(404).json({ success: false, error: "Workspace path does not exist on disk" } as ApiResponse);
      return;
    }

    const filename = `${project.name.replace(/[^a-z0-9_-]/gi, "_")}-${Date.now()}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: Error) => {
      console.error("[devnull API] zip stream error:", err);
      res.end();
    });
    archive.pipe(res);
    archive.glob("**/*", {
      cwd: root,
      ignore: [...EXCLUDED].map((e) => `**/${e}/**`),
      dot: false,
    });
    archive.finalize();
  });
}

