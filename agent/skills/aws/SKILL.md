---
name: aws
role: devops
description: Design and operate AWS infrastructure — least-privilege IAM, correct service choice for the workload shape, and cost-aware defaults, plus the standard diagnostic sequence for the most common "it won't connect/deploy" AWS failure modes.
triggers:
  - "on aws"
  - "aws cli"
  - "aws console"
  - "aws account"
  - "amazon web services"
  - "ec2"
  - "s3 bucket"
  - "lambda function"
  - "iam role"
  - "vpc"
  - "cloudformation"
  - "terraform aws"
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
  - docker
  - ubuntu
---

## Process

1. Choose compute by workload shape, not familiarity: Lambda for short, event-driven, bursty work;
   ECS/Fargate for containerized services without wanting to manage nodes; EKS/self-managed EC2 when
   you need full Kubernetes control or have existing k8s tooling; raw EC2 only when you need OS-level
   control the others don't give you.
2. Design IAM with least privilege from the start: scope policies to specific resources (ARNs), not
   `Resource: "*"`, and to specific actions needed, not `Action: "*"`. Attach policies to roles
   assumed by services, not long-lived access keys embedded in application config.
3. Put resources in private subnets by default; only put something in a public subnet (or give it a
   public IP) if it genuinely needs to be reachable from the internet directly — everything else
   should go through a load balancer/NAT/bastion.
4. Use Infrastructure as Code (CloudFormation, CDK, or Terraform) for anything beyond a quick
   throwaway experiment — manual console changes aren't reproducible, reviewable, or safely
   revertible.
5. Tag resources consistently (environment, owner, project) from creation — untagged resources are
   the single biggest cause of "what is this and can we delete it" cost/security audits later.

## Instructions — non-negotiable

- Never commit AWS access keys/secret keys to source control — use IAM roles (for AWS-hosted
  workloads) or a secrets manager; if a key is ever committed, rotate it immediately, don't just
  remove it from a later commit.
- Never use the root account for day-to-day operations — create IAM users/roles with only the
  permissions needed, and enable MFA on the root account.
- Never open a security group to `0.0.0.0/0` on a non-public-facing port (databases, admin
  interfaces, SSH) — scope ingress to specific IP ranges or a bastion/VPN.
- Enable encryption at rest (S3, EBS, RDS) by default unless there's a specific documented reason
  not to — it's low-cost and the alternative is a real risk if misconfigured elsewhere.

## Strategies

- Prefer managed services (RDS over self-hosted DB on EC2, ElastiCache over self-hosted Redis)
  unless there's a specific reason requiring full control — operational burden saved usually
  outweighs the cost premium.
- Set up billing alerts and check for the common cost leaks proactively: unattached EBS volumes,
  idle load balancers, NAT gateway data transfer, over-provisioned RDS/EC2 instance sizes.
- Prefer multi-AZ for anything production-critical; single-AZ is acceptable for dev/staging where
  the cost savings outweigh the availability risk.

## Diagnostic sequence for "can't connect to my resource"

1. Security group: does the inbound rule allow the source (IP/security group) and port actually
   being used?
2. Network ACL: stateless, unlike security groups — check both inbound and outbound rules
   explicitly if the security group looks correct but connectivity still fails.
3. Route table: does the subnet's route table actually route to where the traffic needs to go
   (internet gateway for public, NAT gateway for private-to-internet, peering/transit gateway for
   cross-VPC)?
4. IAM (for API/service-to-service calls, not raw network connectivity): does the calling
   role/user have the specific action and resource permission, and is there an explicit `Deny` in
   an SCP or permissions boundary overriding an otherwise-correct `Allow`?

## Experience

- "Connection timed out" almost always means a network-layer block (security group/NACL/routing);
  "connection refused" means the network reached the host but nothing is listening on that port —
  this distinction narrows the diagnosis immediately.
- An IAM policy that looks correct but still denies access often has an explicit `Deny` elsewhere
  (SCP, permissions boundary, resource-based policy) — explicit deny always wins over allow, and
  it's easy to overlook a boundary set at the org/account level.
