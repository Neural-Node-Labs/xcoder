---
name: ubuntu
role: devops
description: Administer Ubuntu/Debian-based servers — apt package management, systemd service management, user/permission setup, and the standard diagnostic sequence for a service that won't start or a host that's unreachable.
triggers:
  - "ubuntu"
  - "debian"
  - "apt-get"
  - "apt install"
  - "systemctl"
  - "systemd service"
  - "linux server"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - ssh_copy_tool
composes_with:
  - workspace-context
  - docker
  - aws
  - azure
---

## Process

1. Always `apt-get update` before `install` on a host that hasn't been touched recently — installing
   against a stale package index is a common source of "package not found" or installing an older
   version than intended.
2. Pin package versions explicitly (`apt-get install pkg=1.2.3`) for anything going into a
   reproducible build/deploy process; unpinned installs make "works on one box, not another" bugs
   common.
3. For any long-running process, run it as a systemd service (with a proper unit file:
   `Restart=on-failure`, a dedicated non-root user, explicit `WorkingDirectory`) rather than a
   detached shell process (`nohup ... &`) — the latter doesn't survive reboot, doesn't restart on
   crash, and isn't visible to standard monitoring/log tooling.
4. Follow least-privilege for users: create a dedicated service user per application rather than
   running everything as root or a single shared user; grant `sudo` access scoped to specific
   commands (via `/etc/sudoers.d/`) rather than blanket `sudo` where possible.
5. Check `ufw status` (or `iptables`, depending on what's configured) and confirm required ports are
   actually open before assuming an application-level cause for connectivity failures.

## Instructions — non-negotiable

- Never run `apt-get upgrade`/`dist-upgrade` on a production host without a maintenance
  window/rollback plan — package upgrades can change behavior or break dependencies unexpectedly.
- Never disable a firewall entirely to "fix" a connectivity issue — open the specific port/rule
  actually needed; leaving the host fully exposed is a much larger risk than diagnosing the real
  rule correctly.
- Never store or transmit credentials in plaintext in scripts/cron jobs on the host — use env
  files with restricted permissions (`chmod 600`) or a proper secrets mechanism.
- Always check disk space (`df -h`) before deep-diagnosing a service failure — "disk full" produces
  confusing, seemingly-unrelated application errors far more often than it's obviously the cause.

## Strategies

- Prefer systemd timers over cron for anything that needs logging/status visibility consistent
  with the rest of the system's services; cron remains fine for simple, well-understood jobs.
- Prefer `journalctl -u <service>` over grepping raw log files when the service is running under
  systemd — structured, filterable, and includes stdout/stderr the process itself may not have
  written to a file.
- When provisioning multiple similar hosts, script the setup (or use configuration management)
  rather than repeating manual steps — manual setup on host #2 already differs from host #1 in
  ways nobody remembers by host #5.

## Diagnostic sequence for "service won't start" / "host unreachable"

1. `systemctl status <service>` — active/failed/inactive, and the last few log lines inline.
2. `journalctl -u <service> -n 100 --no-pager` — fuller error context than `status` alone shows.
3. If it's a startup/config error: verify the config file syntax and paths referenced in it
   actually exist and are readable by the service's configured user (not just root).
4. For "host unreachable": check `systemctl status ssh`/network interface status
   (`ip addr`) first if you have any other access path; if fully locked out, check the
   cloud/hypervisor console for boot-time errors before assuming it's purely a network config issue.
5. Check disk space and memory (`df -h`, `free -h`) — many "mysterious" service failures are
   resource exhaustion, not application logic.

## Experience

- A service that starts fine manually (`sudo -u appuser /path/to/binary`) but fails under systemd
  is almost always an environment difference — systemd units don't inherit the interactive shell's
  environment variables/PATH by default; set them explicitly in the unit file (`Environment=`,
  `EnvironmentFile=`).
- "Permission denied" errors after a fresh `apt install` of something expecting specific ownership
  (e.g. a data directory) usually mean the package's default user/group doesn't match an existing
  directory's ownership — check `ls -la` on the relevant path rather than assuming the software
  itself is broken.
