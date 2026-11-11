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
              attempts = attempts + 1
          FROM picked
          WHERE jobs.id = picked.id
          RETURNING jobs.id
        )
        INSERT INTO claim_log (job_id, worker_id)
        SELECT id, $1 FROM claimed
        RETURNING job_id AS id;`,
        [workerId, leaseSeconds]
      );

      if (claimResult.rows.length === 0) {
        await sleep(200);
        continue;
      }

      const job = claimResult.rows[0];
      console.log(`Claimed job ${job.id}`);

      const heartbeatInterval = setInterval(async () => {
        try {
          const res = await pool.query(
            "UPDATE jobs SET lease_expires_at = clock_timestamp() + make_interval(secs => $2) WHERE id = $1 AND status = 'running'",
            [job.id, leaseSeconds]
          );
          if (res.rowCount === 0) {
            console.log(`Heartbeat updated 0 rows for job ${job.id}`);
          }
        } catch (err) {
          console.error(err);
        }
      }, Math.floor((leaseSeconds * 1000) / 3));

      try {
        const workDuration = Math.floor(Math.random() * (workMaxMs - workMinMs + 1)) + workMinMs;
        await sleep(workDuration);

        const word = words[Math.floor(Math.random() * words.length)];
        const line = `jobId=${job.id} worker=${workerId} word=${word} ts=${new Date().toISOString()}\n`;

        await new Promise((resolve, reject) => {
          fs.appendFile(jobFile, line, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });

        await pool.query(
          'INSERT INTO effects (job_id, worker_id) VALUES ($1, $2)',
          [job.id, workerId]
        );

        await pool.query(
          "UPDATE jobs SET status = 'succeeded' WHERE id = $1",
          [job.id]
        );
        console.log(`Finished job ${job.id}`);
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
