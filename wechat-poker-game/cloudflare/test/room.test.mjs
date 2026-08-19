import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function request(path, body) {
  const response = await exports.default.fetch(new Request(`https://poker.test${path}`, {
    method: body == null ? "GET" : "POST",
    headers: body == null ? undefined : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  }));
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function post(path, body, expectedStatus = 200) {
  const result = await request(path, body);
  expect(result.response.status).toBe(expectedStatus);
  return result.payload;
}

async function stateFor(roomCode, token) {
  const result = await request(`/api/rooms/${roomCode}/state?token=${token}`);
  expect(result.response.status).toBe(200);
  return result.payload;
}

describe("Cloudflare room service", () => {
  it("creates a persistent four-player room while hiding opponents' hands", async () => {
    const host = await post("/api/rooms", { profile: { name: "房主", avatar: "😀" } }, 201);
    const roomCode = host.session.roomCode;
    expect(roomCode).toMatch(/^\d{6}$/);

    const second = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小左", avatar: "🐼" } }, 201);
    const third = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小对", avatar: "🦊" } }, 201);
    const fourth = await post(`/api/rooms/${roomCode}/join`, { profile: { name: "小右", avatar: "🐯" } }, 201);
    const sessions = [host.session, second.session, third.session, fourth.session];

    const started = await post(`/api/rooms/${roomCode}/start`, { token: host.session.token });
    expect(started.active).toBe(true);
    expect(started.players[host.session.seat].hand).toHaveLength(13);
    expect(started.players[second.session.seat].hand).toBeUndefined();
    expect(started.players[second.session.seat].cardsLeft).toBeNull();
    expect(started.players[second.session.seat].cardCountVisible).toBe(false);

    const spectator = await post(`/api/rooms/${roomCode}/join`, {
      profile: { name: "观众", avatar: "/assets/avatars/portrait-1.jpg" }
    }, 201);
    expect(spectator.session.role).toBe("spectator");
    expect(spectator.state.isSpectator).toBe(true);
    expect(spectator.state.players.every((player) => player.hand === undefined)).toBe(true);
    expect(spectator.state.players.every((player) => player.cardsLeft === null)).toBe(true);

    const spectatorAction = await request(`/api/rooms/${roomCode}/action`, {
      token: spectator.session.token,
      action: "hint"
    });
    expect(spectatorAction.response.status).toBe(403);

    const lockedProfile = await request(`/api/rooms/${roomCode}/profile`, {
      token: third.session.token,
      profile: { name: "不应修改", avatar: "🐼" }
    });
    expect(lockedProfile.response.status).toBe(409);

    let playable = started;
    for (let attempt = 0; attempt < 3 && playable.phase !== "playing"; attempt += 1) {
      playable = await post(`/api/rooms/${roomCode}/action`, {
        token: host.session.token,
        action: "next-round"
      });
    }
    expect(playable.phase).toBe("playing");

    const current = sessions[playable.currentPlayer];
    const currentState = await stateFor(roomCode, current.token);
    const cardId = currentState.players[current.seat].hand[0].id;
    const toggled = await post(`/api/rooms/${roomCode}/action`, {
      token: current.token,
      action: "toggle",
      cardId
    });
    expect(toggled.players[current.seat].hand.find((card) => card.id === cardId).selected).toBe(true);

    const reacted = await post(`/api/rooms/${roomCode}/action`, {
      token: second.session.token,
      action: "reaction",
      emoji: "👏",
      label: "漂亮"
    });
    expect(reacted.reactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: second.session.seat, emoji: "👏" })
    ]));
  });
});
