import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createPreviewApp } from "../../preview/server.mjs";

test("WebSocket room endpoint sends the viewer-specific room state", async () => {
  const app = createPreviewApp();
  const server = createServer(app.handle);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const match = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
    sockets.handleUpgrade(request, socket, head, (ws) => {
      app.roomService.connectSocket(match[1], url.searchParams.get("token"), ws);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const auth = await post(baseUrl, "/api/auth/register", { username: "wsplayer", password: "abc12345" });
    const room = await post(baseUrl, "/api/rooms", {}, auth.auth);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${room.session.roomCode}/ws?token=${room.session.token}`);
    const state = await new Promise((resolve, reject) => {
      socket.once("message", (event) => resolve(JSON.parse(event.toString()).state));
      socket.once("error", reject);
    });
    assert.equal(state.mode, "room");
    assert.equal(state.roomCode, room.session.roomCode);
    assert.equal(state.players[0].name, "wsplayer");
    socket.close();
  } finally {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function post(baseUrl, path, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${auth.username}:${auth.token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "request failed");
  return payload;
}
