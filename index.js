// ------------------- Dependencies -------------------
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');

// ------------------- Config -------------------
const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// ------------------- PostgreSQL -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------- Track Connected Users -------------------
const connectedUsers = new Map();

// ------------------- Tables Setup -------------------
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        profile_picture TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        sender_id INT NOT NULL REFERENCES users(id),
        receiver_id INT NOT NULL REFERENCES users(id),
        delivered BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log("Tables ensured in Postgres");

  } catch (err) {
    console.error("DB setup error:", err);
  }
})();


// =======================================================
// ===================== HTTP ROUTES =====================
// =======================================================

app.post('/register', async (req, res) => {
  const { username, profile_picture } = req.body;

  if (!username)
    return res.status(400).json({ error: 'Username required' });

  try {
    const existing = await pool.query(
      'SELECT * FROM users WHERE username=$1',
      [username]
    );

    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Username exists' });

    const user = await pool.query(
      'INSERT INTO users (username, profile_picture) VALUES ($1,$2) RETURNING id, username',
      [username, profile_picture || null]
    );

    res.status(201).json({ user: user.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/upload-avatar', async (req, res) => {
  const { userId, image } = req.body;

  if (!userId || !image)
    return res.status(400).json({ error: 'Missing userId or image' });

  try {
    const result = await pool.query(
      'UPDATE users SET profile_picture = $1 WHERE id = $2 RETURNING id',
      [image, userId]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'Avatar updated successfully' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const searchQuery = req.query.q || '';
    let result;

    if (searchQuery) {
      result = await pool.query(
        `SELECT id, username, profile_picture
         FROM users
         WHERE LOWER(username) = LOWER($1)`,
        [searchQuery]
      );
    } else {
      result = await pool.query(
        `SELECT id, username, profile_picture
         FROM users
         ORDER BY username ASC`
      );
    }

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/user/:id/avatar', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT profile_picture FROM users WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });

    res.json({ image: result.rows[0].profile_picture });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/messages/:user1/:user2', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2)
          OR (sender_id=$2 AND receiver_id=$1)
       ORDER BY created_at ASC`,
      [req.params.user1, req.params.user2]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error
