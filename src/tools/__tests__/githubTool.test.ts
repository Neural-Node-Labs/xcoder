/**
 * Regression suite for githubTool.ts exercised against real local git repositories (git works
 * fully offline for local-path remotes, so clone/fetch/pull/push are tested for real rather
 * than mocked — this catches real argument-construction bugs that module-mocking would hide).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubClone, githubFetch, githubPull, githubStatus, githubCommit, githubPush } from "../githubTool.js";

let tmpDir: string;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, env: gitEnv }).toString();
}

/** Creates a local "remote" repo with one commit, returning its filesystem path. */
function makeRemoteRepo(dir: string): string {
  const remoteDir = path.join(dir, "remote.git");
  fs.mkdirSync(remoteDir);
  git(["init", "-q"], remoteDir);
  fs.writeFileSync(path.join(remoteDir, "README.md"), "hello");
  git(["add", "."], remoteDir);
  git(["commit", "-q", "-m", "initial commit"], remoteDir);
  git(["branch", "-M", "main"], remoteDir);
  return remoteDir;
}

/** githubCommit/githubPush shell out using the real process.env (no identity override), so
 *  every cloned working copy under test needs its own local git identity config. */
function configureIdentity(repoDir: string) {
  git(["config", "user.email", "test@example.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-github-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("githubClone", () => {
  it("clones a local repo into the target directory", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    const result = await githubClone(remote, target);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(target, "README.md"))).toBe(true);
  });

  it("clones a specific branch when given one", async () => {
    const remote = makeRemoteRepo(tmpDir);
    git(["checkout", "-q", "-b", "feature"], remote);
    fs.writeFileSync(path.join(remote, "feature.txt"), "x");
    git(["add", "."], remote);
    git(["commit", "-q", "-m", "feature commit"], remote);

    const target = path.join(tmpDir, "cloned-feature");
    const result = await githubClone(remote, target, "feature");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(target, "feature.txt"))).toBe(true);
  });

  it("reports a non-zero exit code for a nonexistent local remote", async () => {
    const result = await githubClone(path.join(tmpDir, "does-not-exist"), path.join(tmpDir, "out"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("githubFetch / githubPull", () => {
  it("fetch pulls down new commits without merging them into the working tree", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);

    fs.writeFileSync(path.join(remote, "new.txt"), "new content");
    git(["add", "."], remote);
    git(["commit", "-q", "-m", "add new file"], remote);

    const result = await githubFetch(target);
    expect(result.exitCode).toBe(0);
    // Fetch alone shouldn't materialize the new file in the working tree.
    expect(fs.existsSync(path.join(target, "new.txt"))).toBe(false);
  });

  it("pull merges new commits into the working tree", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);

    fs.writeFileSync(path.join(remote, "new.txt"), "new content");
    git(["add", "."], remote);
    git(["commit", "-q", "-m", "add new file"], remote);

    const result = await githubPull(target, "origin", "main");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(target, "new.txt"))).toBe(true);
  });

  it("defaults the remote to 'origin' when not specified", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    const result = await githubFetch(target);
    expect(result.exitCode).toBe(0);
  });
});

describe("githubStatus", () => {
  it("reports a clean tree right after clone", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    const result = await githubStatus(target);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("M ");
  });

  it("reports an untracked file after adding one", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    fs.writeFileSync(path.join(target, "untracked.txt"), "x");
    const result = await githubStatus(target);
    expect(result.stdout).toContain("untracked.txt");
  });
});

describe("githubCommit", () => {
  it("stages and commits real file changes", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    configureIdentity(target);
    fs.writeFileSync(path.join(target, "work.txt"), "work in progress");

    const result = await githubCommit(target, "add work.txt");
    expect(result.exitCode).toBe(0);

    const log = git(["log", "--oneline", "-1"], target);
    expect(log).toContain("add work.txt");
  });

  it("stops (without committing) when `git add` fails, and returns that failure", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    configureIdentity(target);

    const result = await githubCommit(target, "should not happen", ["definitely/does/not/exist.txt"]);
    expect(result.exitCode).not.toBe(0);
    const log = git(["log", "--oneline"], target);
    expect(log).not.toContain("should not happen");
  });

  it("only stages the specific files listed, not the whole tree", async () => {
    const remote = makeRemoteRepo(tmpDir);
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    configureIdentity(target);
    fs.writeFileSync(path.join(target, "included.txt"), "yes");
    fs.writeFileSync(path.join(target, "excluded.txt"), "no");

    await githubCommit(target, "partial commit", ["included.txt"]);

    const status = git(["status", "--short"], target);
    expect(status).toContain("excluded.txt"); // still untracked
    expect(status).not.toContain("included.txt"); // committed, so no longer shown
  });
});

describe("githubPush", () => {
  it("pushes local commits to the local-path remote", async () => {
    const remote = makeRemoteRepo(tmpDir);
    // Allow pushing into the currently checked-out branch of a non-bare repo.
    git(["config", "receive.denyCurrentBranch", "updateInstead"], remote);

    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    configureIdentity(target);
    fs.writeFileSync(path.join(target, "pushed.txt"), "pushed content");
    await githubCommit(target, "add pushed.txt");

    const result = await githubPush(target, "origin", "main");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(remote, "pushed.txt"))).toBe(true);
  });

  it("reports a non-zero exit code when pushing to a nonexistent remote branch/repo state fails", async () => {
    const remote = makeRemoteRepo(tmpDir); // denyCurrentBranch left at default (refuse)
    const target = path.join(tmpDir, "cloned");
    await githubClone(remote, target);
    configureIdentity(target);
    fs.writeFileSync(path.join(target, "x.txt"), "x");
    await githubCommit(target, "add x.txt");

    const result = await githubPush(target, "origin", "main");
    expect(result.exitCode).not.toBe(0);
  });
});
