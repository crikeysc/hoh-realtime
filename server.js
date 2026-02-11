// hoh-ws-server.js
// Heart of Hope – WebSocket Engine (with full debug logging)

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
const PORT = process.env.PORT;
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
  console.log(`📢 BROADCAST to room "${room}":`, message);

  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!meta.rooms.has(room)) continue;
    if (ws === exceptWs) continue;

    console.log(`   ↳ Sent to user ${meta.userId}`);
    ws.send(JSON.stringify(message));
  }
}

// ======================================================
// HANDLE NEW CONNECTION
// ======================================================
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

    // ⭐ REMOVE the forced static room join
    // meta.rooms.add("body_chat");

    // ⭐ Auto-join rooms from query (dynamic)
    if (query.rooms) {
      query.rooms.split(',').forEach(r => {
        const room = r.trim();
        if (room) {
          meta.rooms.add(room);
          console.log(`📌 User ${userId} joined room: ${room}`);
        }
      });
    }

    // Initial welcome
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
      console.log("📩 WS MESSAGE RECEIVED:", data.toString());

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.log("❌ Invalid JSON from client");
        return;
      }

      const { type } = msg;

      // ======================================================
      // BODY CHAT: NEW MESSAGE
      // ======================================================
      if (type === "message:new") {
        console.log(`📝 NEW MESSAGE from user ${meta.userId}:`, msg);

        const room = `body_chat_${msg.body_chat_id}`;

        fetch("https://dev.heartofhope777.site/wp-json/bodychat/v1/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body_chat_id: msg.body_chat_id,
            user_id: meta.userId,
            message: {
              content: msg.message.content,
              message_type: msg.message.message_type,
              metadata: msg.message.metadata
            }
          })
        })
        .then(res => res.json())
        .then(saved => {
          console.log("💾 Saved NEW message:", saved);

          // ⭐ Broadcast to the correct dynamic room
          broadcastToRoom(room, {
            type: "message:new",
            message: saved
          }, ws);
        })
        .catch(err => {
          console.error("❌ Failed to save Body Chat message:", err);
        });

        return;
      }

      // ======================================================
      // BODY CHAT: UPDATE MESSAGE
      // ======================================================
      if (type === "message:update") {
        console.log(`✏️ UPDATE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        const room = `body_chat_${msg.body_chat_id}`;

        fetch(
          "https://dev.heartofhope777.site/wp-json/bodychat/v1/message/" +
          encodeURIComponent(msg.message_id),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: msg.content
            })
          }
        )
        .then(res => res.json())
        .then(() => {
          console.log("💾 Updated message:", msg.message_id);

          // ⭐ Broadcast to the correct dynamic room
          broadcastToRoom(room, {
            type: "message:update",
            message_id: msg.message_id,
            content: msg.content
          });
        })
        .catch(err => {
          console.error("❌ Failed to update Body Chat message:", err);
        });

        return;
      }

      // ======================================================
      // BODY CHAT: DELETE MESSAGE
      // ======================================================
      if (type === "message:delete") {
        console.log(`🗑️ DELETE MESSAGE ${msg.message_id} from user ${meta.userId}`);

        const room = `body_chat_${msg.body_chat_id}`;

        fetch(
          "https://dev.heartofhope777.site/wp-json/bodychat/v1/message/" +
          encodeURIComponent(msg.message_id),
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" }
          }
        )
        .then(res => res.json())
        .then(() => {
          console.log("💾 Deleted message:", msg.message_id);

          // ⭐ Broadcast to the correct dynamic room
          broadcastToRoom(room, {
            type: "message:delete",
            message_id: msg.message_id
          });
        })
        .catch(err => {
          console.error("❌ Failed to delete Body Chat message:", err);
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

// ======================================================
// START SERVER
// ======================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Heart of Hope WebSocket server listening on port ${PORT}`);
});
