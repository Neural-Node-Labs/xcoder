// ronin:version 2 | ronin:task task-4508cb | ronin:updated 2026-08-13T15:45:35.498Z | ronin:subtask test-st-ec8121
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../skillRegistry.js";

const tempDirs: string[] = [];

function makeTempSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string, content: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), content, "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SkillRegistry parse robustness", () => {
  it("loads a skill whose SKILL.md has a leading HTML comment before frontmatter", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "html-comment-skill",
      [
        "<!-- ronin:version 1 | a fixture comment -->",
        "---",
        "name: html-comment-skill",
        "role: Fixture Fixture",
        "description: fixture skill",
        "triggers: [alpha, beta]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "",
        "Fixture body content.",
        "",
      ].join("\n")
    );

    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    const headers = registry.loadHeaders();

    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe("html-comment-skill");

    const loaded = registry.loadSkill("html-comment-skill");
    expect(loaded).toBeDefined();
    expect(loaded!.header.name).toBe("html-comment-skill");
    expect(loaded!.body).toBe("Fixture body content.");
  });

  it("reports legacy '# name:' comment metadata via listDiagnostics instead of silently skipping", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "legacy-skill",
      [
        "# name: legacy-skill",
        "# role: something",
        "# composes_with: []",
        "",
        "## Process",
        "do things",
        "",
      ].join("\n")
    );

    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    const headers = registry.loadHeaders();

    expect(headers).toHaveLength(0);
    const diagnostics = registry.listDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("LEGACY_METADATA");
    expect(diagnostics[0].path).toContain("legacy-skill");
  });

  it("tolerates a UTF-8 BOM before frontmatter", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "bom-skill",
      [
        "\uFEFF---",
        "name: bom-skill",
        "role: Fixture",
        "description: fixture with BOM",
        "triggers: [bom]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "BOM body",
        "",
      ].join("\n")
    );

    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    const headers = registry.loadHeaders();

    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe("bom-skill");
  });
});

describe("SkillRegistry real skills integration", () => {
  const dirs = [
    path.join("agent", "skills"),
    path.join("dist", "config", "agent", "skills"),
  ];

  for (const dir of dirs) {
    it(`loads all 37 skill headers from ${dir}`, () => {
      const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
      const headers = registry.loadHeaders();
      expect(headers).toHaveLength(37);
      expect(registry.listDiagnostics()).toHaveLength(0);
    });
  }

  it("routes greetings to the conversation skill", () => {
    const registry = new SkillRegistry(path.join("agent", "skills"), {
      onDiagnostic: () => {},
    });
    const routed = registry.route("hello");
    expect(routed[0].name).toBe("conversation");
  });

  it("routes file-cleanup tasks to the filesystem-management skill", () => {
    const registry = new SkillRegistry(path.join("agent", "skills"), {
      onDiagnostic: () => {},
    });
    const routed = registry.route("clean up files");
    expect(routed.map((h) => h.name)).toContain("filesystem-management");
    expect(routed[0].name).toBe("filesystem-management");
  });
});

