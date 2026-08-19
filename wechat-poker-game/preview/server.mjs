import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const poker = require("../js/poker_core.js");
const rules = require("../js/rules/custom_rules.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const DEFAULT_PORT = 5178;
const MAX_PORT_ATTEMPTS = 30;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

export function createPreviewApp() {
  let selectedTargetScore = 100;
  let state = null;

  function runAutoPlayers() {
    let guard = 0;
    while (state && state.phase === "playing" && state.currentPlayer !== 0 && guard < 32) {
      poker.autoPlayOneCard(state);
      guard += 1;
    }
  }

  function setTarget(score) {
    const parsed = Number(score);
    if (Number.isFinite(parsed) && parsed > 0) {
      selectedTargetScore = Math.floor(parsed);
      if (!state) {
        return;
      }
      state.targetScore = selectedTargetScore;
    }
  }

  function startGame() {
    state = poker.createGame({ targetScore: selectedTargetScore });
    runAutoPlayers();
  }

  function resetRound() {
    if (!state) {
      startGame();
      return;
    }
    if (state.phase === "gameOver") {
      state = null;
      return;
    }
    if (state.phase === "finished") {
      state = poker.createNextRound(state);
    } else {
      state = poker.createGame({ targetScore: state.targetScore || selectedTargetScore });
    }
    runAutoPlayers();
  }

  function viewState() {
    if (!state) {
      return {
        active: false,
        selectedTargetScore,
        targetScore: selectedTargetScore,
        targetOptions: [100, 200, 500],
        players: [],
        message: "",
        lastPlayText: "等待出牌",
        roundResult: [],
        finalSettlement: null,
        myTurn: false,
        phase: "setup",
        resetLabel: "重开",
        turnCount: 0
      };
    }

    const last = state.discardPile[state.discardPile.length - 1];
    return {
      active: true,
      selectedTargetScore,
      targetScore: state.targetScore,
      targetOptions: [100, 200, 500],
      players: state.players,
      message: state.message,
      lastPlayText: last ? `${last.playerName}：${last.label}` : "等待出牌",
      lastPlay: formatLastPlay(state.trick && state.trick.lastPlay),
      roundResult: state.roundResult || [],
      finalSettlement: formatSettlement(state.finalSettlement),
      myTurn: state.phase === "playing" && state.currentPlayer === 0,
      phase: state.phase,
      resetLabel: state.phase === "finished" ? "下一局" : state.phase === "gameOver" ? "新游戏" : "重开",
      turnCount: state.turnCount,
      specialDeal: state.specialDeal,
      winnerId: state.winnerId
    };
  }

  function formatSettlement(settlement) {
    if (!settlement) {
      return null;
    }
    return {
      entries: settlement.entries,
      net: settlement.net.map((item) => ({
        ...item,
        amountText: item.amount > 0 ? `+${item.amount}` : String(item.amount)
      }))
    };
  }

  function formatLastPlay(lastPlay) {
    if (!lastPlay) {
      return null;
    }
    return {
      playerId: lastPlay.playerId,
      playerName: lastPlay.playerName,
      label: lastPlay.label,
      cards: lastPlay.cards
    };
  }

  function toggleCard(cardId) {
    if (state) {
      poker.toggleCardSelection(state, 0, cardId);
    }
  }

  function playSelected() {
    if (state) {
      poker.playSelected(state);
      runAutoPlayers();
    }
  }

  function hintMove() {
    if (!state || state.phase !== "playing" || state.currentPlayer !== 0) {
      return;
    }

    const player = state.players[0];
    const lastPlay = state.trick && state.trick.lastPlay ? state.trick.lastPlay : null;
    const moves = rules.findLegalMoves(player.hand, lastPlay);
    poker.clearSelection(state);

    if (moves.length === 0) {
      state.message = "没有能接上的牌，可以选择过牌。";
      return;
    }

    const move = moves[0];
    poker.selectCardIds(state, 0, move.cards.map((card) => card.id));
    state.message = `已为你选中最小可出的${move.combo.label}。`;
  }

  function passTurn() {
    if (state) {
      poker.passTurn(state);
      runAutoPlayers();
    }
  }

  async function handleApi(req, res, pathname) {
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, viewState());
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }

    const body = await readJson(req);
    if (pathname === "/api/target") {
      setTarget(body.score);
    } else if (pathname === "/api/start") {
      startGame();
    } else if (pathname === "/api/toggle") {
      toggleCard(body.cardId);
    } else if (pathname === "/api/hint") {
      hintMove();
    } else if (pathname === "/api/play") {
      playSelected();
    } else if (pathname === "/api/pass") {
      passTurn();
    } else if (pathname === "/api/reset") {
      resetRound();
    } else {
      sendJson(res, { error: "not_found" }, 404);
      return;
    }

    sendJson(res, viewState());
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (error) {
      sendJson(res, { error: "server_error", message: error.message }, 500);
    }
  }

  return {
    handle,
    viewState,
    startGame,
    resetRound
  };
}

export function createPreviewServer() {
  const app = createPreviewApp();
  return createServer(app.handle);
}

export async function listenWithFallback(startPort = DEFAULT_PORT, host = "127.0.0.1") {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    const server = createPreviewServer();
    try {
      await listen(server, port, host);
      return {
        server,
        port,
        host,
        url: `http://${host}:${port}/`
      };
    } catch (error) {
      if (error.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error(`No available preview port from ${startPort} to ${startPort + MAX_PORT_ATTEMPTS - 1}`);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = normalize(join(publicDir, safePath));
  if (!fullPath.startsWith(publicDir)) {
    sendText(res, "Forbidden", 403, "text/plain; charset=utf-8");
    return;
  }

  try {
    await readFile(fullPath);
  } catch {
    sendText(res, "Not found", 404, "text/plain; charset=utf-8");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(fullPath)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  createReadStream(fullPath).pipe(res);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(text);
}

if (process.argv[1] && normalize(process.argv[1]) === normalize(__filename)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node preview/server.mjs [port]");
    process.exit(0);
  }
  const cliPort = Number(process.argv[2]);
  const envPort = Number(process.env.PORT);
  const requestedPort = Number.isFinite(cliPort)
    ? cliPort
    : Number.isFinite(envPort)
      ? envPort
      : DEFAULT_PORT;
  const preview = await listenWithFallback(requestedPort);
  console.log(`Preview server running at ${preview.url}`);
}
