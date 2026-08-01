/**
 * HOH Unified WebSocket Server
 * Supports: body, team, foyer, future rooms
 * Schema matches ChatEngine.js + REST API
 */

import WebSocket, { WebSocketServer } from "ws";
import http from "http";

// -----------------------------
// SERVER SETUP
// -----------------------------
const PORT = process.env.PORT || 10000;

const server = http.createServer();
const wss = new WebSocketServer({ server });

console.log("🚀 HOH Realtime WebSocket Server starting...");
console.log(`🔌 Listening on port ${PORT}`);


// -----------------------------
// ROOM → CLIENTS MAP (dynamic)
// -----------------------------
const rooms = new Map();

function ensureRoom(room) {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    return rooms.get(room);
}


// -----------------------------
// PARSE ROOM FROM URL
// Example client URL:
// wss://hoh-realtime-ws.onrender.com/?token=JWT&rooms=body_chat_949
// -----------------------------
function getRoomFromUrl(url) {
    try {
        const parsed = new URL(url, "ws://localhost");
        return parsed.searchParams.get("rooms");
    } catch {
        return null;
    }
}


// -----------------------------
// BROADCAST TO A ROOM
// -----------------------------
function broadcast(room, payload) {
    const message = JSON.stringify(payload);
    const roomSet = rooms.get(room);
    if (!roomSet) return;

    roomSet.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}


// -----------------------------
// ON NEW CONNECTION
// -----------------------------
wss.on("connection", (ws, req) => {
    const parsed = new URL(req.url, "ws://localhost");
    const token  = parsed.searchParams.get("token");
    const room   = parsed.searchParams.get("rooms");

    if (!room) {
        console.log("❌ No room provided:", req.url);
        ws.close();
        return;
    }

    const roomSet = ensureRoom(room);
    roomSet.add(ws);

    console.log(`🔌 New WebSocket connection → Room: ${room}`);

    // -----------------------------
    // MESSAGE HANDLER (scaffolded)
    // -----------------------------
    ws.on("message", (data) => {
        let msg;

        // 1. Parse safely
        try {
            msg = JSON.parse(data);
        } catch (err) {
            console.error("❌ Invalid JSON from client:", err);
            return;
        }

        // 2. Validate base structure
        if (!msg || typeof msg !== "object") {
            console.error("❌ Invalid message format:", msg);
            return;
        }

        // 3. Route by type
        switch (msg.type) {

            // -----------------------------
            // NORMAL CHAT MESSAGE
            // -----------------------------
            case "message":
                broadcast(room, {
                    type: "message",
                    id: msg.id,
                    user: msg.user,
                    role: msg.role,
                    message: msg.message,
                    timestamp: msg.timestamp
                });
                break;

            // -----------------------------
            // DELETE MESSAGE
            // -----------------------------
            case "delete":
                if (!msg.id) {
                    console.error("❌ Delete event missing ID");
                    return;
                }

                broadcast(room, {
                    type: "delete",
                    id: msg.id
                });
                break;

            // -----------------------------
            // EDIT MESSAGE
            // -----------------------------
            case "edit":
                if (!msg.id || !msg.content) {
                    console.error("❌ Edit event missing fields");
                    return;
                }

                broadcast(room, {
                    type: "edit",
                    id: msg.id,
                    content: msg.content
                });
                break;

            // -----------------------------
            // TYPING INDICATORS (future)
            // -----------------------------
            case "typing":
                // broadcast(room, { type: "typing", user: msg.user });
                break;

            // -----------------------------
            // PRESENCE (future)
            // -----------------------------
            case "presence":
                // broadcast(room, { type: "presence", user: msg.user, status: msg.status });
                break;

            default:
                console.warn("⚠️ Unknown message type:", msg.type);
        }
    });

    // -----------------------------
    // ON CLOSE
    // -----------------------------
    ws.on("close", () => {
        roomSet.delete(ws);
        console.log(`🔌 Client disconnected from room: ${room}`);
    });
});


// -----------------------------
// HTTP ENDPOINT FOR REST API
// POST → /broadcast
// -----------------------------
server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/broadcast") {
        let body = "";

        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const payload = JSON.parse(body);
                const room = payload.room;

                if (room) {
                    broadcast(room, payload);
                    console.log(`📢 Broadcast to room "${room}"`);
                }

                res.writeHead(200);
                res.end("OK");
            } catch (err) {
                console.error("❌ Broadcast error:", err);
                res.writeHead(400);
                res.end("Invalid JSON");
            }
        });

        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});


// -----------------------------
// START SERVER
// -----------------------------
server.listen(PORT, () => {
    console.log(`🚀 HOH WebSocket server running on port ${PORT}`);
});