describe("SkillRegistry routing and diagnostics edge cases", () => {
  it("matches single-word triggers at word boundaries and not inside longer words", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "greeter",
      [
        "---",
        "name: greeter",
        "role: Fixture",
        "description: fixture greeting skill",
        "triggers: [hi, hello]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Hello body",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });

    // Regression: "hi" must not match inside "matching".
    expect(registry.route("matching parenthesis")).toHaveLength(0);
    expect(registry.route("hi there")).toHaveLength(1);
    expect(registry.route("hello!")).toHaveLength(1);
    expect(registry.route("say hello to the team")).toHaveLength(1);
  });

  it("keeps phrase triggers intact via substring matching", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "cleaner",
      [
        "---",
        "name: cleaner",
        "role: Fixture",
        "description: fixture cleanup skill",
        "triggers: [\"clean up files\", \"tidy workspace\"]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Cleaner body",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });

    expect(registry.route("please clean up files now")).toHaveLength(1);
    expect(registry.route("clean")).toHaveLength(0);
  });

  it("ranks routed skills by trigger match count, highest first", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "double-hit",
      [
        "---",
        "name: double-hit",
        "role: Fixture",
        "description: two trigger hits",
        "triggers: [alpha, beta]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Body A",
        "",
      ].join("\n")
    );
    writeSkill(
      dir,
      "single-hit",
      [
        "---",
        "name: single-hit",
        "role: Fixture",
        "description: one trigger hit",
        "triggers: [alpha]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Body B",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });

    const routed = registry.route("alpha beta");
    expect(routed.map((h) => h.name)).toEqual(["double-hit", "single-hit"]);
  });

  it("emits DIR_NAME_MISMATCH but still loads the skill under its header name", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "folder-name",
      [
        "---",
        "name: header-name",
        "role: Fixture",
        "description: name differs from folder",
        "triggers: [alpha]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Body",
        "",
      ].join("\n")
    );
    const diagnostics: string[] = [];
    const registry = new SkillRegistry(dir, { onDiagnostic: (d) => diagnostics.push(d.code) });

    const headers = registry.loadHeaders();

    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe("header-name");
    expect(diagnostics).toContain("DIR_NAME_MISMATCH");
    expect(registry.listDiagnostics().map((d) => d.code)).toContain("DIR_NAME_MISMATCH");
  });

  it("reports NO_SKILL_MD when a skill directory has no SKILL.md", () => {
    const dir = makeTempSkillDir();
    fs.mkdirSync(path.join(dir, "empty-skill"), { recursive: true });

    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    registry.loadHeaders();

    const diagnostics = registry.listDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("NO_SKILL_MD");
    expect(diagnostics[0].path).toContain("empty-skill");
  });

  it("reports YAML_ERROR for invalid frontmatter YAML", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "bad-yaml",
      [
        "---",
        "name: [unclosed",
        "role: Fixture",
        "---",
        "Body",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    registry.loadHeaders();

    expect(registry.listDiagnostics().map((d) => d.code)).toContain("YAML_ERROR");
    expect(registry.list()).toHaveLength(0);
  });

  it("reports INVALID_HEADER when required fields are missing", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "bad-header",
      [
        "---",
        "name: bad-header",
        "role: Fixture",
        "version: 1.0",
        "---",
        "Body",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    registry.loadHeaders();

    const codes = registry.listDiagnostics().map((d) => d.code);
    expect(codes).toContain("INVALID_HEADER");
    expect(registry.list()).toHaveLength(0);
  });

  it("reports NO_FRONTMATTER for a markdown file with no YAML and no legacy marker", () => {
    const dir = makeTempSkillDir();
    writeSkill(dir, "no-fm", ["## Process", "do things", ""].join("\n"));
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    registry.loadHeaders();

    expect(registry.listDiagnostics()[0].code).toBe("NO_FRONTMATTER");
  });

  it("tolerates leading blank lines and CRLF line endings", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "crlf-skill",
      [
        "",
        "\r",
        "---\r",
        "name: crlf-skill\r",
        "role: Fixture\r",
        "description: CRLF fixture\r",
        "triggers: [crlf]\r",
        "version: 1.0\r",
        "requires_tools: []\r",
        "composes_with: []\r",
        "---\r",
        "\r",
        "CRLF body\r",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });
    const headers = registry.loadHeaders();

    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe("crlf-skill");
    expect(registry.loadSkill("crlf-skill")?.body).toBe("CRLF body");
  });

  it("returns undefined for loadSkill on an unknown name and lazily loads on list/route", () => {
    const dir = makeTempSkillDir();
    writeSkill(
      dir,
      "lazy-skill",
      [
        "---",
        "name: lazy-skill",
        "role: Fixture",
        "description: lazy",
        "triggers: [lazy]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Lazy body",
        "",
      ].join("\n")
    );
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });

    expect(registry.list()).toHaveLength(1);
    expect(registry.route("lazy task")).toHaveLength(1);
    expect(registry.loadSkill("does-not-exist")).toBeUndefined();
    expect(registry.loadSkill("lazy-skill")?.body).toBe("Lazy body");
  });

  it("resets diagnostics on each scan so listDiagnostics reflects only the last loadHeaders", () => {
    const dir = makeTempSkillDir();
    writeSkill(dir, "no-fm", ["## Process", "do things", ""].join("\n"));
    const registry = new SkillRegistry(dir, { onDiagnostic: () => {} });

    registry.loadHeaders();
    expect(registry.listDiagnostics()).toHaveLength(1);

    // Re-scan after fixing the file: diagnostics from the previous scan must be gone.
    writeSkill(
      dir,
      "no-fm",
      [
        "---",
        "name: no-fm",
        "role: Fixture",
        "description: fixed",
        "triggers: [fixed]",
        "version: 1.0",
        "requires_tools: []",
        "composes_with: []",
        "---",
        "Body",
        "",
      ].join("\n")
    );
    registry.loadHeaders();
    expect(registry.listDiagnostics()).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);
  });

  it("routes the repaired conversation skill for 'hi' but never for the substring in 'matching'", () => {
    const registry = new SkillRegistry(path.join("agent", "skills"), {
      onDiagnostic: () => {},
    });
    const routed = registry.route("matching is hard");
    for (const header of routed) {
      expect(header.name).not.toBe("conversation");
    }
    const direct = registry.route("hi");
    expect(direct.some((h) => h.name === "conversation")).toBe(true);
  });
});
