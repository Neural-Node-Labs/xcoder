---
name: kafka
role: devops
description: Design and troubleshoot Kafka topics, partitioning, and consumer groups — correct delivery-semantics choice, partition-key design for ordering guarantees, and the standard diagnostic sequence for consumer lag.
triggers:
  - "kafka"
  - "topic partition"
  - "consumer group"
  - "message queue"
  - "event streaming"
  - "producer consumer"
version: "1.0.0"
requires_tools:
  - run_command_tool
  - ssh_tool
  - read_tool
composes_with:
  - workspace-context
  - docker
  - kubernetes
  - aws
---

## Process

1. Decide the delivery-semantics requirement explicitly before configuring anything: at-most-once
   (fire and forget, fine for non-critical telemetry), at-least-once (default for most Kafka setups
   — requires idempotent consumers since duplicates are possible), or exactly-once (transactional
   producer + consumer, real throughput cost — only use where a duplicate is genuinely unacceptable,
   e.g. financial transactions).
2. Choose the partition key based on the ordering guarantee actually needed: messages with the same
   key land on the same partition and are ordered relative to each other, but there is no ordering
   guarantee across partitions. Partitioning by a high-cardinality key (e.g. user ID) gives good
   parallelism; partitioning by something low-cardinality or constant defeats the purpose of having
   multiple partitions.
3. Set partition count based on target consumer parallelism, not arbitrarily — max useful
   parallelism for one consumer group equals the partition count; more consumers than partitions
   sit idle. Partition count can be increased later but never decreased on an existing topic, so
   under-provisioning is more recoverable than over-provisioning is reversible.
4. Set a retention policy (`retention.ms`/`retention.bytes`) deliberately based on how long
   consumers legitimately need to replay from, not left at the cluster default by accident.
5. For schema evolution, use a schema registry with a compatibility mode (backward/forward/full)
   matched to the actual deploy order of producers vs. consumers — deploying an incompatible schema
   change before all consumers are updated is a common outage cause.

## Instructions — non-negotiable

- Never assume global ordering across a topic — only same-key messages on the same partition are
  ordered. Design consumers to be correct under cross-partition reordering.
- Always make consumers idempotent (dedupe on a message ID/offset, or make the operation naturally
  idempotent) when using at-least-once delivery — duplicates *will* happen (rebalances, retries).
- Never rely on manual offset management without understanding the commit strategy in use
  (auto-commit vs. manual commit, and whether it's committed before or after processing) — this
  determines exactly what's re-processed on a consumer crash.
- Monitor and alert on consumer lag, not just consumer liveness — a consumer that's running but
  falling behind is a slow-motion outage that liveness checks won't catch.

## Strategies

- Prefer fewer, well-designed topics over many narrow ones unless there's a genuine reason to
  separate (different retention needs, different access-control boundary, different consumer
  scaling needs).
- For high-throughput producers, batch and compress (`linger.ms`, `batch.size`, `compression.type`)
  rather than sending every message individually — meaningful throughput difference at scale.
- Prefer Kafka Streams/ksqlDB for stream-processing logic that needs to live close to the data
  over pulling everything into a separate service, when the processing is naturally
  stream-shaped (windowed aggregation, joins between topics).

## Diagnostic sequence for consumer lag / "messages aren't being processed"

1. Check consumer group lag directly (`kafka-consumer-groups.sh --describe --group <g>` or the
   equivalent cluster UI/API) — confirms whether it's actually lagging vs. a false alarm.
2. If lag is growing steadily: is the consumer under-provisioned relative to partition count and
   incoming rate, or is per-message processing slow (check consumer-side processing time, not just
   Kafka-side metrics)?
3. If lag is flat/not moving at all: check for a stuck/crashed consumer, a rebalance loop (frequent
   rebalances usually mean `session.timeout.ms`/`max.poll.interval.ms` too tight for actual
   processing time), or a permissions/connectivity issue preventing fetch.
4. Check for a "poison pill" message (one malformed message repeatedly failing and blocking the
   partition if the consumer isn't skipping/dead-lettering failed messages).

## Experience

- Rebalance storms (consumers repeatedly leaving/rejoining the group) are usually caused by
  processing taking longer than `max.poll.interval.ms`, not a Kafka infrastructure problem —
  check consumer-side timing before touching cluster config.
- A "topic doesn't exist" error on first produce often means `auto.create.topics.enable` is off
  (common and correct for production clusters) — the topic needs to be created explicitly, not
  debugged as a connectivity issue.
