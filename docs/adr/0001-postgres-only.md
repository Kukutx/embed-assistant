# ADR 0001: Postgres is the only infrastructure dependency

Status: accepted (1.0.0)

## Context
A self-hosted assistant needs storage, full-text and vector search, rate limiting, a background queue and fan-out of streaming events across instances. The usual answer is Postgres + Redis + a queue + a vector database.

## Decision
Use Postgres (with pgvector) for all of it: `FOR UPDATE SKIP LOCKED` job queue, UPSERT-based fixed-window rate limits, `run_events` rows plus `LISTEN/NOTIFY` for streaming fan-out, `tsvector` + pgvector for hybrid search.

## Consequences
One thing to run, back up and secure. Correct across multiple instances. Throughput limits are far above what a chat assistant produces. If a deployment ever outgrows it, the event bus and queue sit behind small interfaces (`RunEventBus`, `JobWorker`) that can be reimplemented.
