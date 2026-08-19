const app = document.querySelector("#app");

const REACTIONS = [
  { emoji: "👏", label: "漂亮" },
  { emoji: "😄", label: "开心" },
  { emoji: "😮", label: "厉害" },
  { emoji: "🤔", label: "想一想" },
  { emoji: "🔥", label: "来劲了" },
  { emoji: "😂", label: "笑死" },
  { emoji: "😎", label: "稳住" },
  { emoji: "🥳", label: "好耶" },
  { emoji: "😤", label: "不服" },
  { emoji: "😭", label: "太难了" },
  { emoji: "😱", label: "吓一跳" },
  { emoji: "🤝", label: "合作愉快" },
  { emoji: "💪", label: "加油" },
  { emoji: "🎉", label: "庆祝" },
  { emoji: "🫡", label: "收到" },
  { emoji: "❤️", label: "喜欢" },
  { emoji: "👍", label: "赞" },
  { emoji: "👎", label: "再来" },
  { emoji: "😴", label: "等等" },
  { emoji: "🍀", label: "好运" }
];

const AVATARS = ["😀", "😺", "🐼", "🦊", "🐸", "🐯", "🐰", "🦁", "🐻", "🐨", "🐵", "🐧"];
const PROFILE_KEY = "four-poker-profile-v1";
const SESSION_KEY = "four-poker-room-session-v1";
const RUNTIME = window.__POKER_RUNTIME__ || {};
const REALTIME_TRANSPORT = RUNTIME.transport === "websocket" ? "websocket" : "sse";
const SUPPORTS_SOLO = RUNTIME.supportsSolo !== false;

let currentState = null;
let clientNotice = "";
let emojiPickerOpen = false;
let profileEditorOpen = false;
let profile = loadProfile();
let profileDraft = { ...profile };
let session = loadSession();
let eventSource = null;
let eventSourceKey = "";
let roomSocket = null;
let socketReconnectTimer = null;
let localReaction = null;
let reactionTimer = null;
let expiryTimer = null;

function loadProfile() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    if (stored && typeof stored === "object") {
      return normalizeProfile(stored);
    }
  } catch {
    // A missing or blocked localStorage should not stop local play.
  }
  return { name: "玩家", avatar: "😀" };
}

function loadSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (stored && typeof stored.roomCode === "string" && typeof stored.token === "string") {
      return stored;
    }
  } catch {
    // The lobby remains available when an old session cannot be read.
  }
  return null;
}

function normalizeProfile(source) {
  const rawName = String(source && source.name || "").trim().replace(/\s+/g, " ");
  const name = Array.from(rawName || "玩家").slice(0, 12).join("");
  const avatar = source && typeof source.avatar === "string" && source.avatar.trim()
    ? source.avatar.trim()
    : "😀";
  return { name, avatar };
}

function saveProfile(nextProfile) {
  profile = normalizeProfile(nextProfile);
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // The active tab still keeps the selected profile in memory.
  }
}

function saveSession(nextSession) {
  session = nextSession;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // The session can still live for the current page visit.
  }
}

function clearSession() {
  session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing else is needed when browser storage is unavailable.
  }
  stopRoomEvents();
}

