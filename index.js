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
app.use(bodyParser.json({ limit: '5mb' })); // allow base64 images

// ------------------- PostgreSQL Connection -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
        userid INT NOT NULL REFERENCES users(id)
      )
    `);

    console.log("Tables ensured in Postgres");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
})();


// ------------------- Register -------------------
app.post('/register', async (req, res) => {
  const { username, profile_picture } = req.body;

  if (!username)
    return res.status(400).json({ error: 'Username is required' });

  try {
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE username=$1',
      [username]
    );

    if (userCheck.rows.length > 0)
      return res.status(409).json({ error: 'Username already exists' });

    const insertUser = await pool.query(
      'INSERT INTO users (username, profile_picture) VALUES ($1, $2) RETURNING id, username',
      [username, profile_picture || null]
    );

    res.status(201).json({ user: insertUser.rows[0] });

  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Upload Avatar -------------------
app.post('/upload-avatar', async (req, res) => {
  const { userId, image } = req.body;

  if (!userId || !image)
    return res.status(400).json({ error: 'Missing data' });

  if (image.length > 250000)
    return res.status(400).json({ error: 'Image too large' });

  try {
    await pool.query(
      'UPDATE users SET profile_picture=$1 WHERE id=$2',
      [image, userId]
    );

    res.json({ success: true });

  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Get Avatar -------------------
app.get('/user/:id/avatar', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT profile_picture FROM users WHERE id=$1',
      [req.params.id]
    );

    if (!result.rows.length)
      return res.json({ image: null });

    res.json({
      image: result.rows[0].profile_picture
    });

  } catch (err) {
    console.error('Error fetching avatar:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Get Users (UPDATED) -------------------
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
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Delete User -------------------
app.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId)
    return res.status(400).json({ error: 'User ID is required' });

  try {
    await pool.query('DELETE FROM messages WHERE userid=$1', [userId]);

    const deleteUser = await pool.query(
      'DELETE FROM users WHERE id=$1 RETURNING *',
      [userId]
    );

    if (deleteUser.rowCount === 0)
      return res.status(404).json({ error: 'User not found' });

    res.json({ success: true });

  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Send Message -------------------
app.post('/send', async (req, res) => {
  const { messageId, text, userID } = req.body;

  if (!messageId || !text || !userID)
    return res.status(400).json({ error: 'Invalid request' });

  try {
    await pool.query(
      'INSERT INTO messages (id, text, userid) VALUES ($1, $2, $3)',
      [messageId, text, userID]
    );

    const msg = { messageId, text, type: 'message', userID };

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(msg));
    });

    res.json({ type: 'sent', messageId });

  } catch (err) {
    console.error('DB insert error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- Get All Messages -------------------
app.get('/messages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM messages ORDER BY id ASC'
    );

    const messages = result.rows.map(r => ({
      messageId: r.id,
      text: r.text,
      type: 'message',
      userID: r.userid
    }));

    res.json(messages);

  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ------------------- HTTP & WebSocket -------------------
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
});
