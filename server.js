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
// ROOM → CLIENTS MAP
// -----------------------------
const rooms = {
    body: new Set(),
    team: new Set(),
    foyer: new Set()
};


// -----------------------------
// PARSE ROOM FROM URL
// Example: ws://server/ws/body
// -----------------------------
function getRoomFromUrl(url) {
    try {
        const parts = url.split("/");
        return parts[parts.length - 1]; // "body"
    } catch {
        return null;
    }
}


// -----------------------------
// ON NEW CONNECTION
// -----------------------------
wss.on("connection", (ws, req) => {
    const room = getRoomFromUrl(req.url);

    if (!room || !rooms[room]) {
        console.log("❌ Invalid room:", req.url);
        ws.close();
        return;
    }

    console.log(`🔌 New WebSocket connection → Room: ${room}`);
    rooms[room].add(ws);

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
                    user: msg.user,
                    role: msg.role,
                    message: msg.message,
                    timestamp: msg.timestamp,
                    id: msg.id
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
            // FUTURE EVENT TYPES
            // -----------------------------
            case "edit":
                // scaffold for future editing support
                break;

            case "typing":
                // scaffold for typing indicators
                break;

            default:
                console.warn("⚠️ Unknown message type:", msg.type);
        }
    });

    // -----------------------------
    // ON CLOSE
    // -----------------------------
    ws.on("close", () => {
        rooms[room].delete(ws);
        console.log(`🔌 Client disconnected from room: ${room}`);
    });
});



// -----------------------------
// BROADCAST TO A ROOM
// -----------------------------
function broadcast(room, payload) {
    const message = JSON.stringify(payload);

    rooms[room].forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}


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

                if (rooms[room]) {
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
