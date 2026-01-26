// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());

// Simple health check
app.get('/', (req, res) => {
  res.send('Heart of Hope WebSocket server is running');
});

const server = http.createServer(app);

// WebSocket server on /ws
const wss = new WebSocket.Server({ server, path: '/ws' });

const JWT_SECRET = process.env.HOH_JWT_SECRET;

// Simple room map: roomName -> Set of clients
const rooms = new Map();

function joinRoom(ws, room) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  rooms.get(room).add(ws);
  ws._room = room;
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room) return;
  const set = rooms.get(room);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    rooms.delete(room);
  }
}

function broadcastToRoom(room, data) {
  const set = rooms.get(room);
  if (!set) return;
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const room = url.searchParams.get('room') || 'team_chat';

    if (!token || !JWT_SECRET) {
      ws.close(4001, 'Missing token or server secret');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.error('JWT verification failed:', err.message);
      ws.close(4002, 'Invalid token');
      return;
    }

    ws._user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
    };

    joinRoom(ws, room);

    console.log(`User ${ws._user.name} joined room: ${room}`);

    // Presence: notify others
    broadcastToRoom(room, {
      type: 'presence',
      event: 'join',
      user: ws._user,
      room,
      timestamp: Date.now(),
    });

    ws.on('message', (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch {
        data = { type: 'message', text: String(message) };
      }

      if (data.type === 'typing') {
        broadcastToRoom(room, {
          type: 'typing',
          user: ws._user,
          room,
          timestamp: Date.now(),
        });
        return;
      }

      broadcastToRoom(room, {
        type: 'message',
        user: ws._user,
        room,
        text: data.text || '',
        timestamp: Date.now(),
      });
    });

    ws.on('close', () => {
      console.log(`User ${ws._user?.name || 'Unknown'} left room: ${room}`);
      leaveRoom(ws);
      broadcastToRoom(room, {
        type: 'presence',
        event: 'leave',
        user: ws._user,
        room,
        timestamp: Date.now(),
      });
    });
  } catch (err) {
    console.error('Connection error:', err);
    ws.close(1011, 'Internal server error');
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Heart of Hope WebSocket server running on port ${PORT}`);
});
