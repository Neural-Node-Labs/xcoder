// ronin:version 3 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:48.412Z | ronin:subtask code-st-f034f3
// MultiRoleRouter — TS semantic port of the reference Python brain_workflow/router.py.
// The Python provider/base_url/api_key config collapses away because the transport is always
// the single injected LlmClient (design D2). Per-role differences become model/temperature/
// responseFormat overrides on that one client.
import { LlmClient, LlmMessage } from "../types.js";
import { RoleConfig, RouterCall } from "./types.js";

export const DEFAULT_TEMPERATURE = 0.2;

export class LLMRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMRouterError";
  }
}

const VALID_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

export class MultiRoleRouter {
  private llm: LlmClient;
  private roles: Record<string, RoleConfig>;

  constructor(llm: LlmClient, roles: Record<string, RoleConfig>) {
    if (!roles || Object.keys(roles).length === 0) {
      throw new LLMRouterError("MultiRoleRouter requires at least one role in `roles`.");
    }
    this.llm = llm;
    this.roles = { ...roles };
  }

  get roleNames(): string[] {
    return Object.keys(this.roles);
  }

  hasRole(role: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.roles, role);
  }

  configForRole(role: string): RoleConfig {
    const cfg = this.roles[role];
    if (!cfg) {
      const known = Object.keys(this.roles).sort().join(", ");
      throw new LLMRouterError(`Unknown role '${role}'. Configured roles: ${known}.`);
    }
    return cfg;
  }

  addRole(name: string, config: RoleConfig): void {
    this.roles[name] = config;
  }

  /**
   * Send a chat completion request using the given role's configured model/temperature.
   * `model` explicitly given always wins (mirrors the Python router).
   * Returns the raw text content of the assistant's reply.
   * Throws LLMRouterError on unknown role or transport failure.
   */
  async chat(call: RouterCall): Promise<string> {
    const cfg = this.configForRole(call.role);
    const resolvedModel = call.model ?? cfg.model;
    const temperature = call.temperature ?? cfg.temperature ?? DEFAULT_TEMPERATURE;
    const responseFormat =
      call.responseFormat === true || call.responseFormat === "json_object" || cfg.responseFormat === "json_object"
        ? "json_object"
        : undefined;

    const messages: LlmMessage[] = call.messages
      .filter((m) => VALID_MESSAGE_ROLES.has(m.role))
      .map((m) => ({ role: m.role as LlmMessage["role"], content: m.content }));

    try {
      const response = await this.llm.complete(messages, {
        model: resolvedModel,
        temperature,
        responseFormat,
      });
      return response.content;
    } catch (err) {
      throw new LLMRouterError(
        `Router call failed for role '${call.role}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
