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


// ------------------- HTTP Server -------------------
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


// ------------------- WebSocket -------------------
const wss = new WebSocket.Server({ server });

// ------------------- Heartbeat Function -------------------
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {

  console.log("Client connected");

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', async (message) => {

    try {
      const data = JSON.parse(message);
      console.log("WebSocket message received:", data);

      // ---------------- REGISTER ----------------
      if (data.type === 'register') {

        const userId = data.userID;

        ws.userID = userId;       // attach userId to socket
        ws.isAlive = true;        // mark alive
        connectedUsers.set(userId, ws);

        console.log(`User ${userId} registered`);

        // 🔹 Fetch undelivered messages
        const undelivered = await pool.query(
          `SELECT * FROM messages
           WHERE receiver_id = $1
           AND delivered = false
           ORDER BY created_at ASC`,
          [userId]
        );

        for (const msg of undelivered.rows) {

          ws.send(JSON.stringify({
            type: "message",
            messageId: msg.id,
            text: msg.text,
            senderId: msg.sender_id,
            receiverId: msg.receiver_id
          }));
        }

        // 🔹 Mark them delivered
        await pool.query(
          `UPDATE messages
           SET delivered = true
           WHERE receiver_id = $1
           AND delivered = false`,
          [userId]
        );

        console.log("Delivered stored messages:", undelivered.rowCount);
      }

      // ---------------- REALTIME MESSAGE ----------------
      if (data.type === 'message') {

        const { messageId, text, senderId, receiverId } = data;

        // Save message as undelivered
        await pool.query(
          `INSERT INTO messages (id, text, sender_id, receiver_id, delivered)
           VALUES ($1, $2, $3, $4, false)`,
          [messageId, text, senderId, receiverId]
        );

        const senderResult = await pool.query(
          'SELECT profile_picture FROM users WHERE id = $1',
          [senderId]
        );

        const profilePicture =
          senderResult.rows[0]?.profile_picture || null;

        const receiverSocket = connectedUsers.get(receiverId);

        if (
          receiverSocket &&
          receiverSocket.readyState === WebSocket.OPEN
        ) {

          receiverSocket.send(JSON.stringify({
            type: "message",
            messageId,
            text,
            senderId,
            receiverId,
            profile_picture: profilePicture
          }));

          await pool.query(
            `UPDATE messages
             SET delivered = true
             WHERE id = $1`,
            [messageId]
          );

          console.log("Message delivered instantly");

        } else {
          console.log("Receiver offline. Message stored.");
        }
      }

    } catch (err) {
      console.error("WS error:", err);
    }
  });

  // Clean disconnect
  ws.on('close', () => {
    if (ws.userID) {
      connectedUsers.delete(ws.userID);
      console.log(`User ${ws.userID} disconnected`);
    }
  });

});


// ------------------- Heartbeat Interval -------------------
const interval = setInterval(() => {

  wss.clients.forEach((ws) => {

    if (ws.isAlive === false) {

      if (ws.userID) {
        connectedUsers.delete(ws.userID);
        console.log(`User ${ws.userID} force removed (dead socket)`);
      }

      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();

  });

}, 30000); // every 30 seconds
