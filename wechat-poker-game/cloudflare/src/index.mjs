import { DurableObject } from "cloudflare:workers";
import * as poker from "./poker_core.mjs";
import * as rules from "./rules.mjs";
import { AccountError, normalizeUsername } from "./account.mjs";

export { NicknameClaim, PlayerAccount } from "./account.mjs";
const TARGET_OPTIONS = [100, 200, 500];
const DEFAULT_AVATARS = ["😀", "😺", "🐼", "🦊", "🐸", "🐯", "🐰", "🦁", "🐻", "🐨", "🐵", "🐧"];
const ROOM_CODE_RE = /^\d{6}$/;
const MAX_ROOM_AGE_MS = 1000 * 60 * 60 * 24;
const MAX_AVATAR_DATA_LENGTH = 320000;
const MAX_NAME_LENGTH = 12;
const FOUR_CARD_ALERT_MS = 4500;
const DISMISSAL_VOTE_MS = 1000 * 60 * 2;
const DISMISSAL_NOTICE_MS = 4500;
const AVATAR_ASSET_RE = /^\/assets\/avatars\/portrait-[1-4]\.jpg$/;
const MAX_SPECTATORS = 24;

class RoomError extends Error {
  constructor(message, status = 400, code = "room_error") {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/runtime-config.js") {
        return new Response(
          'window.__POKER_RUNTIME__ = Object.freeze({ transport: "websocket", supportsSolo: false, localDebug: false });\n',
          {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-store"
            }
          }
        );
      }
      if (url.pathname.startsWith("/api/auth") || url.pathname.startsWith("/api/account")) {
        return await handleAccountRequest(request, env, url);
      }
      if (url.pathname.startsWith("/api/rooms")) {
        return await handleRoomRequest(request, env, url);
      }
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "not_found", message: "接口不存在。" }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "worker_request_failed", message: errorMessage(error) }));
      const details = errorDetails(error);
      return json({ error: details.code, message: details.message }, details.status);
    }
  }
};

