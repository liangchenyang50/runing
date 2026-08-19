import assert from "node:assert/strict";
import { createPreviewServer } from "../preview/server.mjs";

const server = createPreviewServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body == null ? "GET" : "POST",
    headers: body == null ? undefined : { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function post(path, body) {
  const result = await request(path, body);
  assert.equal(result.response.ok, true, `${path} should succeed: ${result.payload.message || ""}`);
  return result.payload;
}

async function getState(roomCode, token) {
  const result = await request(`/api/rooms/${roomCode}/state?token=${token}`);
  assert.equal(result.response.ok, true, "room state should be readable by a seated player");
  return result.payload;
}

function readWithTimeout(reader, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("room state was not broadcast")), timeoutMs);
    reader.read().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

try {
  const host = await post("/api/rooms", { profile: { name: "房主", avatar: "😀" } });
  const { roomCode } = host.session;
  assert.match(roomCode, /^\d{6}$/, "room code uses six digits");
  assert.equal(host.state.phase, "lobby", "a new room starts in the lobby");
  assert.equal(host.state.playerCount, 1, "creator occupies the first seat");

  const guestStart = await request(`/api/rooms/${roomCode}/start`, { token: host.session.token.replace(/./g, "0") });
  assert.equal(guestStart.response.status, 403, "an unknown token cannot start a room");

  const second = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小左", avatar: "🐼" } });
  const third = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小对", avatar: "🦊" } });
  const fourth = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小右", avatar: "🐯" } });
  const sessions = [host.session, second.session, third.session, fourth.session];

  const fullLobby = await getState(roomCode, host.session.token);
  assert.equal(fullLobby.playerCount, 4, "four players can fill a room");
  assert.equal(fullLobby.players[3].name, "小右", "custom nickname is visible to the room");

  const started = await post(`/api/rooms/${roomCode}/start`, { token: host.session.token });
  assert.equal(started.mode, "room", "room state marks the multiplayer mode");
  assert.equal(started.active, true, "starting the room creates a shared game");
  assert.equal(started.players[0].hand.length, 13, "the viewer receives their own thirteen cards");
  assert.equal("hand" in started.players[1], false, "the viewer does not receive an opponent hand");
  assert.equal(started.players[1].cardsLeft, 13, "opponent card counts remain visible");

  let playingState = started;
  for (let attempt = 0; attempt < 3 && playingState.phase !== "playing"; attempt += 1) {
    playingState = await post(`/api/rooms/${roomCode}/action`, {
      token: host.session.token,
      action: "next-round"
    });
  }
  assert.equal(playingState.phase, "playing", "the shared game reaches a playable round");

  const turnSession = sessions[playingState.currentPlayer];
  const turnState = await getState(roomCode, turnSession.token);
  const ownHand = turnState.players[turnSession.seat].hand;
  assert.equal(ownHand.length, 13, "the active player can read their own hand");
  const toggled = await post(`/api/rooms/${roomCode}/action`, {
    token: turnSession.token,
    action: "toggle",
    cardId: ownHand[0].id
  });
  assert.equal(
    toggled.players[turnSession.seat].hand.find((card) => card.id === ownHand[0].id).selected,
    true,
    "the current player can select a card"
  );

  const reaction = await post(`/api/rooms/${roomCode}/action`, {
    token: second.session.token,
    action: "reaction",
    emoji: "👏",
    label: "漂亮"
  });
  assert.equal(reaction.reactions[0].playerId, second.session.seat, "room reactions include the sending player");

  const renamed = await post(`/api/rooms/${roomCode}/profile`, {
    token: third.session.token,
    profile: { name: "自定义昵称", avatar: "🦁" }
  });
  assert.equal(renamed.players[third.session.seat].name, "自定义昵称", "a player can update their nickname");

  const controller = new AbortController();
  const eventResponse = await fetch(`${baseUrl}/api/rooms/${roomCode}/events?token=${host.session.token}`, {
    signal: controller.signal
  });
  assert.equal(eventResponse.ok, true, "room event stream opens for a seated player");
  const reader = eventResponse.body.getReader();
  const firstEvent = await reader.read();
  const eventText = new TextDecoder().decode(firstEvent.value);
  assert.match(eventText, /event: state/, "event stream sends an initial state");
  await post(`/api/rooms/${roomCode}/profile`, {
    token: fourth.session.token,
    profile: { name: "实时同步", avatar: "🐯" }
  });
  const streamedEvent = await readWithTimeout(reader);
  const streamedText = new TextDecoder().decode(streamedEvent.value);
  assert.match(streamedText, /实时同步/, "event stream broadcasts room updates to connected players");
  controller.abort();
  await reader.cancel().catch(() => {});

  const leaveLobby = await post("/api/rooms", { profile: { name: "离开房主", avatar: "😀" } });
  const leaveGuest = await post(`/api/rooms/${leaveLobby.session.roomCode}/join`, {
    profile: { name: "离开玩家", avatar: "🐼" }
  });
  const left = await post(`/api/rooms/${leaveLobby.session.roomCode}/leave`, { token: leaveGuest.session.token });
  assert.equal(left.left, true, "a lobby player can leave and release their seat");
  const leaveState = await getState(leaveLobby.session.roomCode, leaveLobby.session.token);
  assert.equal(leaveState.playerCount, 1, "leaving removes the player from the lobby");

  console.log("room server test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
