// hoh-ws-server.js
// Heart of Hope – Universal WebSocket Engine (Body, Team, Foyer)

require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express();

// Node < 18 fallback for fetch
if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import('node-fetch').then(mod => mod.default(...args));
}

// ----------------------
// ENV (robust for Render)
// ----------------------
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.HOH_JWT_SECRET || 'change-me-in-production';

console.log('HOH WS server starting with config:', {
  port: PORT,
  jwtSecretSet: !!process.env.HOH_JWT_SECRET
});

// ------------------------------------------------------
// In-memory presence
// ------------------------------------------------------
const clients = new Map(); // ws -> { userId, name, rooms: Set<string> }

// ------------------------------------------------------
// TELEMETRY STORAGE
// ------------------------------------------------------
let messageCount = 0;
let messagesPerMinute = 0;

const errorLog = [];        // last 100 errors
const disconnectLog = [];   // last 100 disconnects
const roomActivity = {};    // roomName -> message count

// Reset throughput every minute
setInterval(() => {
  messagesPerMinute = messageCount;
  messageCount = 0;
}, 60 * 1000);

function logError(type, details) {
  errorLog.push({
    type,
    details,
    time: new Date().toISOString()
  });
  if (errorLog.length > 100) errorLog.shift();
}

// ------------------------------------------------------
// HTTP SERVER + EXPRESS
// ------------------------------------------------------
const server = http.createServer();
server.on('request', app);

const wss = new WebSocket.Server({ server });

// ------------------------------------------------------
// TELEMETRY ENDPOINTS
// ------------------------------------------------------
app.get('/connections', (req, res) => {
  res.json({ connections: wss.clients.size });
});

app.get('/stats/messages', (req, res) => {
  res.json({ perMinute: messagesPerMinute });
});

app.get('/stats/errors', (req, res) => {
  res.json(errorLog);
});

app.get('/stats/disconnects', (req, res) => {
  res.json(disconnectLog);
});

app.get('/stats/rooms', (req, res) => {
  res.json(roomActivity);
});

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------
function parseQuery(url) {
  const out = {};
  if (!url) return out;
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

function broadcastToRoom(room, message, exceptWs = null) {
  console.log(`📢 BROADCAST to room "${room}":`, message);

  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!meta.rooms.has(room)) continue;
    if (ws === exceptWs) continue;

    console.log(`   ↳ Sent to user ${meta.userId}`);
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.error('❌ Failed to send to ws', err);
    }
  }
}

// ------------------------------------------------------
// REST base mapping (Option 1): use existing WP namespaces
// ------------------------------------------------------
function getRestBase(chatType) {
  // Use the actual REST namespaces and singular message path
  switch (chatType) {
    case "body":  return "https://dev.heartofhope777.site/wp-json/bodychat/v1/message";
    case "team":  return "https://dev.heartofhope777.site/wp-json/teamchat/v1/message";
    case "foyer": return "https://dev.heartofhope777.site/wp-json/foyerchat/v1/message";
    default:      return null;
  }
}

function getRoomName(chatType, chatId) {
  return `${chatType}_chat_${chatId}`;
}