export class PokerRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.room = null;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.room = await this.ctx.storage.get("room") || null;
    });
  }

  async initialize(code, account) {
    return this.asResult(async () => {
      if (this.room) {
        throw new RoomError("房间号已被占用。", 409, "room_exists");
      }
      const member = createMember(0, account);
      const now = Date.now();
      this.room = {
        code,
        targetScore: 100,
        players: [member, null, null, null],
        spectators: [],
        game: null,
        reactions: [],
        fourCardAlerts: [],
        fourCardWarnedSeats: [],
        dismissalVote: null,
        dismissalNotice: null,
        replayRound: null,
        replayRoundNumber: 0,
        createdAt: now,
        updatedAt: now
      };
      await this.persist();
      return {
        session: sessionFor(this.room, member),
        state: this.viewRoom(member)
      };
    });
  }

  async join(account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const seat = room.players.findIndex((player) => player === null);
      if (room.game || seat === -1) {
        room.spectators = room.spectators || [];
        if (room.spectators.length >= MAX_SPECTATORS) {
          throw new RoomError("观战席已满，请稍后再试。", 409, "spectator_full");
        }
        const spectator = createSpectator(account);
        room.spectators.push(spectator);
        await this.commit();
        this.broadcast();
        return {
          session: sessionFor(room, spectator),
          state: this.viewRoom(spectator)
        };
      }
      const member = createMember(seat, account);
      room.players[seat] = member;
      await this.commit();
      this.broadcast();
      return {
        session: sessionFor(room, member),
        state: this.viewRoom(member)
      };
    });
  }

  async getState(token) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      return this.viewRoom(member);
    });
  }

  async start(token, account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      ensureMemberAccount(member, account);
      ensureHost(member);
      if (!room.players.every(Boolean)) {
        throw new RoomError("需要四名玩家全部入座后才能开始。", 409, "players_needed");
      }
      if (room.game) {
        throw new RoomError("牌局已经开始。", 409, "game_started");
      }
      await this.lockRoomProfiles(room);
      room.game = poker.createGame({
        targetScore: room.targetScore,
        playerNames: room.players.map((player) => player.name)
      });
      startReplayRound(room);
      resetFourCardWarnings(room);
      await this.commit();
      await this.storeCompletedReplayRound();
      this.broadcast();
      return this.viewRoom(member);
    });
  }

  async setTarget(token, score, account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      ensureMemberAccount(member, account);
      ensureHost(member);
      if (room.game) {
        throw new RoomError("牌局开始后不能修改目标分。", 409, "target_locked");
      }
      const nextScore = Number(score);
      if (!TARGET_OPTIONS.includes(nextScore)) {
        throw new RoomError("目标分只能选 100、200 或 500。", 400, "invalid_target");
      }
      room.targetScore = nextScore;
      await this.commit();
      this.broadcast();
      return this.viewRoom(member);
    });
  }

  async updateProfile(token, profileInput, account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      ensureMemberAccount(member, account);
      if (room.game) {
        throw new RoomError("牌局开始后不能更改昵称或头像。", 409, "profile_locked");
      }
      const profile = normalizeProfile(profileInput, member.seat);
      const result = await this.env.PLAYER_ACCOUNT
        .getByName(`account:${member.accountId}`)
        .updateProfileFromRoom(profile);
      if (!result.ok) {
        throw new RoomError(result.error.message || "账号资料同步失败。", result.error.status || 500, result.error.code || "account_sync_failed");
      }
      member.name = profile.name;
      member.avatar = profile.avatar;
      await this.commit();
      this.broadcast();
      return this.viewRoom(member);
    });
  }

  async action(token, body, account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      ensureMemberAccount(member, account);
      if (member.role === "spectator") {
        throw new RoomError("观战中不能操作牌局。", 403, "spectator_readonly");
      }
      const action = body && body.action;
      if (action === "next-round") {
        ensureHost(member);
        advanceRound(room);
      } else if (action === "request-dismissal") {
        requestDismissal(room, member);
      } else if (action === "reject-dismissal") {
        rejectDismissal(room, member);
      } else if (action === "reaction") {
        setReaction(room, member, body.emoji, body.label);
      } else {
        runGameAction(room, member, body);
      }
      await this.commit();
      await this.storeCompletedReplayRound();
      this.broadcast();
      return this.viewRoom(member);
    });
  }

  async leave(token, account) {
    return this.asResult(async () => {
      const room = await this.requireActiveRoom();
      const member = getMember(room, token);
      ensureMemberAccount(member, account);
      if (member.role === "spectator") {
        room.spectators = (room.spectators || []).filter((spectator) => spectator.token !== member.token);
        await this.commit();
        this.broadcast();
        return { left: true };
      }
      if (room.game) {
        throw new RoomError("牌局开始后不能离开房间。", 409, "leave_locked");
      }
      const leavingSeat = member.seat;
      room.players[leavingSeat] = null;
      if (leavingSeat === 0) {
        const nextHostSeat = room.players.findIndex((player) => player);
        if (nextHostSeat !== -1) {
          const nextHost = room.players[nextHostSeat];
          room.players[0] = nextHost;
          room.players[nextHostSeat] = null;
          nextHost.seat = 0;
        }
      }
      if (room.players.some(Boolean)) {
        await this.commit();
        this.broadcast();
      } else {
        this.room = null;
        await this.ctx.storage.delete("room");
        await this.ctx.storage.deleteAlarm();
        this.closeSockets(1000, "房间已关闭");
      }
      return { left: true };
    });
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "upgrade_required", message: "请使用 WebSocket 连接房间。" }, 426);
    }
    try {
      const room = await this.requireActiveRoom();
      const token = new URL(request.url).searchParams.get("token") || "";
      const member = getMember(room, token);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ token });
      this.sendState(server, member);
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      const details = errorDetails(error);
      return json({ error: details.code, message: details.message }, details.status);
    }
  }

  async webSocketMessage(socket) {
    await this.ready;
    if (!this.room) {
      socket.close(1008, "房间已失效");
      return;
    }
    if (hasExpiredDismissalVote(this.room)) {
      await this.dissolveRoom("解散投票期间无人拒绝，房间已解散。");
      return;
    }
    const member = memberForSocket(this.room, socket);
    if (!member) {
      socket.close(1008, "房间身份已失效");
      return;
    }
    this.sendState(socket, member);
  }

  async webSocketClose() {
    // Hibernatable WebSockets are removed from ctx.getWebSockets automatically.
  }

  async alarm() {
    await this.ready;
    if (!this.room) {
      return;
    }
    if (hasExpiredDismissalVote(this.room)) {
      await this.dissolveRoom("解散投票期间无人拒绝，房间已解散。");
      return;
    }
    if (Date.now() - this.room.updatedAt < MAX_ROOM_AGE_MS) {
      await this.scheduleAlarm();
      return;
    }
    if (this.ctx.getWebSockets().length > 0) {
      this.room.updatedAt = Date.now();
      await this.persist();
      return;
    }
    this.room = null;
    await this.ctx.storage.delete("room");
  }

  async asResult(callback) {
    try {
      await this.ready;
      return { ok: true, data: await callback() };
    } catch (error) {
      return { ok: false, error: errorDetails(error) };
    }
  }

  requireRoom() {
    if (!this.room || !ROOM_CODE_RE.test(this.room.code)) {
      throw new RoomError("房间不存在或已经失效。", 404, "room_not_found");
    }
    return this.room;
  }

  async requireActiveRoom() {
    const room = this.requireRoom();
    if (hasExpiredDismissalVote(room)) {
      await this.dissolveRoom("解散投票期间无人拒绝，房间已解散。");
      throw new RoomError("房间已解散。", 410, "room_dissolved");
    }
    return room;
  }

  async commit() {
    removeExpiredFourCardAlerts(this.room);
    removeExpiredDismissalNotice(this.room);
    this.room.updatedAt = Date.now();
    await this.persist();
  }

  async persist() {
    if (this.room && this.room.game) {
      delete this.room.game.rng;
    }
    await this.ctx.storage.put("room", this.room);
    await this.scheduleAlarm();
  }

  async storeCompletedReplayRound() {
    const room = this.room;
    const replayRound = room && room.replayRound;
    if (!room || !replayRound || replayRound.recordStored || !replayRound.completedAt) {
      return;
    }
    const record = buildReplayRecord(room, replayRound);
    const results = await Promise.all(room.players
      .filter(Boolean)
      .map(async (player) => this.env.PLAYER_ACCOUNT
        .getByName(`account:${player.accountId}`)
        .recordRound(record)));
    const failed = results.find((result) => !result.ok);
    if (failed) {
      throw new RoomError(failed.error.message || "战绩保存失败。", failed.error.status || 500, failed.error.code || "record_failed");
    }
    replayRound.recordStored = true;
    await this.persist();
  }

  async lockRoomProfiles(room) {
    const results = await Promise.all(room.players.map(async (player) => {
      const result = await this.env.PLAYER_ACCOUNT
        .getByName(`account:${player.accountId}`)
        .lockProfileFromRoom(room.code);
      return result;
    }));
    const failed = results.find((result) => !result || !result.ok);
    if (failed) {
      throw new RoomError(
        failed && failed.error && failed.error.message || "无法锁定玩家资料，请稍后重试。",
        failed && failed.error && failed.error.status || 409,
        failed && failed.error && failed.error.code || "profile_locked"
      );
    }
  }

  async scheduleAlarm() {
    if (!this.room) {
      return;
    }
    const roomExpiry = this.room.updatedAt + MAX_ROOM_AGE_MS;
    const voteExpiry = this.room.dismissalVote && this.room.dismissalVote.expiresAt > Date.now()
      ? this.room.dismissalVote.expiresAt
      : null;
    await this.ctx.storage.setAlarm(voteExpiry == null ? roomExpiry : Math.min(roomExpiry, voteExpiry));
  }

  async dissolveRoom(message) {
    const room = this.room;
    if (!room) {
      return;
    }
    room.dismissalVote = null;
    room.dismissalNotice = {
      message,
      expiresAt: Date.now() + DISMISSAL_NOTICE_MS
    };
    room.roomClosed = true;
    room.roomCloseMessage = message;
    this.broadcast();
    this.closeSockets(1000, "房间已解散");
    this.room = null;
    await this.ctx.storage.delete("room");
    await this.ctx.storage.deleteAlarm();
  }

  viewRoom(member) {
    const room = this.requireRoom();
    const game = room.game;
    const isSpectator = member.role === "spectator";
    const viewerSeat = isSpectator ? null : member.seat;
    const players = room.players.map((player, playerId) => presentPlayer(player, game, playerId, viewerSeat, isSpectator));
    return {
      mode: "room",
      active: Boolean(game),
      roomCode: room.code,
      viewerSeat,
      isSpectator,
      isHost: !isSpectator && member.seat === 0,
      targetScore: room.targetScore,
      selectedTargetScore: room.targetScore,
      targetOptions: TARGET_OPTIONS,
      players,
      playerCount: room.players.filter(Boolean).length,
      phase: game ? game.phase : "lobby",
      myTurn: Boolean(game && game.phase === "playing" && game.currentPlayer === member.seat),
      currentPlayer: game ? game.currentPlayer : null,
      message: game ? game.message : "等待四名玩家入座。",
      lastPlayText: game ? formatLastPlayText(game) : "等待开局",
      lastPlay: game ? formatLastPlay(game.trick && game.trick.lastPlay) : null,
      tableActions: game ? formatTableActions(game) : [],
      roundResult: game ? game.roundResult || [] : [],
      finalSettlement: game ? formatSettlement(game.finalSettlement) : null,
      resetLabel: game && game.phase === "finished" ? "下一轮" : "新游戏",
      canStart: !isSpectator && member.seat === 0 && !game && room.players.every(Boolean),
      canChangeTarget: !isSpectator && member.seat === 0 && !game,
      canContinue: !isSpectator && member.seat === 0 && Boolean(game && game.phase !== "playing"),
      turnCount: game ? game.turnCount : 0,
      specialDeal: game ? game.specialDeal : null,
      winnerId: game ? game.winnerId : null,
      roomClosed: room.roomClosed === true,
      roomCloseMessage: room.roomCloseMessage || "",
      dismissalVote: presentDismissalVote(room, member),
      dismissalNotice: room.dismissalNotice && room.dismissalNotice.expiresAt > Date.now()
        ? { ...room.dismissalNotice }
        : null,
      spectatorCount: (room.spectators || []).length,
      spectators: (room.spectators || []).map((spectator) => ({
        name: spectator.name,
        avatar: spectator.avatar,
        isMe: spectator.token === member.token
      })),
      reactions: isSpectator ? [] : (room.reactions || [])
        .filter((reaction) => reaction.expiresAt > Date.now())
        .map((reaction) => ({ ...reaction })),
      alerts: isSpectator ? [] : (room.fourCardAlerts || [])
        .filter((alert) => alert.expiresAt > Date.now() && alert.playerId !== member.seat)
        .map((alert) => ({ ...alert }))
    };
  }

  sendState(socket, member) {
    socket.send(JSON.stringify({ type: "state", state: this.viewRoom(member) }));
  }

  broadcast() {
    if (!this.room) {
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const member = memberForSocket(this.room, socket);
      if (!member) {
        socket.close(1008, "房间身份已失效");
        continue;
      }
      try {
        this.sendState(socket, member);
      } catch {
        socket.close(1011, "房间同步失败");
      }
    }
  }

  closeSockets(code, reason) {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(code, reason);
    }
  }
}

