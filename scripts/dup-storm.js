const pool = require('../src/db');

const apiUrl = process.env.API_URL || 'http://localhost:3000';
const keysCount = parseInt(process.argv[2], 10) || 10;
const concurrencyPerKey = parseInt(process.argv[3], 10) || 10;

async function run() {
  let hasFailure = false;

  for (let k = 0; k < keysCount; k++) {
    const key = `dup-storm-${k}-${Date.now()}`;
    const payload = { stormIndex: k };
    const body = JSON.stringify({ payload });

    const statuses = await Promise.all(
      Array.from({ length: concurrencyPerKey }, async () => {
        try {
          const res = await fetch(`${apiUrl}/jobs`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': key
            },
            body
          });
          return res.status;
        } catch {
          return 0;
        }
      })
    );

    const count201 = statuses.filter((s) => s === 201).length;
    const count200 = statuses.filter((s) => s === 200).length;

    console.log(`Key ${key}: 201=${count201}, 200=${count200}`);

    if (count201 !== 1) {
      hasFailure = true;
    }
  }

  const dbCheck = await pool.query(
    'SELECT idempotency_key, COUNT(*) AS count FROM jobs GROUP BY idempotency_key HAVING COUNT(*) > 1'
  );

  if (dbCheck.rows.length > 0) {
    hasFailure = true;
    console.log(`Duplicate keys found in database: ${dbCheck.rows.length}`);
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
