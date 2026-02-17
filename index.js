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

// ------------------- Upload / Update Avatar -------------------
app.post('/upload-avatar', async (req, res) => {
  const { userId, image } = req.body;

  if (!userId || !image) {
    return res.status(400).json({ error: 'Missing userId or image' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET profile_picture = $1 WHERE id = $2 RETURNING id',
      [image, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Avatar updated successfully' });

  } catch (err) {
    console.error("Avatar update error:", err);
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


// ------------------- Get Single User Avatar -------------------
app.get('/user/:id/avatar', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'SELECT profile_picture FROM users WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      image: result.rows[0].profile_picture
    });

  } catch (err) {
    console.error("Avatar fetch error:", err);
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

// ------------------- Delete User -------------------
app.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // First delete their messages
    await pool.query(
      'DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1',
      [id]
    );

    // Then delete the user
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });

  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- HTTP Server -------------------
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


// ------------------- WebSocket -------------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {

  console.log("Client connected");

  ws.on('message', async (message) => {

    try {
      const data = JSON.parse(message);
      console.log("WebSocket message received:", data);

      // ---------------- REGISTER ----------------
      if (data.type === 'register') {

  const userId = data.userID;
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

        // 1️⃣ Save message to DB as undelivered
        await pool.query(
          `INSERT INTO messages (id, text, sender_id, receiver_id, delivered)
           VALUES ($1, $2, $3, $4, false)`,
          [messageId, text, senderId, receiverId]
        );

        // 2️⃣ Fetch sender avatar
        const senderResult = await pool.query(
          'SELECT profile_picture FROM users WHERE id = $1',
          [senderId]
        );

        const profilePicture =
          senderResult.rows[0]?.profile_picture || null;

        const receiverSocket = connectedUsers.get(receiverId);

        // 3️⃣ If receiver online → send immediately
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

          // 4️⃣ Mark as delivered
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

  ws.on('close', () => {
    for (const [userId, socket] of connectedUsers.entries()) {
      if (socket === ws) {
        connectedUsers.delete(userId);
        console.log(`User ${userId} disconnected`);
      }
    }
  });

}); 
