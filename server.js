// hoh-ws-server.js
// Heart of Hope – Universal WebSocket Engine (Body, Team, Foyer)

require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Node < 18 fallback
if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import('node-fetch').then(mod => mod.default(...args));
}

// ENV
const PORT = process.env.PORT;
const JWT_SECRET = process.env.HOH_JWT_SECRET || 'change-me-in-production';

// In-memory presence
const clients = new Map(); // ws -> { userId, name, rooms: Set<string> }

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------
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

function broadcastToRoom(room, message, exceptWs = null) {
  console.log(`📢 BROADCAST to room "${room}":`, message);

  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!meta.rooms.has(room)) continue;
    if (ws === exceptWs) continue;

    console.log(`   ↳ Sent to user ${meta.userId}`);
    ws.send(JSON.stringify(message));
  }
}

// ------------------------------------------------------
// Universal REST endpoint resolver
// ------------------------------------------------------
function getRestBase(chatType) {
  switch (chatType) {
    case "body":  return "https://dev.heartofhope777.site/wp-json/bodychat/v1/message";
    case "team":  return "https://dev.heartofhope777.site/wp-json/teamchat/v1/message";
    case "foyer": return "https://dev.heartofhope777.site/wp-json/foyerchat/v1/message";
    default:      return null;
  }
}

// ------------------------------------------------------
// Universal room resolver
// ------------------------------------------------------
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
    const token = query.token;

    if (!token) {
      console.log("❌ Missing token — closing connection");
      ws.close(4001, 'Missing token');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
      console.log("🔑 Token verified:", payload);
    } catch (err) {
      console.log("❌ Invalid token:", err.message);
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
      console.log("📩 WS MESSAGE RECEIVED:", data.toString());

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.log("❌ Invalid JSON from client");
        return;
      }

      const { type } = msg;

      // Determine chatType + chatId dynamically
      const chatType = msg.body_chat_id ? "body" :
                       msg.team_chat_id ? "team" :
                       msg.foyer_chat_id ? "foyer" : null;

      const chatId =
        msg.body_chat_id ||
        msg.team_chat_id ||
        msg.foyer_chat_id;

      if (!chatType || !chatId) {
        console.log("❌ Missing chatType/chatId in message");
        return;
      }

      const room = getRoomName(chatType, chatId);
      const restBase = getRestBase(chatType);

      // ------------------------------------------------------
      // NEW MESSAGE
      // ------------------------------------------------------
      if (type === "message:new") {
        console.log(`📝 NEW MESSAGE from user ${meta.userId}:`, msg);

        // WS should ONLY broadcast, NOT save
        broadcastToRoom(room, {
          type: "message:new",
          message: msg.message
        }, ws);
        
        return;
        }

      // ------------------------------------------------------
      // UPDATE MESSAGE
      // ------------------------------------------------------
      if (type === "message:update") {
        console.log(`✏️ UPDATE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        fetch(`${restBase}/${encodeURIComponent(msg.message_id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: msg.content })
        })
        .then(res => res.json())
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
        });

        return;
      }

      // ------------------------------------------------------
      // DELETE MESSAGE
      // ------------------------------------------------------
      if (type === "message:delete") {
        console.log(`🗑️ DELETE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        fetch(`${restBase}/${encodeURIComponent(msg.message_id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" }
        })
        .then(res => res.json())
        .then(() => {
          console.log("💾 Deleted message:", msg.message_id);

          broadcastToRoom(room, {
            type: "message:delete",
            message_id: msg.message_id
          });
        })
        .catch(err => {
          console.error("❌ Failed to delete message:", err);
        });

        return;
      }

    }); // ws.on('message')

    ws.on('close', () => {
      console.log(`🔌 WS CLOSED for user ${meta.userId}`);
      clients.delete(ws);
    });

  } catch (err) {
    console.error("❌ Connection error:", err);
    ws.close();
  }
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Heart of Hope WebSocket server listening on port ${PORT}`);
});
