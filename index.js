// ------------------- Dependencies -------------------
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// ------------------- Config -------------------
const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ------------------- PostgreSQL Connection -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ------------------- Tables Setup -------------------
(async () => {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        profile_picture TEXT
      )
    `);

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        userid INT NOT NULL REFERENCES users(id)
      )
    `);

    console.log("Tables ensured in Postgres");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
})();

// ------------------- Routes -------------------

// Register new user
app.post('/register', async (req, res) => {
  const { username, profile_picture } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const insertUser = await pool.query(
      'INSERT INTO users (username, profile_picture) VALUES ($1, $2) RETURNING *',
      [username, profile_picture || null]
    );

    const newUser = insertUser.rows[0];
    res.status(201).json({ user: newUser });

  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------- Get users with optional search -------------------
app.get('/users', async (req, res) => {
  try {
    const searchQuery = req.query.q || ''; // GET /users?q=John
    let result;

    if (searchQuery) {
      // Case-insensitive partial match
      result = await pool.query(
        `SELECT id, username, profile_picture 
         FROM users 
         WHERE username ILIKE $1
         ORDER BY username ASC`,
        [`%${searchQuery}%`]
      );
    } else {
      // Return all users if no query
      result = await pool.query(
        `SELECT id, username, profile_picture 
         FROM users 
         ORDER BY username ASC`
      );
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------- Delete user -------------------
app.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    await pool.query('DELETE FROM messages WHERE userid=$1', [userId]);
    const deleteUser = await pool.query('DELETE FROM users WHERE id=$1 RETURNING *', [userId]);
    if (deleteUser.rowCount === 0) return
