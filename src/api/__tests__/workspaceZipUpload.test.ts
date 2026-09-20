import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { extractZipIntoWorkspace, WorkspaceZipError, WorkspacePathEscapeError } from "../workspaceFiles.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-zipupload-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, "utf-8"));
  return zip.toBuffer();
}

describe("extractZipIntoWorkspace — happy path", () => {
  it("extracts flat files into the workspace root", () => {
    const buf = zipOf({ "a.txt": "hello", "b.txt": "world" });
    const result = extractZipIntoWorkspace(root, ".", buf);

    expect(result.filesExtracted).toBe(2);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf-8")).toBe("world");
  });

  it("preserves nested directory structure and creates missing parents", () => {
    const buf = zipOf({ "src/index.ts": "export {}", "src/lib/util.ts": "export const x = 1;" });
    const result = extractZipIntoWorkspace(root, ".", buf);

    expect(result.filesExtracted).toBe(2);
    expect(fs.readFileSync(path.join(root, "src", "index.ts"), "utf-8")).toBe("export {}");
    expect(fs.readFileSync(path.join(root, "src", "lib", "util.ts"), "utf-8")).toBe("export const x = 1;");
  });

  it("extracts into a target subdirectory, confined within the workspace", () => {
    const buf = zipOf({ "readme.md": "# hi" });
    const result = extractZipIntoWorkspace(root, "uploads/batch1", buf);

    expect(result.filesExtracted).toBe(1);
    expect(fs.readFileSync(path.join(root, "uploads", "batch1", "readme.md"), "utf-8")).toBe("# hi");
  });

  it("reports accurate byte counts", () => {
    const buf = zipOf({ "a.txt": "12345" });
    const result = extractZipIntoWorkspace(root, ".", buf);
    expect(result.bytesWritten).toBe(5);
  });
});

describe("extractZipIntoWorkspace — zip-slip protection", () => {
  it("refuses an entry whose path escapes the target directory, and writes nothing at all", () => {
    const zip = new AdmZip();
    zip.addFile("safe.txt", Buffer.from("safe"));
    const evil = zip.addFile("placeholder.txt", Buffer.from("pwned"));
    evil.entryName = "../../evil.txt"; // bypass addFile's own name sanitization for this fixture
    const buf = zip.toBuffer();

    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(WorkspaceZipError);

    // All-or-nothing: the well-behaved "safe.txt" entry must NOT have been written either.
    expect(fs.existsSync(path.join(root, "safe.txt"))).toBe(false);
    // And nothing escaped upward.
    expect(fs.existsSync(path.join(path.dirname(root), "evil.txt"))).toBe(false);
  });

  it("refuses an entry with an absolute path baked in", () => {
    const zip = new AdmZip();
    const evil = zip.addFile("placeholder.txt", Buffer.from("pwned"));
    evil.entryName = "/etc/cron.d/evil";
    const buf = zip.toBuffer();

    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow();
    expect(fs.existsSync("/etc/cron.d/evil")).toBe(false);
  });
});

describe("extractZipIntoWorkspace — excluded directories", () => {
  it("skips node_modules/.git contents but still extracts everything else", () => {
    const buf = zipOf({
      "src/index.ts": "code",
      "node_modules/left-pad/index.js": "junk",
      ".git/HEAD": "ref: refs/heads/main",
    });
    const result = extractZipIntoWorkspace(root, ".", buf);

    expect(result.filesExtracted).toBe(1);
    expect(result.skipped).toContain("node_modules/left-pad/index.js");
    expect(result.skipped).toContain(".git/HEAD");
    expect(fs.existsSync(path.join(root, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("refuses a zip whose entries are entirely excluded, rather than silently extracting nothing", () => {
    const buf = zipOf({ "node_modules/x/index.js": "junk" });
    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(/nothing to extract/i);
  });
});

describe("extractZipIntoWorkspace — validation and limits", () => {
  it("rejects a non-zip buffer", () => {
    expect(() => extractZipIntoWorkspace(root, ".", Buffer.from("not a zip"))).toThrow(WorkspaceZipError);
  });

  it("rejects an empty zip", () => {
    const buf = new AdmZip().toBuffer();
    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(/empty/i);
  });

  it("rejects a single file over the per-file uncompressed size limit", () => {
    const zip = new AdmZip();
    // Random (incompressible) bytes so the per-file check trips before the ratio check would.
    zip.addFile("huge.bin", randomBytes(101 * 1024 * 1024));
    const buf = zip.toBuffer();
    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(/per-file limit/i);
  });

  it("rejects a zip whose entries look like a compression-ratio bomb", () => {
    const zip = new AdmZip();
    zip.addFile("zeros.bin", Buffer.alloc(3 * 1024 * 1024, 0)); // highly compressible, >1MB floor
    const buf = zip.toBuffer();
    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(/zip bomb/i);
    expect(fs.existsSync(path.join(root, "zeros.bin"))).toBe(false);
  });

  it("rejects a zip with more entries than the configured limit", () => {
    const zip = new AdmZip();
    // MAX_ZIP_ENTRIES is 5000 — one over is enough to trip the check without a slow test.
    for (let i = 0; i < 5001; i++) zip.addFile(`f${i}.txt`, Buffer.from("x"));
    const buf = zip.toBuffer();
    expect(() => extractZipIntoWorkspace(root, ".", buf)).toThrow(/entries/i);
  }, 20_000);
});

describe("extractZipIntoWorkspace — target path confinement", () => {
  it("refuses a target directory that itself escapes the workspace", () => {
    const buf = zipOf({ "a.txt": "hi" });
    expect(() => extractZipIntoWorkspace(root, "../../outside", buf)).toThrow(WorkspacePathEscapeError);
  });
});
