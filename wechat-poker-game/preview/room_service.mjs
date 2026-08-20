import { randomBytes, randomInt } from "node:crypto";

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

export function createRoomService({ poker, rules, accountService, dismissalVoteMs = DISMISSAL_VOTE_MS, dismissalNoticeMs = DISMISSAL_NOTICE_MS }) {
  const rooms = new Map();
  const dismissalTimers = new Map();

  function createRoom(account) {
    removeExpiredRooms();
    const roomCode = createRoomCode();
    const member = createMember(0, account);
    const room = {
      code: roomCode,
      targetScore: 100,
      players: [member, null, null, null],
      spectators: new Map(),
      game: null,
      listeners: new Set(),
      reactions: new Map(),
      fourCardAlerts: [],
      fourCardWarnedSeats: new Set(),
      dismissalVote: null,
      dismissalNotice: null,
      replayRound: null,
      replayRoundNumber: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    rooms.set(roomCode, room);
    return { room, member };
  }

  function joinRoom(roomCode, account) {
    const room = getRoom(roomCode);
    const seat = room.players.findIndex((player) => player === null);
    if (room.game || seat === -1) {
      if (room.spectators.size >= MAX_SPECTATORS) {
        throw new RoomError("观战席已满，请稍后再试。", 409, "spectator_full");
      }
      const spectator = createSpectator(account);
      room.spectators.set(spectator.token, spectator);
      touch(room);
      broadcast(room);
      return { room, member: spectator };
    }
    const member = createMember(seat, account);
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
    const room = rooms.get(code);
    if (hasExpiredDismissalVote(room)) {
      dissolveRoom(room, "解散投票期间无人拒绝，房间已解散。");
      throw new RoomError("房间已解散。", 410, "room_dissolved");
    }
    return room;
  }

  function getMember(room, token) {
    const member = room.players.find((player) => player && player.token === token)
      || room.spectators.get(token);
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

  function createMember(seat, account) {
    const profile = normalizeProfile(account && account.profile, seat);
    return {
      role: "player",
      seat,
      token: randomBytes(24).toString("hex"),
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
      token: randomBytes(24).toString("hex"),
      accountId: String(account && account.username || ""),
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

  function lockRoomProfiles(room) {
    if (!accountService) {
      return;
    }
    for (const player of room.players) {
      accountService.lockProfileFromRoom(player.accountId, room.code);
    }
  }

  function removeExpiredRooms() {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.listeners.size === 0 && now - room.updatedAt > MAX_ROOM_AGE_MS) {
        clearDismissalTimer(room.code);
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
    if (AVATAR_ASSET_RE.test(trimmed)) {
      return trimmed;
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
    lockRoomProfiles(room);
    room.game = poker.createGame({
      targetScore: room.targetScore,
      playerNames: room.players.map((player) => player.name)
    });
    startReplayRound(room);
    resetFourCardWarnings(room);
    storeCompletedReplayRound(room);
    clearDismissalVote(room);
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

  function updateProfile(room, member, profileInput, account) {
    ensureMemberAccount(member, account);
    if (room.game) {
      throw new RoomError("牌局开始后不能更改昵称或头像。", 409, "profile_locked");
    }
    const profile = normalizeProfile(profileInput, member.seat);
    if (accountService) {
      accountService.updateProfile(member.accountId, profile);
    }
    member.name = profile.name;
    member.avatar = profile.avatar;
    if (member.role === "player" && room.game) {
      renameGamePlayer(room.game, member.seat, member.name);
    }
    touch(room);
    broadcast(room);
  }

  function leaveRoom(room, member) {
    if (member.role === "spectator") {
      room.spectators.delete(member.token);
      touch(room);
      broadcast(room);
      return;
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
    touch(room);
    if (room.players.some(Boolean)) {
      broadcast(room);
    } else {
      clearDismissalTimer(room.code);
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

  function runAction(room, member, body, account) {
    ensureMemberAccount(member, account);
    if (member.role !== "player") {
      throw new RoomError("观战中不能操作牌局。", 403, "spectator_readonly");
    }
    const action = body && body.action;
    if (action === "request-dismissal") {
      requestDismissal(room, member);
      return;
    }
    if (action === "reject-dismissal") {
      rejectDismissal(room, member);
      return;
    }
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
    storeCompletedReplayRound(room);
    touch(room);
    broadcast(room);
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
      id: randomBytes(18).toString("hex"),
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

  function storeCompletedReplayRound(room) {
    const replayRound = room && room.replayRound;
    if (!accountService || !room || !replayRound || replayRound.recordStored || !replayRound.completedAt) {
      return;
    }
    const record = buildReplayRecord(room, replayRound);
    for (const player of room.players.filter(Boolean)) {
      accountService.recordRound(player.accountId, record);
    }
    replayRound.recordStored = true;
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
    storeCompletedReplayRound(room);
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
      expiresAt: requestedAt + dismissalVoteMs
    };
    scheduleDismissalTimer(room);
    touch(room);
    broadcast(room);
  }

  function rejectDismissal(room, member) {
    const vote = room.dismissalVote;
    if (!vote) {
      throw new RoomError("当前没有待处理的解散申请。", 409, "dismissal_not_pending");
    }
    if (vote.requestedBy === member.seat) {
      throw new RoomError("发起人不能拒绝自己的解散申请。", 409, "dismissal_requester_cannot_reject");
    }
    clearDismissalVote(room);
    room.dismissalNotice = {
      message: `${member.name} 已拒绝解散，游戏继续。`,
      expiresAt: Date.now() + dismissalNoticeMs
    };
    touch(room);
    broadcast(room);
  }

  function scheduleDismissalTimer(room) {
    clearDismissalTimer(room.code);
    const vote = room.dismissalVote;
    if (!vote) {
      return;
    }
    const timer = setTimeout(() => {
      const activeRoom = rooms.get(room.code);
      if (!activeRoom || activeRoom.dismissalVote !== vote || !hasExpiredDismissalVote(activeRoom)) {
        return;
      }
      dissolveRoom(activeRoom, "解散投票期间无人拒绝，房间已解散。");
    }, Math.max(0, vote.expiresAt - Date.now()) + 10);
    timer.unref?.();
    dismissalTimers.set(room.code, timer);
  }

  function clearDismissalVote(room) {
    room.dismissalVote = null;
    clearDismissalTimer(room.code);
  }

  function clearDismissalTimer(roomCode) {
    const timer = dismissalTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      dismissalTimers.delete(roomCode);
    }
  }

  function hasExpiredDismissalVote(room) {
    return Boolean(room && room.dismissalVote && room.dismissalVote.expiresAt <= Date.now());
  }

  function dissolveRoom(room, message) {
    if (!rooms.has(room.code)) {
      return;
    }
    clearDismissalVote(room);
    room.dismissalNotice = {
      message,
      expiresAt: Date.now() + dismissalNoticeMs
    };
    room.roomClosed = true;
    room.roomCloseMessage = message;
    touch(room);
    broadcast(room);
    for (const listener of room.listeners) {
      try {
        listener.res.end();
      } catch {
        // A closed SSE stream needs no further cleanup.
      }
    }
    room.listeners.clear();
    rooms.delete(room.code);
  }

  function resetFourCardWarnings(room) {
    room.fourCardAlerts = [];
    room.fourCardWarnedSeats = new Set();
  }

  function recordFourCardWarning(room, playerId, cardsBeforePlay) {
    const gamePlayer = room.game && room.game.players[playerId];
    if (!gamePlayer || room.game.phase !== "playing" || cardsBeforePlay <= 4) {
      return;
    }
    const warnedSeats = room.fourCardWarnedSeats || (room.fourCardWarnedSeats = new Set());
    const cardsLeft = gamePlayer.hand.length;
    if (cardsLeft > 4 || warnedSeats.has(playerId)) {
      return;
    }
    warnedSeats.add(playerId);
    room.fourCardAlerts.push({
      playerId,
      playerName: room.players[playerId].name,
      cardsLeft,
      expiresAt: Date.now() + FOUR_CARD_ALERT_MS
    });
  }

  function ensureHost(member) {
    if (member.role === "spectator" || member.seat !== 0) {
      throw new RoomError("只有房主可以进行这个操作。", 403, "host_required");
    }
  }

  function touch(room) {
    room.updatedAt = Date.now();
  }

  function viewRoom(room, member) {
    removeExpiredReactions(room);
    removeExpiredFourCardAlerts(room);
    removeExpiredDismissalNotice(room);
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
      dismissalNotice: room.dismissalNotice ? { ...room.dismissalNotice } : null,
      spectatorCount: room.spectators.size,
      spectators: Array.from(room.spectators.values()).map((spectator) => ({
        name: spectator.name,
        avatar: spectator.avatar,
        isMe: spectator.token === member.token
      })),
      reactions: isSpectator ? [] : Array.from(room.reactions.values()).map((reaction) => ({
        playerId: reaction.playerId,
        emoji: reaction.emoji,
        label: reaction.label,
        expiresAt: reaction.expiresAt
      })),
      alerts: isSpectator ? [] : room.fourCardAlerts
        .filter((alert) => alert.playerId !== member.seat)
        .map((alert) => ({ ...alert }))
    };
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

  function removeExpiredReactions(room) {
    const now = Date.now();
    for (const [playerId, reaction] of room.reactions) {
      if (reaction.expiresAt <= now) {
        room.reactions.delete(playerId);
      }
    }
  }

  function removeExpiredFourCardAlerts(room) {
    const now = Date.now();
    room.fourCardAlerts = (room.fourCardAlerts || []).filter((alert) => alert.expiresAt > now);
  }

  function removeExpiredDismissalNotice(room) {
    if (room.dismissalNotice && room.dismissalNotice.expiresAt <= Date.now()) {
      room.dismissalNotice = null;
    }
  }

  function presentDismissalVote(room, member) {
    const vote = room.dismissalVote;
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

  function sessionFor(room, member) {
    return {
      roomCode: room.code,
      token: member.token,
      seat: member.seat,
      role: member.role
    };
  }

  function broadcast(room) {
    removeExpiredReactions(room);
    removeExpiredFourCardAlerts(room);
    removeExpiredDismissalNotice(room);
    for (const listener of room.listeners) {
      const member = room.players.find((player) => player && player.token === listener.token)
        || room.spectators.get(listener.token);
      if (!member || listener.res && listener.res.writableEnded) {
        room.listeners.delete(listener);
        continue;
      }
      try {
        listener.send(viewRoom(room, member));
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
      const authenticated = accountService.authenticateRequest(req);
      const { room, member } = createRoom(authenticated.account);
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
      const authenticated = accountService.authenticateRequest(req);
      const { room, member } = joinRoom(roomCode, authenticated.account);
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
      listener.send = (state) => writeStateEvent(res, state);
      room.listeners.add(listener);
      listener.send(viewRoom(room, member));
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
    const authenticated = accountService.authenticateRequest(req);
    ensureMemberAccount(member, authenticated.account);

    if (actionName === "start") {
      startRoom(room, member);
    } else if (actionName === "target") {
      setTarget(room, member, body.score);
    } else if (actionName === "profile") {
      updateProfile(room, member, body.profile, authenticated.account);
    } else if (actionName === "action") {
      runAction(room, member, body, authenticated.account);
    } else if (actionName === "leave") {
      leaveRoom(room, member);
      return transport.sendJson(res, { left: true });
    }
    return transport.sendJson(res, viewRoom(room, member));
  }

  return {
    handle,
    rooms,
    viewRoom,
    connectSocket(roomCode, token, socket) {
      const room = getRoom(roomCode);
      const member = getMember(room, token);
      const listener = {
        token,
        send(state) {
          if (socket.readyState !== 1) {
            throw new Error("WebSocket 已关闭。");
          }
          socket.send(JSON.stringify({ type: "state", state }));
        }
      };
      room.listeners.add(listener);
      listener.send(viewRoom(room, member));
      const close = () => room.listeners.delete(listener);
      socket.once("close", close);
      socket.once("error", close);
      return close;
    }
  };
}

function writeStateEvent(res, state) {
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

export function isRoomError(error) {
  return error instanceof RoomError;
}
