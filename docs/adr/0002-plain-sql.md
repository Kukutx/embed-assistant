# ADR 0002: Hand-written SQL with postgres.js instead of an ORM

Status: accepted (1.0.0)

## Context
The schema uses Postgres-specific features (generated tsvector columns, `vector` without fixed dimension, partial HNSW indexes per dimension, array overlap filters, advisory locks).

## Decision
Use postgres.js with tagged-template SQL (parameterised by construction) and numbered `.sql` migrations applied under an advisory lock. All data access lives in `src/db/store.ts` and takes the tenant id explicitly.

## Consequences
No ORM abstraction leaks, queries are visible and tunable, and migrations are portable SQL that any DBA can read. The cost is writing row mappers by hand, which is small at this size.