// ------------------------------------------------------
// WebSocket Connection
// ------------------------------------------------------
wss.on('connection', (ws, req) => {
  console.log("🔌 New WS connection:", req.url);

  try {
    const query = parseQuery(req.url || '');

    // Accept token from query string OR Authorization header (Bearer)
    let token = query.token || null;
    if (!token && req.headers && req.headers.authorization) {
      const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
      if (m) token = m[1];
    }

    if (!token) {
      console.log("❌ Missing token — closing connection");
      try { ws.close(4001, 'Missing token'); } catch(e){/*ignore*/ }
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
      console.log("🔑 Token verified:", payload);
    } catch (err) {
      console.log("❌ Invalid token:", err.message);
      try { ws.close(4002, 'Invalid token'); } catch(e){/*ignore*/ }
      return;
    }

    const userId = payload.sub || payload.user_id;
    const name = payload.name || payload.username || 'Guest';

    const meta = {
      userId,
      name,
      rooms: new Set()
    };

    clients.set(ws, meta);

    console.log(`👤 User connected: ${userId} (${name})`);

    // Dynamic room join
    if (query.rooms) {
      query.rooms.split(',').forEach(r => {
        const room = r.trim();
        if (room) {
          meta.rooms.add(room);
          console.log(`📌 User ${userId} joined room: ${room}`);
        }
      });
    }

    // Send initial connected event
    try {
      ws.send(JSON.stringify({
        type: 'connected',
        userId,
        name,
        rooms: Array.from(meta.rooms)
      }));
    } catch (err) {
      console.error('❌ Failed to send connected message', err);
    }

    // ------------------------------------------------------
    // MESSAGE HANDLER
    // ------------------------------------------------------
    ws.on('message', (data) => {
      console.log("📩 WS MESSAGE RECEIVED:", data.toString());

      messageCount++; // throughput counter

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.log("❌ Invalid JSON from client");
        logError('invalid-json', data.toString());
        return;
      }

      const { type } = msg;

      const chatType = msg.body_chat_id ? "body" :
                       msg.team_chat_id ? "team" :
                       msg.foyer_chat_id ? "foyer" : null;

      const chatId =
        msg.body_chat_id ||
        msg.team_chat_id ||
        msg.foyer_chat_id;

      if (!chatType || !chatId) {
        console.log("❌ Missing chatType/chatId in message");
        logError('missing-chatType', JSON.stringify(msg));
        return;
      }

      const room = getRoomName(chatType, chatId);
      const restBase = getRestBase(chatType);

      // Track room activity
      roomActivity[room] = (roomActivity[room] || 0) + 1;

      // ------------------------------------------------------
      // NEW MESSAGE (broadcast to room)
      // ------------------------------------------------------
      if (type === "message:new") {
        console.log(`📝 NEW MESSAGE from user ${meta.userId}:`, msg);

        broadcastToRoom(room, {
          type: "message:new",
          message: msg.message
        }, ws);

        return;
      }

      // ------------------------------------------------------
      // UPDATE MESSAGE (persist via REST then broadcast)
      // ------------------------------------------------------
      if (type === "message:update") {
        console.log(`✏️ UPDATE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        if (!restBase) {
          console.error('❌ No restBase for chatType', chatType);
          logError('no-rest-base', chatType);
          return;
        }

        fetch(`${restBase}/${encodeURIComponent(msg.message_id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: msg.content })
        })
        .then(res => res.json().catch(() => ({})))
        .then(() => {
          console.log("💾 Updated message:", msg.message_id);

          broadcastToRoom(room, {
            type: "message:update",
            message_id: msg.message_id,
            content: msg.content
          });
        })
        .catch(err => {
          console.error("❌ Failed to update message:", err);
          logError('update-failed', err.message || String(err));
        });

        return;
      }

      // ------------------------------------------------------
      // DELETE MESSAGE (persist via REST then broadcast)
      // ------------------------------------------------------
      if (type === "message:delete") {
        console.log(`🗑️ DELETE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        if (!restBase) {
          console.error('❌ No restBase for chatType', chatType);
          logError('no-rest-base', chatType);
          return;
        }

        fetch(`${restBase}/${encodeURIComponent(msg.message_id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" }
        })
        .then(res => res.json().catch(() => ({})))
        .then(() => {
          console.log("💾 Deleted message:", msg.message_id);

          broadcastToRoom(room, {
            type: "message:delete",
            message_id: msg.message_id
          });
        })
        .catch(err => {
          console.error("❌ Failed to delete message:", err);
          logError('delete-failed', err.message || String(err));
        });

        return;
      }

      // Unknown message type
      console.log("⚠️ Unknown message type:", type);
      logError('unknown-type', JSON.stringify(msg));
    }); // ws.on('message')

    ws.on('close', (code, reason) => {
      console.log(`🔌 WS CLOSED for user ${meta.userId}`);

      disconnectLog.push({
        userId: meta.userId,
        code,
        reason: reason ? reason.toString() : '',
        time: new Date().toISOString()
      });

      if (disconnectLog.length > 100) disconnectLog.shift();

      clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error("❌ WS ERROR:", err);
      logError('ws-error', err.message || String(err));
    });

  } catch (err) {
    console.error("❌ Connection error:", err);
    logError('connection-error', err.message || String(err));
    try { ws.close(); } catch(e){/*ignore*/ }
  }
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Heart of Hope WebSocket server listening on port ${PORT}`);
});
