// hoh-ws-server.js
// Heart of Hope – WebSocket Engine
// Supports: body_chat, team_chat, foyer

require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// If Node < 18, provide fetch
if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import('node-fetch').then(mod => mod.default(...args));
}

// ENV
const PORT = process.env.PORT || 435;
const JWT_SECRET = process.env.HOH_JWT_SECRET || 'change-me-in-production';

// In-memory presence
const clients = new Map(); // ws -> { userId, name, rooms: Set<string> }

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Helper: parse query string
function parseQuery(url) {
  const out = {};
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return out;
  const query = url.slice(qIndex + 1);
  query.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (!k) return;
    out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return out;
}

// Helper: broadcast to room
function broadcastToRoom(room, message, exceptWs = null) {
  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!meta.rooms.has(room)) continue;
    if (ws === exceptWs) continue;
    ws.send(JSON.stringify(message));
  }
}

// ======================================================
// HANDLE NEW CONNECTION
// ======================================================
wss.on('connection', (ws, req) => {
  try {
    const query = parseQuery(req.url || '');
    const token = query.token;

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      ws.close(4002, 'Invalid token');
      return;
    }

    const userId = payload.sub || payload.user_id;
    const name = payload.name || 'Guest';

    const meta = {
      userId,
      name,
      rooms: new Set()
    };

    clients.set(ws, meta);

    // Auto-join rooms from query
    if (query.rooms) {
      query.rooms.split(',').forEach(r => {
        const room = r.trim();
        if (room) meta.rooms.add(room);
      });
    }

    // Send initial welcome
    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      name,
      rooms: Array.from(meta.rooms)
    }));

    // ======================================================
    // MESSAGE HANDLER
    // ======================================================
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const { type, room } = msg;

      // ======================================================
      // BODY CHAT: NEW MESSAGE
      // ======================================================
      if (type === "message:new") {

        // Ensure sender is in the room
        meta.rooms.add("body_chat");

        fetch("https://dev.heartofhope777.site/wp-json/bodychat/v1/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body_chat_id: msg.body_chat_id,
            user_id: meta.userId,
            content: msg.message.content,
            message_type: msg.message.message_type,
            metadata: msg.message.metadata
          })
        })
        .then(res => res.json())
        .then(saved => {
          broadcastToRoom("body_chat", {
            type: "message:new",
            message: saved
          }, ws);
        })
        .catch(err => {
          console.error("Failed to save Body Chat message:", err);
        });

        return;
      }

      // ======================================================
      // LEGACY CHAT: TEAM / FOYER
      // ======================================================
      if (type === 'message' && room) {

        if (!msg.text || msg.text.trim() === "") return;

        const outgoing = {
          type: 'message',
          room,
          text: msg.text,
          user: { id: userId, name },
          timestamp: Date.now()
        };

        broadcastToRoom(room, outgoing, ws);
        return;
      }

      // JOIN ROOM
      if (type === 'join' && room) {
        meta.rooms.add(room);
        ws.send(JSON.stringify({ type: 'joined', room }));
        return;
      }

      // LEAVE ROOM
      if (type === 'leave' && room) {
        meta.rooms.delete(room);
        ws.send(JSON.stringify({ type: 'left', room }));
        return;
      }

      // TYPING / PRESENCE EVENTS
      if (type === 'event' && room && msg.payload && msg.payload.event) {
        broadcastToRoom(room, {
          type: 'event',
          room,
          event: msg.payload.event,
          data: msg.payload.data || {},
          from: { userId, name }
        }, ws);
      }
    });

  } catch (err) {
    console.error("Connection error:", err);
    ws.close();
  }
});

// ======================================================
// HTTP ENDPOINT FOR WORDPRESS TO PUSH EVENTS
// ======================================================
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/emit') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { room, event, data } = JSON.parse(body || '{}');
        if (!room || !event) {
          res.statusCode = 400;
          res.end('Missing room or event');
          return;
        }

        broadcastToRoom(room, {
          type: 'event',
          room,
          event,
          data: data || {},
          from: { system: true }
        });

        res.statusCode = 200;
        res.end('OK');
      } catch {
        res.statusCode = 400;
        res.end('Invalid JSON');
      }
    });
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

// ======================================================
// START SERVER
// ======================================================
server.listen(PORT, () => {
  console.log(`Heart of Hope WebSocket server listening on port ${PORT}`);
});
