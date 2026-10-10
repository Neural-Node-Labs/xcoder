// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { canSee, defaultPage } from "../access";
import { FeatureSwitches } from "../pages/FeatureSwitches";
import type { FeatureInfo } from "../api/client";

const f = (o: Partial<FeatureInfo>): FeatureInfo => ({ id: "crm", label: "CRM", description: "d", kind: "module", sensitive: false, platformOnly: false, platformEnabled: true, platformLocked: false, tenantEnabled: true, canTenantToggle: true, ...o });

describe("navigation access", () => {
  it("single-tenant: admins see users/audit, others do not; SaaS pages hidden", () => {
    expect(canSee("users", { role: "admin", saasMode: false })).toBe(true);
    expect(canSee("users", { role: "user", saasMode: false })).toBe(false);
    expect(canSee("saas", { role: "admin", saasMode: false })).toBe(false);
    expect(canSee("crm", { role: "user", saasMode: false, features: [] })).toBe(false);
  });
  it("SaaS owner/ops get the admin console and no tenant content", () => {
    for (const role of ["saas_owner", "saas_ops"] as const) {
      expect(canSee("saas", { role, saasMode: true, features: ["saas_management"] })).toBe(true);
      for (const p of ["dashboard", "crm", "projects", "workspace"] as const) expect(canSee(p, { role, saasMode: true, features: ["crm"] })).toBe(false);
      expect(defaultPage({ role, saasMode: true })).toBe("saas");
    }
    expect(canSee("auditlog", { role: "saas_ops", saasMode: true })).toBe(false);
  });
  it("tenant members never see platform pages; module switches hide pages", () => {
    for (const role of ["tenant_admin", "tenant_user"] as const) {
      expect(canSee("saas", { role, saasMode: true, features: ["crm"] })).toBe(false);
      expect(canSee("users", { role, saasMode: true })).toBe(false);
      expect(canSee("codegraph", { role, saasMode: true, features: ["codegraph"] })).toBe(false);
      expect(canSee("crm", { role, saasMode: true, features: ["crm"] })).toBe(true);
      expect(canSee("crm", { role, saasMode: true, features: [] })).toBe(false);
      expect(canSee("tenant", { role, saasMode: true, features: [] })).toBe(true);
    }
  });
});

afterEach(cleanup);
describe("FeatureSwitches", () => {
  it("tenant admin cannot enable a sensitive feature or a locked one", () => {
    render(<FeatureSwitches mode="tenant-admin" onToggle={vi.fn()} features={[f({ id: "shell_tools", label: "Shell", sensitive: true, tenantEnabled: false, canTenantToggle: false })]} />);
    expect((screen.getByLabelText("Enable Shell") as HTMLButtonElement).disabled).toBe(true);
  });
  it("tenant admin can toggle a normal module", () => {
    const fn = vi.fn();
    render(<FeatureSwitches mode="tenant-admin" onToggle={fn} features={[f({})]} />);
    fireEvent.click(screen.getByLabelText("Disable CRM"));
    expect(fn).toHaveBeenCalledWith("crm", false);
  });
  it("platform switches honour an env lock", () => {
    render(<FeatureSwitches mode="platform" onToggle={vi.fn()} features={[f({ platformLocked: true })]} />);
    expect((screen.getByLabelText("Disable CRM") as HTMLButtonElement).disabled).toBe(true);
  });
});