async function handleAccountRequest(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/auth/register") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const account = env.PLAYER_ACCOUNT.getByName(`account:${username}`);
    return rpcResponse(await account.register({ username, password: body.password }), 201);
  }

  if (pathname === "/api/auth/login") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const account = env.PLAYER_ACCOUNT.getByName(`account:${username}`);
    return rpcResponse(await account.login({ username, password: body.password }));
  }

  const authenticated = await requireAuthenticatedAccount(request, env);
  const account = env.PLAYER_ACCOUNT.getByName(`account:${authenticated.auth.username}`);

  if (pathname === "/api/auth/me") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return json({ account: authenticated.account });
  }

  if (pathname === "/api/auth/logout") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    return rpcResponse(await account.logout(authenticated.auth.token));
  }

  if (pathname === "/api/account/profile") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const body = await readJson(request);
    return rpcResponse(await account.updateProfile(authenticated.auth.token, body.profile));
  }

  if (pathname === "/api/account/history") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return rpcResponse(await account.getHistory(authenticated.auth.token));
  }

  const replayMatch = pathname.match(/^\/api\/account\/history\/([a-zA-Z0-9_-]+)$/);
  if (replayMatch) {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return rpcResponse(await account.getReplay(authenticated.auth.token, replayMatch[1]));
  }

  return json({ error: "not_found", message: "接口不存在。" }, 404);
}