async function requestJson(path, body, method) {
  const requestMethod = method || (body == null ? "GET" : "POST");
  const response = await fetch(path, {
    method: requestMethod,
    headers: body == null ? undefined : { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "操作没有完成，请重试。");
  }
  return payload;
}

function soloApi(path, body) {
  return requestJson(path, body);
}

function roomUrl(suffix) {
  return `/api/rooms/${encodeURIComponent(session.roomCode)}${suffix}`;
}

function roomApi(suffix, body) {
  if (!session) {
    throw new Error("房间身份已失效，请重新进入房间。");
  }
  return requestJson(roomUrl(suffix), { ...body, token: session.token });
}

function roomStateUrl() {
  return `${roomUrl("/state")}?token=${encodeURIComponent(session.token)}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render(state) {
  currentState = state || { mode: "home" };
  const content = currentState.mode === "room"
    ? currentState.phase === "lobby" ? renderRoomLobby(currentState) : renderGame(currentState)
    : currentState.active ? renderGame(currentState) : isSoloSetup(currentState) ? renderSoloSetup(currentState) : renderHome();
  app.innerHTML = `<section class="shell">${content}${profileEditorOpen ? renderProfileEditor() : ""}</section>`;
  bindEvents(currentState);
  syncRoomEvents(currentState);
  scheduleReactionExpiry(currentState);
}

function isSoloSetup(state) {
  return Boolean(state && Object.prototype.hasOwnProperty.call(state, "selectedTargetScore"));
}

function renderSoloSetup(state) {
  return `
    <section class="setup-screen home-screen">
      <header class="game-header setup-header">
        <div class="round-sign"><strong>四人扑克</strong><span>本地网页试玩版</span></div>
        <button class="header-profile" data-action="open-profile" title="编辑昵称和头像">${renderAvatar(profile.avatar, "header-avatar", profile.name)}<span>${escapeHtml(profile.name)}</span></button>
      </header>
      <div class="setup-deck" aria-hidden="true">
        <span class="setup-card setup-card-one">A</span>
        <span class="setup-card setup-card-two">K</span>
        <span class="setup-card setup-card-three">2</span>
      </div>
      <section class="home-content">
        <p class="eyebrow">单人试玩</p>
        <h1>设置目标分</h1>
        <p class="setup-copy">三名对手会自动出牌；联网房间可从主页重新进入。</p>
        <div class="target-row" aria-label="选择目标分">
          ${state.targetOptions.map((score) => `
            <button class="target-button ${state.selectedTargetScore === score ? "selected" : ""}" data-action="target" data-score="${score}">
              ${score} 分
            </button>
          `).join("")}
        </div>
        <button class="game-button game-button-play start-button" data-action="start">开始对局</button>
        <button class="solo-entry" data-action="back-home">返回联机大厅</button>
        <p class="rule-note">单张、对子、三张、四张、四张顺子；有牌能接时必须接牌。</p>
      </section>
    </section>
  `;
}

function renderHome() {
  return `
    <section class="setup-screen home-screen">
      <header class="game-header setup-header">
        <div class="round-sign"><strong>四人扑克</strong><span>联机欢乐牌桌</span></div>
        <button class="header-profile" data-action="open-profile" title="编辑昵称和头像">${renderAvatar(profile.avatar, "header-avatar", profile.name)}<span>${escapeHtml(profile.name)}</span></button>
      </header>
      <div class="setup-deck" aria-hidden="true">
        <span class="setup-card setup-card-one">A</span>
        <span class="setup-card setup-card-two">K</span>
        <span class="setup-card setup-card-three">2</span>
      </div>
      <section class="home-content">
        <p class="eyebrow">欢乐牌桌</p>
        <h1>创建一桌牌</h1>
        <p class="setup-copy">创建房间后，把六位房间号发给朋友。四人到齐后由房主开局。</p>
        ${renderProfileSummary("home")}
        <div class="home-actions">
          <button class="game-button game-button-play start-button" data-action="create-room">创建房间</button>
          <div class="join-room-row">
            <input id="join-room-code" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="输入 6 位房间号" aria-label="房间号">
            <button class="join-room-button" data-action="join-room">加入</button>
          </div>
          ${SUPPORTS_SOLO ? '<button class="solo-entry" data-action="solo">单人试玩</button>' : ""}
        </div>
        <p class="rule-note">单张、对子、三张、四张、四张顺子；有牌能接时必须接牌。</p>
      </section>
    </section>
  `;
}

function renderRoomLobby(state) {
  return `
    <section class="setup-screen room-lobby-screen">
      <header class="game-header setup-header">
        <div class="round-sign"><strong>房间 ${escapeHtml(state.roomCode)}</strong><span>等待入座</span></div>
        <button class="header-profile" data-action="open-profile" title="编辑昵称和头像">${renderAvatar(profile.avatar, "header-avatar", profile.name)}<span>${escapeHtml(profile.name)}</span></button>
      </header>
      <section class="room-lobby-content">
        <div class="room-code-banner">
          <span>房间号</span>
          <strong>${escapeHtml(state.roomCode)}</strong>
          <button data-action="copy-room" title="复制房间号" aria-label="复制房间号">复制</button>
        </div>
        <div class="lobby-seat-grid">
          ${state.players.map((player) => renderLobbySeat(player, player.id === state.viewerSeat)).join("")}
        </div>
        <div class="lobby-controls">
          <p class="lobby-count">已入座 ${state.playerCount} / 4</p>
          <div class="target-row room-target-row" aria-label="选择目标分">
            ${state.targetOptions.map((score) => `
              <button class="target-button ${state.targetScore === score ? "selected" : ""}" data-action="room-target" data-score="${score}" ${state.canChangeTarget ? "" : "disabled"}>
                ${score} 分
              </button>
            `).join("")}
          </div>
          <button class="game-button game-button-play start-button" data-action="room-start" ${state.canStart ? "" : "disabled"}>${state.isHost ? "开始对局" : "等待房主开始"}</button>
          <button class="solo-entry" data-action="leave-room">离开房间</button>
          <p class="rule-note">${state.isHost ? "四人到齐后即可开始。" : "请等待房主开始对局。"}</p>
        </div>
      </section>
    </section>
  `;
}

function renderLobbySeat(player, isMe) {
  if (!player.occupied) {
    return `
      <section class="lobby-seat is-empty">
        <div class="lobby-avatar empty-avatar">＋</div>
        <strong>等待玩家</strong>
      </section>
    `;
  }
  return `
    <section class="lobby-seat ${isMe ? "is-me" : ""}">
      ${renderAvatar(player.avatar, "lobby-avatar", player.name)}
      <strong>${escapeHtml(player.name)}</strong>
      <span>${player.isHost ? "房主" : "已入座"}</span>
    </section>
  `;
}

function renderGame(state) {
  const seats = getViewerSeats(state);
  const roomLabel = state.mode === "room" ? `<span>房间 ${escapeHtml(state.roomCode)}</span>` : "<span>欢乐牌桌</span>";
  return `
    <section class="game-board ${state.phase !== "playing" ? "round-finished" : ""}">
      <header class="game-header">
        <div class="round-sign"><strong>第 ${state.turnCount} 手</strong><span>目标 ${state.targetScore} 分</span></div>
        <div class="table-title">四人扑克 ${roomLabel}</div>
        ${state.mode === "room"
          ? `<button class="restart-control room-info-control" data-action="copy-room" title="复制房间号" aria-label="复制房间号">#</button>`
          : `<button class="restart-control" data-action="reset" title="${escapeHtml(state.resetLabel)}" aria-label="${escapeHtml(state.resetLabel)}">↻</button>`}
      </header>

      ${renderSeat(seats.left, "left", state)}
      ${renderSeat(seats.top, "top", state)}
      ${renderSeat(seats.right, "right", state)}

      ${renderTableActions(state.tableActions, state.viewerSeat || 0)}

      <section class="center-stage">
        <div class="turn-message ${clientNotice ? "has-notice" : ""}">${escapeHtml(clientNotice || state.message)}</div>
        ${renderRoundScore(state.roundResult)}
        ${renderSettlement(state.finalSettlement)}
        ${renderRoundControl(state)}
      </section>

      ${state.phase === "playing" ? renderGameActions(state) : ""}

      <section class="emoji-dock">
        ${emojiPickerOpen ? renderEmojiPicker() : ""}
        <button class="emoji-toggle" data-action="toggle-emoji" title="发送表情" aria-label="发送表情">
          <span class="emoji-icon">☺</span><span>表情</span>
        </button>
      </section>

      <section class="my-zone">
        <div class="my-profile">
          <button class="avatar-edit-control" data-action="open-profile" title="编辑昵称和头像">${renderAvatar(seats.me.avatar, "my-avatar", seats.me.name)}</button>
          <div class="my-profile-copy">
            <strong>${escapeHtml(seats.me.name)}</strong>
            <span>${state.myTurn ? "轮到你出牌" : "等待对手出牌"}</span>
          </div>
          <div class="my-score">${seats.me.score || 0} <small>分</small></div>
          ${renderReactionBubble(state, seats.me.id, "my-reaction")}
        </div>
        <div class="hand-rack" aria-label="你的手牌">
          ${(seats.me.hand || []).map((card) => renderHandCard(card, state.myTurn)).join("")}
        </div>
      </section>
    </section>
  `;
}

function getViewerSeats(state) {
  const viewerSeat = Number.isInteger(state.viewerSeat) ? state.viewerSeat : 0;
  const playerById = new Map((state.players || []).map((player) => [player.id, player]));
  const fallback = (id) => ({ id, name: "玩家", avatar: "😀", hand: [], cardsLeft: 0, score: 0 });
  const currentPlayer = playerById.get(viewerSeat) || fallback(viewerSeat);
  const me = state.mode === "room"
    ? currentPlayer
    : { ...currentPlayer, name: profile.name, avatar: profile.avatar };
  return {
    me,
    left: playerById.get((viewerSeat + 1) % 4) || fallback((viewerSeat + 1) % 4),
    top: playerById.get((viewerSeat + 2) % 4) || fallback((viewerSeat + 2) % 4),
    right: playerById.get((viewerSeat + 3) % 4) || fallback((viewerSeat + 3) % 4)
  };
}

function renderSeat(player, position, state) {
  const cardCount = player.cardsLeft == null ? (player.hand || []).length : player.cardsLeft;
  return `
    <section class="seat seat-${position}">
      ${renderAvatar(player.avatar, `avatar avatar-${player.id}`, player.name)}
      <div class="seat-copy">
        <strong>${escapeHtml(player.name)}</strong>
        ${player.isHost ? '<span class="seat-host">房主</span>' : ""}
      </div>
      <div class="seat-stats">
        <span class="cards-left">${cardCount}</span>
        <span class="score-chip">${player.score || 0} 分</span>
      </div>
      <div class="back-fan" aria-label="${escapeHtml(player.name)}剩余 ${cardCount} 张牌">
        ${renderCardBacks(cardCount)}
      </div>
      ${renderReactionBubble(state, player.id, "seat-reaction")}
    </section>
  `;
}

function renderAvatar(avatar, className, name) {
  const safeAvatar = String(avatar || "😀");
  const content = safeAvatar.startsWith("data:image/")
    ? `<img src="${escapeHtml(safeAvatar)}" alt="${escapeHtml(name || "头像")}">`
    : escapeHtml(safeAvatar);
  return `<div class="${className}" aria-label="${escapeHtml(name || "玩家头像")}">${content}</div>`;
}

function renderCardBacks(cardCount) {
  const shown = Math.min(5, Math.max(2, Math.ceil(cardCount / 3)));
  return Array.from({ length: shown }, (_, index) => `<i class="card-back card-back-${index}"></i>`).join("");
}

function renderTableActions(actions, viewerSeat) {
  if (!actions || actions.length === 0) {
    return '<section class="table-action table-action-empty">等待首出</section>';
  }
  return actions.map((action) => renderTableAction(action, viewerSeat)).join("");
}

function renderTableAction(action, viewerSeat) {
  const isPass = action.kind === "pass";
  const relativeSeat = ((action.playerId - viewerSeat) % 4 + 4) % 4;
  return `
    <section class="table-action table-action-${relativeSeat} ${isPass ? "is-pass" : "is-play"}">
      <div class="table-action-label">${escapeHtml(action.playerName)}${isPass ? "" : " 出牌"}</div>
      ${isPass
        ? '<div class="pass-stamp">要不起</div>'
        : `<div class="played-hand">${(action.cards || []).map((card) => renderTableCard(card)).join("")}</div>`}
    </section>
  `;
}

function renderGameActions(state) {
  return `
    <section class="action-dock" aria-label="出牌操作">
      <button class="game-button game-button-hint" data-action="hint" ${state.myTurn ? "" : "disabled"}>提示</button>
      <button class="game-button game-button-play" data-action="play" ${state.myTurn ? "" : "disabled"}>出牌</button>
      <button class="pass-control" data-action="pass" ${state.myTurn ? "" : "disabled"}>过牌</button>
    </section>
  `;
}

function renderRoundControl(state) {
  if (state.phase === "playing") {
    return "";
  }
  if (state.mode === "room" && !state.canContinue) {
    return '<div class="round-waiting">等待房主开始下一轮</div>';
  }
  return `
    <button class="round-continue" data-action="reset">
      ${escapeHtml(state.resetLabel)}
    </button>
  `;
}

function renderRoundScore(roundResult) {
  if (!roundResult || roundResult.length === 0) {
    return "";
  }
  return `
    <section class="result-panel">
      <div class="panel-title">本局计分</div>
      ${roundResult.map((item) => `
        <div class="score-line">${escapeHtml(item.playerName)} +${item.penalty}，累计 ${item.total}</div>
      `).join("")}
    </section>
  `;
}

function renderSettlement(settlement) {
  if (!settlement) {
    return "";
  }
  return `
    <section class="result-panel settlement-panel">
      <div class="panel-title">最终结算</div>
      ${settlement.net.map((item) => `
        <div class="score-line ${item.amount >= 0 ? "receive" : "pay"}">
          ${escapeHtml(item.playerName)} ${item.amountText}
        </div>
      `).join("")}
    </section>
  `;
}

function renderHandCard(card, enabled) {
  return `
    <button
      class="playing-card hand-card ${card.color} ${card.selected ? "selected-card" : ""}"
      data-action="toggle"
      data-card-id="${escapeHtml(card.id)}"
      aria-label="${escapeHtml(card.rank + card.suit)}"
      ${enabled ? "" : "disabled"}
    >
      ${renderCardFace(card)}
    </button>
  `;
}

function renderTableCard(card) {
  return `<div class="playing-card table-card ${card.color}" aria-label="${escapeHtml(card.rank + card.suit)}">${renderCardFace(card)}</div>`;
}

function renderCardFace(card) {
  return `
    <span class="card-corner card-corner-top"><b>${escapeHtml(card.rank)}</b><i>${escapeHtml(card.suit)}</i></span>
    <span class="card-pip">${escapeHtml(card.suit)}</span>
  `;
}

function renderEmojiPicker() {
  return `
    <div class="emoji-picker" role="dialog" aria-label="选择表情">
      ${REACTIONS.map((reaction) => `
        <button data-action="emoji" data-emoji="${reaction.emoji}" data-label="${reaction.label}" title="${reaction.label}">${reaction.emoji}</button>
      `).join("")}
    </div>
  `;
}

function renderReactionBubble(state, playerId, className) {
  const reaction = (state.reactions || []).find((item) => item.playerId === playerId && item.expiresAt > Date.now())
    || (state.mode !== "room" && playerId === 0 ? localReaction : null);
  if (!reaction) {
    return "";
  }
  return `<div class="reaction-bubble ${className}" role="status"><b>${escapeHtml(reaction.emoji)}</b>${escapeHtml(reaction.label)}</div>`;
}

function renderProfileSummary(scope) {
  return `
    <button class="profile-summary" data-action="open-profile" data-scope="${scope}" title="编辑昵称和头像">
      ${renderAvatar(profile.avatar, "profile-summary-avatar", profile.name)}
      <span><small>当前资料</small><strong>${escapeHtml(profile.name)}</strong></span>
      <i>编辑</i>
    </button>
  `;
}

function renderProfileEditor() {
  return `
    <section class="profile-modal" role="dialog" aria-modal="true" aria-label="编辑玩家资料">
      <form class="profile-editor" id="profile-editor-form">
        <header>
          <h2>我的资料</h2>
          <button type="button" class="modal-close" data-action="close-profile" title="关闭" aria-label="关闭">×</button>
        </header>
        <div class="profile-preview">${renderAvatar(profileDraft.avatar, "profile-preview-avatar", profileDraft.name)}</div>
        <label class="field-label" for="profile-name">昵称</label>
        <input id="profile-name" maxlength="12" value="${escapeHtml(profileDraft.name)}" autocomplete="nickname">
        <span class="field-label">选择头像</span>
        <div class="avatar-choice-grid">
          ${AVATARS.map((avatar) => `
            <button type="button" class="avatar-choice ${profileDraft.avatar === avatar ? "selected" : ""}" data-action="avatar-choice" data-avatar="${avatar}" aria-label="选择头像 ${avatar}">${avatar}</button>
          `).join("")}
        </div>
        <label class="upload-avatar-button" for="profile-avatar-file">上传图片头像</label>
        <input id="profile-avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <button type="button" class="profile-save" data-action="save-profile">保存资料</button>
      </form>
    </section>
  `;
}

function syncRoomEvents(state) {
  if (state.mode !== "room" || !session || state.roomCode !== session.roomCode) {
    stopRoomEvents();
    return;
  }
  const key = `${session.roomCode}:${session.token}`;
  if (eventSource && eventSourceKey === key) {
    return;
  }
  if (roomSocket && eventSourceKey === key && (roomSocket.readyState === WebSocket.OPEN || roomSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  stopRoomEvents();
  eventSourceKey = key;
  if (REALTIME_TRANSPORT === "websocket") {
    openRoomSocket(key);
    return;
  }
  eventSource = new EventSource(`${roomUrl("/events")}?token=${encodeURIComponent(session.token)}`);
  eventSource.addEventListener("state", (event) => {
    try {
      clientNotice = "";
      render(JSON.parse(event.data));
    } catch {
      // A transient SSE payload will be replaced by the next state event.
    }
  });
  eventSource.addEventListener("error", () => {
    // EventSource reconnects automatically. Keep the last visible game state meanwhile.
  });
}

function stopRoomEvents() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
  if (roomSocket) {
    roomSocket.close();
  }
  roomSocket = null;
  if (socketReconnectTimer) {
    clearTimeout(socketReconnectTimer);
    socketReconnectTimer = null;
  }
  eventSourceKey = "";
}

function openRoomSocket(key) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${roomUrl("/ws")}?token=${encodeURIComponent(session.token)}`, window.location.origin);
  url.protocol = protocol;
  const socket = new WebSocket(url);
  roomSocket = socket;

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload && payload.type === "state" && payload.state) {
        clientNotice = "";
        render(payload.state);
      }
    } catch {
      // The next room state will replace an incomplete WebSocket payload.
    }
  });

  socket.addEventListener("error", () => {
    socket.close();
  });

  socket.addEventListener("close", () => {
    if (roomSocket !== socket || eventSourceKey !== key) {
      return;
    }
    roomSocket = null;
    socketReconnectTimer = window.setTimeout(() => {
      socketReconnectTimer = null;
      if (eventSourceKey === key && currentState && currentState.mode === "room" && session) {
        eventSourceKey = "";
        syncRoomEvents(currentState);
      }
    }, 1000);
  });
}

