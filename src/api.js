const crypto = require('crypto');
const express = require('express');
const pool = require('./db');

const app = express();
app.use(express.json());

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(obj[key]));
  return '{' + pairs.join(',') + '}';
}

function hashPayload(payload) {
  const canonical = canonicalJson(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/jobs', async (req, res) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      return res.status(400).json({ error: 'Idempotency-Key header is required' });
    }

    let payload = {};
    if (req.body && req.body.payload !== undefined) {
      if (typeof req.body.payload !== 'object' || req.body.payload === null || Array.isArray(req.body.payload)) {
        return res.status(400).json({ error: 'payload must be a JSON object' });
      }
      payload = req.body.payload;
    }

    const requestHash = hashPayload(payload);

    const insertResult = await pool.query(
      'INSERT INTO jobs (idempotency_key, payload, request_hash) VALUES ($1, $2, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *',
      [idempotencyKey, JSON.stringify(payload), requestHash]
    );

    if (insertResult.rows.length > 0) {
      return res.status(201).json(insertResult.rows[0]);
    }

    const existingResult = await pool.query(
      'SELECT * FROM jobs WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    const existingJob = existingResult.rows[0];
    if (existingJob.request_hash === requestHash) {
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(200).json(existingJob);
    }

    return res.status(422).json({ error: 'idempotency_key_reused_with_different_body' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/jobs/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const updateResult = await pool.query(
      "UPDATE jobs SET status = 'cancelled', cancelled_at = clock_timestamp(), worker_id = NULL, lease_expires_at = NULL WHERE id = $1 AND status IN ('queued', 'running') RETURNING *",
      [id]
    );

    if (updateResult.rows.length > 0) {
      return res.status(200).json(updateResult.rows[0]);
    }

    const selectResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1',
      [id]
    );

    if (selectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = selectResult.rows[0];
    if (job.status === 'cancelled') {
      return res.status(200).json(job);
    }

    return res.status(409).json({ error: `Job cannot be cancelled in status ${job.status}`, status: job.status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/jobs', async (req, res) => {
  try {
    const rawLimit = req.query.limit;
    let limit = 50;
    if (rawLimit !== undefined) {
      const parsedLimit = parseInt(rawLimit, 10);
      if (isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(parsedLimit, 200);
    }

    const rawCursor = req.query.cursor;
    let cursor = '0';
    if (rawCursor !== undefined) {
      if (!/^\d+$/.test(rawCursor)) {
        return res.status(400).json({ error: 'cursor must be a non-negative integer' });
      }
      cursor = rawCursor;
    }

    const result = await pool.query(
      'SELECT * FROM jobs WHERE id > $1 ORDER BY id LIMIT $2',
      [cursor, limit + 1]
    );

    let nextCursor = null;
    let items = result.rows;
    if (items.length > limit) {
      items = items.slice(0, limit);
      nextCursor = String(items[items.length - 1].id);
    }

    return res.status(200).json({ items, nextCursor });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