async function requireAuthenticatedAccount(request, env) {
  const authorization = String(request.headers.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+([^:\s]+):([^\s]+)$/i);
  if (!match) {
    throw new RoomError("请先登录账号。", 401, "auth_required");
  }
  const username = normalizeUsername(match[1]);
  const account = env.PLAYER_ACCOUNT.getByName(`account:${username}`);
  const result = await account.authenticate(match[2]);
  if (!result.ok) {
    throw new RoomError(result.error.message || "登录已失效，请重新登录。", result.error.status || 401, result.error.code || "auth_required");
  }
  return result.data;
}

async function handleRoomRequest(request, env, url) {
  if (url.pathname === "/api/rooms") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const account = await requireAuthenticatedAccount(request, env);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const roomCode = createRoomCode();
      const stub = env.POKER_ROOM.getByName(`room:${roomCode}`);
      const result = await stub.initialize(roomCode, account.account);
      if (result.ok || result.error.code !== "room_exists") {
        return rpcResponse(result, 201);
      }
    }
    return json({ error: "room_code_unavailable", message: "暂时无法分配房间号，请稍后重试。" }, 503);
  }

  const match = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/(join|state|ws|start|target|action|profile|leave))?$/);
  if (!match) {
    return json({ error: "not_found", message: "接口不存在。" }, 404);
  }
  const [, roomCode, actionName] = match;
  const stub = env.POKER_ROOM.getByName(`room:${roomCode}`);
  if (actionName === "ws") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return stub.fetch(request);
  }
  if (actionName === "join") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.join(account.account), 201);
  }
  if (!actionName || actionName === "state") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return rpcResponse(await stub.getState(url.searchParams.get("token") || ""));
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const body = await readJson(request);
  const token = url.searchParams.get("token") || body.token || "";
  if (url.searchParams.has("token") && body.token && body.token !== token) {
    return json({ error: "invalid_session", message: "房间身份校验失败。" }, 403);
  }
  if (actionName === "start") {
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.start(token, account.account));
  }
  if (actionName === "target") {
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.setTarget(token, body.score, account.account));
  }
  if (actionName === "action") {
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.action(token, body, account.account));
  }
  if (actionName === "profile") {
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.updateProfile(token, body.profile, account.account));
  }
  if (actionName === "leave") {
    const account = await requireAuthenticatedAccount(request, env);
    return rpcResponse(await stub.leave(token, account.account));
  }
  return json({ error: "not_found", message: "接口不存在。" }, 404);
}

