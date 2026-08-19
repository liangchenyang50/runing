import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function request(path, body, auth) {
  const headers = {};
  if (body != null) {
    headers["content-type"] = "application/json";
  }
  if (auth) {
    headers.authorization = `Bearer ${auth.username}:${auth.token}`;
  }
  const response = await exports.default.fetch(new Request(`https://poker.test${path}`, {
    method: body == null ? "GET" : "POST",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body == null ? undefined : JSON.stringify(body)
  }));
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function post(path, body, expectedStatus = 200, auth) {
  const result = await request(path, body, auth);
  expect(result.response.status).toBe(expectedStatus);
  return result.payload;
}

async function createAccount(username, name, avatar) {
  const registered = await post("/api/auth/register", { username, password: "PokerPass123" }, 201);
  const updated = await post("/api/account/profile", { profile: { name, avatar } }, 200, registered.auth);
  return { auth: registered.auth, profile: updated.account.profile };
}

async function seatPlayer(path, account) {
  const payload = await post(path, {}, 201, account.auth);
  payload.session.auth = account.auth;
  return payload;
}

async function stateFor(roomCode, token) {
  const result = await request(`/api/rooms/${roomCode}/state?token=${token}`);
  expect(result.response.status).toBe(200);
  return result.payload;
}

describe("Cloudflare room service", () => {
  it("creates a persistent four-player room while hiding opponents' hands", async () => {
    const hostAccount = await createAccount("workerhost1", "房主", "😀");
    const secondAccount = await createAccount("workerleft1", "小左", "🐼");
    const thirdAccount = await createAccount("workertop01", "小对", "🦊");
    const fourthAccount = await createAccount("workerright", "小右", "🐯");
    const spectatorAccount = await createAccount("workerspect", "观众", "/assets/avatars/portrait-1.jpg");
    const duplicateAccount = await createAccount("workerdupe1", "候补", "😀");
    const duplicateNickname = await request("/api/account/profile", { profile: { name: "房主", avatar: "😀" } }, duplicateAccount.auth);
    expect(duplicateNickname.response.status).toBe(409);

    const host = await seatPlayer("/api/rooms", hostAccount);
    const roomCode = host.session.roomCode;
    expect(roomCode).toMatch(/^\d{6}$/);

    const second = await seatPlayer(`/api/rooms/${roomCode}/join`, secondAccount);
    const third = await seatPlayer(`/api/rooms/${roomCode}/join`, thirdAccount);
    const fourth = await seatPlayer(`/api/rooms/${roomCode}/join`, fourthAccount);
    const sessions = [host.session, second.session, third.session, fourth.session];

    const started = await post(`/api/rooms/${roomCode}/start`, { token: host.session.token }, 200, hostAccount.auth);
    expect(started.active).toBe(true);
    expect(started.players[host.session.seat].hand).toHaveLength(13);
    expect(started.players[second.session.seat].hand).toBeUndefined();
    expect(started.players[second.session.seat].cardsLeft).toBeNull();
    expect(started.players[second.session.seat].cardCountVisible).toBe(false);

    const accountLockedProfile = await request("/api/account/profile", {
      profile: { name: "不应绕过", avatar: "😀" }
    }, hostAccount.auth);
    expect(accountLockedProfile.response.status).toBe(409);

    const spectator = await seatPlayer(`/api/rooms/${roomCode}/join`, spectatorAccount);
    expect(spectator.session.role).toBe("spectator");
    expect(spectator.state.isSpectator).toBe(true);
    expect(spectator.state.players.every((player) => player.hand === undefined)).toBe(true);
    expect(spectator.state.players.every((player) => player.cardsLeft === null)).toBe(true);

    const spectatorAction = await request(`/api/rooms/${roomCode}/action`, {
      token: spectator.session.token,
      action: "hint"
    }, spectatorAccount.auth);
    expect(spectatorAction.response.status).toBe(403);

    const lockedProfile = await request(`/api/rooms/${roomCode}/profile`, {
      token: third.session.token,
      profile: { name: "不应修改", avatar: "🐼" }
    }, thirdAccount.auth);
    expect(lockedProfile.response.status).toBe(409);

    const requestedDismissal = await post(`/api/rooms/${roomCode}/action`, {
      token: host.session.token,
      action: "request-dismissal"
    }, 200, hostAccount.auth);
    expect(requestedDismissal.dismissalVote).toEqual(expect.objectContaining({
      requestedBy: host.session.seat,
      canReject: false
    }));

    const guestVoteState = await stateFor(roomCode, second.session.token);
    expect(guestVoteState.dismissalVote).toEqual(expect.objectContaining({ canReject: true }));

    const rejectedDismissal = await post(`/api/rooms/${roomCode}/action`, {
      token: second.session.token,
      action: "reject-dismissal"
    }, 200, secondAccount.auth);
    expect(rejectedDismissal.dismissalVote).toBeNull();
    expect(rejectedDismissal.dismissalNotice.message).toContain("拒绝解散");

    let playable = started;
    for (let attempt = 0; attempt < 3 && playable.phase !== "playing"; attempt += 1) {
      playable = await post(`/api/rooms/${roomCode}/action`, {
        token: host.session.token,
        action: "next-round"
      }, 200, hostAccount.auth);
    }
    expect(playable.phase).toBe("playing");

    const current = sessions[playable.currentPlayer];
    const currentState = await stateFor(roomCode, current.token);
    const cardId = currentState.players[current.seat].hand[0].id;
    const toggled = await post(`/api/rooms/${roomCode}/action`, {
      token: current.token,
      action: "toggle",
      cardId
    }, 200, current.auth);
    expect(toggled.players[current.seat].hand.find((card) => card.id === cardId).selected).toBe(true);

    const reacted = await post(`/api/rooms/${roomCode}/action`, {
      token: second.session.token,
      action: "reaction",
      emoji: "👏",
      label: "漂亮"
    }, 200, secondAccount.auth);
    expect(reacted.reactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: second.session.seat, emoji: "👏" })
    ]));
  });

  it("keeps only the newest five replay records for each account", async () => {
    const username = "historyuser";
    const registered = await post("/api/auth/register", { username, password: "PokerPass123" }, 201);
    const account = env.PLAYER_ACCOUNT.getByName(`account:${username}`);
    const baseTime = Date.now() - 6000;

    for (let index = 0; index < 6; index += 1) {
      const result = await account.recordRound({
        id: `record-${index}`,
        roomCode: "123456",
        roundNumber: index + 1,
        targetScore: 100,
        completedAt: baseTime + index * 1000,
        winnerId: 0,
        players: [
          { seat: 0, accountId: username, name: username, avatar: "😀" },
          { seat: 1, accountId: "other-one", name: "玩家二", avatar: "😺" },
          { seat: 2, accountId: "other-two", name: "玩家三", avatar: "🐼" },
          { seat: 3, accountId: "other-three", name: "玩家四", avatar: "🦊" }
        ],
        initialHands: [[], [], [], []],
        events: [],
        scores: [{ playerId: 0, score: index }]
      });
      expect(result.ok).toBe(true);
    }

    const history = await request("/api/account/history", null, registered.auth);
    expect(history.response.status).toBe(200);
    expect(history.payload.records).toHaveLength(5);
    expect(history.payload.records.map((record) => record.id)).toEqual([
      "record-5",
      "record-4",
      "record-3",
      "record-2",
      "record-1"
    ]);

    const expired = await request("/api/account/history/record-0", null, registered.auth);
    expect(expired.response.status).toBe(404);
    const latest = await request("/api/account/history/record-5", null, registered.auth);
    expect(latest.response.status).toBe(200);
    expect(latest.payload.record.id).toBe("record-5");
  });
});
