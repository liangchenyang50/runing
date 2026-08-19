import assert from "node:assert/strict";
import { createPreviewServer } from "../preview/server.mjs";

const server = createPreviewServer({ dismissalVoteMs: 300 });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, body, auth) {
  const headers = {};
  if (body != null) {
    headers["Content-Type"] = "application/json";
  }
  if (auth) {
    headers.Authorization = `Bearer ${auth.username}:${auth.token}`;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: body == null ? "GET" : "POST",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function post(path, body, auth) {
  const result = await request(path, body, auth);
  assert.equal(result.response.ok, true, `${path} should succeed: ${result.payload.message || ""}`);
  return result.payload;
}

async function createAccount(username, name, avatar) {
  const registered = await post("/api/auth/register", { username, password: "PokerPass123" });
  const updated = await post("/api/account/profile", { profile: { name, avatar } }, registered.auth);
  return { auth: registered.auth, profile: updated.account.profile };
}

async function seatPlayer(path, account) {
  const payload = await post(path, {}, account.auth);
  payload.session.auth = account.auth;
  return payload;
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
  const hostAccount = await createAccount("hostroom01", "房主", "😀");
  const secondAccount = await createAccount("leftroom01", "小左", "🐼");
  const thirdAccount = await createAccount("toproom001", "小对", "🦊");
  const fourthAccount = await createAccount("rightroom1", "小右", "🐯");
  const spectatorAccount = await createAccount("spectator1", "观众", "/assets/avatars/portrait-1.jpg");
  const duplicateAccount = await createAccount("duplicate1", "候补", "😀");
  const duplicateNickname = await request("/api/account/profile", { profile: { name: "房主", avatar: "😀" } }, duplicateAccount.auth);
  assert.equal(duplicateNickname.response.status, 409, "registered nicknames are globally unique");

  const host = await seatPlayer("/api/rooms", hostAccount);
  const { roomCode } = host.session;
  assert.match(roomCode, /^\d{6}$/, "room code uses six digits");
  assert.equal(host.state.phase, "lobby", "a new room starts in the lobby");
  assert.equal(host.state.playerCount, 1, "creator occupies the first seat");

  const guestStart = await request(`/api/rooms/${roomCode}/start`, { token: host.session.token.replace(/./g, "0") }, hostAccount.auth);
  assert.equal(guestStart.response.status, 403, "an unknown token cannot start a room");

  const second = await seatPlayer(`/api/rooms/${roomCode}/join`, secondAccount);
  const third = await seatPlayer(`/api/rooms/${roomCode}/join`, thirdAccount);
  const fourth = await seatPlayer(`/api/rooms/${roomCode}/join`, fourthAccount);
  const sessions = [host.session, second.session, third.session, fourth.session];

  const renamed = await post(`/api/rooms/${roomCode}/profile`, {
    token: third.session.token,
    profile: { name: "自定义昵称", avatar: "🦁" }
  }, thirdAccount.auth);
  assert.equal(renamed.players[third.session.seat].name, "自定义昵称", "a player can update their nickname before the room starts");

  const fullLobby = await getState(roomCode, host.session.token);
  assert.equal(fullLobby.playerCount, 4, "four players can fill a room");
  assert.equal(fullLobby.players[3].name, "小右", "custom nickname is visible to the room");

  const started = await post(`/api/rooms/${roomCode}/start`, { token: host.session.token }, hostAccount.auth);
  assert.equal(started.mode, "room", "room state marks the multiplayer mode");
  assert.equal(started.active, true, "starting the room creates a shared game");
  assert.equal(started.players[0].hand.length, 13, "the viewer receives their own thirteen cards");
  assert.equal("hand" in started.players[1], false, "the viewer does not receive an opponent hand");
  assert.equal(started.players[1].cardsLeft, null, "opponent card counts stay hidden above four cards");
  assert.equal(started.players[1].cardCountVisible, false, "opponent hidden card counts are explicit in the room state");

  const accountLockedProfile = await request("/api/account/profile", {
    profile: { name: "不应绕过", avatar: "😀" }
  }, hostAccount.auth);
  assert.equal(accountLockedProfile.response.status, 409, "the account profile endpoint also locks after the game starts");

  const spectator = await seatPlayer(`/api/rooms/${roomCode}/join`, spectatorAccount);
  assert.equal(spectator.session.role, "spectator", "joining a full room creates a spectator session");
  assert.equal(spectator.state.isSpectator, true, "spectator state is marked as read-only");
  assert.equal(spectator.state.players.every((player) => !Object.hasOwn(player, "hand")), true, "spectator never receives any hand");
  assert.equal(spectator.state.players.every((player) => player.cardsLeft === null), true, "spectator never receives card counts");
  assert.equal(spectator.state.spectatorCount, 1, "the room exposes the active spectator count");

  const spectatorAction = await request(`/api/rooms/${roomCode}/action`, {
    token: spectator.session.token,
    action: "hint"
  }, spectatorAccount.auth);
  assert.equal(spectatorAction.response.status, 403, "spectator actions are rejected by the server");

  const lockedProfile = await request(`/api/rooms/${roomCode}/profile`, {
    token: third.session.token,
    profile: { name: "不应修改", avatar: "🐼" }
  }, thirdAccount.auth);
  assert.equal(lockedProfile.response.status, 409, "player profiles lock once a room starts");

  const requestedDismissal = await post(`/api/rooms/${roomCode}/action`, {
    token: host.session.token,
    action: "request-dismissal"
  }, hostAccount.auth);
  assert.equal(requestedDismissal.dismissalVote.requestedBy, host.session.seat, "a player can start a room dismissal vote");
  assert.equal(requestedDismissal.dismissalVote.canReject, false, "the requester cannot reject their own vote");

  const guestVoteState = await getState(roomCode, second.session.token);
  assert.equal(guestVoteState.dismissalVote.canReject, true, "another seated player can reject the dismissal vote");

  const rejectedDismissal = await post(`/api/rooms/${roomCode}/action`, {
    token: second.session.token,
    action: "reject-dismissal"
  }, secondAccount.auth);
  assert.equal(rejectedDismissal.dismissalVote, null, "one rejection cancels the dismissal vote");
  assert.match(rejectedDismissal.dismissalNotice.message, /拒绝解散/, "the room announces that play continues after a rejection");

  let playingState = started;
  for (let attempt = 0; attempt < 3 && playingState.phase !== "playing"; attempt += 1) {
    playingState = await post(`/api/rooms/${roomCode}/action`, {
      token: host.session.token,
      action: "next-round"
    }, hostAccount.auth);
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
  }, turnSession.auth);
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
  }, secondAccount.auth);
  assert.equal(reaction.reactions[0].playerId, second.session.seat, "room reactions include the sending player");

  const controller = new AbortController();
  const eventResponse = await fetch(`${baseUrl}/api/rooms/${roomCode}/events?token=${host.session.token}`, {
    signal: controller.signal
  });
  assert.equal(eventResponse.ok, true, "room event stream opens for a seated player");
  const reader = eventResponse.body.getReader();
  const firstEvent = await reader.read();
  const eventText = new TextDecoder().decode(firstEvent.value);
  assert.match(eventText, /event: state/, "event stream sends an initial state");
  await post(`/api/rooms/${roomCode}/action`, {
    token: fourth.session.token,
    action: "reaction",
    emoji: "😄",
    label: "实时同步"
  }, fourthAccount.auth);
  const streamedEvent = await readWithTimeout(reader);
  const streamedText = new TextDecoder().decode(streamedEvent.value);
  assert.match(streamedText, /实时同步/, "event stream broadcasts room updates to connected players");
  controller.abort();
  await reader.cancel().catch(() => {});

  const leaveHostAccount = await createAccount("leavehost1", "离开房主", "😀");
  const leaveGuestAccount = await createAccount("leaveguest", "离开玩家", "🐼");
  const leaveLobby = await seatPlayer("/api/rooms", leaveHostAccount);
  const leaveGuest = await seatPlayer(`/api/rooms/${leaveLobby.session.roomCode}/join`, leaveGuestAccount);
  const left = await post(`/api/rooms/${leaveLobby.session.roomCode}/leave`, { token: leaveGuest.session.token }, leaveGuestAccount.auth);
  assert.equal(left.left, true, "a lobby player can leave and release their seat");
  const leaveState = await getState(leaveLobby.session.roomCode, leaveLobby.session.token);
  assert.equal(leaveState.playerCount, 1, "leaving removes the player from the lobby");

  const dissolveAccounts = await Promise.all([
    createAccount("votehost01", "投票房主", "😀"),
    createAccount("voteleft01", "投票左家", "🐼"),
    createAccount("votetop001", "投票对家", "🦊"),
    createAccount("voteright1", "投票右家", "🐯")
  ]);
  const dissolvingRoom = await seatPlayer("/api/rooms", dissolveAccounts[0]);
  const dissolvingCode = dissolvingRoom.session.roomCode;
  await seatPlayer(`/api/rooms/${dissolvingCode}/join`, dissolveAccounts[1]);
  await seatPlayer(`/api/rooms/${dissolvingCode}/join`, dissolveAccounts[2]);
  await seatPlayer(`/api/rooms/${dissolvingCode}/join`, dissolveAccounts[3]);
  await post(`/api/rooms/${dissolvingCode}/start`, { token: dissolvingRoom.session.token }, dissolveAccounts[0].auth);
  await post(`/api/rooms/${dissolvingCode}/action`, {
    token: dissolvingRoom.session.token,
    action: "request-dismissal"
  }, dissolveAccounts[0].auth);
  await new Promise((resolve) => setTimeout(resolve, 380));
  const dissolvedState = await request(`/api/rooms/${dissolvingCode}/state?token=${dissolvingRoom.session.token}`);
  assert.equal(dissolvedState.response.status, 404, "a vote without rejection dissolves the room after its deadline");

  console.log("room server test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
