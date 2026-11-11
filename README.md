# Job Queue Service (v0)

## Start

```bash
docker compose up --build
```

## Seed

```bash
node scripts/seed.js 1000
```

## Report

```bash
node scripts/report.js
```

## Kill a Worker Mid-Job

```bash
docker kill --signal=SIGKILL <container-name>
```

## Known flaws (intentional)

- non-atomic claim
- no lease
- no recovery of running jobs
- no idempotency enforcement
- no unique constraint on effects
- file write and DB write not atomic