function scheduleReactionExpiry(state) {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const expiryTimes = (state.reactions || [])
    .map((reaction) => reaction.expiresAt)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now());
  if (expiryTimes.length === 0) {
    return;
  }
  const nextExpiry = Math.min(...expiryTimes);
  expiryTimer = window.setTimeout(() => render(currentState), Math.max(50, nextExpiry - Date.now() + 60));
}

function openProfileEditor() {
  profileDraft = { ...profile };
  profileEditorOpen = true;
  emojiPickerOpen = false;
  render(currentState);
}

function closeProfileEditor() {
  profileEditorOpen = false;
  render(currentState);
}

function captureProfileName() {
  const input = app.querySelector("#profile-name");
  if (input) {
    profileDraft.name = input.value;
  }
}

async function handleAvatarFile(input) {
  const file = input.files && input.files[0];
  if (!file) {
    return;
  }
  if (file.size > 220000) {
    clientNotice = "头像图片请控制在 220 KB 以内。";
    render(currentState);
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("头像图片读取失败。"));
    reader.readAsDataURL(file);
  });
  captureProfileName();
  profileDraft.avatar = String(dataUrl);
  render(currentState);
}

async function enterRoom(payload) {
  saveSession(payload.session);
  clientNotice = "";
  stopRoomEvents();
  render(payload.state);
}

