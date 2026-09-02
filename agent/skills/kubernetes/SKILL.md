---
name: kubernetes
role: devops
description: Write and troubleshoot Kubernetes manifests and cluster workloads — correct workload type choice, resource requests/limits, probes, and the standard kubectl-based diagnostic sequence for a failing pod/deployment.
triggers:
  - "kubernetes"
  - "k8s"
  - "kubectl"
  - "the pod "
  - "a pod "
  - "pod is "
  - "pod status"
  - "deployment yaml"
  - "helm chart"
  - "ingress"
  - "kubernetes cluster"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - read_tool
  - write_edit_tool
composes_with:
  - workspace-context
  - docker
  - openshift
  - rosa
  - aws
  - azure
---

## Process

1. Choose the right workload type deliberately: `Deployment` for stateless/replaceable pods,
   `StatefulSet` when pods need stable identity/storage/ordering, `DaemonSet` for one-per-node
   agents, `Job`/`CronJob` for run-to-completion work. Using `Deployment` for something that needs
   stable network identity or ordered startup is a common, hard-to-debug-later mistake.
2. Always set both `resources.requests` and `resources.limits` (CPU and memory) — no requests means
   the scheduler can't place pods sensibly; no limits means one runaway pod can starve its node.
3. Define `readinessProbe` (traffic routing) and `livenessProbe` (restart-if-stuck) separately and
   correctly — a liveness probe that's too aggressive causes restart loops on slow-starting apps; a
   missing readiness probe sends traffic to a pod before it's actually ready.
4. Use `ConfigMap`/`Secret` for configuration, never bake environment-specific values into the
   image — the same image should be deployable unchanged across environments.
5. For anything beyond a handful of static manifests, prefer Helm or Kustomize over hand-copied
   YAML per environment, to keep environment diffs explicit and reviewable instead of implicit.

## Instructions — non-negotiable

- Never apply a manifest without first running `kubectl diff` (or `--dry-run=client -o yaml`) to
  see what will actually change, when the cluster is a shared/production one.
- Never set `livenessProbe` with a timeout/period tight enough to fail during normal startup —
  check actual startup time first, or use `startupProbe` to give slow-starting apps room before
  liveness checks begin.
- Namespace every resource explicitly rather than relying on `kubectl`'s current context default —
  applying to the wrong namespace/cluster is a common, costly mistake.
- Never store secrets as plain `ConfigMap` values or in-image — use `Secret` objects (and note that
  base64 in a `Secret` is encoding, not encryption; use a proper secrets manager/sealed-secrets
  approach for anything genuinely sensitive).

## Strategies

- Prefer many small, single-purpose containers/pods over one large pod doing several unrelated
  jobs — matches Kubernetes' scaling and failure-isolation model.
- Set `PodDisruptionBudget` for anything that must maintain a minimum available replica count
  during voluntary disruptions (node drains, cluster upgrades).
- Prefer `kubectl rollout status`/`kubectl rollout undo` for deploys over deleting and recreating
  resources — preserves rollout history and enables clean rollback.

## The standard diagnostic sequence for "pod isn't working"

1. `kubectl get pods -n <ns>` — what phase is it in (Pending/CrashLoopBackOff/ImagePullBackOff/
   Running-but-not-Ready)? The phase narrows the cause category immediately.
2. `kubectl describe pod <pod> -n <ns>` — check `Events` at the bottom first; scheduling failures,
   image pull errors, and probe failures all show up here with a specific reason.
3. `kubectl logs <pod> -n <ns>` (add `--previous` if it's currently restarting) — application-level
   errors.
4. `kubectl get events -n <ns> --sort-by='.lastTimestamp'` — cluster-level events (evictions,
   node pressure) that `describe pod` alone might not surface.
5. For networking issues specifically: confirm the `Service` selector actually matches the pod's
   labels (`kubectl get endpoints <svc>` should list the pod IPs — if empty, the selector is wrong).

## Experience

- `ImagePullBackOff` is almost always either a typo'd image tag, a private registry the cluster
  isn't authenticated against, or a platform/architecture mismatch (e.g. arm64 image on an amd64
  node) — check these three before anything more exotic.
- `CrashLoopBackOff` combined with a very short `Age`-to-restart interval usually means the
  container is exiting immediately on start (missing env var, bad config, wrong entrypoint) rather
  than crashing after real work — `kubectl logs --previous` is the fastest path to the actual error.
- Pending pods are almost always a scheduling constraint (insufficient resources, node
  selector/affinity nothing matches, or a taint with no matching toleration) — `describe pod`'s
  Events section names the specific unmet constraint.
