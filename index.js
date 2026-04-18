// ------------------- Dependencies -------------------
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

//JWT Token authentication 
const JWT_SECRET = process.env.JWT_SECRET;
//Authentication token

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);

    req.user = user;
    next();
  });
}

// ------------------- Username Filter -------------------

const BLOCKED_WORDS = new Set([
  "fuck","cunt","bitch","dick","cock","pussy","twat","slut","whore","bastard",
  "penis","vagina","anal","blowjob","handjob","cumshot","deepthroat","porn","xxx",
  "asshole","douchebag","motherfucker","nigger","faggot","retard",
  "rapist","rape","killyourself","suicide","murder"
].map(w => w.trim().toLowerCase()));

function containsBlockedWords(username) {

  // Normalize
  let clean = username.toLowerCase().replace(/[^a-z]/g, "");

  // Compress input (fuuuck → fuck)
  let compressed = clean.replace(/(.)\1+/g, "$1");

  for (const word of BLOCKED_WORDS) {

    // Compress blocked word too (nigger → niger)
    let compressedWord = word.replace(/(.)\1+/g, "$1");

    if (
      clean.includes(word) ||                // exact match
      compressed.includes(word) ||           // stretched input
      clean.includes(compressedWord) ||      // edge case
      compressed.includes(compressedWord)    // both compressed
    ) {
      return true;
    }
  }

  return false;
}

// ------------------- Config -------------------
const PORT = process.env.PORT || 10000;
const app = express();


app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use('/uploads', express.static('uploads'));

// 🔒 LOGIN LIMITER
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts. Try again in a minute." }
});

//Registration Failed login limiter 
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: "Too many accounts created. Try again later." }
});

//Registration sucess limiter 
const registerSuccessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: "Too many registration attempts. Try again later." }
});

