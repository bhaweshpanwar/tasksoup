const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

process.env.DB_PORT = process.env.DB_PORT || '5433';
const pool = require('../src/db');

const seed = process.env.CHAOS_SEED
  ? parseInt(process.env.CHAOS_SEED, 10)
  : Math.floor(Math.random() * 2147483647);

console.log(`CHAOS_SEED: ${seed}`);

function createPrng(s) {
  let state = s >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = createPrng(seed);

const jobCount = parseInt(process.env.JOB_COUNT || '10000', 10);
const workerCount = parseInt(process.env.WORKER_COUNT || '8', 10);
const killIntervalMs = parseInt(process.env.KILL_INTERVAL_MS || '2000', 10);
const duplicateRate = parseFloat(process.env.DUPLICATE_RATE || '0.3');
const cancelPercent = parseFloat(process.env.CANCEL_PERCENT || '5');
const settleTimeoutSec = parseInt(process.env.SETTLE_TIMEOUT_SEC || '180', 10);
const freezeEnabled = parseInt(process.env.FREEZE_ENABLED || '0', 10) === 1;
const apiUrl = process.env.API_URL || 'http://localhost:3000';
const jobFilePath = process.env.JOB_FILE || path.join(__dirname, '../data/jobs.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getWorkerContainers() {
  try {
    const rawIds = execSync('docker compose ps -q worker 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    if (!rawIds) return [];
    const output = execSync(
      `docker inspect --format '{{.Id}}|{{.Name}}|{{.Config.Hostname}}|{{.State.Running}}' ${rawIds.split(/\s+/).join(' ')} 2>/dev/null`,
      { encoding: 'utf8' }
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id, name, hostname, running] = line.split('|');
        return {
          id,
          name: (name || '').replace(/^\//, ''),
          hostname: hostname || '',
          running: running === 'true'
        };
      });
  } catch {
    return [];
  }
}

async function run() {
  const startTime = Date.now();
  let failedInvariants = 0;

  const keyRecords = new Map();
  const knownJobIds = [];
  const knownJobIdsSet = new Set();
  const cancelRecords = new Map();

  let producer201 = 0;
  let producer200 = 0;
  let producer422 = 0;
  let producerNetErr = 0;

  let totalKills = 0;
  let killsOnRunning = 0;
  let killsOnIdle = 0;

  let cancel200 = 0;
  let cancel409 = 0;
  let cancel404 = 0;
  let cancelOther = 0;
  let cancelAttemptsTargetingRunning = 0;
  let cancelAttemptsTargetingRandom = 0;
  let cancelAttemptsTargetingRunning200 = 0;

  let totalFreezes = 0;
  let freezesOnJob = 0;

  async function postJobRequest(key, payload) {
    try {
      const res = await fetch(`${apiUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key
        },
        body: JSON.stringify({ payload })
      });

      const status = res.status;
      let jobId = null;
      try {
        const data = await res.json();
        if (data && data.id) {
          jobId = String(data.id);
        }
      } catch {}

      if (status === 201) producer201++;
      else if (status === 200) producer200++;
      else if (status === 422) producer422++;
      else producerNetErr++;

      return { status, jobId };
    } catch {
      producerNetErr++;
      return { status: 0, jobId: null };
    }
  }

  let nextJobIndex = 0;
  async function producerWorker() {
    while (true) {
      const i = nextJobIndex++;
      if (i >= jobCount) {
        break;
      }

      const key = `chaos-${seed}-${i}`;
      const payload = { seed, index: i };

      const shouldDup = rng() < duplicateRate;
      const dupCount = shouldDup ? Math.floor(rng() * 3) + 1 : 0;
      const totalReqs = 1 + dupCount;

      const promises = [];
      for (let r = 0; r < totalReqs; r++) {
        promises.push(postJobRequest(key, payload));
      }

      const results = await Promise.all(promises);
      const statuses = results.map((r) => r.status);
      const jobIds = results.map((r) => r.jobId).filter(Boolean);

      keyRecords.set(key, { statuses, jobIds });

      for (const jid of jobIds) {
        if (!knownJobIdsSet.has(jid)) {
          knownJobIdsSet.add(jid);
          knownJobIds.push(jid);
        }
      }
    }
  }

  let chaosRunning = true;

  async function killerLoop() {
    while (chaosRunning) {
      const jitterFactor = 0.5 + rng();
      const delay = Math.floor(killIntervalMs * jitterFactor);
      await sleep(delay);
      if (!chaosRunning) break;

      const live = getWorkerContainers().filter((w) => w.running);
      if (live.length === 0) continue;

      const pickIndex = Math.floor(rng() * live.length);
      const target = live[pickIndex];

      let heldJobIds = [];
      try {
        const queryRes = await pool.query(
          "SELECT id FROM jobs WHERE status = 'running' AND worker_id LIKE $1 || '%'",
          [target.hostname]
        );
        heldJobIds = queryRes.rows.map((r) => String(r.id));
      } catch {}

      totalKills++;
      if (heldJobIds.length > 0) {
        killsOnRunning++;
      } else {
        killsOnIdle++;
      }

      log(
        `Killer: killing container=${target.name} hostname=${target.hostname} held_jobs=[${heldJobIds.join(', ')}]`
      );

      try {
        execSync(`docker kill --signal=SIGKILL ${target.id} 2>/dev/null`);
      } catch {}

      await sleep(3000);
      try {
        const isRunning = execSync(
          `docker inspect --format '{{.State.Running}}' ${target.id} 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
        if (isRunning !== 'true') {
          execSync(`docker start ${target.id} 2>/dev/null`);
          log(`Killer: restarted container=${target.name}`);
        }
      } catch {}
    }
  }

  async function cancellerLoop() {
    let cancelsSent = 0;
    const targetCancels = Math.floor((jobCount * cancelPercent) / 100);

    while (chaosRunning && cancelsSent < targetCancels) {
      const pickRunning = rng() < 0.5;
      let jobId = null;
      let attemptKind = 'random';

      if (pickRunning) {
        try {
          const runningRes = await pool.query(
            "SELECT id FROM jobs WHERE status = 'running' LIMIT 20"
          );
          if (runningRes.rows.length > 0) {
            const pick = runningRes.rows[Math.floor(rng() * runningRes.rows.length)];
            jobId = String(pick.id);
            attemptKind = 'running';
          }
        } catch {}
      }

      if (!jobId) {
        if (knownJobIds.length === 0) {
          await sleep(50);
          continue;
        }
        const pickIdx = Math.floor(rng() * knownJobIds.length);
        jobId = knownJobIds[pickIdx];
        attemptKind = 'random';
      }

      if (attemptKind === 'running') {
        cancelAttemptsTargetingRunning++;
      } else {
        cancelAttemptsTargetingRandom++;
      }
      cancelsSent++;

      try {
        const res = await fetch(`${apiUrl}/jobs/${jobId}/cancel`, {
          method: 'POST'
        });
        const statusCode = res.status;
        let respStatus = null;
        try {
          const body = await res.json();
          respStatus = body.status || null;
        } catch {}

        if (statusCode === 200) {
          cancel200++;
          if (attemptKind === 'running') {
            cancelAttemptsTargetingRunning200++;
          }
        } else if (statusCode === 409) {
          cancel409++;
        } else if (statusCode === 404) {
          cancel404++;
        } else {
          cancelOther++;
        }

        cancelRecords.set(jobId, { statusCode, respStatus, attemptKind });
      } catch {
        cancelOther++;
      }

      await sleep(Math.floor(rng() * 40) + 10);
    }
  }

  async function freezerLoop() {
    while (chaosRunning) {
      await sleep(7000);
      if (!chaosRunning) break;

      const live = getWorkerContainers().filter((w) => w.running);
      if (live.length === 0) continue;

      const pickIndex = Math.floor(rng() * live.length);
      const target = live[pickIndex];

      let heldJobIds = [];
      try {
        const queryRes = await pool.query(
          "SELECT id FROM jobs WHERE status = 'running' AND worker_id LIKE $1 || '%'",
          [target.hostname]
        );
        heldJobIds = queryRes.rows.map((r) => String(r.id));
      } catch {}

      totalFreezes++;
      if (heldJobIds.length > 0) {
        freezesOnJob++;
      }

      log(
        `Freezer: pausing container=${target.name} hostname=${target.hostname} held_jobs=[${heldJobIds.join(', ')}]`
      );
      try {
        execSync(`docker pause ${target.id} 2>/dev/null`);
      } catch {}

      await sleep(7000);

      try {
        execSync(`docker unpause ${target.id} 2>/dev/null`);
        log(`Freezer: unpaused container=${target.name}`);
      } catch {}
    }
  }

  async function printEventCoverage() {
    console.log('--- EVENT COVERAGE ---');
    console.log(
      `Kills: total=${totalKills}, landed_on_running=${killsOnRunning}, held_no_job=${killsOnIdle}`
    );

    try {
      const attemptsAggRes = await pool.query(
        'SELECT COUNT(*) AS count, COALESCE(MAX(attempts), 0) AS max_attempts FROM jobs WHERE attempts > 1'
      );
      console.log(
        `Attempts > 1: count=${attemptsAggRes.rows[0].count}, max_attempts=${attemptsAggRes.rows[0].max_attempts}`
      );
    } catch {
      console.log('Attempts > 1: count=N/A');
    }

    try {
      const failedCountRes = await pool.query(
        "SELECT COUNT(*) AS count FROM jobs WHERE status = 'failed'"
      );
      console.log(`Failed jobs count: ${failedCountRes.rows[0].count}`);
    } catch {
      console.log('Failed jobs count: N/A');
    }

    let cancelledClaimedCount = 0;
    try {
      const cancelledClaimedRes = await pool.query(
        "SELECT COUNT(DISTINCT j.id) AS count FROM jobs j JOIN claim_log c ON j.id = c.job_id WHERE j.status = 'cancelled'"
      );
      cancelledClaimedCount = parseInt(cancelledClaimedRes.rows[0].count, 10);
    } catch {}

    console.log(
      `Cancels: 200=${cancel200}, 409=${cancel409}, 404=${cancel404}, cancelled_after_claim=${cancelledClaimedCount}`
    );
    console.log(
      `Cancel attempts targeting a running job: ${cancelAttemptsTargetingRunning}`
    );
    console.log(
      `Cancel attempts targeting a running job returned 200: ${cancelAttemptsTargetingRunning200}`
    );
    console.log(`Cancel attempts that returned 200: ${cancel200}`);

    let workerLogs = '';
    try {
      workerLogs = execSync('docker compose logs worker 2>/dev/null', {
        encoding: 'utf8'
      });
    } catch {}

    const totalStaleRejections = (
      workerLogs.match(/stale write rejected/g) || []
    ).length;

    let cancelledClaimedWithStale = 0;
    if (cancelledClaimedCount > 0) {
      try {
        const cancelledClaimedIdsRes = await pool.query(
          "SELECT DISTINCT j.id FROM jobs j JOIN claim_log c ON j.id = c.job_id WHERE j.status = 'cancelled'"
        );
        for (const r of cancelledClaimedIdsRes.rows) {
          if (workerLogs.includes(`stale write rejected for job ${r.id}`)) {
            cancelledClaimedWithStale++;
          }
        }
      } catch {}
    }
    console.log(
      `Cancelled-after-claim with stale write rejection: ${cancelledClaimedWithStale}`
    );
    console.log(
      `Total "stale write rejected" lines in worker logs: ${totalStaleRejections}`
    );

    console.log(
      `Producer: 201=${producer201}, 200_replays=${producer200}, 422=${producer422}, network_errors=${producerNetErr}`
    );

    if (freezeEnabled) {
      console.log(
        `Freezes: total=${totalFreezes}, held_job=${freezesOnJob}`
      );
    }

    const durationSec = Math.max(0.1, (Date.now() - startTime) / 1000);
    const jobsPerSec = (jobCount / durationSec).toFixed(2);
    console.log(
      `Duration: ${durationSec.toFixed(2)}s, Throughput: ${jobsPerSec} jobs/s`
    );
  }

  try {
    log('Phase a: Verifying worker containers');
    const verifyDeadline = Date.now() + 30000;
    let runningWorkers = [];
    while (Date.now() < verifyDeadline) {
      runningWorkers = getWorkerContainers().filter((w) => w.running);
      if (runningWorkers.length >= workerCount) {
        break;
      }
      await sleep(1000);
    }

    if (runningWorkers.length < workerCount) {
      throw new Error(
        `Expected ${workerCount} running worker containers, found ${runningWorkers.length}`
      );
    }
    log(`Verified ${runningWorkers.length} worker containers are running`);

    log('Phase b: Starting concurrent chaos activities');

    const producerPromise = Promise.all(
      Array.from({ length: 50 }, () => producerWorker())
    );
    const killerPromise = killerLoop();
    const cancellerPromise = cancellerLoop();
    const freezerPromise = freezeEnabled ? freezerLoop() : Promise.resolve();

    await producerPromise;
    log('Phase c: Producer completed. Draining queue.');

    const settleStart = Date.now();
    const settleDeadline = settleStart + settleTimeoutSec * 1000;

    while (Date.now() < settleDeadline) {
      try {
        const activeRes = await pool.query(
          "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')"
        );
        const activeCount = parseInt(activeRes.rows[0].count, 10);
        if (activeCount === 0) {
          break;
        }
      } catch {}
      await sleep(1000);
    }

    chaosRunning = false;
    await Promise.all([killerPromise, cancellerPromise, freezerPromise]);

    log('Phase c: Stopping chaos, restoring all workers.');
    const allContainers = getWorkerContainers();
    for (const c of allContainers) {
      try {
        execSync(`docker unpause ${c.id} 2>/dev/null`);
      } catch {}
      try {
        const isRunning = execSync(
          `docker inspect --format '{{.State.Running}}' ${c.id} 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
        if (isRunning !== 'true') {
          execSync(`docker start ${c.id} 2>/dev/null`);
        }
      } catch {}
    }

    const finalSettleDeadline = Date.now() + 30000;
    while (Date.now() < finalSettleDeadline) {
      try {
        const activeRes = await pool.query(
          "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')"
        );
        const activeCount = parseInt(activeRes.rows[0].count, 10);
        if (activeCount === 0) {
          break;
        }
      } catch {}
      await sleep(1000);
    }

    log('Phase d: Running invariant checks');

    const dbJobsMap = new Map();
    const dbJobsRes = await pool.query(
      'SELECT id, idempotency_key, status, lease_expires_at, attempts, lease_token, cancelled_at, failed_reason FROM jobs WHERE idempotency_key LIKE $1',
      [`chaos-${seed}-%`]
    );
    for (const row of dbJobsRes.rows) {
      dbJobsMap.set(row.idempotency_key, row);
    }

    const inv1Offenders = [];
    for (const [key, rec] of keyRecords.entries()) {
      const hasSuccess = rec.statuses.some((s) => s === 201 || s === 200);
      if (!hasSuccess) continue;
      const dbJob = dbJobsMap.get(key);
      if (!dbJob) {
        inv1Offenders.push(`missing_key=${key}`);
        continue;
      }
      const expectedId = rec.jobIds[0];
      if (expectedId && String(dbJob.id) !== expectedId) {
        inv1Offenders.push(`id_mismatch key=${key} expected=${expectedId} db=${dbJob.id}`);
      }
    }
    if (inv1Offenders.length === 0) {
      console.log('[PASS] Invariant 1: No job lost');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 1: No job lost (${inv1Offenders.length} offenders, top 10: ${inv1Offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv2Offenders = [];
    for (const [key, rec] of keyRecords.entries()) {
      const distinctIds = new Set(rec.jobIds);
      if (distinctIds.size > 1) {
        inv2Offenders.push(`multiple_ids key=${key}`);
      }
      const count201 = rec.statuses.filter((s) => s === 201).length;
      if (count201 > 1) {
        inv2Offenders.push(`multiple_201 key=${key}`);
      }
    }
    const dupDbKeyRes = await pool.query(
      'SELECT idempotency_key, COUNT(*) AS count FROM jobs WHERE idempotency_key LIKE $1 GROUP BY idempotency_key HAVING COUNT(*) > 1',
      [`chaos-${seed}-%`]
    );
    for (const row of dupDbKeyRes.rows) {
      inv2Offenders.push(`db_dup key=${row.idempotency_key}`);
    }
    if (inv2Offenders.length === 0) {
      console.log('[PASS] Invariant 2: Idempotency');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 2: Idempotency (${inv2Offenders.length} offenders, top 10: ${inv2Offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv3Res = await pool.query(
      'SELECT job_id, COUNT(*) AS count FROM effects GROUP BY job_id HAVING COUNT(*) > 1 LIMIT 10'
    );
    if (inv3Res.rows.length === 0) {
      console.log('[PASS] Invariant 3: No job has more than one effects row');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 3: No job has more than one effects row (${inv3Res.rows.map((r) => r.job_id).join(', ')})`
      );
    }

    let fileLines = [];
    if (fs.existsSync(jobFilePath)) {
      const content = fs.readFileSync(jobFilePath, 'utf8');
      fileLines = content.split('\n').filter((l) => l.trim().length > 0);
    }
    const logCounts = new Map();
    for (const line of fileLines) {
      const match = line.match(/^jobId=(\d+)/);
      if (match) {
        const jid = match[1];
        logCounts.set(jid, (logCounts.get(jid) || 0) + 1);
      }
    }
    const inv4Offenders = [];
    for (const [jid, count] of logCounts.entries()) {
      if (count > 1) {
        inv4Offenders.push(`jobId=${jid} count=${count}`);
      }
    }
    if (inv4Offenders.length === 0) {
      console.log('[PASS] Invariant 4: No job has more than one jobs.log line');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 4: No job has more than one jobs.log line (${inv4Offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv5Res = await pool.query(
      "SELECT id, status FROM jobs WHERE status IN ('queued', 'running') LIMIT 10"
    );
    if (inv5Res.rows.length === 0) {
      console.log('[PASS] Invariant 5: Every job is in a terminal state');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 5: Every job is in a terminal state (${inv5Res.rows.map((r) => `${r.id}:${r.status}`).join(', ')})`
      );
    }

    const inv6A = await pool.query(
      "SELECT j.id FROM jobs j LEFT JOIN effects e ON j.id = e.job_id WHERE j.status = 'succeeded' AND (e.id IS NULL OR e.lease_token != j.lease_token) LIMIT 10"
    );
    const inv6B = await pool.query(
      "SELECT j.id FROM jobs j JOIN effects e ON j.id = e.job_id WHERE j.status IN ('cancelled', 'failed') LIMIT 10"
    );
    if (inv6A.rows.length === 0 && inv6B.rows.length === 0) {
      console.log('[PASS] Invariant 6: Status vs effects consistency');
    } else {
      failedInvariants++;
      const offenders = [
        ...inv6A.rows.map((r) => `succeeded_bad=${r.id}`),
        ...inv6B.rows.map((r) => `non_succeeded_has_effects=${r.id}`)
      ];
      console.log(
        `[FAIL] Invariant 6: Status vs effects consistency (${offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv7Offenders = [];
    const cancelIdsToCheck = Array.from(cancelRecords.keys()).map((id) => parseInt(id, 10));
    if (cancelIdsToCheck.length > 0) {
      const cancelDbRes = await pool.query(
        'SELECT id, status FROM jobs WHERE id = ANY($1::bigint[])',
        [cancelIdsToCheck]
      );
      const cancelDbMap = new Map();
      for (const row of cancelDbRes.rows) {
        cancelDbMap.set(String(row.id), row.status);
      }
      for (const [jid, rec] of cancelRecords.entries()) {
        const dbStatus = cancelDbMap.get(String(jid));
        if (rec.statusCode === 200 && dbStatus !== 'cancelled') {
          inv7Offenders.push(`200_not_cancelled jobId=${jid} dbStatus=${dbStatus}`);
        }
        if (rec.statusCode === 409 && rec.respStatus === 'succeeded' && dbStatus !== 'succeeded') {
          inv7Offenders.push(`409_succeeded_mismatch jobId=${jid} dbStatus=${dbStatus}`);
        }
      }
    }
    if (inv7Offenders.length === 0) {
      console.log('[PASS] Invariant 7: Cancel consistency');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 7: Cancel consistency (${inv7Offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv8A = await pool.query(
      'SELECT job_id, lease_token, COUNT(*) AS count FROM claim_log GROUP BY job_id, lease_token HAVING COUNT(*) > 1 LIMIT 10'
    );
    const inv8B = await pool.query(
      'SELECT j.id, j.attempts, COUNT(c.id) AS claim_count FROM jobs j LEFT JOIN claim_log c ON j.id = c.job_id GROUP BY j.id, j.attempts HAVING j.attempts != COUNT(c.id) LIMIT 10'
    );
    if (inv8A.rows.length === 0 && inv8B.rows.length === 0) {
      console.log('[PASS] Invariant 8: Claim log consistency');
    } else {
      failedInvariants++;
      const offenders = [
        ...inv8A.rows.map((r) => `dup_claim jobId=${r.job_id}:${r.lease_token}`),
        ...inv8B.rows.map((r) => `attempts_mismatch jobId=${r.id}`)
      ];
      console.log(
        `[FAIL] Invariant 8: Claim log consistency (${offenders.slice(0, 10).join(', ')})`
      );
    }

    const inv9Res = await pool.query(
      "SELECT id FROM jobs WHERE status IN ('succeeded', 'failed', 'cancelled') AND lease_expires_at IS NOT NULL LIMIT 10"
    );
    if (inv9Res.rows.length === 0) {
      console.log('[PASS] Invariant 9: Terminal jobs have lease_expires_at NULL');
    } else {
      failedInvariants++;
      console.log(
        `[FAIL] Invariant 9: Terminal jobs have lease_expires_at NULL (${inv9Res.rows.map((r) => r.id).join(', ')})`
      );
    }

    const effectsRowsRes = await pool.query(
      "SELECT j.id FROM jobs j JOIN effects e ON j.id = e.job_id WHERE j.status = 'succeeded'"
    );
    const knownFlawIds = [];
    for (const row of effectsRowsRes.rows) {
      const idStr = String(row.id);
      if (!logCounts.has(idStr)) {
        knownFlawIds.push(idStr);
      }
    }
    console.log(
      `[KNOWN-FLAW] Succeeded jobs with effects row but no jobs.log line: count=${knownFlawIds.length} (ids: ${knownFlawIds.slice(0, 10).join(', ')})`
    );
  } finally {
    await printEventCoverage();
  }

  await pool.end();

  console.log(`CHAOS_SEED: ${seed}`);

  if (failedInvariants > 0) {
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {}
  console.log(`CHAOS_SEED: ${seed}`);
  process.exit(1);
});
