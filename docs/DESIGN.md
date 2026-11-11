# Design Note

## Claim

The worker claims jobs atomically using a single statement with a Common Table Expression (CTE) and row-level locking:

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

Reasoning:
TODO(human)

## Dead-Worker Detection

Dead or stalled workers are detected through lease expiration evaluated against the database clock.

Heartbeat loop running every `Math.floor((leaseSeconds * 1000) / 3)` ms:
```sql
UPDATE jobs
SET lease_expires_at = clock_timestamp() + make_interval(secs => $2)
WHERE id = $1 AND status = 'running' AND lease_token = $3;
```

Reaper loop running every 1000 ms:
```sql
UPDATE jobs
SET status = 'failed', failed_reason = 'max_attempts', lease_expires_at = NULL
WHERE status = 'running' AND lease_expires_at < clock_timestamp() AND attempts >= $1
RETURNING id;
```

```sql
UPDATE jobs
SET status = 'queued', worker_id = NULL, lease_expires_at = NULL
WHERE status = 'running' AND lease_expires_at < clock_timestamp() AND attempts < $1
RETURNING id;
```

Reasoning:
TODO(human)

## Cancel Semantics

Cancellation is initiated via `POST /jobs/:id/cancel` which marks queued or running jobs as `cancelled`:

```sql
UPDATE jobs
SET status = 'cancelled', cancelled_at = clock_timestamp(), worker_id = NULL, lease_expires_at = NULL
WHERE id = $1 AND status IN ('queued', 'running')
RETURNING *;
```

The worker completes its processing inside a fenced database transaction:
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

If the job was cancelled while the worker was processing, `status = 'running'` fails, the transaction rolls back, and no effects row is inserted.

Reasoning:
TODO(human)

## Delivery Guarantee

The system provides at-least-once processing across crashes with at-most-once side-effect execution enforced by the database transaction and unique constraint:

```sql
CREATE TABLE IF NOT EXISTS effects (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  lease_token BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Reasoning:
TODO(human)

## Isolation Level

The system runs on PostgreSQL default `READ COMMITTED` isolation level without explicit transaction isolation modifiers. Concurrency safety relies on atomic CTE statements, `FOR UPDATE SKIP LOCKED` row locking, and conditional updates on monotonically increasing `lease_token`.

Reasoning:
TODO(human)

## Clock Source

Lease deadlines and expiration checks exclusively use the database engine clock via `clock_timestamp()`:

```sql
lease_expires_at = clock_timestamp() + make_interval(secs => $2)
```

No worker host or client machine timestamps are evaluated for lease validation or expiration transitions.

Reasoning:
TODO(human)

## Known Weaknesses

Post-commit file append gap:
In `src/worker.js`, the log line is appended to disk only after the database transaction has committed:

```javascript
await client.query('COMMIT');
committed = true;
// ...
if (committed) {
  const line = `jobId=${job.id} worker=${workerId} word=${word} ts=${new Date().toISOString()}\n`;
  await new Promise((resolve, reject) => {
    fs.appendFile(jobFile, line, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
```

A process crash or SIGKILL between `COMMIT` and `fs.appendFile` leaves an effect row committed in the database without a corresponding line in `data/jobs.log`.

Reasoning:
TODO(human)
