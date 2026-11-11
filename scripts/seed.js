const apiUrl = process.env.API_URL || 'http://localhost:3000';
const total = parseInt(process.argv[2], 10) || 1000;
const concurrency = 20;

let succeeded = 0;
let failed = 0;
let nextIndex = 0;

async function sendJob() {
  while (true) {
    const i = nextIndex++;
    if (i >= total) {
      break;
    }

    try {
      const response = await fetch(`${apiUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: `key-${i}` })
      });

      if (response.status === 201) {
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
}

async function main() {
  const workers = [];
  const workerCount = Math.min(concurrency, total);

  for (let i = 0; i < workerCount; i++) {
    workers.push(sendJob());
  }

  await Promise.all(workers);

  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
}

main();
