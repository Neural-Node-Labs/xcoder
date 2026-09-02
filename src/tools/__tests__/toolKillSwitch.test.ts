import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchToolCall } from "../toolDispatcher.js";
import type { ToolCall } from "../../core/types.js";

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

afterEach(() => {
  delete process.env.DEVNULL_DISABLE_SHELL_TOOLS;
  delete process.env.DEVNULL_DISABLE_NETWORK_TOOLS;
});

describe("tool kill switches (security fix — no per-tenant sandboxing, so operators need a way to fully disable shell/network tools)", () => {
  it("DEVNULL_DISABLE_SHELL_TOOLS blocks run_command_tool at the dispatch layer", async () => {
    process.env.DEVNULL_DISABLE_SHELL_TOOLS = "1";
    const result = await dispatchToolCall(call("run_command_tool", { command: "echo hi" }), "/tmp");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.observation)).toContain("disabled");
  });

  it("DEVNULL_DISABLE_SHELL_TOOLS blocks every ssh_*/docker_* tool, not just run_command_tool", async () => {
    process.env.DEVNULL_DISABLE_SHELL_TOOLS = "1";
    for (const name of ["ssh_tool", "ssh_copy_tool", "ssh_run_command", "docker_compose_deploy_tool", "docker_deploy_ssh_tool"]) {
      const result = await dispatchToolCall(call(name, {}), "/tmp");
      expect(result.isError, `${name} should be blocked`).toBe(true);
    }
  });

  it("DEVNULL_DISABLE_NETWORK_TOOLS blocks outbound-fetch tools independently of the shell switch", async () => {
    process.env.DEVNULL_DISABLE_NETWORK_TOOLS = "1";
    for (const name of ["playwright_run_tool", "crawl_and_generate_playwright_test_tool", "crawl_site_mapper_tool", "summarize_url_tool", "api_test_tool", "github_tool"]) {
      const result = await dispatchToolCall(call(name, {}), "/tmp");
      expect(result.isError, `${name} should be blocked`).toBe(true);
    }
  });

  it("tools NOT in either dangerous group are unaffected by either kill switch", async () => {
    process.env.DEVNULL_DISABLE_SHELL_TOOLS = "1";
    process.env.DEVNULL_DISABLE_NETWORK_TOOLS = "1";
    // workspace_info_tool takes no required args and is side-effect-light — a safe probe that
    // it reaches real dispatch logic instead of being blocked.
    const result = await dispatchToolCall(call("workspace_info_tool", {}), "/tmp");
    expect(JSON.stringify(result.observation)).not.toContain("DEVNULL_DISABLE");
  });

  it("with neither env var set, dangerous tools are NOT blocked by the kill switch (default: available)", async () => {
    // Confirms the switches are genuinely opt-in — reaching a real (likely different) error
    // from the tool's own argument validation, not the kill-switch's "disabled" message.
    const result = await dispatchToolCall(call("run_command_tool", { command: "true" }), "/tmp");
    expect(JSON.stringify(result.observation)).not.toContain("DEVNULL_DISABLE_SHELL_TOOLS is set");
  });

  it("'true' and '1' are both accepted truthy values for the kill switches", async () => {
    process.env.DEVNULL_DISABLE_SHELL_TOOLS = "true";
    const result = await dispatchToolCall(call("run_command_tool", { command: "echo hi" }), "/tmp");
    expect(result.isError).toBe(true);
  });
});