function runGameAction(room, member, body) {
  if (member.role === "spectator") {
    throw new RoomError("观战中不能操作牌局。", 403, "spectator_readonly");
  }
  const action = body && body.action;
  if (!room.game || room.game.phase !== "playing") {
    throw new RoomError("牌局尚未开始或本局已经结束。", 409, "game_not_playing");
  }
  if (room.game.currentPlayer !== member.seat) {
    throw new RoomError("还没轮到你出牌。", 409, "not_your_turn");
  }
  if (action === "toggle") {
    poker.toggleCardSelection(room.game, member.seat, body.cardId);
  } else if (action === "hint") {
    selectHint(room.game, member.seat);
  } else if (action === "play") {
    const discardCount = room.game.discardPile.length;
    const cardsBeforePlay = room.game.players[member.seat].hand.length;
    poker.playSelected(room.game);
    recordFourCardWarning(room, member.seat, cardsBeforePlay);
    captureReplayDiscards(room, discardCount);
  } else if (action === "pass") {
    const discardCount = room.game.discardPile.length;
    poker.passTurn(room.game);
    captureReplayDiscards(room, discardCount);
  } else {
    throw new RoomError("不支持这个牌桌操作。", 400, "unknown_action");
  }
  if (action === "play" || action === "pass") {
    autoPassUnplayablePlayers(room);
  }
}

function advanceRound(room) {
  if (!room.game || (room.game.phase !== "finished" && room.game.phase !== "gameOver")) {
    throw new RoomError("当前不能开始下一轮。", 409, "round_not_finished");
  }
  room.game = room.game.phase === "gameOver"
    ? poker.createGame({
      targetScore: room.targetScore,
      playerNames: room.players.map((player) => player.name)
    })
    : poker.createNextRound(room.game);
  startReplayRound(room);
  resetFourCardWarnings(room);
}

function autoPassUnplayablePlayers(room) {
  const game = room.game;
  let guard = 0;
  while (game.phase === "playing" && game.trick && game.trick.lastPlay && guard < game.players.length) {
    const player = game.players[game.currentPlayer];
    const moves = rules.findLegalMoves(player.hand, game.trick.lastPlay);
    if (moves.length > 0) {
      break;
    }
    const discardCount = game.discardPile.length;
    poker.passTurn(game);
    captureReplayDiscards(room, discardCount);
    guard += 1;
  }
}

function startReplayRound(room) {
  const game = room && room.game;
  if (!game) {
    return;
  }
  const roundNumber = Number(room.replayRoundNumber || 0) + 1;
  room.replayRoundNumber = roundNumber;
  room.replayRound = {
    id: createToken(),
    roomCode: room.code,
    roundNumber,
    targetScore: game.targetScore,
    startedAt: Date.now(),
    completedAt: null,
    recordStored: false,
    winnerId: null,
    players: room.players.map((player) => ({
      seat: player.seat,
      accountId: player.accountId,
      name: player.name,
      avatar: replayAvatar(player.avatar)
    })),
    initialHands: game.players.map((player) => player.hand.map(copyReplayCard)),
    events: [],
    scores: [],
    roundResult: [],
    finalSettlement: null
  };
  finishReplayRound(room);
}

