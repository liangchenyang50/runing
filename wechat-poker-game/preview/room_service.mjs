import { randomBytes, randomInt } from "node:crypto";

const TARGET_OPTIONS = [100, 200, 500];
const DEFAULT_AVATARS = ["😀", "😺", "🐼", "🦊", "🐸", "🐯", "🐰", "🦁", "🐻", "🐨", "🐵", "🐧"];
const ROOM_CODE_RE = /^\d{6}$/;
const MAX_ROOM_AGE_MS = 1000 * 60 * 60 * 24;
const MAX_AVATAR_DATA_LENGTH = 320000;
const MAX_NAME_LENGTH = 12;

class RoomError extends Error {
  constructor(message, status = 400, code = "room_error") {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.code = code;
  }
}

export function createRoomService({ poker, rules }) {
  const rooms = new Map();

  function createRoom(profileInput) {
    removeExpiredRooms();
    const roomCode = createRoomCode();
    const member = createMember(0, profileInput);
    const room = {
      code: roomCode,
      targetScore: 100,
      players: [member, null, null, null],
      game: null,
      listeners: new Set(),
      reactions: new Map(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    rooms.set(roomCode, room);
    return { room, member };
  }

  function joinRoom(roomCode, profileInput) {
    const room = getRoom(roomCode);
    if (room.game) {
      throw new RoomError("牌局已经开始，不能再加入。", 409, "game_started");
    }
    const seat = room.players.findIndex((player) => player === null);
    if (seat === -1) {
      throw new RoomError("房间已经满员。", 409, "room_full");
    }
    const member = createMember(seat, profileInput);
    room.players[seat] = member;
    touch(room);
    broadcast(room);
    return { room, member };
  }

  function getRoom(roomCode) {
    const code = String(roomCode || "").trim();
    if (!ROOM_CODE_RE.test(code) || !rooms.has(code)) {
      throw new RoomError("房间不存在或已经失效。", 404, "room_not_found");
    }
    return rooms.get(code);
  }

  function getMember(room, token) {
    const member = room.players.find((player) => player && player.token === token);
    if (!member) {
      throw new RoomError("房间身份已失效，请重新加入。", 403, "invalid_session");
    }
    return member;
  }

  function createMember(seat, profileInput) {
    const profile = normalizeProfile(profileInput, seat);
    return {
      seat,
      token: randomBytes(24).toString("hex"),
      name: profile.name,
      avatar: profile.avatar,
      joinedAt: Date.now()
    };
  }

  function createRoomCode() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      if (!rooms.has(code)) {
        return code;
      }
    }
    throw new RoomError("暂时无法分配房间号，请稍后重试。", 503, "room_code_unavailable");
  }

  function removeExpiredRooms() {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.listeners.size === 0 && now - room.updatedAt > MAX_ROOM_AGE_MS) {
        rooms.delete(code);
      }
    }
  }

  function normalizeProfile(profileInput, seat) {
    const source = profileInput && typeof profileInput === "object" ? profileInput : {};
    const fallbackName = `玩家${seat + 1}`;
    const rawName = String(source.name || "").trim().replace(/\s+/g, " ");
    const name = Array.from(rawName || fallbackName).slice(0, MAX_NAME_LENGTH).join("");
    const avatar = sanitizeAvatar(source.avatar, seat);
    return { name, avatar };
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
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(trimmed)) {
      return trimmed.length <= MAX_AVATAR_DATA_LENGTH ? trimmed : fallback;
    }
    return Array.from(trimmed).slice(0, 4).join("") || fallback;
  }

  function startRoom(room, member) {
    ensureHost(member);
    if (!room.players.every(Boolean)) {
      throw new RoomError("需要四名玩家全部入座后才能开始。", 409, "players_needed");
    }
    if (room.game) {
      throw new RoomError("牌局已经开始。", 409, "game_started");
    }
    room.game = poker.createGame({
      targetScore: room.targetScore,
      playerNames: room.players.map((player) => player.name)
    });
    touch(room);
    broadcast(room);
  }

  function setTarget(room, member, score) {
    ensureHost(member);
    if (room.game) {
      throw new RoomError("牌局开始后不能修改目标分。", 409, "target_locked");
    }
    const nextScore = Number(score);
    if (!TARGET_OPTIONS.includes(nextScore)) {
      throw new RoomError("目标分只能选 100、200 或 500。", 400, "invalid_target");
    }
    room.targetScore = nextScore;
    touch(room);
    broadcast(room);
  }

  function updateProfile(room, member, profileInput) {
    const profile = normalizeProfile(profileInput, member.seat);
    member.name = profile.name;
    member.avatar = profile.avatar;
    if (room.game) {
      renameGamePlayer(room.game, member.seat, member.name);
    }
    touch(room);
    broadcast(room);
  }

  function leaveRoom(room, member) {
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
    touch(room);
    if (room.players.some(Boolean)) {
      broadcast(room);
    } else {
      rooms.delete(room.code);
    }
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

  function runAction(room, member, body) {
    const action = body && body.action;
    if (action === "next-round") {
      ensureHost(member);
      advanceRound(room);
      return;
    }
    if (action === "reaction") {
      setReaction(room, member, body.emoji, body.label);
      return;
    }
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
      poker.playSelected(room.game);
    } else if (action === "pass") {
      poker.passTurn(room.game);
    } else {
      throw new RoomError("不支持这个牌桌操作。", 400, "unknown_action");
    }
    if (action === "play" || action === "pass") {
      autoPassUnplayablePlayers(room.game);
    }
    touch(room);
    broadcast(room);
  }

  function autoPassUnplayablePlayers(game) {
    let guard = 0;
    while (game.phase === "playing" && game.trick && game.trick.lastPlay && guard < game.players.length) {
      const player = game.players[game.currentPlayer];
      const moves = rules.findLegalMoves(player.hand, game.trick.lastPlay);
      if (moves.length > 0) {
        break;
      }
      poker.passTurn(game);
      guard += 1;
    }
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
    touch(room);
    broadcast(room);
  }

  function setReaction(room, member, emoji, label) {
    const safeEmoji = Array.from(String(emoji || "")).slice(0, 4).join("");
    if (!safeEmoji) {
      throw new RoomError("请选择一个表情。", 400, "invalid_reaction");
    }
    const safeLabel = Array.from(String(label || "")).slice(0, 12).join("");
    room.reactions.set(member.seat, {
      playerId: member.seat,
      emoji: safeEmoji,
      label: safeLabel,
      expiresAt: Date.now() + 2600
    });
    touch(room);
    broadcast(room);
  }

  function ensureHost(member) {
    if (member.seat !== 0) {
      throw new RoomError("只有房主可以进行这个操作。", 403, "host_required");
    }
  }

  function touch(room) {
    room.updatedAt = Date.now();
  }

  function viewRoom(room, member) {
    removeExpiredReactions(room);
    const game = room.game;
    const players = room.players.map((player, playerId) => presentPlayer(player, game, playerId, member.seat));
    return {
      mode: "room",
      active: Boolean(game),
      roomCode: room.code,
      viewerSeat: member.seat,
      isHost: member.seat === 0,
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
      canStart: member.seat === 0 && !game && room.players.every(Boolean),
      canChangeTarget: member.seat === 0 && !game,
      canContinue: member.seat === 0 && Boolean(game && game.phase !== "playing"),
      turnCount: game ? game.turnCount : 0,
      specialDeal: game ? game.specialDeal : null,
      winnerId: game ? game.winnerId : null,
      reactions: Array.from(room.reactions.values()).map((reaction) => ({
        playerId: reaction.playerId,
        emoji: reaction.emoji,
        label: reaction.label,
        expiresAt: reaction.expiresAt
      }))
    };
  }

  function presentPlayer(member, game, playerId, viewerSeat) {
    if (!member) {
      return {
        id: playerId,
        occupied: false,
        name: "等待玩家",
        avatar: "＋",
        cardsLeft: 0,
        score: 0,
        isHost: playerId === 0
      };
    }
    const gamePlayer = game && game.players[playerId];
    const presented = {
      id: playerId,
      occupied: true,
      name: member.name,
      avatar: member.avatar,
      cardsLeft: gamePlayer ? gamePlayer.hand.length : 0,
      score: gamePlayer ? gamePlayer.score : 0,
      isHost: playerId === 0
    };
    if (gamePlayer && playerId === viewerSeat) {
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
    const visibleActions = currentActions.length > 0 ? currentActions : game.previousTrickActions || [];
    return visibleActions.map((action) => ({
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

  function removeExpiredReactions(room) {
    const now = Date.now();
    for (const [playerId, reaction] of room.reactions) {
      if (reaction.expiresAt <= now) {
        room.reactions.delete(playerId);
      }
    }
  }

  function sessionFor(room, member) {
    return {
      roomCode: room.code,
      token: member.token,
      seat: member.seat
    };
  }

  function broadcast(room) {
    removeExpiredReactions(room);
    for (const listener of room.listeners) {
      const member = room.players.find((player) => player && player.token === listener.token);
      if (!member || listener.res.writableEnded) {
        room.listeners.delete(listener);
        continue;
      }
      try {
        writeStateEvent(listener.res, viewRoom(room, member));
      } catch {
        room.listeners.delete(listener);
      }
    }
  }

  async function handle(req, res, url, transport) {
    const { pathname, searchParams } = url;
    const createMatch = pathname === "/api/rooms";
    const roomMatch = pathname.match(/^\/api\/rooms\/(\d{6})(?:\/(join|state|events|start|target|action|profile|leave))?$/);
    if (!createMatch && !roomMatch) {
      throw new RoomError("接口不存在。", 404, "not_found");
    }

    if (createMatch) {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed" }, 405);
      }
      const body = await transport.readJson(req);
      const { room, member } = createRoom(body.profile);
      return transport.sendJson(res, {
        session: sessionFor(room, member),
        state: viewRoom(room, member)
      }, 201);
    }

    const [, roomCode, actionName] = roomMatch;
    if (actionName === "join") {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed" }, 405);
      }
      const body = await transport.readJson(req);
      const { room, member } = joinRoom(roomCode, body.profile);
      return transport.sendJson(res, {
        session: sessionFor(room, member),
        state: viewRoom(room, member)
      }, 201);
    }

    const body = req.method === "POST" ? await transport.readJson(req) : null;
    const token = searchParams.get("token") || (body && body.token) || "";
    const room = getRoom(roomCode);
    const member = getMember(room, token);

    if (actionName === "events") {
      if (req.method !== "GET") {
        return transport.sendJson(res, { error: "method_not_allowed" }, 405);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders?.();
      const listener = { res, token };
      room.listeners.add(listener);
      writeStateEvent(res, viewRoom(room, member));
      req.on("close", () => {
        room.listeners.delete(listener);
      });
      return;
    }

    if (actionName === "state" || !actionName) {
      if (req.method !== "GET") {
        return transport.sendJson(res, { error: "method_not_allowed" }, 405);
      }
      return transport.sendJson(res, viewRoom(room, member));
    }

    if (req.method !== "POST") {
      return transport.sendJson(res, { error: "method_not_allowed" }, 405);
    }
    if (body.token !== token) {
      throw new RoomError("房间身份校验失败。", 403, "invalid_session");
    }

    if (actionName === "start") {
      startRoom(room, member);
    } else if (actionName === "target") {
      setTarget(room, member, body.score);
    } else if (actionName === "profile") {
      updateProfile(room, member, body.profile);
    } else if (actionName === "action") {
      runAction(room, member, body);
    } else if (actionName === "leave") {
      leaveRoom(room, member);
      return transport.sendJson(res, { left: true });
    }
    return transport.sendJson(res, viewRoom(room, member));
  }

  return {
    handle,
    rooms,
    viewRoom
  };
}

function writeStateEvent(res, state) {
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

export function isRoomError(error) {
  return error instanceof RoomError;
}
