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

    await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_requests (
    id SERIAL PRIMARY KEY,
    from_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (from_user_id, to_user_id)
    )
    `);


  //CASCADE USER DELETE INFORMATION

    // ------------------- Ensure Conversations Cascade -------------------

await pool.query(`
  DO $$
  BEGIN

    -- Drop existing foreign key on user1_id if it exists
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'conversations_user1_id_fkey'
    ) THEN
      ALTER TABLE conversations
      DROP CONSTRAINT conversations_user1_id_fkey;
    END IF;

    -- Drop existing foreign key on user2_id if it exists
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'conversations_user2_id_fkey'
    ) THEN
      ALTER TABLE conversations
      DROP CONSTRAINT conversations_user2_id_fkey;
    END IF;

    -- Recreate with ON DELETE CASCADE
    ALTER TABLE conversations
    ADD CONSTRAINT conversations_user1_id_fkey
    FOREIGN KEY (user1_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

    ALTER TABLE conversations
    ADD CONSTRAINT conversations_user2_id_fkey
    FOREIGN KEY (user2_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

  END
  $$;
  `);
  
  //END CASCADE DELETE

    

    console.log("Tables ensured in Postgres");

  } catch (err) {
    console.error("DB setup error:", err);
  }
})();

// =======================================================
// ===================== HTTP ROUTES =====================
// =======================================================

app.post('/register', async (req, res) => {
  let { username, profile_picture } = req.body;

  // 1️⃣ Required check
  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username required' });
  }

  // 2️⃣ Trim + collapse multiple spaces
  username = username.trim().replace(/\s+/g, ' ');

  // 3️⃣ Length validation (3–20 characters)
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({
      error: 'Username must be between 3 and 20 characters'
    });
  }

  // 4️⃣ Letters + spaces only (no numbers, no symbols)
  const validPattern = /^[A-Za-z ]+$/;
  if (!validPattern.test(username)) {
    return res.status(400).json({
      error: 'Username can contain letters and spaces only'
    });
  }

  // 5️⃣ Normalize: Capitalize each word
  username = username
    .toLowerCase()
    .split(' ')
    .map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');

  try {

    // 6️⃣ Case-insensitive duplicate check
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username)=LOWER($1)',
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username exists' });
    }

    // 7️⃣ Insert new user
    const user = await pool.query(
      'INSERT INTO users (username, profile_picture) VALUES ($1,$2) RETURNING id, username',
      [username, profile_picture || null]
    );

    return res.status(201).json({ user: user.rows[0] });

  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


app.get('/chat-requests/:userId', async (req, res) => {

  try {

    const result = await pool.query(
      `SELECT cr.from_user_id, u.username
       FROM chat_requests cr
       JOIN users u ON cr.from_user_id = u.id
       WHERE cr.to_user_id = $1
       AND cr.status = 'pending'
       ORDER BY cr.created_at DESC`,
      [req.params.userId]
    );

    res.json(result.rows);

  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- Upload Avatar -------------------
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

// ------------------- Get Users -------------------
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

// ------------------- Get Avatar -------------------
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

// ------------------- Get Conversation -------------------
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
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------- Get Conversations -------------------
app.get('/conversations/:userId', async (req, res) => {
  try {

    const result = await pool.query(
      `SELECT 
         u.id AS other_user_id,
         u.username
       FROM conversations c
       JOIN users u 
         ON u.id = c.user1_id OR u.id = c.user2_id
       WHERE (c.user1_id = $1 OR c.user2_id = $1)
       AND u.id != $1`,
      [req.params.userId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("Conversations route error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ------------------- Delete User -------------------
app.delete('/users/:id', async (req, res) => {
  try {

    await pool.query(
      'DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1',
      [req.params.id]
    );

    const result = await pool.query(
      'DELETE FROM users WHERE id=$1 RETURNING id',
      [req.params.id]
    );

    if (result.rowCount === 0)
  return res.status(404).json({ error: 'User not found' });

// 🔥 Broadcast user deletion to all connected clients
const deletedUserId = parseInt(req.params.id);

// Notify all connected users
connectedUsers.forEach((clientSocket) => {
  if (clientSocket.readyState === WebSocket.OPEN) {
    clientSocket.send(JSON.stringify({
      type: "user_deleted",
      deletedUserId: deletedUserId
    }));
  }
});

// 🔥 Force close deleted user's socket (if connected)
const deletedSocket = connectedUsers.get(deletedUserId);

if (deletedSocket) {
  deletedSocket.terminate();
  connectedUsers.delete(deletedUserId);
}

res.json({ message: 'User deleted successfully' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =======================================================
// =================== SERVER START ======================
// =======================================================

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

// ------------------- Heartbeat -------------------
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', async (message) => {

    try {

      const data = JSON.parse(message);

      if (data.type === 'register') {

        ws.userID = data.userID;
        connectedUsers.set(data.userID, ws);

        const undelivered = await pool.query(
          `SELECT * FROM messages
           WHERE receiver_id=$1 AND delivered=false
           ORDER BY created_at ASC`,
          [data.userID]
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
      }

      if (data.type === 'chat_request') {

      try {

     if (data.fromUserId === data.toUserId) return;

  const existing = await pool.query(
    `SELECT status FROM chat_requests
     WHERE (from_user_id=$1 AND to_user_id=$2)
        OR (from_user_id=$2 AND to_user_id=$1)`,
    [data.fromUserId, data.toUserId]
  );

  if (existing.rows.length > 0) {

    const status = existing.rows[0].status;

    // If already accepted → tell sender to open chat
    if (status === 'accepted') {

      const senderSocket = connectedUsers.get(data.fromUserId);

      if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
        senderSocket.send(JSON.stringify({
          type: "chat_already_active",
          otherUserId: data.toUserId
        }));
      }
    }

    // If pending → do nothing
    return;
  }

  // No existing request → create new one
  await pool.query(
    `INSERT INTO chat_requests (from_user_id, to_user_id)
     VALUES ($1,$2)`,
    [data.fromUserId, data.toUserId]
  );

  // Get sender username from database
const senderResult = await pool.query(
  `SELECT username FROM users WHERE id=$1`,
  [data.fromUserId]
);

const senderUsername =
  senderResult.rows.length > 0
    ? senderResult.rows[0].username
    : "User";

const receiverSocket = connectedUsers.get(data.toUserId);

if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
  receiverSocket.send(JSON.stringify({
    type: "chat_request_received",
    fromUserId: data.fromUserId,
    username: senderUsername
  }));
}

} catch (err) {
  console.error("Chat request error:", err);
} 
}


  if (data.type === 'chat_request_accept') {

  try {

    await pool.query(
      `UPDATE chat_requests
       SET status='accepted'
       WHERE from_user_id=$1 AND to_user_id=$2`,
      [data.fromUserId, data.toUserId]
    );

// Create permanent conversation
const userA = Math.min(data.fromUserId, data.toUserId);
const userB = Math.max(data.fromUserId, data.toUserId);

await pool.query(
  `INSERT INTO conversations (user1_id, user2_id)
   VALUES ($1, $2)
   ON CONFLICT DO NOTHING`,
  [userA, userB]
);

    
    const users = await pool.query(
      `SELECT id, username FROM users WHERE id=$1 OR id=$2`,
      [data.fromUserId, data.toUserId]
    );

    const userMap = {};
    users.rows.forEach(u => {
      userMap[u.id] = u.username;
    });

    const senderSocket = connectedUsers.get(data.fromUserId);
    const receiverSocket = connectedUsers.get(data.toUserId);

    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      senderSocket.send(JSON.stringify({
        type: "chat_request_accepted",
        otherUserId: data.toUserId,
        username: userMap[data.toUserId]
      }));
    }

    if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
      receiverSocket.send(JSON.stringify({
        type: "chat_request_accepted",
        otherUserId: data.fromUserId,
        username: userMap[data.fromUserId]
      }));
    }

  } catch (err) {
    console.error("Chat accept error:", err);
  }
}



      
      
      if (data.type === 'message') {

        await pool.query(
          `INSERT INTO messages (id,text,sender_id,receiver_id,delivered)
           VALUES ($1,$2,$3,$4,false)`,
          [data.messageId, data.text, data.senderId, data.receiverId]
        );

        const receiverSocket = connectedUsers.get(data.receiverId);

        if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
          receiverSocket.send(JSON.stringify(data));
        }
      }

      if (data.type === 'ack') {

        await pool.query(
          `UPDATE messages
           SET delivered=true
           WHERE id=$1`,
          [data.messageId]
        );

        console.log("Delivery confirmed:", data.messageId);
      }

    } catch (err) {
      console.error("WS error:", err);
    }

  });

  ws.on('close', () => {
  if (ws.userID) {
    const current = connectedUsers.get(ws.userID);

    // Only remove mapping if THIS socket is still the active one
    if (current === ws) {
      connectedUsers.delete(ws.userID);
      console.log("Socket removed for user:", ws.userID);
    }
  }
});

});

// ------------------- Heartbeat Interval -------------------
setInterval(() => {

  wss.clients.forEach((ws) => {

    if (!ws.isAlive) {

      if (ws.userID) {
        const current = connectedUsers.get(ws.userID);

        // Only delete if THIS socket is still the active one
        if (current === ws) {
          connectedUsers.delete(ws.userID);
          console.log("Terminated dead socket for user:", ws.userID);
        }
      }

      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();

  });

}, 30000);
