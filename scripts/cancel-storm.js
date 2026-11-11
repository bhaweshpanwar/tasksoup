const apiUrl = process.env.API_URL || 'http://localhost:3000';
const percent = parseFloat(process.argv[2]) || 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let allJobs = [];
  let cursor = null;

  while (true) {
    const url = cursor
      ? `${apiUrl}/jobs?limit=200&cursor=${cursor}`
      : `${apiUrl}/jobs?limit=200`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      break;
    }
    allJobs = allJobs.concat(data.items);
    if (!data.nextCursor) {
      break;
    }
    cursor = data.nextCursor;
  }

  const targetCount = Math.floor((allJobs.length * percent) / 100);
  const shuffled = allJobs.slice().sort(() => Math.random() - 0.5);
  const selectedJobs = shuffled.slice(0, targetCount);

  let count200 = 0;
  let count409 = 0;
  let count404 = 0;
  let countOther = 0;

  const cancelPromises = selectedJobs.map(async (job) => {
    const delay = Math.floor(Math.random() * 500);
    await sleep(delay);

    try {
      const res = await fetch(`${apiUrl}/jobs/${job.id}/cancel`, {
        method: 'POST'
      });
      if (res.status === 200) {
        count200++;
      } else if (res.status === 409) {
        count409++;
      } else if (res.status === 404) {
        count404++;
      } else {
        countOther++;
      }
    } catch {
      countOther++;
    }
  });

  await Promise.all(cancelPromises);

  console.log(`200 OK: ${count200}`);
  console.log(`409 Conflict: ${count409}`);
  console.log(`404 Not Found: ${count404}`);
  if (countOther > 0) {
    console.log(`Other: ${countOther}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