function captureReplayDiscards(room, previousDiscardCount) {
  const game = room && room.game;
  const replayRound = room && room.replayRound;
  if (!game || !replayRound || !Array.isArray(game.discardPile)) {
    return;
  }
  const start = Math.max(0, Number(previousDiscardCount) || 0);
  for (let index = start; index < game.discardPile.length; index += 1) {
    const discard = game.discardPile[index];
    if (!discard) {
      continue;
    }
    const isPass = !discard.cards || discard.cards.length === 0;
    replayRound.events.push({
      step: replayRound.events.length + 1,
      playerId: discard.playerId,
      playerName: discard.playerName,
      kind: isPass ? "pass" : "play",
      label: isPass ? "要不起" : discard.label,
      cards: (discard.cards || []).map(copyReplayCard),
      currentPlayer: game.currentPlayer,
      turnCount: game.turnCount,
      occurredAt: Date.now()
    });
  }
  finishReplayRound(room);
}

function finishReplayRound(room) {
  const game = room && room.game;
  const replayRound = room && room.replayRound;
  if (!game || !replayRound || replayRound.completedAt || game.phase === "playing") {
    return;
  }
  replayRound.completedAt = Date.now();
  replayRound.winnerId = game.winnerId;
  replayRound.scores = game.players.map((player) => ({ playerId: player.id, score: player.score || 0 }));
  replayRound.roundResult = cloneReplayValue(game.roundResult || []);
  replayRound.finalSettlement = cloneReplayValue(game.finalSettlement || null);
}

function buildReplayRecord(room, replayRound) {
  return {
    id: replayRound.id,
    roomCode: room.code,
    roundNumber: replayRound.roundNumber,
    targetScore: replayRound.targetScore,
    startedAt: replayRound.startedAt,
    completedAt: replayRound.completedAt,
    winnerId: replayRound.winnerId,
    players: cloneReplayValue(replayRound.players),
    initialHands: cloneReplayValue(replayRound.initialHands),
    events: cloneReplayValue(replayRound.events),
    scores: cloneReplayValue(replayRound.scores),
    roundResult: cloneReplayValue(replayRound.roundResult),
    finalSettlement: cloneReplayValue(replayRound.finalSettlement)
  };
}

function copyReplayCard(card) {
  return {
    id: card.id,
    suit: card.suit,
    rank: card.rank,
    color: card.color,
    rankValue: card.rankValue,
    suitValue: card.suitValue
  };
}

function replayAvatar(avatar) {
  return typeof avatar === "string" && avatar.startsWith("data:image/") ? "😀" : avatar;
}

function cloneReplayValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectHint(game, playerId) {
  const player = game.players[playerId];
  const lastPlay = game.trick && game.trick.lastPlay ? game.trick.lastPlay : null;
  const moves = rules.findLegalMoves(player.hand, lastPlay);
  poker.clearSelection(game);
  if (moves.length === 0) {
    game.message = "没有能接上的牌，可以选择过牌。";
    return;
  }
  const move = moves[0];
  poker.selectCardIds(game, playerId, move.cards.map((card) => card.id));
  game.message = `已为${player.name}选中最小可出的${move.combo.label}。`;
}

function setReaction(room, member, emoji, label) {
  const safeEmoji = Array.from(String(emoji || "")).slice(0, 4).join("");
  if (!safeEmoji) {
    throw new RoomError("请选择一个表情。", 400, "invalid_reaction");
  }
  const safeLabel = Array.from(String(label || "")).slice(0, 12).join("");
  const reaction = {
    playerId: member.seat,
    emoji: safeEmoji,
    label: safeLabel,
    expiresAt: Date.now() + 2600
  };
  const index = room.reactions.findIndex((item) => item.playerId === member.seat);
  if (index === -1) {
    room.reactions.push(reaction);
  } else {
    room.reactions[index] = reaction;
  }
}

function requestDismissal(room, member) {
  if (!room.game) {
    throw new RoomError("牌局开始后才能申请解散。", 409, "game_not_started");
  }
  if (room.dismissalVote) {
    throw new RoomError("已有解散申请正在等待处理。", 409, "dismissal_pending");
  }
  const requestedAt = Date.now();
  room.dismissalNotice = null;
  room.dismissalVote = {
    requestedBy: member.seat,
    requesterName: member.name,
    requestedAt,
    expiresAt: requestedAt + DISMISSAL_VOTE_MS
  };
}

