import { createServer } from "node:http";
import { createPool } from "mysql2/promise";
import { WebSocketServer } from "ws";
import { createPreviewApp } from "../preview/server.mjs";
import { createMysqlAccountService } from "./mysql_account_service.mjs";

const PORT = readPort(process.env.PORT, 3000);
const HOST = process.env.HOST || "0.0.0.0";
const pool = createPool(databaseOptions());
const accountService = createMysqlAccountService(pool);

await accountService.ready;
const app = createPreviewApp({ accountService });
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/runtime-config.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end('window.__POKER_RUNTIME__ = Object.freeze({ transport: "websocket", supportsSolo: false, localDebug: false });\n');
    return;
  }
  app.handle(req, res);
});

const sockets = new WebSocketServer({ noServer: true, clientTracking: false });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const match = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
  const token = url.searchParams.get("token") || "";
  if (!match || !token) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    try {
      app.roomService.connectSocket(match[1], token, ws);
    } catch (error) {
      ws.close(1008, error.message || "无法连接房间。");
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Poker Node server running at http://${HOST}:${PORT}/`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  await accountService.flush();
  sockets.clients.forEach((socket) => socket.close(1001, "服务器正在重启。"));
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function databaseOptions() {
  const fromUrl = process.env.DATABASE_URL;
  if (fromUrl) {
    const parsed = new URL(fromUrl);
    return {
      host: parsed.hostname,
      port: readPort(parsed.port, 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ""),
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4"
    };
  }
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: readPort(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || "poker_user",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "four_player_poker",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4"
  };
}

function readPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}