async function createRoom() {
  const payload = await requestJson("/api/rooms", { profile });
  await enterRoom(payload);
}

async function joinRoom() {
  const input = app.querySelector("#join-room-code");
  const roomCode = String(input && input.value || "").replace(/\D/g, "");
  if (roomCode.length !== 6) {
    throw new Error("请输入 6 位房间号。");
  }
  const payload = await requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, { profile });
  await enterRoom(payload);
}

async function saveCurrentProfile() {
  captureProfileName();
  saveProfile(profileDraft);
  if (currentState.mode === "room" && session) {
    const state = await roomApi("/profile", { profile });
    profileEditorOpen = false;
    render(state);
    return;
  }
  profileEditorOpen = false;
  render(currentState);
}

function showLocalReaction(emoji, label) {
  localReaction = { emoji, label };
  emojiPickerOpen = false;
  if (reactionTimer) {
    clearTimeout(reactionTimer);
  }
  reactionTimer = window.setTimeout(() => {
    localReaction = null;
    render(currentState);
  }, 2600);
}

function bindEvents(state) {
  app.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", async () => {
      const action = element.dataset.action;
      try {
        if (action === "open-profile") {
          openProfileEditor();
          return;
        }
        if (action === "close-profile") {
          closeProfileEditor();
          return;
        }
        if (action === "avatar-choice") {
          captureProfileName();
          profileDraft.avatar = element.dataset.avatar;
          render(currentState);
          return;
        }
        if (action === "save-profile") {
          await saveCurrentProfile();
          return;
        }
        if (action === "toggle-emoji") {
          emojiPickerOpen = !emojiPickerOpen;
          render(state);
          return;
        }
        if (action === "emoji") {
          if (state.mode === "room") {
            const nextState = await roomApi("/action", {
              action: "reaction",
              emoji: element.dataset.emoji,
              label: element.dataset.label
            });
            emojiPickerOpen = false;
            render(nextState);
          } else {
            showLocalReaction(element.dataset.emoji, element.dataset.label);
            render(state);
          }
          return;
        }
        if (action === "create-room") {
          await createRoom();
          return;
        }
        if (action === "join-room") {
          await joinRoom();
          return;
        }
        if (action === "copy-room") {
          await navigator.clipboard.writeText(String(state.roomCode));
          clientNotice = "房间号已复制。";
          render(state);
          return;
        }
        if (action === "solo") {
          clearSession();
          const nextState = await soloApi("/api/state");
          clientNotice = "";
          render(nextState);
          return;
        }
        if (action === "leave-room") {
          await roomApi("/leave", {});
          clearSession();
          clientNotice = "已离开房间。";
          render({ mode: "home" });
          return;
        }
        if (action === "back-home") {
          clearSession();
          clientNotice = "";
          render({ mode: "home" });
          return;
        }

        let nextState;
        clientNotice = "";
        if (action === "room-target") {
          nextState = await roomApi("/target", { score: Number(element.dataset.score) });
        } else if (action === "room-start") {
          nextState = await roomApi("/start", {});
        } else if (state.mode === "room") {
          if (action === "reset") {
            nextState = await roomApi("/action", { action: "next-round" });
          } else {
            nextState = await roomApi("/action", { action, cardId: element.dataset.cardId });
          }
        } else if (action === "target") {
          nextState = await soloApi("/api/target", { score: Number(element.dataset.score) });
        } else if (action === "start") {
          nextState = await soloApi("/api/start", {});
        } else if (action === "toggle") {
          nextState = await soloApi("/api/toggle", { cardId: element.dataset.cardId });
        } else if (action === "hint") {
          nextState = await soloApi("/api/hint", {});
        } else if (action === "play") {
          nextState = await soloApi("/api/play", {});
        } else if (action === "pass") {
          nextState = await soloApi("/api/pass", {});
        } else if (action === "reset") {
          nextState = await soloApi("/api/reset", {});
        }
        render(nextState || currentState);
      } catch (error) {
        clientNotice = error.message || "操作没有完成，请重试。";
        render(currentState);
      }
    });
  });

  const avatarInput = app.querySelector("#profile-avatar-file");
  if (avatarInput) {
    avatarInput.addEventListener("change", () => {
      handleAvatarFile(avatarInput).catch((error) => {
        clientNotice = error.message || "头像图片读取失败。";
        render(currentState);
      });
    });
  }
}

async function initialize() {
  if (session) {
    try {
      const restored = await requestJson(roomStateUrl());
      render(restored);
      return;
    } catch {
      clearSession();
      clientNotice = "之前的房间已失效，请重新创建或加入。";
    }
  }
  render({ mode: "home" });
}

initialize().catch(() => {
  app.innerHTML = '<p class="load-error">牌桌没有启动，请确认网页服务正在运行。</p>';
});
