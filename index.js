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

  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (userCheck.rows.length > 0) return res.status(409).json({ error: 'Username already exists' });

    const insertUser = await pool.query(
      'INSERT INTO users (username, profile_picture) VALUES ($1, $2) RETURNING *',
      [username, profile_picture || null]
    );

    res.status(201).json({ user: insertUser.rows[0] });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------- Get users (with optional search) -------------------
app.get('/users', async (req, res) => {
  try {
    const searchQuery = req.query.q || ''; // Example: /users?q=John
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

// ------------------- Delete user -------------------
app.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    await pool.query('DELETE FROM messages WHERE userid=$1', [userId]);
    const deleteUser = await pool.query('DELETE FROM users WHERE id=$1 RETURNING *', [userId]);
    if (deleteUser.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, message: 'User and messages deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------- Alias delete route for compatibility -------------------
app.delete('/deleteUser/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    await pool.query('DELETE FROM messages WHERE userid=$1', [userId]);
    const result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING *', [userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, message: 'User and messages deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------- Messages -------------------

// Send message
app.post('/send', async (req, res) => {
  const { messageId, text, userID } = req.body;
  if (!messageId || !text || !userID) return res.status(400).json({ error: 'Invalid request' });

  try {
    await pool.query('INSERT INTO messages (id, text, userid) VALUES ($1, $2, $3)', [messageId, text, userID]);

    const msg = { messageId, text, type: 'message', userID };

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    });

    res.json({ type: 'sent', messageId });
  } catch (err) {
    console.error('DB insert error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all messages
app.get('/messages', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM messages ORDER BY id ASC');
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

  (async () => {
    try {
      const result = await pool.query('SELECT * FROM messages ORDER BY id ASC');
      result.rows.forEach(r => {
        ws.send(JSON.stringify({
          messageId: r.id,
          text: r.text,
          type: 'message',
          userID: r.userid
        }));
      });
    } catch (err) {
      console.error('Error fetching messages for WS:', err);
    }
  })();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.messageId || !msg.text || !msg.userID) return;

      await pool.query('INSERT INTO messages (id, text, userid) VALUES ($1, $2, $3)',
        [msg.messageId, msg.text, msg.userID]);

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            messageId: msg.messageId,
            text: msg.text,
            type: 'message',
            userID: msg.userID
          }));
        }
      });

      ws.send(JSON.stringify({ type: 'sent', messageId: msg.messageId }));
    } catch (err) {
      console.error('Error processing WS message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
