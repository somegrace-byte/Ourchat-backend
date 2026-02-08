const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Initialize SQLite database
const dbPath = path.join(__dirname, 'messages.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Error opening DB:', err);
  else console.log('SQLite DB connected at', dbPath);
});

// Create messages table if not exists
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    userID TEXT NOT NULL
  )
`);

// HTTP endpoint to fetch all messages
app.get('/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY rowid ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const messages = rows.map(r => ({
      messageId: r.id,
      text: r.text,
      type: 'message',
      userID: r.userID
    }));
    res.json(messages);
  });
});

// Optional HTTP endpoint to send a message (for testing)
app.post('/send', (req, res) => {
  const { messageId, text, userID } = req.body;
  if (!messageId || !text || !userID) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const stmt = db.prepare('INSERT INTO messages (id, text, userID) VALUES (?, ?, ?)');
  stmt.run(messageId, text, userID, (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const msg = { messageId, text, type: 'message', userID };
    
    // Broadcast to all WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    });

    res.json({ type: 'sent', messageId });
  });
  stmt.finalize();
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  // Send all existing messages to the new client
  db.all('SELECT * FROM messages ORDER BY rowid ASC', [], (err, rows) => {
    if (!err) {
      rows.forEach(r => {
        ws.send(JSON.stringify({
          messageId: r.id,
          text: r.text,
          type: 'message',
          userID: r.userID
        }));
      });
    }
  });

  // Receive messages from clients
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.messageId || !msg.text || !msg.userID) return;

      const stmt = db.prepare('INSERT INTO messages (id, text, userID) VALUES (?, ?, ?)');
      stmt.run(msg.messageId, msg.text, msg.userID, (err) => {
        if (err) return console.error('DB insert error:', err);

        // Broadcast to all connected clients
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

        // Send ACK to sender
        ws.send(JSON.stringify({ type: 'sent', messageId: msg.messageId }));
      });
      stmt.finalize();
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
