/**
 * Dispatcher-level tests for security_ops_tool (src/tools/securityOpsTool.ts wired into
 * src/tools/toolDispatcher.ts). Exercises the real dispatch path — schema presence, routing,
 * observation shape, the network kill switch, and the TARGET_ALLOWLIST refusal — without
 * mocking runSecurityTool itself, since its blue-team local checks and the allowlist refusal
 * path are all real, offline, and safe to run in CI.
 */
import { describe, it, expect, afterEach } from "vitest";
import { dispatchToolCall } from "../toolDispatcher.js";
import { TOOL_SCHEMAS } from "../toolSchemas.js";
import type { ToolCall } from "../../core/types.js";

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

afterEach(() => {
  delete process.env.XCODER_DISABLE_NETWORK_TOOLS;
});

describe("security_ops_tool schema", () => {
  it("is registered in TOOL_SCHEMAS with team/toolId/params", () => {
    const schema = TOOL_SCHEMAS.find((s) => s.function.name === "security_ops_tool");
    expect(schema).toBeDefined();
    expect(schema!.function.parameters.required).toEqual(["team", "toolId"]);
    expect(schema!.function.parameters.properties).toHaveProperty("team");
    expect(schema!.function.parameters.properties).toHaveProperty("toolId");
    expect(schema!.function.parameters.properties).toHaveProperty("params");
  });
});

describe("security_ops_tool dispatch", () => {
  it("routes a blue-team offline check through to runSecurityTool and returns its result shape", async () => {
    const result = await dispatchToolCall(
      call("security_ops_tool", { team: "blue", toolId: "port_audit", params: { host: "localhost", expected_ports: "22,80,443" } }),
      "/tmp"
    );
    expect(result.isError).toBe(false);
    const obs = result.observation as { level: string; text: string };
    expect(["ok", "warn", "err"]).toContain(obs.level);
    expect(typeof obs.text).toBe("string");
  });

  it("runs the offline password-strength audit with no network access", async () => {
    const result = await dispatchToolCall(
      call("security_ops_tool", { team: "red", toolId: "password_strength_audit", params: { hash_type: "sha256", hashes: "not-a-real-hash" } }),
      "/tmp"
    );
    expect(result.isError).toBe(false);
    const obs = result.observation as { level: string; text: string };
    expect(obs.text).toContain("checked offline");
  });

  it("refuses a red-team network action against a host not on the TARGET_ALLOWLIST, without throwing", async () => {
    const result = await dispatchToolCall(
      call("security_ops_tool", { team: "red", toolId: "port_scanner", params: { target: "definitely-not-allowlisted.example", port_range: "80", scan_type: "connect" } }),
      "/tmp"
    );
    expect(result.isError).toBe(false);
    const obs = result.observation as { level: string; text: string };
    expect(obs.level).toBe("err");
    expect(obs.text).toContain("REFUSED");
  });

  it("phishing_simulation_sender always reports not-implemented rather than sending anything", async () => {
    const result = await dispatchToolCall(call("security_ops_tool", { team: "red", toolId: "phishing_simulation_sender" }), "/tmp");
    expect(result.isError).toBe(false);
    const obs = result.observation as { level: string; text: string };
    expect(obs.level).toBe("err");
    expect(obs.text).toContain("Not implemented");
  });

  it("returns an error observation (not a thrown exception) for an unknown toolId", async () => {
    const result = await dispatchToolCall(call("security_ops_tool", { team: "blue", toolId: "not_a_real_tool" }), "/tmp");
    expect(result.isError).toBe(false);
    const obs = result.observation as { level: string; text: string };
    expect(obs.level).toBe("err");
    expect(obs.text).toContain("Unknown tool");
  });

  it("flags missing required args (team/toolId) before ever calling runSecurityTool", async () => {
    const result = await dispatchToolCall(call("security_ops_tool", {}), "/tmp");
    expect(result.isError).toBe(true);
  });
});

describe("security_ops_tool respects XCODER_DISABLE_NETWORK_TOOLS", () => {
  it("is blocked at the dispatch layer when the network kill switch is set, even for a local-only action", async () => {
    process.env.XCODER_DISABLE_NETWORK_TOOLS = "1";
    const result = await dispatchToolCall(
      call("security_ops_tool", { team: "blue", toolId: "port_audit", params: { host: "localhost", expected_ports: "22" } }),
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.observation)).toContain("disabled");
  });

  it("runs normally when the kill switch is unset", async () => {
    const result = await dispatchToolCall(
      call("security_ops_tool", { team: "blue", toolId: "port_audit", params: { host: "localhost", expected_ports: "22" } }),
      "/tmp"
    );
    expect(JSON.stringify(result.observation)).not.toContain("XCODER_DISABLE_NETWORK_TOOLS is set");
  });
});
