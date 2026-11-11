CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  lease_token BIGINT NOT NULL DEFAULT 0,
  cancelled_at TIMESTAMPTZ,
  failed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS effects (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  lease_token BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs (status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS claim_log (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL,
  worker_id TEXT NOT NULL,
  lease_token BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
