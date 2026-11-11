const os = require('os');
const fs = require('fs');
const path = require('path');
const pool = require('./db');

const workerId = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const jobFile = process.env.JOB_FILE || '/data/jobs.log';
const leaseSeconds = parseInt(process.env.LEASE_SECONDS || '5', 10);
const workMinMs = parseInt(process.env.WORK_MIN_MS || '50', 10);
const workMaxMs = parseInt(process.env.WORK_MAX_MS || '300', 10);

const words = [
  'cloud', 'stream', 'ocean', 'forest', 'mountain',
  'river', 'desert', 'valley', 'canyon', 'meadow',
  'glacier', 'island', 'volcano', 'prairie', 'lagoon',
  'tundra', 'jungle', 'plateau', 'oasis', 'savanna'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('SIGTERM', () => {
  process.exit(0);
});

setInterval(async () => {
  try {
    const res = await pool.query(
      "UPDATE jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL WHERE status = 'running' AND lease_expires_at < clock_timestamp() RETURNING id"
    );
    if (res.rows.length > 0) {
      const ids = res.rows.map((r) => r.id).join(', ');
      console.log(`Requeued expired jobs: ${ids}`);
    }
  } catch (err) {
    console.error(err);
  }
}, 1000);

async function run() {
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });

  while (true) {
    try {
      const claimResult = await pool.query(
        `WITH picked AS (
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
        RETURNING job_id AS id, lease_token;`,
        [workerId, leaseSeconds]
      );

      if (claimResult.rows.length === 0) {
        await sleep(200);
        continue;
      }

      const job = claimResult.rows[0];
      console.log(`Claimed job ${job.id}`);

      let lostLease = false;
      const heartbeatInterval = setInterval(async () => {
        try {
          const res = await pool.query(
            "UPDATE jobs SET lease_expires_at = clock_timestamp() + make_interval(secs => $2) WHERE id = $1 AND status = 'running' AND lease_token = $3",
            [job.id, leaseSeconds, job.lease_token]
          );
          if (res.rowCount === 0) {
            lostLease = true;
            console.log(`Heartbeat lost lease for job ${job.id}`);
            clearInterval(heartbeatInterval);
          }
        } catch (err) {
          console.error(err);
        }
      }, Math.floor((leaseSeconds * 1000) / 3));

      try {
        const workDuration = Math.floor(Math.random() * (workMaxMs - workMinMs + 1)) + workMinMs;
        await sleep(workDuration);
        clearInterval(heartbeatInterval);

        if (lostLease) {
          console.log(`Worker noted lost lease flag for job ${job.id}`);
        }

        let committed = false;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const updateResult = await client.query(
            "UPDATE jobs SET status = 'succeeded', lease_expires_at = NULL WHERE id = $1 AND lease_token = $2 AND status = 'running'",
            [job.id, job.lease_token]
          );

          if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            console.log(`stale write rejected for job ${job.id}`);
          } else {
            await client.query(
              'INSERT INTO effects (job_id, worker_id, lease_token) VALUES ($1, $2, $3)',
              [job.id, workerId, job.lease_token]
            );
            await client.query('COMMIT');
            committed = true;
            console.log(`Finished job ${job.id}`);
          }
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {}
          console.error(err);
        } finally {
          client.release();
        }

        if (committed) {
          const word = words[Math.floor(Math.random() * words.length)];
          const line = `jobId=${job.id} worker=${workerId} word=${word} ts=${new Date().toISOString()}\n`;

          await new Promise((resolve, reject) => {
            fs.appendFile(jobFile, line, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        }
      } finally {
        clearInterval(heartbeatInterval);
      }
    } catch (err) {
      console.error(err);
      await sleep(500);
    }
  }
}

run();
