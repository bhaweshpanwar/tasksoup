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

## v3: fencing token

- What changed: Added monotonically increasing `lease_token` (fencing token) to `jobs`, `effects`, and `claim_log`. Added a `UNIQUE (job_id)` constraint to `effects`. Heartbeats check the `lease_token`. The finish step is wrapped in a single database transaction on a dedicated client that verifies `status = 'running'` and `lease_token` before updating to `succeeded` and inserting into `effects`. The file append is moved after commit. Stale writes by zombie workers whose leases expired are rejected.
- Deliberately still broken: The file append is not atomic with the database commit. If a worker crashes or is killed after the database commit but before `fs.appendFile` completes, the effect is recorded in the database but missing from `jobs.log` (dual-write problem). Additionally, no idempotency enforcement on `POST /jobs`, no cancel, no max attempts, and no failed state.
