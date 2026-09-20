import { useState, useEffect, useCallback, useRef } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, Project, WorkspaceFileEntry, WorkspaceZipUploadResult } from "../api/client";

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function WorkspacePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [dirPath, setDirPath] = useState(".");
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);

  const [uploadingZip, setUploadingZip] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipResult, setZipResult] = useState<WorkspaceZipUploadResult | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const [cgIndexing, setCgIndexing] = useState(false);
  const [cgResult, setCgResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      const active = ps.find((p) => p.active);
      setProjectId(active?.id ?? ps[0]?.id);
    }).catch(() => {});
  }, []);

  const refreshList = useCallback(() => {
    setLoadingList(true);
    setListError(null);
    api.workspaceFiles(projectId, dirPath)
      .then((r) => setEntries(r.entries))
      .catch((e) => setListError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingList(false));
  }, [projectId, dirPath]);

  useEffect(() => {
    if (projectId !== undefined || projects.length === 0) refreshList();
  }, [refreshList, projectId, projects.length]);

  // Returning to the page: the project list and directory listing may have changed (project
  // added/removed, a task wrote files). Deliberately leaves the open file and its unsaved edits
  // alone — that's exactly the state this page is kept mounted to preserve.
  useOnActivate(() => {
    api.projects().then(setProjects).catch(() => {});
    refreshList();
  });

  function switchProject(id: string) {
    setProjectId(id);
    setDirPath(".");
    setOpenFile(null);
    setZipResult(null);
    setZipError(null);
  }

  function enterDir(p: string) {
    setDirPath(p);
    setOpenFile(null);
    setZipResult(null);
    setZipError(null);
  }

  function goUp() {
    if (dirPath === ".") return;
    const parts = dirPath.split("/");
    parts.pop();
    setDirPath(parts.length === 0 ? "." : parts.join("/"));
    setOpenFile(null);
    setZipResult(null);
    setZipError(null);
  }

  async function openFileForEdit(p: string) {
    setOpenFile(p);
    setFileError(null);
    setLoadingFile(true);
    try {
      const r = await api.workspaceFile(projectId, p);
      setContent(r.content);
      setOriginalContent(r.content);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
      setContent("");
      setOriginalContent("");
    } finally {
      setLoadingFile(false);
    }
  }

  async function saveFile() {
    if (!openFile) return;
    setSavingFile(true);
    setFileError(null);
    try {
      await api.writeWorkspaceFile(projectId, openFile, content);
      setOriginalContent(content);
      refreshList();
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingFile(false);
    }
  }

  async function createFile(e: React.FormEvent) {
    e.preventDefault();
    const name = newFileName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const filePath = dirPath === "." ? name : `${dirPath}/${name}`;
      await api.writeWorkspaceFile(projectId, filePath, "");
      setNewFileName("");
      refreshList();
      openFileForEdit(filePath);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const folderPath = dirPath === "." ? name : `${dirPath}/${name}`;
      await api.createWorkspaceDir(projectId, folderPath);
      setNewFolderName("");
      refreshList();
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function removeEntry(entry: WorkspaceFileEntry) {
    const kind = entry.type === "dir" ? "folder (and everything in it)" : "file";
    if (!confirm(`Delete this ${kind}? "${entry.name}"`)) return;
    try {
      await api.deleteWorkspacePath(projectId, entry.path);
      if (openFile === entry.path) setOpenFile(null);
      refreshList();
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadZip(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file name after an error, without a no-op change event
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setZipError("Only .zip files are accepted.");
      setZipResult(null);
      return;
    }

    setUploadingZip(true);
    setZipError(null);
    setZipResult(null);
    try {
      const result = await api.uploadWorkspaceZip(projectId, dirPath, file);
      setZipResult(result);
      refreshList();
    } catch (err) {
      setZipError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingZip(false);
    }
  }

  const dirty = content !== originalContent;
  const breadcrumbs = dirPath === "." ? [] : dirPath.split("/");

  async function indexInCodegraph() {
    setCgIndexing(true);
    setCgResult(null);
    try {
      const project = projects.find((p) => p.id === projectId);
      const result = await api.indexCodegraphWorkspace(projectId, project?.name);
      // The Explorer remembers its selected project in this same-origin localStorage key, so it
      // opens on what was just indexed.
      localStorage.setItem("codegraph_project_id", String(result.codegraphProjectId));
      setCgResult({ ok: true, message: `Indexed ${result.extractedFiles} file(s) as CodeGraph project "${result.codegraphProjectName}". Open CodeGraph in the sidebar to explore it.` });
    } catch (err) {
      setCgResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setCgIndexing(false);
    }
  }

  return (
    <div className="grid grid-2" style={{ alignItems: "start", gridTemplateColumns: "360px 1fr" }}>
      <div className="card">
        <div className="field">
          <label>Project</label>
          <select value={projectId ?? ""} onChange={(e) => switchProject(e.target.value)}>
            {projects.length === 0 && <option value="">No projects — using server working directory</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.active ? " (active)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-sm" onClick={indexInCodegraph} disabled={cgIndexing} title="Zip this project (skipping node_modules, .git, build output) and index it into CodeGraph">
            {cgIndexing ? <span className="spinner" /> : "◉ Index in CodeGraph"}
          </button>
          {cgResult && (
            <div className={`badge ${cgResult.ok ? "badge-green" : "badge-red"}`} style={{ display: "flex", marginTop: 8, whiteSpace: "normal" }}>
              {cgResult.message}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: "wrap", fontSize: 12 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => enterDir(".")} disabled={dirPath === "."}>
            root
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="row" style={{ gap: 6 }}>
              <span className="text-2">/</span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => enterDir(breadcrumbs.slice(0, i + 1).join("/"))}
                disabled={i === breadcrumbs.length - 1}
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {dirPath !== "." && (
          <button className="btn btn-sm" style={{ marginBottom: 10 }} onClick={goUp}>
            ↑ Up
          </button>
        )}

        {listError && <div className="badge badge-red" style={{ marginBottom: 10, display: "flex" }}>{listError}</div>}

        {loadingList ? (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">▢</div>
            Empty directory.
          </div>
        ) : (
          <div className="tool-list">
            {entries.map((entry) => (
              <div key={entry.path} className="tool-row row-between">
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ justifyContent: "flex-start", flex: 1, textAlign: "left" }}
                  onClick={() => (entry.type === "dir" ? enterDir(entry.path) : openFileForEdit(entry.path))}
                >
                  {entry.type === "dir" ? "▸ " : "▤ "}
                  {entry.name}
                  {entry.type === "file" && <span className="text-2" style={{ marginLeft: 8, fontSize: 11 }}>{formatSize(entry.size)}</span>}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => removeEntry(entry)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <form onSubmit={createFile} className="row" style={{ gap: 6 }}>
            <input placeholder="new-file.ts" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-sm" disabled={creating || !newFileName.trim()}>
              + File
            </button>
          </form>
          <form onSubmit={createFolder} className="row" style={{ gap: 6 }}>
            <input placeholder="new-folder" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-sm" disabled={creating || !newFolderName.trim()}>
              + Folder
            </button>
          </form>

          <button className="btn btn-sm" onClick={() => zipInputRef.current?.click()} disabled={uploadingZip}>
            {uploadingZip ? <span className="spinner" /> : "⇪ Upload zip"}
          </button>
          <input ref={zipInputRef} type="file" accept=".zip,application/zip" style={{ display: "none" }} onChange={uploadZip} />
          <div className="field-hint" style={{ marginTop: -4 }}>
            Extracts into {dirPath === "." ? "the current (root) folder" : `"${dirPath}"`}. Existing files with the same
            path are overwritten.
          </div>

          {zipError && <div className="badge badge-red" style={{ display: "flex" }}>{zipError}</div>}
          {zipResult && (
            <div className="badge badge-green" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span>
                Extracted {zipResult.filesExtracted} file{zipResult.filesExtracted === 1 ? "" : "s"}
                {zipResult.dirsCreated > 0 ? ` into ${zipResult.dirsCreated} folder${zipResult.dirsCreated === 1 ? "" : "s"}` : ""}.
              </span>
              {zipResult.skipped.length > 0 && (
                <span style={{ fontWeight: 400 }}>
                  Skipped {zipResult.skipped.length} entr{zipResult.skipped.length === 1 ? "y" : "ies"} inside excluded
                  directories (node_modules, .git, etc.).
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ minHeight: 420, display: "flex", flexDirection: "column" }}>
        {!openFile ? (
          <div className="empty-state">
            <div className="empty-state-icon">▤</div>
            Select a file to view or edit it.
          </div>
        ) : (
          <>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                {openFile}
                {dirty && <span className="badge badge-amber" style={{ marginLeft: 8 }}>unsaved</span>}
              </div>
              <button className="btn btn-sm btn-primary" onClick={saveFile} disabled={savingFile || !dirty}>
                {savingFile ? <span className="spinner" /> : "Save"}
              </button>
            </div>
            {fileError && <div className="badge badge-red" style={{ marginBottom: 10, display: "flex" }}>{fileError}</div>}
            {loadingFile ? (
              <div className="row text-2">
                <span className="spinner" /> Loading…
              </div>
            ) : (
              <textarea
                className="mono"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                style={{ flex: 1, minHeight: 380, width: "100%", resize: "vertical", fontSize: 12.5, lineHeight: 1.5 }}
                spellCheck={false}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