function rejectDismissal(room, member) {
  const vote = room.dismissalVote;
  if (!vote) {
    throw new RoomError("当前没有待处理的解散申请。", 409, "dismissal_not_pending");
  }
  if (vote.requestedBy === member.seat) {
    throw new RoomError("发起人不能拒绝自己的解散申请。", 409, "dismissal_requester_cannot_reject");
  }
  room.dismissalVote = null;
  room.dismissalNotice = {
    message: `${member.name} 已拒绝解散，游戏继续。`,
    expiresAt: Date.now() + DISMISSAL_NOTICE_MS
  };
}

function resetFourCardWarnings(room) {
  room.fourCardAlerts = [];
  room.fourCardWarnedSeats = [];
}

function recordFourCardWarning(room, playerId, cardsBeforePlay) {
  const gamePlayer = room.game && room.game.players[playerId];
  if (!gamePlayer || room.game.phase !== "playing" || cardsBeforePlay <= 4) {
    return;
  }
  const warnedSeats = Array.isArray(room.fourCardWarnedSeats)
    ? room.fourCardWarnedSeats
    : (room.fourCardWarnedSeats = []);
  const cardsLeft = gamePlayer.hand.length;
  if (cardsLeft > 4 || warnedSeats.includes(playerId)) {
    return;
  }
  warnedSeats.push(playerId);
  room.fourCardAlerts = room.fourCardAlerts || [];
  room.fourCardAlerts.push({
    playerId,
    playerName: room.players[playerId].name,
    cardsLeft,
    expiresAt: Date.now() + FOUR_CARD_ALERT_MS
  });
}

function removeExpiredFourCardAlerts(room) {
  if (!room) {
    return;
  }
  const now = Date.now();
  room.fourCardAlerts = (room.fourCardAlerts || []).filter((alert) => alert.expiresAt > now);
}

function removeExpiredDismissalNotice(room) {
  if (room && room.dismissalNotice && room.dismissalNotice.expiresAt <= Date.now()) {
    room.dismissalNotice = null;
  }
}

function hasExpiredDismissalVote(room) {
  return Boolean(room && room.dismissalVote && room.dismissalVote.expiresAt <= Date.now());
}

function presentDismissalVote(room, member) {
  const vote = room && room.dismissalVote;
  if (!vote || vote.expiresAt <= Date.now()) {
    return null;
  }
  return {
    requesterName: vote.requesterName,
    requestedBy: vote.requestedBy,
    requestedAt: vote.requestedAt,
    expiresAt: vote.expiresAt,
    isRequester: member.role === "player" && member.seat === vote.requestedBy,
    canReject: member.role === "player" && member.seat !== vote.requestedBy
  };
}

function createMember(seat, account) {
  const profile = normalizeProfile(account && account.profile, seat);
  return {
    role: "player",
    seat,
    token: createToken(),
    accountId: String(account && account.username || ""),
    name: profile.name,
    avatar: profile.avatar,
    joinedAt: Date.now()
  };
}

function createSpectator(account) {
  const profile = normalizeProfile(account && account.profile, 0);
  return {
    role: "spectator",
    seat: null,
    token: createToken(),
    accountId: String(account && account.username || ""),
    name: profile.name,
    avatar: profile.avatar,
    joinedAt: Date.now()
  };
}

function normalizeProfile(profileInput, seat) {
  const source = profileInput && typeof profileInput === "object" ? profileInput : {};
  const fallbackName = `玩家${seat + 1}`;
  const rawName = String(source.name || "").trim().replace(/\s+/g, " ");
  return {
    name: Array.from(rawName || fallbackName).slice(0, MAX_NAME_LENGTH).join(""),
    avatar: sanitizeAvatar(source.avatar, seat)
  };
}

function sanitizeAvatar(value, seat) {
  const fallback = DEFAULT_AVATARS[seat % DEFAULT_AVATARS.length];
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (AVATAR_ASSET_RE.test(trimmed)) {
    return trimmed;
  }
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(trimmed)) {
    return trimmed.length <= MAX_AVATAR_DATA_LENGTH ? trimmed : fallback;
  }
  return Array.from(trimmed).slice(0, 4).join("") || fallback;
}

function getMember(room, token) {
  const member = room.players.find((player) => player && player.token === token)
    || (room.spectators || []).find((spectator) => spectator.token === token);
  if (!member) {
    throw new RoomError("房间身份已失效，请重新加入。", 403, "invalid_session");
  }
  return member;
}

