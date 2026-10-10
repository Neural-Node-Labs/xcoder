import type { Request, Response, Router } from "express";
import { principalOf } from "../gate.js";
import { requireFeature, requireTenantMember } from "../guards.js";
import { KINDS, create, get, list, remove, summary, update, type Kind } from "./crmStore.js";

/** CRM API. Mounted behind: authMiddleware -> tenantGate (tenant context + `crm` switch) -> here (tenant members only; SaaS staff are refused). */
export function registerCrmRoutes(router: Router): void {
  const me = (req: Request) => principalOf(req);
  const pre = [requireFeature(me, "crm"), requireTenantMember(me)];
  const kindOf = (req: Request, res: Response): Kind | null => { const k = String(req.params.kind) as Kind; if (!KINDS.includes(k)) { res.status(404).json({ success: false, error: "Unknown CRM collection" }); return null; } return k; };

  router.get("/crm/summary", ...pre, (_req, res) => res.json({ success: true, data: summary() }));
  router.get("/crm/:kind", ...pre, (req, res) => {
    const kind = kindOf(req, res); if (!kind) return;
    const filter: Record<string, string> = {};
    for (const f of ["stage", "type", "companyId", "contactId", "dealId"]) if (typeof req.query[f] === "string") filter[f] = req.query[f] as string;
    res.json({ success: true, data: list(kind, { search: typeof req.query.search === "string" ? req.query.search : undefined, filter, limit: Number(req.query.limit) || undefined }) });
  });
  router.get("/crm/:kind/:id", ...pre, (req, res) => {
    const kind = kindOf(req, res); if (!kind) return; const r = get(kind, String(req.params.id));
    r ? res.json({ success: true, data: r }) : res.status(404).json({ success: false, error: "Not found" });
  });
  router.post("/crm/:kind", ...pre, (req, res) => {
    const kind = kindOf(req, res); if (!kind) return; const r = create(kind, req.body, me(req)!.userId);
    typeof r === "string" ? res.status(400).json({ success: false, error: r }) : res.status(201).json({ success: true, data: r });
  });
  router.put("/crm/:kind/:id", ...pre, (req, res) => {
    const kind = kindOf(req, res); if (!kind) return; const r = update(kind, String(req.params.id), req.body);
    r === undefined ? res.status(404).json({ success: false, error: "Not found" }) : typeof r === "string" ? res.status(400).json({ success: false, error: r }) : res.json({ success: true, data: r });
  });
  router.delete("/crm/:kind/:id", ...pre, (req, res) => {
    const kind = kindOf(req, res); if (!kind) return;
    remove(kind, String(req.params.id)) ? res.json({ success: true, data: { id: req.params.id } }) : res.status(404).json({ success: false, error: "Not found" });
  });
}
