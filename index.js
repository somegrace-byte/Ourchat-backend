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
  connectionString: process.env.DATABASE_URL, // Read from Render environment variable
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
        userID INT NOT NULL REFERENCES users(id)
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

// Get all users (optional, useful for search)
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, profile_picture FROM users ORDER BY username ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message via HTTP (optional)
app.post('/send', async (req, res) => {
  const { messageId, text, userID } = req.body;
  if (!messageId || !text || !userID) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    await pool.query('INSERT INTO messages (id, text, userID) VALUES ($1, $2, $3)', [messageId, text, userID]);

    const msg = { messageId, text, type: 'message', userID };

    // Broadcast to WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
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

// ------------------- HTTP Server -------------------
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// ------------------- WebSocket Server -------------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  // Send all existing messages to the new client
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

  // Receive messages from clients
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.messageId || !msg.text || !msg.userID) return;

      await pool.query('INSERT INTO messages (id, text, userID) VALUES ($1, $2, $3)',
        [msg.messageId, msg.text, msg.userID]);

      // Broadcast to all clients
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

      // Confirm to sender
      ws.send(JSON.stringify({ type: 'sent', messageId: msg.messageId }));

    } catch (err) {
      console.error('Error processing WS message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
