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
        receiver_id INT NOT NULL REFERENCES users(id)
      )
    `);

    console.log("Tables ensured in Postgres");

  } catch (err) {
    console.error("DB setup error:", err);
  }
})();


// ------------------- Register -------------------
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


// ------------------- Get Users (SEARCH) -------------------
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
    console.error("User fetch error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- Send Message -------------------
app.post('/send', async (req, res) => {

  const { messageId, text, senderID, receiverID } = req.body;

  console.log("SEND endpoint hit");
  console.log("Incoming body:", req.body);

  if (!messageId || !text || !senderID || !receiverID)
    return res.status(400).json({ error: 'Invalid request' });

  try {

    await pool.query(
      'INSERT INTO messages (id, text, sender_id, receiver_id) VALUES ($1,$2,$3,$4)',
      [messageId, text, senderID, receiverID]
    );

    console.log(`Message saved to DB from ${senderID} to ${receiverID}`);

    const msg = {
      messageId,
      text,
      senderID,
      receiverID
    };

    const receiverSocket = connectedUsers.get(receiverID);

    console.log("Connected users:", Array.from(connectedUsers.keys()));
    console.log("Looking for receiver:", receiverID);
    console.log("Socket found:", !!receiverSocket);

    if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
      console.log("Sending message to receiver via WebSocket");
      receiverSocket.send(JSON.stringify(msg));
    } else {
      console.log("Receiver socket not open or not found");
    }

    res.json({ type: 'sent', messageId });

  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- Get Conversation -------------------
app.get('/messages/:user1/:user2', async (req, res) => {

  const { user1, user2 } = req.params;

  try {

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2)
          OR (sender_id=$2 AND receiver_id=$1)
       ORDER BY id ASC`,
      [user1, user2]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- HTTP Server -------------------
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ------------------- WebSocket -------------------
// ------------------- WebSocket -------------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {

  console.log("Client connected");

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log("WebSocket message received:", data);

      // ---------------- REGISTER ----------------
      if (data.type === 'register') {
        connectedUsers.set(data.userID, ws);
        console.log(`User ${data.userID} registered`);
        console.log("Currently connected users:", Array.from(connectedUsers.keys()));
      }

      // ---------------- REALTIME MESSAGE ----------------
      if (data.type === 'message') {

        console.log("Forward attempt:", data);

        const receiverSocket = connectedUsers.get(data.receiverId);

        if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
          receiverSocket.send(JSON.stringify(data));
          console.log("Message forwarded to user:", data.receiverId);
        } else {
          console.log("Receiver not connected:", data.receiverId);
        }
      }

    } catch (err) {
      console.error("WS error:", err);
    }
  });

  ws.on('close', () => {
    for (const [userId, socket] of connectedUsers.entries()) {
      if (socket === ws) {
        connectedUsers.delete(userId);
        console.log(`User ${userId} disconnected`);
        console.log("Currently connected users:", Array.from(connectedUsers.keys()));
      }
    }
  });

});
