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

## v2: lease and reaper

- What changed: Added `lease_expires_at` and `attempts` to the `jobs` table with a partial index on running leases. Claims set an initial lease and increment attempts in SQL. Workers run a periodic heartbeat (`LEASE_SECONDS / 3`) to extend active leases, and a periodic reaper (every 1s) to requeue expired running jobs. Jobs abandoned by crashed or frozen workers are automatically recovered.
- Deliberately still broken: No fencing tokens, no unique constraints on effects, no transactions around the finish step, no idempotency enforcement, and no cancellation. If a worker pauses or runs longer than its lease, the reaper requeues the job and a second worker can claim it, leading to duplicate effects and log lines when the first worker resumes.
