const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

const expectedCount = process.env.EXPECTED_JOBS
  ? parseInt(process.env.EXPECTED_JOBS, 10)
  : (process.argv[2]
    ? parseInt(process.argv[2], 10)
    : (process.env.EXPECTED_COUNT ? parseInt(process.env.EXPECTED_COUNT, 10) : 1000));

const reportLabel = process.env.REPORT_LABEL || 'v4';
const jobFilePath = process.env.JOB_FILE || path.join(__dirname, '../data/jobs.log');

async function run() {
  console.log(`REPORT_LABEL: ${reportLabel}`);
  console.log(`TIMESTAMP: ${new Date().toISOString()}`);
  console.log(`EXPECTED_JOBS: ${expectedCount}`);
  console.log('---');

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
  const statusCounts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of statusRes.rows) {
    statusCounts[row.status] = parseInt(row.count, 10);
  }

  const statusPass =
    totalJobs > 0 &&
    statusCounts.queued === 0 &&
    statusCounts.running === 0 &&
    statusCounts.succeeded + statusCounts.failed + statusCounts.cancelled === totalJobs;

  if (statusPass) {
    console.log(
      `[PASS] Jobs by status (counts: succeeded=${statusCounts.succeeded}, failed=${statusCounts.failed}, cancelled=${statusCounts.cancelled}, queued=${statusCounts.queued}, running=${statusCounts.running})`
    );
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs by status (counts: succeeded=${statusCounts.succeeded}, failed=${statusCounts.failed}, cancelled=${statusCounts.cancelled}, queued=${statusCounts.queued}, running=${statusCounts.running})`
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

  const dupClaimsRes = await pool.query(
    'SELECT job_id, lease_token, COUNT(*) AS count FROM claim_log GROUP BY job_id, lease_token HAVING COUNT(*) > 1 ORDER BY count DESC, job_id ASC LIMIT 10'
  );
  if (dupClaimsRes.rows.length === 0) {
    console.log('[PASS] Jobs with more than one claim_log row for same lease_token: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs with more than one claim_log row for same lease_token (${dupClaimsRes.rows.length} offenders shown):`
    );
    for (const row of dupClaimsRes.rows) {
      console.log(`  jobId=${row.job_id} lease_token=${row.lease_token} count=${row.count}`);
    }
  }

  const attemptsCountRes = await pool.query(
    'SELECT COUNT(*) AS count FROM jobs WHERE attempts > 1'
  );
  const attemptsCount = parseInt(attemptsCountRes.rows[0].count, 10);
  const attemptsRes = await pool.query(
    'SELECT id, attempts FROM jobs WHERE attempts > 1 ORDER BY attempts DESC, id ASC LIMIT 10'
  );

  if (attemptsCount === 0) {
    console.log('[PASS] Jobs with attempts > 1: 0');
  } else {
    console.log(
      `[INFO] Jobs with attempts > 1 (${attemptsCount} total, up to 10 examples shown):`
    );
    for (const row of attemptsRes.rows) {
      console.log(`  jobId=${row.id} attempts=${row.attempts}`);
    }
  }

  const expiredRes = await pool.query(
    "SELECT id, lease_expires_at FROM jobs WHERE status = 'running' AND lease_expires_at < clock_timestamp()"
  );
  if (expiredRes.rows.length === 0) {
    console.log("[PASS] Jobs with status 'running' and lease_expires_at in the past: 0");
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs with status 'running' and lease_expires_at in the past: ${expiredRes.rows.length}`
    );
  }

  const mismatchCountRes = await pool.query(
    "SELECT COUNT(*) AS count FROM jobs j JOIN effects e ON j.id = e.job_id WHERE j.status = 'succeeded' AND e.lease_token != j.lease_token"
  );
  const mismatchCount = parseInt(mismatchCountRes.rows[0].count, 10);
  const mismatchRes = await pool.query(
    "SELECT j.id, j.lease_token AS job_token, e.lease_token AS effect_token FROM jobs j JOIN effects e ON j.id = e.job_id WHERE j.status = 'succeeded' AND e.lease_token != j.lease_token LIMIT 10"
  );
  if (mismatchCount === 0) {
    console.log('[PASS] Succeeded jobs with effects lease_token mismatch: 0');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Succeeded jobs with effects lease_token mismatch (${mismatchCount} found):`
    );
    for (const row of mismatchRes.rows) {
      console.log(
        `  jobId=${row.id} job_token=${row.job_token} effect_token=${row.effect_token}`
      );
    }
  }

  const diffCountRes = await pool.query(
    'SELECT COUNT(*) AS count FROM (SELECT j.id FROM jobs j LEFT JOIN claim_log c ON j.id = c.job_id GROUP BY j.id, j.attempts HAVING j.attempts != COUNT(c.id)) sub'
  );
  const diffCount = parseInt(diffCountRes.rows[0].count, 10);
  const diffRes = await pool.query(
    'SELECT j.id, j.attempts, COUNT(c.id) AS claim_count FROM jobs j LEFT JOIN claim_log c ON j.id = c.job_id GROUP BY j.id, j.attempts HAVING j.attempts != COUNT(c.id) LIMIT 10'
  );
  if (diffCount === 0) {
    console.log('[PASS] Jobs where claim_log count differs from attempts: 0');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Jobs where claim_log count differs from attempts (${diffCount} found):`
    );
    for (const row of diffRes.rows) {
      console.log(
        `  jobId=${row.id} attempts=${row.attempts} claim_count=${row.claim_count}`
      );
    }
  }

  const dupKeysRes = await pool.query(
    'SELECT idempotency_key, COUNT(*) AS count FROM jobs GROUP BY idempotency_key HAVING COUNT(*) > 1 LIMIT 10'
  );
  if (dupKeysRes.rows.length === 0) {
    console.log('[PASS] Duplicate idempotency_key in jobs: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Duplicate idempotency_key in jobs (${dupKeysRes.rows.length} offenders shown):`
    );
    for (const row of dupKeysRes.rows) {
      console.log(`  key=${row.idempotency_key} count=${row.count}`);
    }
  }

  const cancelledWithEffectsRes = await pool.query(
    "SELECT j.id FROM jobs j JOIN effects e ON j.id = e.job_id WHERE j.status = 'cancelled' LIMIT 10"
  );
  if (cancelledWithEffectsRes.rows.length === 0) {
    console.log('[PASS] Cancelled jobs with effects rows: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Cancelled jobs with effects rows (${cancelledWithEffectsRes.rows.length} offenders shown):`
    );
    for (const row of cancelledWithEffectsRes.rows) {
      console.log(`  jobId=${row.id}`);
    }
  }

  const cancelledJobsRes = await pool.query(
    "SELECT id FROM jobs WHERE status = 'cancelled'"
  );
  const cancelledWithLogs = [];
  for (const row of cancelledJobsRes.rows) {
    const idStr = String(row.id);
    if (logCounts.has(idStr)) {
      cancelledWithLogs.push({ id: row.id, count: logCounts.get(idStr) });
    }
  }
  if (cancelledWithLogs.length === 0) {
    console.log('[PASS] Cancelled jobs with jobs.log lines: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Cancelled jobs with jobs.log lines (${cancelledWithLogs.length} offenders shown):`
    );
    for (const item of cancelledWithLogs.slice(0, 10)) {
      console.log(`  jobId=${item.id} count=${item.count}`);
    }
  }

  const failedJobsRes = await pool.query(
    "SELECT id, failed_reason FROM jobs WHERE status = 'failed' ORDER BY id ASC"
  );
  const failedCount = failedJobsRes.rows.length;
  if (failedCount === 0) {
    console.log('[INFO] Jobs in failed state: 0');
  } else {
    const examples = failedJobsRes.rows
      .slice(0, 10)
      .map((r) => `${r.id} (${r.failed_reason})`)
      .join(', ');
    console.log(`[INFO] Jobs in failed state: ${failedCount} (examples: ${examples})`);
  }

  const succeededAndCancelledRes = await pool.query(
    "SELECT id FROM jobs WHERE status = 'succeeded' AND cancelled_at IS NOT NULL LIMIT 10"
  );
  if (succeededAndCancelledRes.rows.length === 0) {
    console.log('[PASS] Succeeded jobs with cancelled_at set: none');
  } else {
    hasFailure = true;
    console.log(
      `[FAIL] Succeeded jobs with cancelled_at set (${succeededAndCancelledRes.rows.length} offenders shown):`
    );
    for (const row of succeededAndCancelledRes.rows) {
      console.log(`  jobId=${row.id}`);
    }
  }

  console.log('Reminder: docker compose logs worker | grep "stale write rejected"');

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
