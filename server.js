// server.js
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
// Crash handlers (diagnostic)
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
// REST base mapping
// ------------------------------------------------------
function getRestBase(chatType) {
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

    // Accept token from query string OR Authorization header OR sec-websocket-protocol
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

    const meta = {
      userId,
      name,
      rooms: new Set()
    };

    clients.set(ws, meta);

    // Dynamic room join
    if (query.rooms) {
      query.rooms.split(',').forEach(r => {
        const room = r.trim();
        if (room) meta.rooms.add(room);
      });
    }

    // Initial connected event
    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      name,
      rooms: Array.from(meta.rooms)
    }));

    // ------------------------------------------------------
    // MESSAGE HANDLER
    // ------------------------------------------------------
    ws.on('message', (data) => {
      messageCount++;

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        logError('invalid-json', data.toString());
        return;
      }

      const { type } = msg;

      // NEW unified schema
      const chatType = msg.chatType;
      const chatId = msg.chatId;

      if (!chatType || !chatId) {
        logError('missing-chatType', JSON.stringify(msg));
        return;
      }

      const room = getRoomName(chatType, chatId);
      const restBase = getRestBase(chatType);

      roomActivity[room] = (roomActivity[room] || 0) + 1;

      // ------------------------------------------------------
      // NEW MESSAGE (broadcast)
      // ------------------------------------------------------
      if (type === "attachment") {
          if (!restBase) {
              logError('no-rest-base', chatType);
              return;
          }
      
          const now = new Date().toISOString();
      
          const payload = {
              type: "attachment",
              content: msg.content,     // URL of uploaded file
              fileName: msg.fileName,   // optional
              mime: msg.mime,           // optional
              user_id: meta.userId,
              body_chat_id: chatId
          };
      
          fetch(restBase, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(saved => {
              broadcastToRoom(room, {
                type: "attachment",
                message: {
                  id: saved.id,
                  content: saved.content,
                  fileName: saved.fileName,
                  mime: saved.mime,
                  created_at: saved.created_at,
                  updated_at: saved.updated_at
                }
              });
          })
          .catch(err => {
              logError('attachment-failed', err.message || String(err));
          });
      
          return;
      }
      
      if (type === "message:new") {
          if (!restBase) {
              logError('no-rest-base', chatType);
              return;
          }
      
          const payload = {
              content: msg.message,
              author_id: meta.userId,
              author_name: meta.name,
              body_chat_id: chatId
          };
      
          fetch(restBase, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(saved => {
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
        const content = message.content;

        if (!restBase) {
          logError('no-rest-base', chatType);
          return;
        }

        fetch(`${restBase}/${encodeURIComponent(messageId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content })
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

        if (!restBase) {
          logError('no-rest-base', chatType);
          return;
        }

        fetch(`${restBase}/${encodeURIComponent(msg.message_id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" }
        })
        .then(() => {
          broadcastToRoom(room, {
            type: "message:delete",
            message: {
              id: msg.message_id
            }
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
        const { chatType, chatId } = msg;

        if (!chatType || !chatId) {
          logError('join-missing-fields', JSON.stringify(msg));
          return;
        }

        const joinRoom = getRoomName(chatType, chatId);
        meta.rooms.add(joinRoom);

        ws.send(JSON.stringify({
          type: "joined",
          room: joinRoom
        }));

        return;
      }

      logError('unknown-type', JSON.stringify(msg));
    });

    ws.on('close', (code, reason) => {
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
      logError('ws-error', err.message || String(err));
    });

  } catch (err) {
    logError('connection-error', err.message || String(err));
    try { ws.close(); } catch(e){}
  }
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Heart of Hope WebSocket server listening on port ${PORT}`);
});
