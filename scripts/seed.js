const apiUrl = process.env.API_URL || 'http://localhost:3000';
const total = parseInt(process.argv[2], 10) || 1000;
const duplicateRate = parseFloat(process.env.DUPLICATE_RATE || '0');
const concurrency = 20;

let count201 = 0;
let count200 = 0;
let count422 = 0;
let countOther = 0;
let nextIndex = 0;

async function sendRequest(key, payload) {
  try {
    const response = await fetch(`${apiUrl}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key
      },
      body: JSON.stringify({ payload })
    });

    if (response.status === 201) {
      count201++;
    } else if (response.status === 200) {
      count200++;
    } else if (response.status === 422) {
      count422++;
    } else {
      countOther++;
    }
  } catch {
    countOther++;
  }
}

async function sendJob() {
  while (true) {
    const i = nextIndex++;
    if (i >= total) {
      break;
    }

    const key = `key-${i}`;
    const payload = { index: i };

    if (duplicateRate > 0 && Math.random() < duplicateRate) {
      await Promise.all([
        sendRequest(key, payload),
        sendRequest(key, payload)
      ]);
    } else {
      await sendRequest(key, payload);
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

  console.log(`201 Created: ${count201}`);
  console.log(`200 Replays: ${count200}`);
  console.log(`422 Rejected: ${count422}`);
  console.log(`Other: ${countOther}`);
}

main();
