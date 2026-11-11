const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

const expectedCount = process.argv[2]
  ? parseInt(process.argv[2], 10)
  : (process.env.EXPECTED_COUNT ? parseInt(process.env.EXPECTED_COUNT, 10) : 1000);

const jobFilePath = process.env.JOB_FILE || path.join(__dirname, '../data/jobs.log');

async function run() {
  let hasFailure = false;

  let fileLines = [];
  if (fs.existsSync(jobFilePath)) {
    const content = fs.readFileSync(jobFilePath, 'utf8');
    fileLines = content.split('\n').filter((line) => line.trim().length > 0);
  }

  const totalRes = await pool.query('SELECT COUNT(*) AS count FROM jobs');
  const totalJobs = parseInt(totalRes.rows[0].count, 10);

  if (totalJobs === expectedCount) {
    console.log(`[PASS] Total jobs in table matches expected count: ${totalJobs}/${expectedCount}`);
  } else {
    hasFailure = true;
    console.log(`[FAIL] Total jobs in table (${totalJobs}) does not match expected count (${expectedCount})`);
  }

  const statusRes = await pool.query(
    'SELECT status, COUNT(*) AS count FROM jobs GROUP BY status'
  );
  const statusCounts = { queued: 0, running: 0, succeeded: 0 };
  for (const row of statusRes.rows) {
    statusCounts[row.status] = parseInt(row.count, 10);
  }

  const statusPass =
    totalJobs > 0 &&
    statusCounts.queued === 0 &&
    statusCounts.running === 0 &&
    statusCounts.succeeded === totalJobs;

  if (statusPass) {
    console.log(
      `[PASS] Jobs by status (counts: succeeded=${statusCounts.succeeded}, queued=${statusCounts.queued}, running=${statusCounts.running})`
    );
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs by status (counts: succeeded=${statusCounts.succeeded}, queued=${statusCounts.queued}, running=${statusCounts.running})`
    );
  }

  const dupEffectsRes = await pool.query(
    'SELECT job_id, COUNT(*) AS count FROM effects GROUP BY job_id HAVING COUNT(*) > 1 ORDER BY count DESC, job_id ASC LIMIT 10'
  );
  if (dupEffectsRes.rows.length === 0) {
    console.log('[PASS] Jobs with more than one row in effects: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs with more than one row in effects (${dupEffectsRes.rows.length} offenders shown):`
    );
    for (const row of dupEffectsRes.rows) {
      console.log(`  jobId=${row.job_id} count=${row.count}`);
    }
  }

  const logCounts = new Map();
  for (const line of fileLines) {
    const match = line.match(/^jobId=(\d+)/);
    if (match) {
      const jobId = match[1];
      logCounts.set(jobId, (logCounts.get(jobId) || 0) + 1);
    }
  }

  const duplicateLogJobs = [];
  for (const [jobId, count] of logCounts.entries()) {
    if (count > 1) {
      duplicateLogJobs.push({ jobId, count });
    }
  }
  duplicateLogJobs.sort((a, b) => b.count - a.count);
  const topDuplicateLogs = duplicateLogJobs.slice(0, 10);

  if (topDuplicateLogs.length === 0) {
    console.log('[PASS] Jobs with more than one line in jobs.log: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs with more than one line in jobs.log (${duplicateLogJobs.length} offenders found, top ${topDuplicateLogs.length} shown):`
    );
    for (const item of topDuplicateLogs) {
      console.log(`  jobId=${item.jobId} count=${item.count}`);
    }
  }

  const runningRes = await pool.query(
    "SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'"
  );
  const runningCount = parseInt(runningRes.rows[0].count, 10);
  if (runningCount === 0) {
    console.log('[PASS] Jobs stuck in running: 0');
  } else {
    hasFailure = true;
    console.log(`[FAIL] Jobs stuck in running: ${runningCount}`);
  }

  const noEffectsRes = await pool.query(
    "SELECT j.id FROM jobs j LEFT JOIN effects e ON j.id = e.job_id WHERE j.status = 'succeeded' AND e.id IS NULL"
  );
  if (noEffectsRes.rows.length === 0) {
    console.log('[PASS] Jobs succeeded with zero effects: 0');
  } else {
    hasFailure = true;
    console.log(`[FAIL] Jobs succeeded with zero effects: ${noEffectsRes.rows.length}`);
  }

  const effectsCountRes = await pool.query('SELECT COUNT(*) AS count FROM effects');
  const totalEffects = parseInt(effectsCountRes.rows[0].count, 10);
  const totalLogLines = fileLines.length;

  if (totalEffects === totalLogLines) {
    console.log(
      `[PASS] Effects rows (${totalEffects}) match jobs.log line count (${totalLogLines})`
    );
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Effects rows (${totalEffects}) do not match jobs.log line count (${totalLogLines})`
    );
  }

  await pool.end();

  if (hasFailure) {
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
