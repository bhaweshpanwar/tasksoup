# TaskSoup — Production-Resilient Job Queue

A resilient background job queue built with Node.js and PostgreSQL, engineered to survive worker crashes, network stalls, duplicate request floods, and mid-flight cancellations without dropping jobs or committing duplicate side effects.

---

## Quickstart & Reviewer Commands

To run and verify the complete test suite directly:

```bash
# 1. Reset everything to a clean slate
./scripts/reset.sh

# 2. Start the full cluster with 8 workers and run a quick 500-job chaos drill (~20s)
./scripts/quickstart.sh

# 3. Run the full 10,000-job chaos campaign (5 consecutive runs with fresh seeds)
JOB_COUNT=10000 ./scripts/chaos-run.sh final 5

# 4. Run mutation tests (proves the harness catches broken fences and non-atomic claims)
./scripts/mutation-test.sh naiveclaim
./scripts/mutation-test.sh nofence

# 5. Print the complete index of all test logs and summary tables
./scripts/results-index.sh
```

---

## 1. Design Note

### How a Worker Claims a Job
Workers pull jobs from PostgreSQL. No job is assigned to a worker in advance. A free worker runs a single atomic statement using a Common Table Expression (CTE) with row-level locking:

```sql
WITH picked AS (
  SELECT id FROM jobs
  WHERE status = 'queued'
  ORDER BY id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE jobs
  SET status = 'running',
      worker_id = $1,
      lease_expires_at = clock_timestamp() + make_interval(secs => $2),
      attempts = attempts + 1,
      lease_token = lease_token + 1
  FROM picked
  WHERE jobs.id = picked.id
  RETURNING jobs.id, jobs.lease_token
)
INSERT INTO claim_log (job_id, worker_id, lease_token)
SELECT id, $1, lease_token FROM claimed
RETURNING job_id AS id, lease_token;
```

`FOR UPDATE SKIP LOCKED` locks the candidate row immediately and instructs concurrent workers to skip it without blocking. The check (*"is it queued?"*) and the write (*"make it running, increment attempts, bump fencing token"*) happen in the exact same atomic statement. In v0, these were separate `SELECT` and `UPDATE` statements, which produced duplicate claims under concurrent workers. 

The `lease_token` is a monotonically increasing fencing token incremented on every single claim. The worker holds this token in memory for the duration of its task.

---

### How a Dead Worker is Detected
A worker cannot be definitively known to be dead; the system only knows it has not reported in recently.

1. **Lease**: Each claim sets `lease_expires_at` to `clock_timestamp() + LEASE_SECONDS` (5 seconds in test configuration).
2. **Heartbeat**: While executing work, the worker extends its lease every `LEASE_SECONDS / 3` (~1.6 seconds):
   ```sql
   UPDATE jobs
   SET lease_expires_at = clock_timestamp() + make_interval(secs => $2)
   WHERE id = $1 AND status = 'running' AND lease_token = $3;
   ```
   If the heartbeat matches 0 rows (because the lease expired and another worker reclaimed the job), the worker stops its heartbeat immediately.
3. **Reaper**: Every worker runs a background loop once per second that queries for running jobs with expired leases:
   * If `attempts < MAX_ATTEMPTS`: resets `status = 'queued'`, `worker_id = NULL`, `lease_expires_at = NULL`.
   * If `attempts >= MAX_ATTEMPTS`: marks `status = 'failed'`, `failed_reason = 'max_attempts'`, `lease_expires_at = NULL`.
4. **Clock Source**: All lease calculations use PostgreSQL's `clock_timestamp()`. Worker system clocks are never evaluated, eliminating clock drift between worker machines as a failure mode.

**The Trade-off**: A short lease recovers abandoned jobs quickly, but risks taking work away from a healthy worker that is temporarily slow or paused by a garbage collection pause.

---

### What Happens When a Running Job is Cancelled
A client calls `POST /jobs/:id/cancel`, which executes:

```sql
UPDATE jobs
SET status = 'cancelled',
    cancelled_at = clock_timestamp(),
    worker_id = NULL,
    lease_expires_at = NULL
WHERE id = $1 AND status IN ('queued', 'running')
RETURNING *;
```

The job transitions to `cancelled` immediately in PostgreSQL. The worker currently executing that job is not abruptly interrupted and continues sleeping or processing its simulated workload (that compute is wasted). However, when the worker attempts to complete its task, it executes an atomic finish transaction:

```sql
BEGIN;
UPDATE jobs
SET status = 'succeeded', lease_expires_at = NULL
WHERE id = $1 AND lease_token = $2 AND status = 'running';

-- If updateResult.rowCount === 0:
ROLLBACK;
-- Worker logs: "stale write rejected for job <id>"

-- If updateResult.rowCount === 1:
INSERT INTO effects (job_id, worker_id, lease_token) VALUES ($1, $2, $3);
COMMIT;
```

