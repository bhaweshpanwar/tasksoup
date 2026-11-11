const express = require('express');
const pool = require('./db');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/jobs', async (req, res) => {
  try {
    const { idempotencyKey } = req.body || {};
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'idempotencyKey is required' });
    }

    const result = await pool.query(
      'INSERT INTO jobs (idempotency_key) VALUES ($1) RETURNING *',
      [idempotencyKey]
    );

    return res.status(201).json(result.rows[0]);
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
    const rawOffset = req.query.offset;
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'limit and offset must be non-negative integers' });
    }

    const result = await pool.query(
      'SELECT * FROM jobs ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
