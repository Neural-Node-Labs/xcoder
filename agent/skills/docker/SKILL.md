---
name: docker
role: devops
description: Build, run, and troubleshoot Docker images and Compose stacks — multi-stage builds, image size/security discipline, and the specific docker/compose commands and failure patterns relevant to this project's own docker_compose_deploy_tool/docker_deploy_ssh_tool.
triggers:
  - "docker"
  - "dockerfile"
  - "docker compose"
  - "container image"
  - "containerize"
  - "docker build"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - docker_compose_deploy_tool
  - docker_deploy_ssh_tool
  - read_tool
composes_with:
  - workspace-context
  - kubernetes
  - ubuntu
  - redhat
---

## Process

1. Use multi-stage builds for any compiled/transpiled language: a `build` stage with full
   toolchain, a final stage copying only the built artifact onto a minimal base
   (`-slim`/`-alpine`/`distroless`) — this is the single biggest lever on both image size and
   attack surface.
2. Order Dockerfile layers from least- to most-frequently-changing (dependency manifests and
   install before copying application source) so the dependency-install layer stays cached across
   rebuilds instead of invalidating on every source change.
3. Run as a non-root user in the final image (`USER` directive) unless there's a specific,
   documented reason not to.
4. Define `HEALTHCHECK` (or the Compose/orchestrator equivalent) for any long-running service —
   "the container is running" and "the service inside it is healthy" are different facts, and
   deploy tooling that only checks the former will report false success.
5. Pin base image versions (a specific tag or digest, not `latest`) for reproducible builds; this
   project's own CI/deploy flow (`docker_compose_deploy_tool`) depends on builds being
   deterministic across environments.

## Instructions — non-negotiable

- Never bake secrets (API keys, passwords) into an image layer — even a later `RUN rm` doesn't
  remove them from earlier layers in the image history. Use build args passed at build time only
  for non-secret values, and runtime env/secrets mounts for anything sensitive.
- Never `COPY . .` before installing dependencies — invalidates the dependency cache layer on every
  file change, dramatically slowing rebuilds.
- Always add a `.dockerignore` excluding `node_modules`, `.git`, and local env files — an image
  that unintentionally includes `.git` history or local secrets is a real, common leak vector.
- When debugging "works locally, fails in the container," check environment differences first
  (env vars, file paths, user/permissions, network access) before assuming the code is wrong — this
  is the most common class of container-specific bug.

## Strategies

- Prefer official/verified base images over community ones unless there's a specific reason;
  prefer minimal bases (`alpine`, `slim`, `distroless`) unless a dependency genuinely needs the
  full OS surface (some native modules need glibc rather than musl — verify before assuming
  alpine works for a given language ecosystem).
- For local multi-service development, prefer Docker Compose over hand-rolled `docker run` scripts
  — declarative, versionable, and reproducible across machines.
- When a build is slow, check whether cache invalidation (see layer ordering above) or actual work
  (large dependency install, no build cache mount) is the cause before optimizing the wrong thing.

## Experience

- "Exit code 137" almost always means the container was OOM-killed, not that the application
  crashed on its own — check memory limits before debugging application logic.
- A container that can't reach another container by service name in Compose is usually a networking
  config issue (wrong network, service not on the same Compose network) rather than an application
  bug — verify with `docker compose ps`/`docker network inspect` before changing application code.
- Image size regressions usually come from a forgotten cache-busting layer order change or a debug
  tool left in the final stage — diff the Dockerfile against the last known-good version rather
  than guessing.