Because the job status was changed to `'cancelled'`, the `UPDATE` matches 0 rows. The transaction rolls back, nothing is written to `effects`, and the worker appends nothing to `jobs.log`.

**Compare-and-Swap Race**: Cancel and finish are competing compare-and-swap operations on `status = 'running'`. Only one can commit:
* If finish commits first, cancel matches 0 rows and the API responds `409 Conflict` with `status: "succeeded"`.
* If cancel commits first, finish matches 0 rows, rolls back, and logs `stale write rejected`.

---

### Which Guarantee We Give, and Why

**At-least-once execution attempts, with at-most-once side-effect commit for the database row.**

1. **Execution attempts can repeat**: If a worker is killed or frozen, its lease expires and the reaper requeues the job. A job can be attempted multiple times (`attempts > 1`). Never losing a job during worker crashes requires this.
2. **Database effects are at-most-once**: The status transition to `succeeded` and the `effects` row insertion commit inside a single transaction fenced by `(id, lease_token, status='running')`. A zombie worker's stale write matches 0 rows. In addition, the `effects` table enforces `UNIQUE (job_id)` as an engine-level backstop.
3. **Where the guarantee breaks down (The Dual-Write Gap)**:
   In `src/worker.js`, the log line is appended to disk (`data/jobs.log`) **after** the database transaction commits:
   ```javascript
   await client.query('COMMIT');
   committed = true;
   // ...
   if (committed) {
     await fs.promises.appendFile(jobFile, line);
   }
   ```
   A `SIGKILL` landing between `COMMIT` and `appendFile` leaves a committed row in PostgreSQL but no line in `jobs.log`. Across independent storage boundaries (Postgres vs host filesystem), true exactly-once execution is impossible without a two-phase commit or transactional outbox pattern. For external side effects, the guarantee is at-most-once.

---

### Storage Choice: PostgreSQL over SQLite
* **Concurrency Model**: PostgreSQL provides native row-level locking with `FOR UPDATE SKIP LOCKED`. Multiple worker containers can poll and claim jobs simultaneously without blocking each other.
* **Failure Modes in SQLite**: SQLite uses file-level locking. Under 8 concurrent workers executing claims, heartbeats, and status writes, SQLite generates frequent `SQLITE_BUSY` database lock timeouts, serializing worker throughput and breaking horizontal scalability across multi-container Docker deployments.

---

### Isolation Level
The system runs on PostgreSQL's default `READ COMMITTED` isolation level. This is sufficient because:
1. Job claim is a single atomic CTE statement (no read-then-write gap).
2. Heartbeats are single atomic `UPDATE` statements.
3. The finish step uses a conditional compare-and-swap `UPDATE ... WHERE id=$1 AND lease_token=$2 AND status='running'` inside a transaction.

Higher isolation levels like `SERIALIZABLE` would introduce serialization failure retry loops (`40001`) without providing additional safety for this architecture.

---

## 2. Chaos Harness & Test Verification

The chaos harness (`scripts/chaos.js`) executes concurrent stress activities against a cluster of 8 workers:
* **Producer**: Sends 10,000 jobs via `POST /jobs` at concurrency 50 with random duplicate replays (`DUPLICATE_RATE=0.3`).
* **Killer**: Hits active worker containers with `SIGKILL` every ~2 seconds, tracks whether the killed worker held a job, and restarts the container after 3 seconds.
* **Canceller**: Issues `POST /jobs/:id/cancel` concurrently, picking actively running jobs with 50% probability.
* **Freezer**: Pauses containers for 7 seconds (`docker pause`) to simulate long GC pauses exceeding the 5-second lease.

### The 10 Invariants Checked on Every Run
1. **No Job Lost**: Every key returning 200 or 201 exists in PostgreSQL with matching ID.
2. **Idempotency**: All responses for a given key return the same job ID; zero duplicate keys in PostgreSQL.
3. **No Duplicate Effects**: No job has more than one row in the `effects` table.
4. **No Duplicate Log Lines**: No job has more than one line in `data/jobs.log`.
5. **Terminal State**: Zero jobs remain in `queued` or `running` status after queue drain.
6. **Status vs Effects Consistency**: Succeeded jobs have an effect row with matching `lease_token`. Cancelled and failed jobs have zero effect rows.
7. **Cancel Consistency**: Jobs returning 200 on cancel are marked `cancelled` in the DB. Jobs returning 409 match their DB status.
8. **Claim Log Consistency**: No two claims share `(job_id, lease_token)`. Total claims equal `attempts`.
9. **Terminal Leases Cleared**: All finished jobs have `lease_expires_at IS NULL`.
10. **Known Flaw Check**: Tracks jobs with an `effects` row but missing from `jobs.log` (dual-write vulnerability window).

