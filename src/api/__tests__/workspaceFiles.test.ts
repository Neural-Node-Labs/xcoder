import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  writeWorkspaceFile,
  createWorkspaceDirectory,
  deleteWorkspacePath,
  WorkspacePathEscapeError,
  WorkspaceBinaryFileError,
} from "../workspaceFiles.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-workspacefiles-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listWorkspaceDirectory", () => {
  it("lists files and directories, directories first then alphabetical", () => {
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.mkdirSync(path.join(root, "zdir"));
    const entries = listWorkspaceDirectory(root, ".");
    expect(entries.map((e) => e.name)).toEqual(["zdir", "a.txt", "b.txt"]);
    expect(entries[0].type).toBe("dir");
    expect(entries[1].type).toBe("file");
  });

  it("returns an empty array for a nonexistent directory rather than throwing", () => {
    expect(listWorkspaceDirectory(root, "does/not/exist")).toEqual([]);
  });

  it("skips excluded directories like node_modules and .git", () => {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "src"));
    const entries = listWorkspaceDirectory(root, ".");
    expect(entries.map((e) => e.name)).toEqual(["src"]);
  });

  it("uses forward-slash relative paths for nested entries regardless of host OS", () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "x");
    const entries = listWorkspaceDirectory(root, "src");
    expect(entries[0].path).toBe("src/index.ts");
  });

  it("refuses a path-traversal attempt", () => {
    expect(() => listWorkspaceDirectory(root, "../../etc")).toThrow(WorkspacePathEscapeError);
  });
});

describe("readWorkspaceFile / writeWorkspaceFile", () => {
  it("writes then reads back a file, creating missing parent directories", () => {
    writeWorkspaceFile(root, "nested/dir/file.txt", "hello world");
    const { content, size } = readWorkspaceFile(root, "nested/dir/file.txt");
    expect(content).toBe("hello world");
    expect(size).toBe(Buffer.byteLength("hello world"));
  });

  it("overwrites an existing file", () => {
    writeWorkspaceFile(root, "a.txt", "first");
    writeWorkspaceFile(root, "a.txt", "second");
    expect(readWorkspaceFile(root, "a.txt").content).toBe("second");
  });

  it("throws for a file that looks binary (contains a null byte)", () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    expect(() => readWorkspaceFile(root, "bin.dat")).toThrow(WorkspaceBinaryFileError);
  });

  it("refuses to read a path that escapes the workspace root", () => {
    expect(() => readWorkspaceFile(root, "../outside.txt")).toThrow(WorkspacePathEscapeError);
  });

  it("refuses to write a path that escapes the workspace root", () => {
    expect(() => writeWorkspaceFile(root, "../outside.txt", "x")).toThrow(WorkspacePathEscapeError);
  });

  it("refuses an absolute path even if it happens to still be inside root", () => {
    expect(() => readWorkspaceFile(root, path.join(root, "a.txt"))).toThrow(WorkspacePathEscapeError);
  });
});

describe("createWorkspaceDirectory", () => {
  it("creates a nested directory", () => {
    createWorkspaceDirectory(root, "a/b/c");
    expect(fs.statSync(path.join(root, "a", "b", "c")).isDirectory()).toBe(true);
  });

  it("is a no-op if the directory already exists", () => {
    createWorkspaceDirectory(root, "a");
    expect(() => createWorkspaceDirectory(root, "a")).not.toThrow();
  });
});

describe("deleteWorkspacePath", () => {
  it("deletes a file", () => {
    writeWorkspaceFile(root, "a.txt", "x");
    deleteWorkspacePath(root, "a.txt");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("deletes a directory recursively", () => {
    writeWorkspaceFile(root, "dir/a.txt", "x");
    deleteWorkspacePath(root, "dir");
    expect(fs.existsSync(path.join(root, "dir"))).toBe(false);
  });

  it("refuses to delete the workspace root itself", () => {
    expect(() => deleteWorkspacePath(root, ".")).toThrow(/Refused/);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("is a no-op (doesn't throw) deleting something that doesn't exist", () => {
    expect(() => deleteWorkspacePath(root, "nope.txt")).not.toThrow();
  });
});
