const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Store messages in memory (simple for demo)
const messages = [];

// HTTP endpoint for polling or testing
app.get('/messages', (req, res) => {
  res.json(messages);
});

app.post('/send', (req, res) => {
  const { messageId, text } = req.body;
  if (!messageId || !text) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Add message to store
  const msg = { messageId, text, type: 'message' };
  messages.push(msg);

  // Broadcast to all WebSocket clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });

  // Respond with ACK for Sent ✓
  res.json({ type: 'sent', messageId });
});

const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  // Send all existing messages to new client
  messages.forEach(msg => ws.send(JSON.stringify(msg)));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.messageId || !msg.text) return;

      // Store message
      messages.push({ messageId: msg.messageId, text: msg.text, type: 'message' });

      // Broadcast to all clients
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ messageId: msg.messageId, text: msg.text, type: 'message' }));
        }
      });

      // Send ACK to sender
      ws.send(JSON.stringify({ type: 'sent', messageId: msg.messageId }));
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
