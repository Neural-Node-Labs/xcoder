# Running xcoder as a multi-tenant SaaS

## Turn it on
```
XCODER_SAAS_MODE=true
XCODER_SAAS_DATA_DIR=/data/saas        # tenants.json, platform.json, usage.json, tenants/<id>/{crm.json,audit.jsonl}; persist this volume
```
First account registered becomes the **SaaS owner**. Registration is then closed. An existing single-tenant install: the oldest `admin` is promoted to SaaS owner on first start; other legacy users have no privileges until moved into a tenant (re-create them under a tenant).

## Roles
| Role | Can | Cannot |
|---|---|---|
| `saas_owner` (SaaS admin) | Create/update/suspend/delete tenants, plans and quotas, platform feature switches, per-tenant switches (including sensitive ones), platform staff, platform audit log, platform settings | See any tenant's projects, files, chats or CRM |
| `saas_ops` (SaaS operations) | View tenants, usage, audit; suspend/reactivate; reset a tenant admin's password | Create/delete tenants, change plans or switches, manage staff, see tenant data |
| `tenant_admin` | Manage own tenant's users, switch non-sensitive features off/on, usage, tenant audit log, everything a user can | Anything outside own tenant; enable sensitive features |
| `tenant_user` | Tasks, projects, workspace, CRM (if enabled) in own tenant | Administration |

## Feature switches (disable any feature)
Two levels, both must allow it: **platform** (SaaS owner: Admin > Features, API `PUT /saas/features/:id`, or env `XCODER_FEATURE_<ID>=on|off` which locks it) and **tenant** (owner for any; tenant admin for non-sensitive ones).

| id | What | Tenant default (SaaS) |
|---|---|---|
| `crm` | CRM module | on |
| `saas_management` | SaaS admin console | on (staff only) |
| `shell_tools` | run_command, ssh, docker deploy | **off**, owner-only |
| `network_tools` | web search, URL fetch, crawl, API tests, GitHub | **off**, owner-only |
| `mcp_tools` | MCP servers | **off**, owner-only |
| `security_ops` | Blue/Red team checks | **off**, owner-only |
| `agi` | AGI agent | staff: shared instance; tenants: only with an owner-provisioned dedicated instance |
| `codegraph` | shared CodeGraph | platform staff only |

Disabled features return 403 `{feature}` from the API, vanish from the navigation, and tools are refused at dispatch.

## Plans and quotas
`free` / `pro` / `enterprise` (see `src/saas/tenantStore.ts`), overridable per tenant. Monthly tokens and requests are metered per tenant; chat is refused with 429 when spent. Seat limit is enforced when a tenant admin adds users.

## API
`/saas/*` (staff), `/tenant/*` (tenant members), `/crm/*` (tenant members). `GET /auth/me` returns `saasMode`, `tenantName` and the effective `features`.

## Before you sell this: read `SAAS_ISOLATION_AUDIT.md`
The open items matter: sandbox shell tools before enabling them for any tenant, move sessions out of process memory before running multiple API replicas, add a tenant column to the Postgres task-log telemetry, and consider Postgres RLS.

## LLM connections
One central resolver (`src/llm/connections.ts`). Each tenant admin configures **Default / Chat / Tasks / AGI** connections in *Settings* (own provider, base URL, model, key; or "use platform" with an optional own model). The owner sets policy in *SaaS admin → LLM*: whether tenants may configure, whether they may fall back to the platform connection, whether private URLs are allowed, and which providers are allowed. Platform overrides per purpose live there too.

- Keys are write-only, sealed with AES-256-GCM. Set `XCODER_SECRET_KEY` (from a secrets manager); otherwise one is generated in the SaaS data dir. Losing it makes stored keys unreadable.
- Tenant base URLs must be public https (SSRF guard). Egress filtering is still recommended.
- AGI: deploy a separate AGI instance per tenant, then enter its URL and token under the tenant in *SaaS admin*. The API pushes the tenant's AGI connection to that instance.
- API: `GET/PUT/DELETE /llm/connections[/:slot]`, `POST /llm/connections/:slot/test` (tenant); `/saas/llm*`, `/saas/tenants/:id/llm`, `/saas/tenants/:id/agi` (staff/owner).

## Rate limits and proxies
Login is limited per IP+username, per IP and per username; `/register` and Google sign-in are limited per IP. Set `XCODER_TRUST_PROXY=<hops>` (compose: 1) when running behind nginx or a load balancer so the limiter sees real client IPs; leave it unset when the API is exposed directly.

## Environment variables
| Variable | Purpose |
|---|---|
| `XCODER_SAAS_MODE` | `true` turns multi-tenancy on |
| `XCODER_SAAS_DATA_DIR` | tenant, usage, CRM, audit and LLM connection files (persist it) |
| `XCODER_SECRET_KEY` | master key sealing tenant LLM keys and AGI tokens |
| `XCODER_TRUST_PROXY` | proxy hops in front of the API (compose: 1) |
| `XCODER_LOGIN_IP_MAX`, `XCODER_LOGIN_USER_MAX` | login attempts per 15 min per IP / username |
| `XCODER_FEATURE_<ID>` | lock a feature on/off platform-wide |

## Security validation
`src/saas/__tests__/saas.security.test.ts` checks, over real HTTP: token required on every route; auth rate limits; SQL injection and parameterised-query scan; cross-tenant workspace/project/plan/CRM access and path traversal; prompt-injection controls; CodeGraph proxy. Run it after adding any route (new routes are protected by default and the test fails if one becomes public). Results and residual risk: `SAAS_ISOLATION_AUDIT.md`.