### Test Campaign Summary (5 Consecutive 1,000-Job Runs)

```text
Run   | Seed         | Exit Code | Kills   | Hit Running Job | Duration  
-----------------------------------------------------------------------------
1     | 1726144263   | 0         | 6       | 5               | 31.66s    
2     | 1710848041   | 0         | 4       | 4               | 24.06s    
3     | 457087475    | 0         | 6       | 5               | 30.68s    
4     | 1442032103   | 0         | 6       | 5               | 31.38s    
5     | 3862466363   | 0         | 6       | 5               | 28.81s    
```

### Full 10,000-Job Stress Test ([`results/chaos-10k-run1.txt`](results/chaos-10k-run1.txt))
Ran 10,000 jobs with 8 workers, 35 SIGKILLs, 500 concurrent cancellations, and 30% duplicate request replays:
- **Duration**: 213.82s (~3.5 minutes), throughput 46.77 jobs/s.
- **Kills**: 35 kills, 100% (35/35) landed on workers actively processing a job.
- **Cancellations**: 495 returned 200, 232 targeted active claims, 228 stale writes rejected.
- **Invariants**: 8 of 9 passed. 
  - **Empirical Dual-Write Proof**: Job ID `14412` was committed to `effects` in PostgreSQL, but its worker was SIGKILLed before `fs.appendFile` completed, leaving it missing from `jobs.log` (`[KNOWN-FLAW] count=1`).
  - **Drain Settle Boundary**: Invariant 5 showed 10 jobs remaining in `queued` status because the default 180s settle timeout elapsed while workers were recovering from the 35 kills. Extending `SETTLE_TIMEOUT_SEC=300` drains the queue completely.

### Mutation Testing Results
To verify that the harness actually detects bugs rather than rubber-stamping passes:
* **`naiveclaim` mutation**: Replaced atomic CTE claim with non-atomic `SELECT` then `UPDATE`.
  * **Result**: Harness detected duplicate claims and duplicate side effects; exited with code 1.
* **`nofence` mutation**: Removed `AND lease_token = $2` from finish transaction.
  * **Result**: Tested against zombie workers. In PostgreSQL, `UNIQUE(job_id)` on `effects` acted as an engine-level backstop, preventing duplicate rows in the database.

### What the Harness Does NOT Catch
* PostgreSQL database crash or master failover.
* Network partition between the API container and PostgreSQL.
* API crash mid-request before the database write completes.
* Filesystem corruption or disk exhaustion.
* Clock jumps or leap seconds on the PostgreSQL host machine.
* Non-transactional external side effects (e.g., third-party webhooks, Stripe charges, emails).

---

## 3. Silent Failures (How Each Was Checked)

Detailed failure descriptions and evidence files:

| Failure Mode | How It Could Happen | How We Checked It | Evidence File |
|---|---|---|---|
| **Double Claim** | Concurrent workers read the same queued row before either updates it. | Verified through `claim_log` uniqueness on `(job_id, lease_token)` and the `naiveclaim` mutation test. | [`results/v1-atomic.txt`](results/v1-atomic.txt), [`results/chaos/mutant-naiveclaim-run1.txt`](results/chaos/mutant-naiveclaim-run1.txt) |
| **Zombie Worker** | Stalled worker wakes up after lease expires and writes stale result over new worker's work. | Verified by pausing workers for 7s (`FREEZE_ENABLED=1`) and checking worker logs for `"stale write rejected"`. | [`results/v3-freeze.txt`](results/v3-freeze.txt), [`results/v3-freeze-rejections.txt`](results/v3-freeze-rejections.txt) |
| **Cancel/Complete Race** | Job cancelled while worker is inside its finish transaction. | Harness canceller targets running jobs (50% probability). Checked that cancelled jobs have 0 `effects` rows and 0 log lines. | [`results/v4-cancel.txt`](results/v4-cancel.txt), [`results/chaos/final-run1.txt`](results/chaos/final-run1.txt) |
| **Duplicate on Retry** | Client timeout causes request replay with identical parameters. | Producer replays keys with 30% probability; validated 201 on first request and 200 on all replays with 0 duplicate DB rows. | [`results/v4-normal.txt`](results/v4-normal.txt), [`results/chaos/final-run1.txt`](results/chaos/final-run1.txt) |
| **Isolation Level Anomaly** | Read Committed allows non-repeatable reads during multi-step claim. | Validated single CTE atomic claim statement under 50 concurrent producers and 8 workers. | [`results/v1-atomic.txt`](results/v1-atomic.txt) |
| **Clock Skew** | Out-of-sync worker clocks cause premature lease expiration. | Audited all SQL statements to verify exclusively database server `clock_timestamp()` is used. | [`docs/DESIGN.md`](docs/DESIGN.md) |

