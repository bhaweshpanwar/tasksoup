const os = require('os');
const fs = require('fs');
const path = require('path');
const pool = require('./db');

const workerId = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const jobFile = process.env.JOB_FILE || '/data/jobs.log';

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

async function run() {
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });

  while (true) {
    try {
      const selectResult = await pool.query(
        "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1"
      );

      if (selectResult.rows.length === 0) {
        await sleep(200);
        continue;
      }

      const job = selectResult.rows[0];

      await pool.query(
        'UPDATE jobs SET status = $1, worker_id = $2 WHERE id = $3',
        ['running', workerId, job.id]
      );
      console.log(`Claimed job ${job.id}`);

      const workDuration = Math.floor(Math.random() * (300 - 50 + 1)) + 50;
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
    } catch (err) {
      console.error(err);
      await sleep(500);
    }
  }
}

run();
