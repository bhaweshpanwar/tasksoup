# Job Queue Service (v0)

## Start

```bash
docker compose up --build
```

## Seed

```bash
node scripts/seed.js 1000
```

## Report

```bash
node scripts/report.js
```

## Kill a Worker Mid-Job

```bash
docker kill --signal=SIGKILL <container-name>
```

## Known flaws (intentional)

- non-atomic claim
- no lease
- no recovery of running jobs
- no idempotency enforcement
- no unique constraint on effects
- file write and DB write not atomic

## v1: atomic claim

- What changed: Replaced the non-atomic two-step claim with a single atomic CTE query using `FOR UPDATE SKIP LOCKED` and added the `claim_log` table. Double claim is eliminated.
- Deliberately still broken: No leases, no heartbeats, no reapers or recovery of running jobs, no fencing tokens, no retries, no idempotency enforcement, no cancellation, no unique constraints on effects, and file write and DB write remain non-atomic.