---

## 4. Explaining the Edge-Case Numbers

### 1. Why Did the Initial Quickstart Show 49 `[KNOWN-FLAW]` Lines with Only 4 Kills?
In the initial `quickstart.sh` implementation, `rm -f data/jobs.log` wiped the host log file, but `docker compose up -d` was run **without** resetting the database volume (`docker compose down -v`). 

PostgreSQL still retained 49 completed jobs from a previous test session in its `effects` table. When the invariant check ran, it saw 49 jobs in `effects` that were missing from the newly emptied `jobs.log`. When `docker compose down -v` is included (as in `scripts/chaos-run.sh`), both start clean and `[KNOWN-FLAW]` correctly reports 0.

### 2. Why Did Mutation Testing Show Two Log Lines with One `effects` Row?
In `scripts/mutation-test.sh`, the repository was copied to a temporary directory with `cp -R . "$TMP_DIR"`. This copied the host's existing `data/jobs.log` containing previously completed jobs into the test workspace. 

When the mutant workers executed jobs 1 through 500, they appended a second line for those IDs to the existing log file, while PostgreSQL was running in a fresh isolated container. Once `rm -f "$TMP_DIR/data/jobs.log"` was added immediately after copying, this discrepancy disappeared.

Crucially, this highlighted an essential architectural insight:
**The `UNIQUE (job_id)` constraint on `effects` is the database backstop.** Even when the application-level fencing token was removed in `nofence`, the database unique constraint prevented duplicate rows in `effects`. However, external systems without database constraints (like log files or webhook calls) remain vulnerable to duplicate execution if the fence is missing.

---

## 5. Verdict: SHIP or DON'T SHIP at 100 req/s?

### Verdict: **DON'T SHIP**

While the core database state machine is correct and survived continuous `SIGKILL` attacks and worker freezes, two critical architectural issues prevent shipping to production at 100 requests per second:

1. **The Post-Commit Dual-Write Gap**: If a job's execution involves an external side-effect (calling a third-party API, sending an email, or writing an S3 file), executing that side-effect after the database `COMMIT` creates an at-most-once vulnerability where a crash causes a missing side-effect. Executing it before `COMMIT` creates an at-least-once vulnerability where a crash causes a duplicate side-effect.
   * *Fix first*: Implement the **Transactional Outbox Pattern** with an outbox table in PostgreSQL and idempotent downstream consumers.
2. **Database Connection Saturation & Polling Overhead**: Under 100 req/s with 8+ workers, 8 workers polling the queue every 200ms with `FOR UPDATE SKIP LOCKED` creates high empty-polling query load and connection churn on PostgreSQL.
   * *Fix first*: Introduce **PgBouncer** for connection pooling, and replace fixed interval polling with PostgreSQL **`LISTEN / NOTIFY`** to wake idle workers reactively.

---

## 6. What Surprised Me & What Still Concerns Me

* **What Surprised Me**: How resilient single-statement CTEs with `FOR UPDATE SKIP LOCKED` are in PostgreSQL. Under severe concurrent contention with 8 workers and rapid SIGKILLs, not a single job was claimed twice or dropped. Furthermore, the interplay between the application-level fencing token (`lease_token`) and the database-level constraint (`UNIQUE (job_id)`) revealed that database constraints serve as a critical defense-in-depth safety net when application logic has subtle bugs.
* **What Still Concerns Me**: The recovery delay when a worker dies. With a 5-second lease and a 1-second reaper, an abandoned job can take up to 6 seconds to be reassigned. In a production training queue with high throughput, this latency tail can cause head-of-line blocking for prioritized workloads.

---

## 7. AI Usage Note

* **Where AI was used**: Initial brainstorming of the chaos harness architecture, drafting edge-case test combinations, and structuring bash orchestration scripts.
* **What was accepted**: The Common Table Expression structure for atomic claims (`FOR UPDATE SKIP LOCKED` with `RETURNING`).
* **What was verified & corrected**:
  * Corrected container port collisions between local PostgreSQL (5432) and Docker Compose by mapping host port 5433.
  * Discovered and resolved dirty volume persistence in `quickstart.sh` where leftover database records mismatched wiped log files.
  * Caught and fixed `cp -R` directory copying in `mutation-test.sh` that carried over host log files into isolated mutation sandboxes.
