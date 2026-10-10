import type { LlmClient, LlmMessage, LlmResponse, ToolSchema } from "../core/types.js";
import { currentTenant } from "./context.js";
import { isSaasMode } from "./roles.js";
import { quotaExceeded, recordUsage } from "./usage.js";

type Opts = { model?: string; temperature?: number; tools?: ToolSchema[]; responseFormat?: "json_object" };

/** Wraps an LlmClient: refuses calls once the tenant's monthly allowance is spent, and records tokens used. Pass-through outside SaaS mode. */
export class MeteredLlmClient implements LlmClient {
  constructor(private inner: LlmClient, private o: { byo?: boolean } = {}) {}
  async complete(messages: LlmMessage[], opts?: Opts): Promise<LlmResponse> {
    const ctx = currentTenant();
    if (!isSaasMode() || !ctx) return this.inner.complete(messages, opts);
    if (ctx.role === "saas_owner" || ctx.role === "saas_ops") return this.inner.complete(messages, opts);
    // Own key = the tenant pays the provider directly: usage is still recorded, but the platform allowance does not apply.
    const over = this.o.byo ? null : quotaExceeded(ctx.tenantId);
    if (over) throw new Error(over);
    const r = await this.inner.complete(messages, opts);
    recordUsage(ctx.tenantId, { tokens: r.usage?.totalTokens ?? 0, requests: 1 });
    return r;
  }
}
export const metered = (c: LlmClient, o: { byo?: boolean } = {}): LlmClient => (isSaasMode() ? new MeteredLlmClient(c, o) : c);
