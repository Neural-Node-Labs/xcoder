// ronin:version 1 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:44:09.162Z | ronin:subtask code-st-f034f3
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeProcedure } from "../stepExecution.js";
import { LlmClient, LlmResponse } from "../../types.js";
import { Procedure } from "../types.js";

function makeLlm(): LlmClient {
  return {
    complete: vi.fn(async (): Promise<LlmResponse> => ({
      content: "llm-call-result",
      toolCalls: [],
      reasoningContent: undefined,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
  };
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "step-exec-"));
}

describe("executeProcedure", () => {
  it("runs a trivial shell step under workspaceRoot and concatenates outputs", async () => {
    const workspaceRoot = tmpWorkspace();
    const procedure: Procedure = {
      procedureId: "p1",
      steps: [
        {
          stepId: "s1",
          name: "echo done",
          action: "shell",
          command: "echo done",
          dependsOn: [],
          onFailure: "halt",
          maxRetries: 1,
        },
      ],
    };

    const report = await executeProcedure(procedure, { llm: makeLlm(), workspaceRoot });

    expect(report.status).toBe("completed");
    expect(report.stepReports).toHaveLength(1);
    expect(report.stepReports[0].ok).toBe(true);
    expect(report.finalOutput).toContain("done");
  });

  it("honors dependsOn ordering", async () => {
    const workspaceRoot = tmpWorkspace();
    const procedure: Procedure = {
      procedureId: "p2",
      steps: [
        { stepId: "a", name: "first", action: "shell", command: "echo first", dependsOn: [], onFailure: "halt", maxRetries: 1 },
        { stepId: "b", name: "second", action: "shell", command: "echo second", dependsOn: ["a"], onFailure: "halt", maxRetries: 1 },
      ],
    };

    const report = await executeProcedure(procedure, { llm: makeLlm(), workspaceRoot });

    expect(report.status).toBe("completed");
    expect(report.stepReports.map((s) => s.stepId)).toEqual(["a", "b"]);
    expect(report.finalOutput).toContain("first");
    expect(report.finalOutput).toContain("second");
  });

  it("halts the procedure when a halt-on-failure step fails", async () => {
    const workspaceRoot = tmpWorkspace();
    const procedure: Procedure = {
      procedureId: "p3",
      steps: [
        { stepId: "a", name: "fail", action: "shell", command: "this-command-definitely-does-not-exist-xyz", dependsOn: [], onFailure: "halt", maxRetries: 1 },
        { stepId: "b", name: "never", action: "shell", command: "echo never", dependsOn: ["a"], onFailure: "halt", maxRetries: 1 },
      ],
    };

    const report = await executeProcedure(procedure, { llm: makeLlm(), workspaceRoot });

    expect(report.status).toBe("halted");
    expect(report.stepReports.map((s) => s.stepId)).toEqual(["a"]);
  });

  it("runs an llm_call step through the injected LlmClient", async () => {
    const workspaceRoot = tmpWorkspace();
    const llm = makeLlm();
    const procedure: Procedure = {
      procedureId: "p4",
      steps: [
        {
          stepId: "s1",
          name: "ask the model",
          action: "llm_call",
          command: "summarize the plan",
          dependsOn: [],
          onFailure: "skip",
          maxRetries: 1,
        },
      ],
    };

    const report = await executeProcedure(procedure, { llm, workspaceRoot });

    expect(report.status).toBe("completed");
    expect(report.finalOutput).toContain("llm-call-result");
  });

  it("reports file write steps through the dispatcher", async () => {
    const workspaceRoot = tmpWorkspace();
    const procedure: Procedure = {
      procedureId: "p5",
      steps: [
        {
          stepId: "s1",
          name: "write file",
          action: "file",
          command: JSON.stringify({ op: "write", path: "out.txt", content: "hello" }),
          dependsOn: [],
          onFailure: "halt",
          maxRetries: 1,
        },
      ],
    };

    const report = await executeProcedure(procedure, { llm: makeLlm(), workspaceRoot });

    expect(report.status).toBe("completed");
    expect(fs.readFileSync(path.join(workspaceRoot, "out.txt"), "utf-8")).toBe("hello");
  });
});
