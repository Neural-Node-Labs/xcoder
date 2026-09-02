---
name: redhat
role: devops
description: Administer RHEL/CentOS/Rocky/Alma servers — dnf/yum package management, subscription-manager registration, SELinux troubleshooting, and firewalld — the RHEL-family equivalents that differ meaningfully from Debian/Ubuntu conventions.
triggers:
  - "red hat"
  - "redhat"
  - "rhel"
  - "centos"
  - "rocky linux"
  - "dnf install"
  - "yum install"
  - "selinux"
  - "firewalld"
  - "subscription-manager"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - ssh_copy_tool
composes_with:
  - workspace-context
  - openshift
  - rosa
  - docker
---

## Process

1. On RHEL proper (not CentOS Stream/Rocky/Alma), register the system with
   `subscription-manager register` and attach an appropriate subscription/enable the needed repos
   before `dnf install` — unregistered RHEL has no package repos enabled by default, unlike
   Ubuntu's apt which works out of the box. This is the most common "package not found" surprise
   for anyone coming from Debian-family systems.
2. Use `dnf` (RHEL 8+/CentOS Stream/Rocky/Alma) or `yum` (RHEL 7 and older) — `dnf` is the modern
   tool and is what current guidance should target; confirm the actual OS version rather than
   assuming.
3. Check SELinux status (`getenforce`) before debugging a "permission denied" that looks otherwise
   inexplicable — SELinux enforces mandatory access control independent of standard Unix
   permissions, and a process can have correct file permissions and still be blocked by policy.
4. Manage the firewall with `firewall-cmd` (firewalld), not raw `iptables`, on modern RHEL-family
   systems — firewalld is the standard front-end and mixing direct iptables rules with it causes
   confusing, hard-to-reproduce state.
5. Use systemd (same as Ubuntu) for service management — this part is consistent across the
   Linux distributions covered here, unlike package management and MAC (mandatory access control).

## Instructions — non-negotiable

- Never resolve a SELinux-caused denial by running `setenforce 0` (disabling enforcement) on a
  production/shared system — diagnose the specific denial (see sequence below) and fix the context
  or write a targeted policy exception instead. Disabling SELinux removes a real security layer
  system-wide for the sake of one local issue.
- Never open a firewalld port with `--zone=public` when a more restrictive zone would do — scope
  to the minimum needed.
- Always make firewalld changes with `--permanent` and then `firewall-cmd --reload` — without
  `--permanent`, changes vanish on the next reboot, which reliably confuses anyone testing a change
  and forgetting to persist it.
- Never assume CentOS Stream/Rocky/Alma package availability is identical to RHEL — they track
  RHEL closely but aren't guaranteed bit-identical; verify a package/repo exists for the specific
  distro and version in use.

## Strategies

- Prefer `dnf module` for software with multiple available versions (e.g. different language
  runtime streams) over manually adding third-party repos, when a module stream provides what's
  needed — keeps the system on RHEL's supported package paths.
- When SELinux blocks something legitimate repeatedly, prefer a scoped `semanage`/policy module fix
  for the specific context over broad `setenforce 0`/`chcon` one-offs that don't survive a
  relabel and don't document why the exception exists.
- For services listening on non-standard ports, remember SELinux also tracks expected port-to-service
  type mappings (`semanage port -l`) independent of the firewall — a firewalld rule alone isn't
  always sufficient if SELinux's port type doesn't match.

## Diagnostic sequence for SELinux-blocked access

1. `getenforce` — confirm SELinux is actually in `Enforcing` mode (vs. `Permissive`/`Disabled`)
   before spending time chasing an SELinux theory for a non-SELinux problem.
2. `ausearch -m avc -ts recent` (or `grep AVC /var/log/audit/audit.log`) — find the actual denial
   and what it was trying to do.
3. `sealert -a /var/log/audit/audit.log` (if `setroubleshoot` is installed) — gives a human-readable
   explanation and the specific suggested fix command, usually a `semanage`/`setsebool` invocation.
4. Apply the narrowest suggested fix (a specific boolean or file context change) rather than the
   broadest one offered.

## Experience

- "It works when I run it manually as root but not as the service" combined with correct file
  permissions is the classic SELinux signature — check `getenforce` and AVC denials before
  anything else once permissions are confirmed correct.
- A firewalld rule that "isn't working" after being added is very often the missing `--permanent`
  + `--reload`, or being added to the wrong zone (`firewall-cmd --get-active-zones` shows which
  zone the actual interface is using) rather than a genuinely wrong rule.