// ------------------- PostgreSQL -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------- Track Connected Users -------------------
const connectedUsers = new Map();
const userPresence = new Map(); 
const registerSuccessMap = new Map();
// ------------------- Tables Setup -------------------
(async () => {
  try {

    await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    profile_picture TEXT,
    profile_visible BOOLEAN DEFAULT true
    )
    `);

    await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_visible BOOLEAN DEFAULT true
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

    await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
    user1_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user1_id, user2_id)
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

app.post('/register', registerLimiter, async (req, res) => {

//Max 3 registrations per hour
const ip = req.ip;
const now = Date.now();

const record = registerSuccessMap.get(ip);

if (record) {
  const { count, firstTime } = record;

  if (now - firstTime < 60 * 60 * 1000) {
    if (count >= 3) {
      return res.status(429).json({
        error: "Too many accounts created. Try again later."
      });
    }
  } else {
    registerSuccessMap.set(ip, { count: 0, firstTime: now });
  }
} else {
  registerSuccessMap.set(ip, { count: 0, firstTime: now });
}
  //End max 3 registrations 
  
  let { username, password, profile_picture } = req.body;
  

  // 1️⃣ Required check
  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username required' });
  }

  // 2️⃣ Trim + collapse multiple spaces
  username = username.trim().replace(/\s+/g, ' ');

  // 3️⃣ Length validation (3–20 characters)
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({
      error: 'Invalid username'
    });
  }

  // 4️⃣ Letters + spaces only (no numbers, no symbols)
  const validPattern = /^[A-Za-z ]+$/;
  if (!validPattern.test(username)) {
    return res.status(400).json({
      error: 'Invalid username'
    });
  }

  // 5️⃣ Block explicit/inappropriate names (STRICT)
  if (containsBlockedWords(username)) {
  return res.status(400).json({
  error: 'Invalid username'
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

// 🔐 require password
if (!password) {
  return res.status(400).json({ error: 'Password required' });
}

// 🔐 hash password
const hashedPassword = await bcrypt.hash(password, 10);

// 7️⃣ Insert new user
const user = await pool.query(
  'INSERT INTO users (username, profile_picture, password_hash) VALUES ($1,$2,$3) RETURNING id, username',
  [username, profile_picture || null, hashedPassword]
);

  //Send token on register 
  const token = jwt.sign(
  { userId: user.rows[0].id },
  JWT_SECRET,
  { expiresIn: "7d" }
  );
  //End send token

   const successRecord = registerSuccessMap.get(ip);
   if (successRecord) {
  successRecord.count += 1;
} 
    
  return res.status(201).json({
  user: user.rows[0],
  token: token
  });
    
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

//Login 
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    // Find user
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE LOWER(username)=LOWER($1)',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    
  const token = jwt.sign(
  { userId: user.id },
  JWT_SECRET,
  { expiresIn: "7d" }
  );

  res.json({
  token: token,
  userId: user.id,
  username: user.username
  });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

//END Login

app.get('/chat-requests', authenticateToken, async (req, res) => {
  try {

    const result = await pool.query(
      `SELECT cr.from_user_id, u.username
       FROM chat_requests cr
       JOIN users u ON cr.from_user_id = u.id
       WHERE cr.to_user_id = $1
       AND cr.status = 'pending'
       ORDER BY cr.created_at DESC`,
      [req.user.userId]
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


//UPLOAD IMAGE
const fs = require('fs');
const path = require('path');

app.post('/upload-image', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    const filename = `${Date.now()}.jpg`;
    const filePath = path.join(__dirname, 'uploads', filename);

    fs.writeFileSync(filePath, base64Data, 'base64');

    res.json({
      imagePath: `/uploads/${filename}`
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

//Username avaliablity check 
app.get('/check-username', async (req, res) => {
  let username = req.query.username;

  if (!username || username.trim() === '') {
    return res.json({ available: false });
  }

  username = username.trim().replace(/\s+/g, ' ');

  // Length check
  if (username.length < 3 || username.length > 20) {
    return res.json({ available: false });
  }

  // Letters + spaces only
  if (!/^[A-Za-z ]+$/.test(username)) {
    return res.json({ available: false });
  }

  // Blocked words check
  if (containsBlockedWords(username)) {
    return res.json({ available: false });
  }

  try {
    const result = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)',
      [username]
    );

    if (result.rows.length > 0) {
      return res.json({ available: false });
    }

    res.json({ available: true });

  } catch (err) {
    console.error("Username check error:", err);
    res.status(500).json({ available: false });
  }
});


// ------------------- Get Users -------------------
app.get('/users', async (req, res) => {
  try {

    const searchQuery = req.query.q || '';
    let result;
    const currentUserId = req.query.userId;

    if (searchQuery) {
      result = await pool.query(
  `SELECT id, username, profile_picture
   FROM users u
   WHERE LOWER(u.username) = LOWER($1)
   AND (
     u.profile_visible = true
     OR EXISTS (
       SELECT 1 FROM conversations c
       WHERE (
         (c.user1_id = $2 AND c.user2_id = u.id)
         OR
         (c.user2_id = $2 AND c.user1_id = u.id)
       )
     )
   )`,
  [searchQuery, currentUserId]
);
    } else {
      result = await pool.query(
        `SELECT id, username, profile_picture
         FROM users
         WHERE profile_visible = true
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
app.get('/messages/:user1/:user2', authenticateToken, async (req, res) => {

  try {

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2)
          OR (sender_id=$2 AND receiver_id=$1)
       ORDER BY created_at ASC`,
      [req.params.user1, req.params.user2]
    );

    res.json(
    result.rows.map(m => ({
    id: m.id,
    text: m.text,
    sender_id: m.sender_id,
    receiver_id: m.receiver_id,
    image: m.image_path,   // 🔥 ADD THIS
    type: m.type,          // 🔥 ADD THIS
    timestamp: new Date(m.created_at).getTime()
  }))
);
    
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


// ------------------- Get Blocked Users -------------------

app.get('/blocked-users/:userId', async (req, res) => {

  try {

    const result = await pool.query(
      `SELECT 
         bu.blocked_id AS blocked_user_id,
         u.username
       FROM blocked_users bu
       JOIN users u ON u.id = bu.blocked_id
       WHERE bu.blocker_id = $1
       ORDER BY u.username`,
      [req.params.userId]
    );

    res.json(result.rows);

  } catch (err) {

    console.error("Blocked users route error:", err);
    res.status(500).json({ error: "Server error" });

  }

});

// ------------------- Check Messages + Chat Requests (Notifications) -------------------
app.get('/checkMessages', async (req, res) => {

  const userId = req.query.userId;
  const lastId = req.query.lastId || '';

  if (!userId) {
    return res.json({ type: "none" });
  }

  try {

    // ------------------- CHECK MESSAGES -------------------
    const messageResult = await pool.query(
      `SELECT text, sender_id, id, created_at
       FROM messages
       WHERE receiver_id = $1
       AND delivered = false
       AND id != $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, lastId]
    );

    if (messageResult.rows.length > 0) {

      const msg = messageResult.rows[0];

      const sender = await pool.query(
        'SELECT username FROM users WHERE id=$1',
        [msg.sender_id]
      );

    await pool.query(
   `UPDATE messages 
    SET delivered = true 
    WHERE receiver_id = $1 
    AND delivered = false`,
   [userId]
 );

      return res.json({
        type: "message",
        sender: sender.rows[0].username,
        senderId: msg.sender_id,
        message: msg.text,
        messageId: msg.id,
        timestamp: new Date(msg.created_at).getTime()
      });
    }

    // ------------------- CHECK CHAT REQUESTS -------------------
    const requestResult = await pool.query(
      `SELECT cr.from_user_id, u.username
       FROM chat_requests cr
       JOIN users u ON cr.from_user_id = u.id
       WHERE cr.to_user_id = $1
       AND cr.status = 'pending'
       AND cr.notified = false
       ORDER BY cr.created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (requestResult.rows.length > 0) {

      const reqData = requestResult.rows[0];

      await pool.query(
        `UPDATE chat_requests
         SET notified = true
         WHERE from_user_id = $1 AND to_user_id = $2`,
        [reqData.from_user_id, userId]
      );

      return res.json({
        type: "chat_request",
        sender: reqData.username,
        senderId: reqData.from_user_id
      });
    }

    // ------------------- NOTHING -------------------
    res.json({ type: "none" });

  } catch (err) {
    console.error("Check messages error:", err);
    res.json({ type: "none" });
  }

});


// ------------------- Delete User -------------------
app.delete('/users/:id', authenticateToken, async (req, res) => {

const userIdFromToken = req.user.userId;
const userIdFromParams = parseInt(req.params.id);

// 🚨 BLOCK if user tries to delete someone else
if (userIdFromToken !== userIdFromParams) {
  return res.status(403).json({ error: 'Unauthorized' });
}
  
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

        const token = data.token;

if (!token) {
  ws.close();
  return;
}

jwt.verify(token, JWT_SECRET, async (err, decoded) => {

  if (err) {
    ws.close();
    return;
  }

  const userId = decoded.userId;

  if (userId !== data.userID) {
    ws.close();
    return;
  }

  ws.userID = userId;
  connectedUsers.set(userId, ws);

  
  userPresence.set(userId, false);

        
   // 🔥 Notify only users who have a conversation with this user
   const convoResult = await pool.query(
  `SELECT user1_id, user2_id
   FROM conversations
   WHERE user1_id = $1 OR user2_id = $1`,
  [data.userID]
  );

const partnerIds = new Set();

convoResult.rows.forEach(row => {
  if (row.user1_id === data.userID) {
    partnerIds.add(row.user2_id);
  } else {
    partnerIds.add(row.user1_id);
  }  
});

if (userPresence.get(data.userID) === true) {

  partnerIds.forEach(partnerId => {
    const partnerSocket = connectedUsers.get(partnerId);

    if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
      partnerSocket.send(JSON.stringify({
        type: "user_online",
        userId: data.userID
      }));
    }
  });
  
}


//END show online status
        
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
        });     
      }

//Added background offline status
      
if (data.type === 'user_online') {

  userPresence.set(data.userId, true);

  // 🔥 notify chat partners
  const convoResult = await pool.query(
    `SELECT user1_id, user2_id
     FROM conversations
     WHERE user1_id = $1 OR user2_id = $1`,
    [data.userId]
  );

  const partnerIds = new Set();

  convoResult.rows.forEach(row => {
    if (row.user1_id === data.userId) {
      partnerIds.add(row.user2_id);
    } else {
      partnerIds.add(row.user1_id);
    }
  });

  partnerIds.forEach(partnerId => {
    const partnerSocket = connectedUsers.get(partnerId);

    if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
      partnerSocket.send(JSON.stringify({
        type: "user_online",
        userId: data.userId
      }));
    }
  });
}


if (data.type === 'user_offline') {

  userPresence.set(data.userId, false);

  // 🔥 notify chat partners
  const convoResult = await pool.query(
    `SELECT user1_id, user2_id
     FROM conversations
     WHERE user1_id = $1 OR user2_id = $1`,
    [data.userId]
  );

  const partnerIds = new Set();

  convoResult.rows.forEach(row => {
    if (row.user1_id === data.userId) {
      partnerIds.add(row.user2_id);
    } else {
      partnerIds.add(row.user1_id);
    }
  });

  partnerIds.forEach(partnerId => {
    const partnerSocket = connectedUsers.get(partnerId);

    if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
      partnerSocket.send(JSON.stringify({
        type: "user_offline",
        userId: data.userId
      }));
    }
  });
}

// ------------------- PROFILE VISIBILITY -------------------

if (data.type === 'profile_visibility') {

  try {

    await pool.query(
      `UPDATE users
       SET profile_visible = $1
       WHERE id = $2`,
      [data.visible, data.userId]
    );

  } catch (err) {
    console.error("Profile visibility update error:", err);
  }
}
      
// ------------------- Check Online Status -------------------
if (data.type === 'check_online') {

  const targetSocket = connectedUsers.get(data.userId);

  if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "user_online",
      userId: data.userId
    }));
  } else {
    ws.send(JSON.stringify({
      type: "user_offline",
      userId: data.userId
    }));
  }

}

//Handle incoming online status request 

if (data.type === 'check_user_status') {

  const { requesterId, targetUserId } = data;

  const targetSocket = connectedUsers.get(targetUserId);
  const requesterSocket = connectedUsers.get(requesterId);

  if (!requesterSocket || requesterSocket.readyState !== WebSocket.OPEN) return;

  const isOnline =
  userPresence.get(targetUserId) !== false &&
  (
    userPresence.get(targetUserId) === true ||
    (connectedUsers.get(targetUserId)?.readyState === WebSocket.OPEN)
  );
  
  requesterSocket.send(JSON.stringify({
    type: "user_status",   // ✅ IMPORTANT CHANGE
    userId: targetUserId,
    online: isOnline
  }));
}

//END status request 
      
      if (data.type === 'chat_request') {

      try {

     if (data.fromUserId === data.toUserId) return;

  // Check if receiver blocked sender
const blockedCheck = await pool.query(
  `SELECT 1
   FROM blocked_users
   WHERE blocker_id=$1 AND blocked_id=$2`,
  [data.toUserId, data.fromUserId]
);

if (blockedCheck.rows.length > 0) {
  return; // silently ignore the request
}

  //END BLOCK CHAT REQUEST
        
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

// ------------------- Block User -------------------

if (data.type === 'block_user') {

  try {

    await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [data.blockerId, data.blockedId]
    );

    // Remove any pending requests between users
    await pool.query(
      `DELETE FROM chat_requests
       WHERE (from_user_id=$1 AND to_user_id=$2)
          OR (from_user_id=$2 AND to_user_id=$1)`,
      [data.blockerId, data.blockedId]
    );

  } catch (err) {
    console.error("Block user error:", err);
  }

}

// ------------------- Unblock User -------------------

if (data.type === 'unblock_user') {

  try {

    await pool.query(
      `DELETE FROM blocked_users
       WHERE blocker_id=$1 AND blocked_id=$2`,
      [data.blockerId, data.blockedId]
    );

    await pool.query(
      `DELETE FROM chat_requests
       WHERE (from_user_id=$1 AND to_user_id=$2)
          OR (from_user_id=$2 AND to_user_id=$1)`,
      [data.blockerId, data.blockedId]
    );

  } catch (err) {
    console.error("Unblock user error:", err);
  }

}
      

//CHAT REQUEST DECLINE
if (data.type === 'chat_request_decline') {

  try {

    await pool.query(
      `DELETE FROM chat_requests
       WHERE from_user_id=$1 AND to_user_id=$2`,
      [data.fromUserId, data.toUserId]
    );

    console.log("Chat request declined:", data.fromUserId, "->", data.toUserId);

  } catch (err) {
    console.error("Chat decline error:", err);
  }

}

// ------------------- Typing Indicator -------------------

if (data.type === 'typing' || data.type === 'stop_typing') {

  const receiverSocket = connectedUsers.get(data.receiverId);

  if (!receiverSocket || receiverSocket.readyState !== WebSocket.OPEN) return;

  receiverSocket.send(JSON.stringify({
    type: data.type,
    senderId: data.senderId
  }));
}


 //MESSAGE SECTION 

if (data.type === 'message') {

try {

  const userCheck = await pool.query(
    'SELECT id FROM users WHERE id=$1',
    [data.receiverId]
  );

  // User deleted
  if (userCheck.rows.length === 0) {

    const senderSocket = connectedUsers.get(data.senderId);

    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      senderSocket.send(JSON.stringify({
        type: "user_not_found",
        receiverId: data.receiverId
      }));
    }

    return;
  }

  // 🔒 Check if conversation still exists
  const userA = Math.min(data.senderId, data.receiverId);
  const userB = Math.max(data.senderId, data.receiverId);

  const convoCheck = await pool.query(
    `SELECT 1 FROM conversations
     WHERE user1_id=$1 AND user2_id=$2`,
    [userA, userB]
  );

  // Conversation removed
  if (convoCheck.rows.length === 0) {

    const senderSocket = connectedUsers.get(data.senderId);

    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      senderSocket.send(JSON.stringify({
        type: "chat_closed",
        receiverId: data.receiverId
      }));
    }

    return;
  }

    // Insert message (SAFE VERSION)
  await pool.query(
    `
    INSERT INTO messages (id, text, sender_id, receiver_id, delivered, type, image_path)
    VALUES ($1, $2, $3, $4, false, $5, $6)
    ON CONFLICT (id) DO NOTHING
    `,
  [
  data.messageId,
  data.text || '',
  data.senderId,
  data.receiverId,
  data.messageType || 'text',
  data.messageType === 'image' ? data.image : null
  ]
  );

  const receiverSocket = connectedUsers.get(data.receiverId);

  if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
    receiverSocket.send(JSON.stringify(data));
  }

} catch (err) {
  console.error("Message error:", err);
}

}

// ------------------- EDIT MESSAGE -------------------
if (data.type === 'edit_message') {
  try {

    // 🔒 Ensure message exists and belongs to sender
    const check = await pool.query(
      `SELECT sender_id FROM messages WHERE id = $1`,
      [data.messageId]
    );

    if (check.rows.length === 0) return;

    if (check.rows[0].sender_id !== data.senderId) return;

    // ✅ Update message
    await pool.query(
      `UPDATE messages
       SET text = $1,
           updated_at = NOW(),
           is_edited = TRUE
       WHERE id = $2`,
      [data.newText, data.messageId]
    );

    console.log("Message edited:", data.messageId);

    // 🔥 ADD THIS PART (broadcast)
    const receiverSocket = connectedUsers.get(data.receiverId);

    if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
      receiverSocket.send(JSON.stringify({
        type: "message_edited",
        messageId: data.messageId,
        newText: data.newText
      }));
    }

  } catch (err) {
    console.error("Edit message error:", err);
  }
}


// ------------------- CLEAR CHAT FOR EVERYONE -------------------

if (data.type === 'clear_chat_everyone') {

  try {

    const userA = Math.min(data.senderId, data.receiverId);
    const userB = Math.max(data.senderId, data.receiverId);

    // 🔥 Delete ALL messages between both users
    await pool.query(
      `DELETE FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2)
          OR (sender_id=$2 AND receiver_id=$1)`,
      [userA, userB]
    );

    // 🔔 Notify both users
    const senderSocket = connectedUsers.get(data.senderId);
    const receiverSocket = connectedUsers.get(data.receiverId);

    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      senderSocket.send(JSON.stringify({
        type: "chat_cleared_everyone",
        userId: data.receiverId
      }));
    }

    if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
      receiverSocket.send(JSON.stringify({
        type: "chat_cleared_everyone",
        userId: data.senderId
      }));
    }

  } catch (err) {
    console.error("Clear chat for everyone error:", err);
  }
}
      
// ------------------- Leave Chat -------------------

if (data.type === 'leave_chat') {

  try {

    const userA = Math.min(data.senderId, data.receiverId);
    const userB = Math.max(data.senderId, data.receiverId);

    // Remove conversation
    await pool.query(
      `DELETE FROM conversations
       WHERE user1_id=$1 AND user2_id=$2`,
      [userA, userB]
    );

    await pool.query(
    `DELETE FROM messages
    WHERE (sender_id=$1 AND receiver_id=$2)
      OR (sender_id=$2 AND receiver_id=$1)`,
  [data.senderId, data.receiverId]
    );
   

  // 🔥 Remove chat request so users can start a new chat later
    await pool.query(
  `DELETE FROM chat_requests
   WHERE (from_user_id=$1 AND to_user_id=$2)
      OR (from_user_id=$2 AND to_user_id=$1)`,
  [data.senderId, data.receiverId]
    ); 

    

    // Notify both users
    const senderSocket = connectedUsers.get(data.senderId);
    const receiverSocket = connectedUsers.get(data.receiverId);

    const payload = JSON.stringify({
      type: "chat_closed",
      receiverId: data.receiverId
    });

    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      senderSocket.send(payload);
    }

    if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
      receiverSocket.send(JSON.stringify({
        type: "chat_closed",
        receiverId: data.senderId
      }));
    }

  } catch (err) {
    console.error("Leave chat error:", err);
  }
}


      
      //END MESSAGE SECTION

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

  // 🔥 Notify chat partners that user is offline
  (async () => {
    try {

      const convoResult = await pool.query(
        `SELECT user1_id, user2_id
         FROM conversations
         WHERE user1_id = $1 OR user2_id = $1`,
        [ws.userID]
      );

      const partnerIds = new Set();

      convoResult.rows.forEach(row => {
        if (row.user1_id === ws.userID) {
          partnerIds.add(row.user2_id);
        } else {
          partnerIds.add(row.user1_id);
        }
      });

      partnerIds.forEach(partnerId => {
        const partnerSocket = connectedUsers.get(partnerId);

        if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
          partnerSocket.send(JSON.stringify({
            type: "user_offline",
            userId: ws.userID
          }));
        }
      });

    } catch (err) {
      console.error("Offline broadcast error:", err);
    }
  })();

  // ✅ Remove user AFTER notifying
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



// ------------------- CLEANUP OLD IMAGE MESSAGES -------------------
setInterval(async () => {
  try {

    // 1️⃣ Get old image messages (older than 1 hour)
    const result = await pool.query(`
      SELECT id, image_path
      FROM messages
      WHERE image_path IS NOT NULL
      AND created_at < NOW() - INTERVAL '1 hour'
    `);

    for (const msg of result.rows) {

      // 2️⃣ Delete file from disk (if exists)
      if (msg.image_path) {
        const filePath = require('path').join(__dirname, msg.image_path);

        require('fs').unlink(filePath, (err) => {
          if (err) {
            console.log("File delete failed (may already be gone):", filePath);
          }
        });
      }

      // 3️⃣ Delete message from DB
      await pool.query(
        `DELETE FROM messages WHERE id = $1`,
        [msg.id]
      );
    }

    if (result.rows.length > 0) {
      console.log(`Cleaned up ${result.rows.length} old image messages`);
    }

  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 5 * 60 * 1000); // runs every 5 minutes
