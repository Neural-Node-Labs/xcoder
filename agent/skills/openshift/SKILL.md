---
name: openshift
role: devops
description: Operate OpenShift day-to-day — the oc CLI, Projects vs. raw Kubernetes namespaces, Routes vs. Ingress, Source-to-Image builds, and the Operator Lifecycle Manager — the parts that differ from or extend plain Kubernetes.
triggers:
  - "openshift"
  - "oc cli"
  - "oc apply"
  - "s2i"
  - "source-to-image"
  - "openshift route"
  - "operator lifecycle manager"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - read_tool
  - write_edit_tool
composes_with:
  - workspace-context
  - kubernetes
  - rosa
  - redhat
  - docker
---

## Process

1. Use `oc` for OpenShift-specific resources (Projects, Routes, BuildConfigs, DeploymentConfigs,
   ImageStreams) and standard `kubectl`-compatible manifests/`oc apply` for plain Kubernetes
   objects — `oc` is a superset of `kubectl`, so it's safe to default to `oc` throughout rather
   than switching tools.
2. Use `Project` (`oc new-project`) as the day-to-day unit — it's a Kubernetes `Namespace` with
   additional OpenShift access-control and metadata; don't create a raw `Namespace` and expect
   identical behavior to a `Project` created via `oc`.
3. Use `Route` for exposing HTTP(S) services externally rather than `Ingress` unless there's a
   specific portability reason to use Ingress — Routes integrate with OpenShift's built-in router
   and support things like automatic edge/passthrough TLS termination more directly.
4. For building application images from source, evaluate Source-to-Image (`oc new-app` from a Git
   repo, or an explicit `BuildConfig` with an S2I builder image) as an alternative to hand-writing
   a Dockerfile when the language/framework has a good S2I builder available — it removes an entire
   class of Dockerfile-maintenance work for straightforward apps; fall back to a Dockerfile-based
   `BuildConfig` for anything with unusual build requirements.
5. Install cluster capabilities (databases, service meshes, monitoring stacks) via Operators through
   OLM (`oc get packagemanifests`, then a `Subscription`) rather than hand-installed Helm charts
   where a well-maintained Operator exists — gets you lifecycle management (upgrades, health
   reconciliation) the raw Helm install doesn't provide.

## Instructions — non-negotiable

- Never run application containers as root inside the pod spec — OpenShift's default Security
  Context Constraints (SCCs) block arbitrary root UIDs by design (`restricted` SCC assigns a
  random non-root UID). If an image is built assuming a fixed root UID, fix the image rather than
  requesting a broader SCC as the first move.
- Never grant the `anyuid` or `privileged` SCC broadly to "make deployment errors go away" without
  understanding why the default `restricted` SCC is failing — diagnose the actual permission need
  first (see diagnostic sequence below); broad SCC grants are a real security regression.
- Always set explicit resource requests/limits on `DeploymentConfig`/`Deployment` objects, same
  requirement as plain Kubernetes — OpenShift doesn't change this need.
- Use `oc whoami`/`oc project` to confirm the current user and project context before applying
  changes on a shared cluster — same class of mistake as applying to the wrong `kubectl` context.

## Strategies

- Prefer `DeploymentConfig` only where its OpenShift-specific features (image-change triggers,
  built-in rollback) are actually needed; prefer standard Kubernetes `Deployment` otherwise for
  better portability and alignment with upstream tooling/documentation.
- Use `ImageStream`s to track image tags/get automatic rollout on new image pushes when working
  within OpenShift's build/deploy chain; use plain image references pulled from an external
  registry when the image is built outside OpenShift entirely.
- For multi-tenant clusters, use `ResourceQuota` and `LimitRange` per Project alongside SCCs — SCCs
  govern *what* a pod is allowed to do; quotas govern *how much* a project can consume.

## Diagnostic sequence for "pod won't schedule / SCC-related failure"

1. `oc get events -n <project>` — SCC admission failures show up here with the specific reason
   (e.g. attempting to run as a disallowed UID).
2. `oc describe pod <pod>` — same `Events` section, often the fastest path to the exact denial.
3. `oc get scc` and `oc describe scc restricted` (or whichever SCC applies) — confirm what the
   applicable SCC actually allows before assuming a broader one is required.
4. Fix the pod spec (remove a hardcoded `runAsUser`, let OpenShift assign one) before considering
   an SCC change — most "SCC failures" are a pod spec asking for something unnecessary, not a
   genuine need for elevated permissions.

## Experience

- Images built assuming Docker Hub-style "runs as root by default" behavior are the most common
  source of first-deployment failures on OpenShift — build images to run as an arbitrary non-root
  UID (writable directories owned by group `0` with group-write permissions is the standard
  pattern) rather than requesting `anyuid`.
- "Works on plain Kubernetes, fails on OpenShift" is very often exactly this SCC/root-UID
  difference, not a genuine incompatibility — check that first before assuming an OpenShift-specific
  bug.
