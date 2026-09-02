---
name: azure
role: devops
description: Design and operate Azure infrastructure — resource group/subscription organization, least-privilege RBAC via Entra ID, and correct compute service choice, plus the standard diagnostic sequence for connectivity and permission failures.
triggers:
  - "azure"
  - "microsoft azure"
  - "azure ad"
  - "entra id"
  - "resource group"
  - "azure vm"
  - "aks"
  - "azure functions"
  - "bicep"
  - "arm template"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - read_tool
  - write_edit_tool
composes_with:
  - workspace-context
  - kubernetes
  - docker
---

## Process

1. Choose compute by workload shape, not familiarity: Azure Functions for short event-driven work;
   Container Apps/AKS for containerized services (Container Apps if you don't want to manage
   cluster infrastructure, AKS if you need full Kubernetes control); Azure VMs only when you need
   OS-level control the platform services don't give you.
2. Organize resources into resource groups by lifecycle, not by type — things that get created and
   deleted together (an environment's full stack) belong in one resource group, so a teardown is a
   single resource-group delete rather than hunting down every individual resource.
3. Use Entra ID (formerly Azure AD) roles and managed identities for service-to-service auth
   instead of connection strings/keys embedded in app config wherever the target service supports
   it (most first-party Azure services do).
4. Use Bicep or Terraform for infrastructure definition rather than manual portal changes — same
   reasoning as AWS: reproducibility, review, and safe rollback.
5. Apply Azure Policy and tagging (environment, owner, cost-center) at the subscription or
   management-group level so new resources inherit governance instead of relying on every deploy
   remembering to tag correctly.

## Instructions — non-negotiable

- Never embed a storage account key or connection string in source control — use managed
  identities or, where a secret must exist, Azure Key Vault referenced at runtime.
- Never assign the `Owner` or `Contributor` role at the subscription level when a scoped,
  resource-group- or resource-level role would do — least privilege applies the same way it does
  to AWS IAM.
- Never leave a Network Security Group rule open to `Any`/`Internet` on a management or database
  port — scope source to specific ranges or route through Azure Bastion/VPN Gateway.
- Enable diagnostic logging and Azure Monitor for anything production-critical before it's needed —
  reconstructing "what happened" without logs after an incident is far harder than after.

## Strategies

- Prefer PaaS/managed offerings (Azure SQL over SQL Server on a VM, Azure Cache for Redis over
  self-hosted) unless there's a specific reason requiring full control.
- Use separate subscriptions (not just resource groups) for hard billing/governance boundaries
  (e.g. genuinely separate business units or compliance scopes); use resource groups for
  environment/lifecycle separation within a subscription.
- Set up Azure Cost Management budgets and alerts early — the common cost leaks (idle App Service
  plans, oversized VMs, orphaned managed disks) are easy to catch with alerts and easy to miss
  without them.

## Diagnostic sequence for "can't connect to my resource"

1. Network Security Group: does the inbound rule (checked in priority order — lower number wins)
   allow the actual source and port?
2. Firewall on the resource itself (many PaaS services — Storage, SQL, Key Vault — have their own
   firewall/private-endpoint config independent of NSGs) — check this even if NSGs look correct.
3. DNS resolution: for private endpoints specifically, confirm the private DNS zone is linked to
   the VNet actually making the request — a very common miss that looks like a network issue but
   is actually a DNS one.
4. RBAC (for management-plane/API calls): does the identity have the role assignment at the correct
   scope, and is there a Deny assignment or Azure Policy blocking it despite an otherwise-correct
   role?

## Experience

- "The resource name is already taken" errors for globally-unique-name resources (Storage
  accounts, Key Vaults, Container Registries) are common and usually mean picking a more specific
  name, not an actual conflict with your own prior deployment — verify before assuming a stuck
  soft-deleted resource is the cause (though Key Vault soft-delete specifically can cause this and
  needs an explicit purge).
- Private endpoint connectivity issues are disproportionately DNS problems, not network-path
  problems — check DNS resolution before deeper network diagnostics.
