const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const pool = require("./db"); // PostgreSQL connection

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ============================
// SETUP ROUTE TO CREATE TABLES
// ============================
app.get("/setup", async (req, res) => {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        profile_picture TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INT REFERENCES users(id),
        receiver_id INT REFERENCES users(id),
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send("Tables created!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating tables");
  }
});

// ============================
// TEST DATABASE CONNECTION
// ============================
app.get("/testdb", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.send(`Database connected! Time: ${result.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Database connection failed");
  }
});

// ============================
// REGISTER USER
// ============================
app.post("/register", async (req, res) => {
  const { username, profile_picture } = req.body;
  if (!username) return res.status(400).json({ error: "Username is required" });

  try {
    const result = await pool.query(
      "INSERT INTO users (username, profile_picture) VALUES ($1, $2) RETURNING id, username, profile_picture",
      [username, profile_picture || null]
    );
    const user = result.rows[0];
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") { // unique violation
      return res.status(400).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================
// SEARCH USERS
// ============================
app.get("/search", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Username query is required" });

  try {
    const result = await pool.query(
      "SELECT id, username, profile_picture FROM users WHERE username ILIKE $1",
      [`%${username}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// MESSAGES ENDPOINTS
// ============================

// Fetch all messages
app.get('/messages', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM messages ORDER BY created_at ASC");
    const messages = result.rows.map(r => ({
      messageId: r.id,
      text: r.text,
      type: 'message',
      senderId: r.sender_id,
      receiverId: r.receiver_id
    }));
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Send a message
app.post('/send', async (req, res) => {
  const { text, senderId, receiverId } = req.body;
  if (!text || !senderId || !receiverId) return res.status(400).json({ error: 'Invalid request' });

  try {
    const result = await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING id",
      [senderId, receiverId, text]
    );
    const messageId = result.rows[0].id;
    const msg = { messageId, text, type: 'message', senderId, receiverId };

    // Broadcast to all WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    });

    res.json({ type: 'sent', messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// START HTTP SERVER
// ============================
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// ============================
// WEBSOCKET SERVER
// ============================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  // Send all existing messages to the new client
  pool.query("SELECT * FROM messages ORDER BY created_at ASC")
    .then(result => {
      result.rows.forEach(r => {
        ws.send(JSON.stringify({
          messageId: r.id,
          text: r.text,
          type: "message",
          senderId: r.sender_id,
          receiverId: r.receiver_id
        }));
      });
    }).catch(console.error);

  // Receive messages from clients
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.text || !msg.senderId || !msg.receiverId) return;

      pool.query(
        "INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING id",
        [msg.senderId, msg.receiverId, msg.text]
      ).then(result => {
        const messageId = result.rows[0].id;
        const msgToSend = {
          messageId,
          text: msg.text,
          type: "message",
          senderId: msg.senderId,
          receiverId: msg.receiverId
        };

        // Broadcast to all clients
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msgToSend));
        });

        ws.send(JSON.stringify({ type: "sent", messageId }));
      }).catch(console.error);

    } catch (e) {
      console.error("Error parsing message:", e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
