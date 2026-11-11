CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS effects (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL,
  worker_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs (status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS claim_log (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
