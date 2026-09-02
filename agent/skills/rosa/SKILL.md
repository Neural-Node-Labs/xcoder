---
name: rosa
role: devops
description: Provision and operate Red Hat OpenShift Service on AWS (ROSA) — the AWS-account and STS prerequisites specific to managed OpenShift, how much is Red-Hat-managed vs. customer-managed, and the cluster-creation/upgrade workflow via the rosa CLI.
triggers:
  - "rosa cluster"
  - "red hat openshift service on aws"
  - "openshift on aws"
  - "provision rosa"
  - "rosa cli"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - read_tool
composes_with:
  - workspace-context
  - openshift
  - aws
  - kubernetes
---

## Process

1. Understand the managed-service boundary before doing anything else: Red Hat and AWS jointly
   operate and are responsible for the control plane (masters, etcd, the OpenShift platform itself,
   patching, SLA); the customer is responsible for what runs on worker nodes (applications, their
   configuration and security) and for the AWS account/IAM setup the cluster lives inside. Don't
   plan control-plane-level changes (etcd tuning, master node access) that ROSA doesn't expose —
   that's intentionally not customer-managed.
2. Set up prerequisites in order: an AWS account meeting ROSA's requirements, the `rosa` CLI and
   `oc` CLI installed, `rosa login`, then `rosa create account-roles` and (for STS clusters, the
   modern default) `rosa create operator-roles`/`oidc-provider` before `rosa create cluster`.
   Skipping the account-roles/operator-roles step is the most common cause of cluster creation
   failing partway through.
3. Prefer STS (Security Token Service) mode over the older non-STS/IAM-credentials mode for new
   clusters — narrower, per-operator IAM permissions instead of one broad set of long-lived
   credentials; this is the current recommended default.
4. Plan networking (VPC CIDR, subnet layout across AZs, whether it's a public or fully-private
   cluster) before creation — networking topology is far more disruptive to change after cluster
   creation than most other settings.
5. Once created, treat it as OpenShift for day-to-day operations (see the `openshift` skill for
   `oc`, projects, routes, S2I) — ROSA is standard OpenShift underneath; the ROSA-specific concerns
   are almost entirely at the provisioning/AWS-integration layer, not day-to-day workload management.

## Instructions — non-negotiable

- Never attempt to modify control-plane/master node configuration directly — it's not exposed for
  customer modification and isn't the supported path even where technically reachable; use
  cluster-level OpenShift configuration objects (`Machine­Config`, operators) for anything that
  needs to be customer-configured.
- Never share the AWS IAM credentials used for cluster creation broadly — scope `rosa` CLI access
  to the specific people/automation that need to manage cluster lifecycle, following the same
  least-privilege principle as any other AWS IAM usage.
- Confirm the target AWS region actually supports ROSA before planning around it — availability is
  not universal across all AWS regions.
- Plan and budget for both AWS infrastructure costs (EC2, EBS, load balancers, data transfer) and
  the separate ROSA service fee — these are billed differently and both need to be accounted for.

## Strategies

- Use multi-AZ cluster topology for production; single-AZ is a reasonable cost tradeoff for
  dev/test only.
- Prefer cluster autoscaling (`rosa create autoscaler`/machine pool min/max) over statically sized
  worker node counts for variable workloads, to avoid both over-provisioning cost and
  under-provisioning capacity crunches.
- For multi-cluster setups (e.g. separate clusters per environment), keep the account-roles/
  operator-roles naming consistent and documented — becomes hard to track which IAM roles serve
  which cluster otherwise.

## Experience

- Cluster creation failures most often trace back to an incomplete or out-of-order prerequisite
  step (missing account-roles, expired/insufficient IAM permissions on the creating principal, or
  a service quota limit in the target AWS account/region) rather than a `rosa create cluster`
  parameter being wrong — check `rosa describe cluster -c <name>` and `rosa logs install -c <name>`
  for the actual failure stage before re-attempting.
- Upgrades are cluster-scoped and versioned like standard OpenShift — check `rosa list upgrade -c
  <name>` for available versions and known upgrade-path constraints before scheduling one, same
  discipline as any other production OpenShift upgrade.
