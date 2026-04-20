// server.js
// Heart of Hope – Unified WebSocket Engine (Body, Team, Foyer)

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
// ENV
// ----------------------
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.HOH_JWT_SECRET || 'change-me-in-production';

console.log('HOH WS server starting with config:', {
  port: PORT,
  jwtSecretSet: !!process.env.HOH_JWT_SECRET
});

// ------------------------------------------------------
// Crash handlers
// ------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason && reason.stack ? reason.stack : reason);
});

// ------------------------------------------------------
// In-memory presence
// ------------------------------------------------------
const clients = new Map();

// ------------------------------------------------------
// Telemetry
// ------------------------------------------------------
let messageCount = 0;
let messagesPerMinute = 0;

const errorLog = [];
const disconnectLog = [];
const roomActivity = {};

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
// Telemetry endpoints
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

function getRoomName(chatType, chatId) {
  return `${chatType}_chat_${chatId}`;
}

const HOH_REST_BASE = "https://dev.heartofhope777.site/wp-json/hoh/v1";

function getRestUrl(chatType) {
  return `${HOH_REST_BASE}/message?room=${encodeURIComponent(chatType)}`;
}

// ------------------------------------------------------
// WebSocket Connection
// ------------------------------------------------------
wss.on('connection', (ws, req) => {
  console.log("🔌 New WS connection:", req.url);

  // ------------------------------------------------------
  // AUTH + ROOM SETUP
  // ------------------------------------------------------
  try {
    const query = parseQuery(req.url || '');

    let token = null;
    try {
      token = query.token || null;

      if (!token && req.headers && req.headers.authorization) {
        const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
        if (m) token = m[1];
      }

      if (!token && req.headers && req.headers['sec-websocket-protocol']) {
        const proto = req.headers['sec-websocket-protocol'];
        const m1 = proto.match(/Bearer\s+(.+)/i);
        const m2 = proto.match(/Bearer,(.+)/i);
        if (m1) token = m1[1];
        else if (m2) token = m2[1];
        else token = proto;
      }

    } catch (e) {
      token = null;
    }

    if (!token) {
      try { ws.close(4001, 'Missing token'); } catch(e){}
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      try { ws.close(4002, 'Invalid token'); } catch(e){}
      return;
    }

    const userId = payload.sub || payload.user_id;
    const name = payload.name || payload.username || 'Guest';

    ws.meta = {
      userId,
      name,
      rooms: new Set()
    };

    clients.set(ws, ws.meta);

    if (query.rooms) {
      query.rooms.split(',').forEach(r => {
        const room = r.trim();
        if (room) ws.meta.rooms.add(room);
      });
    }

    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      name,
      rooms: Array.from(ws.meta.rooms)
    }));

  } catch (err) {
    logError('connection-error', err.message || String(err));
    try { ws.close(); } catch(e){}
    return;
  }

  // ------------------------------------------------------
  // MESSAGE HANDLER
  // ------------------------------------------------------
  ws.on('message', (data) => {
    console.log('📩 RAW WS MESSAGE:', data.toString());
    messageCount++;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logError('invalid-json', data.toString());
      return;
    }

    const { type } = msg;
    const chatType = msg.chatType;
    const chatId   = msg.chatId;

    if (!chatType || !chatId) {
      logError('missing-chatType', JSON.stringify(msg));
      return;
    }

    const room    = getRoomName(chatType, chatId);
    const restUrl = getRestUrl(chatType);

    roomActivity[room] = (roomActivity[room] || 0) + 1;

    // ------------------------------------------------------
    // ATTACHMENT
    // ------------------------------------------------------
    if (type === "attachment") {
      const now = new Date().toISOString();

      const payload = {
        type: "attachment",
        content: msg.content,
        fileName: msg.fileName,
        mime: msg.mime,
        user_id: ws.meta.userId,
        body_chat_id: chatId,
        created_at: now
      };

      fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          logError('attachment-rest-failed', `status=${res.status} body=${text}`);
          return;
        }
        return res.json();
      })
      .then(saved => {
        if (!saved) return;

        broadcastToRoom(room, {
          type: "attachment",
          message: saved
        });
      })
      .catch(err => {
        logError('attachment-failed', err.message || String(err));
      });

      return;
    }

    // ------------------------------------------------------
    // NEW MESSAGE
    // ------------------------------------------------------
    if (type === "message:new") {
      const payload = {
        type: "message",
        content: msg.message,
        author_id: ws.meta.userId,
        author_name: ws.meta.name,
        body_chat_id: chatId
      };

      fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          logError('message-new-rest-failed', `status=${res.status} body=${text}`);
          return;
        }
        return res.json();
      })
      .then(saved => {
        if (!saved) return;

        broadcastToRoom(room, {
          type: "message:new",
          message: saved
        });
      })
      .catch(err => {
        logError('message-new-failed', err.message || String(err));
      });

      return;
    }

    // ------------------------------------------------------
    // UPDATE MESSAGE
    // ------------------------------------------------------
    if (type === "message:update") {
      const { message } = msg;

      if (!message || !message.id) {
        logError('update-missing-fields', JSON.stringify(msg));
        return;
      }

      const messageId = message.id;
      const content   = message.content;

      fetch(`${restUrl}&id=${encodeURIComponent(messageId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          logError('update-rest-failed', `status=${res.status} body=${text}`);
          return;
        }
      })
      .then(() => {
        broadcastToRoom(room, {
          type: "message:update",
          message: {
            id: messageId,
            content,
            updated_at: new Date().toISOString()
          }
        });
      })
      .catch(err => {
        logError('update-failed', err.message || String(err));
      });

      return;
    }

    // ------------------------------------------------------
    // DELETE MESSAGE
    // ------------------------------------------------------
    if (type === "message:delete") {
      const messageId = msg.message_id;
    
      if (!messageId) {
        logError('delete-missing-id', JSON.stringify(msg));
        return;
      }
    
      fetch(`${restUrl}&id=${encodeURIComponent(messageId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          logError('delete-rest-failed', `status=${res.status} body=${text}`);
          return;
        }
      })
      .then(() => {
        broadcastToRoom(room, {
          type: "message:delete",
          chatType: "body",
          chatId: chatId,
          message_id: messageId,
          user_id: meta.userId
        });
      })
      .catch(err => {
        logError('delete-failed', err.message || String(err));
      });
    
      return;
    }

    // ------------------------------------------------------
    // JOIN ROOM
    // ------------------------------------------------------
    if (type === "join") {
      const joinRoom = getRoomName(chatType, chatId);
      ws.meta.rooms.add(joinRoom);

      ws.send(JSON.stringify({
        type: "joined",
        room: joinRoom
      }));

      return;
    }

    logError('unknown-type', JSON.stringify(msg));
  });

  // ------------------------------------------------------
  // CLOSE + ERROR HANDLERS
  // ------------------------------------------------------
  ws.on('close', (code, reason) => {
    disconnectLog.push({
      userId: ws.meta.userId,
      code,
      reason: reason ? reason.toString() : '',
      time: new Date().toISOString()
    });

    if (disconnectLog.length > 100) disconnectLog.shift();

    clients.delete(ws);
  });

  ws.on('error', (err) => {
    logError('ws-error', err.message || String(err));
  });
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Heart of Hope WebSocket server listening on port ${PORT}`);
});