function ensureMemberAccount(member, account) {
  if (!member || !account || !member.accountId || member.accountId !== account.username) {
    throw new RoomError("当前账号与房间身份不一致。", 403, "room_account_mismatch");
  }
}

function memberForSocket(room, socket) {
  const attachment = socket.deserializeAttachment();
  const token = attachment && typeof attachment.token === "string" ? attachment.token : "";
  return room.players.find((player) => player && player.token === token)
    || (room.spectators || []).find((spectator) => spectator.token === token)
    || null;
}

function ensureHost(member) {
  if (member.role === "spectator" || member.seat !== 0) {
    throw new RoomError("只有房主可以进行这个操作。", 403, "host_required");
  }
}

function sessionFor(room, member) {
  return { roomCode: room.code, token: member.token, seat: member.seat, role: member.role };
}

function presentPlayer(member, game, playerId, viewerSeat, isSpectator) {
  if (!member) {
    return {
      id: playerId,
      occupied: false,
      name: "等待玩家",
      avatar: "＋",
      cardsLeft: null,
      cardCountVisible: false,
      score: 0,
      isHost: playerId === 0
    };
  }
  const gamePlayer = game && game.players[playerId];
  const cardCountVisible = Boolean(!isSpectator && gamePlayer && (playerId === viewerSeat || gamePlayer.hand.length <= 4));
  const presented = {
    id: playerId,
    occupied: true,
    name: member.name,
    avatar: member.avatar,
    cardsLeft: cardCountVisible ? gamePlayer.hand.length : null,
    cardCountVisible,
    score: gamePlayer ? gamePlayer.score : 0,
    isHost: playerId === 0
  };
  if (!isSpectator && gamePlayer && playerId === viewerSeat) {
    presented.hand = gamePlayer.hand;
  }
  return presented;
}

function formatLastPlayText(game) {
  const last = game.discardPile[game.discardPile.length - 1];
  return last ? `${last.playerName}：${last.label}` : "等待出牌";
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

function formatTableActions(game) {
  const currentActions = game.trick && Array.isArray(game.trick.actions) ? game.trick.actions : [];
  const latestByPlayer = new Map();
  for (const action of currentActions) {
    latestByPlayer.set(action.playerId, action);
  }
  return Array.from(latestByPlayer.values()).map((action) => ({
    playerId: action.playerId,
    playerName: action.playerName,
    kind: action.kind,
    label: action.label,
    cards: action.cards
  }));
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

function renameGamePlayer(game, playerId, name) {
  const player = game.players[playerId];
  if (!player) {
    return;
  }
  player.name = name;
  updateNamedEntries(game.discardPile, playerId, name, "playerId", "playerName");
  if (game.trick) {
    if (game.trick.lastPlay && game.trick.lastPlay.playerId === playerId) {
      game.trick.lastPlay.playerName = name;
    }
    updateNamedEntries(game.trick.actions, playerId, name, "playerId", "playerName");
  }
  updateNamedEntries(game.previousTrickActions, playerId, name, "playerId", "playerName");
  updateNamedEntries(game.roundResult, playerId, name, "playerId", "playerName");
  if (game.finalSettlement) {
    updateNamedEntries(game.finalSettlement.net, playerId, name, "playerId", "playerName");
    for (const entry of game.finalSettlement.entries || []) {
      if (entry.fromPlayerId === playerId) {
        entry.fromPlayerName = name;
      }
      if (entry.toPlayerId === playerId) {
        entry.toPlayerName = name;
      }
    }
  }
}

function updateNamedEntries(entries, playerId, name, idKey, nameKey) {
  for (const entry of entries || []) {
    if (entry && entry[idKey] === playerId) {
      entry[nameKey] = name;
    }
  }
}

function createRoomCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(100000 + values[0] % 900000);
}

function createToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  try {
    const payload = await request.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    throw new RoomError("请求数据格式不正确。", 400, "invalid_json");
  }
}

function rpcResponse(result, successStatus = 200) {
  if (!result.ok) {
    return json({ error: result.error.code, message: result.error.message }, result.error.status);
  }
  return json(result.data, successStatus);
}

function methodNotAllowed() {
  return json({ error: "method_not_allowed", message: "请求方法不支持。" }, 405);
}

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function errorDetails(error) {
  if (error instanceof RoomError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof AccountError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: "room_error", message: errorMessage(error) || "房间服务暂时不可用。", status: 500 };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "");
}
