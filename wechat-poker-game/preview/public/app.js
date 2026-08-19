const app = document.querySelector("#app");

const REACTIONS = [
  { emoji: "👏", label: "漂亮" },
  { emoji: "😄", label: "开心" },
  { emoji: "😮", label: "厉害" },
  { emoji: "🤔", label: "想一想" },
  { emoji: "🔥", label: "来劲了" }
];

let currentState = null;
let clientNotice = "";
let emojiPickerOpen = false;
let activeReaction = null;
let reactionTimer = null;

async function api(path, body) {
  const options = body == null
    ? {}
    : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render(state) {
  currentState = state;
  app.innerHTML = `
    <section class="shell">
      ${state.active ? renderGame(state) : renderSetup(state)}
    </section>
  `;
  bindEvents(state);
}

function renderSetup(state) {
  return `
    <section class="setup-screen">
      <header class="game-header setup-header">
        <div class="round-sign"><strong>四人扑克</strong><span>本地网页试玩版</span></div>
        <div class="header-note">一副牌 · 四人对局</div>
      </header>
      <div class="setup-deck" aria-hidden="true">
        <span class="setup-card setup-card-one">A</span>
        <span class="setup-card setup-card-two">K</span>
        <span class="setup-card setup-card-three">2</span>
      </div>
      <section class="setup-content">
        <p class="eyebrow">欢乐牌桌</p>
        <h1>设置目标分</h1>
        <p class="setup-copy">有人累计达到目标分后整场结束。每一局都会重新洗牌发牌。</p>
        <div class="target-row" aria-label="选择目标分">
          ${state.targetOptions.map((score) => `
            <button class="target-button ${state.selectedTargetScore === score ? "selected" : ""}" data-action="target" data-score="${score}">
              ${score} 分
            </button>
          `).join("")}
        </div>
        <button class="game-button game-button-play start-button" data-action="start">开始对局</button>
        <p class="rule-note">可出单张、对子、三张、四张、四张顺子；有牌能接时必须接牌。</p>
      </section>
    </section>
  `;
}

function renderGame(state) {
  const players = state.players;
  return `
    <section class="game-board">
      <header class="game-header">
        <div class="round-sign"><strong>第 ${state.turnCount} 手</strong><span>目标 ${state.targetScore} 分</span></div>
        <div class="table-title">四人扑克 <span>欢乐牌桌</span></div>
        <button class="restart-control" data-action="reset" title="${escapeHtml(state.resetLabel)}" aria-label="${escapeHtml(state.resetLabel)}">↻</button>
      </header>

      ${renderSeat(players[1], "left")}
      ${renderSeat(players[2], "top")}
      ${renderSeat(players[3], "right")}

      ${renderTableActions(state.tableActions)}

      <section class="center-stage">
        <div class="turn-message ${clientNotice ? "has-notice" : ""}">${escapeHtml(clientNotice || state.message)}</div>
        ${renderRoundScore(state.roundResult)}
        ${renderSettlement(state.finalSettlement)}
      </section>

      <section class="action-dock" aria-label="出牌操作">
        <button class="game-button game-button-hint" data-action="hint" ${state.myTurn ? "" : "disabled"}>提示</button>
        <button class="game-button game-button-play" data-action="play" ${state.myTurn ? "" : "disabled"}>出牌</button>
        <button class="pass-control" data-action="pass" ${state.myTurn ? "" : "disabled"}>过牌</button>
      </section>

      <section class="emoji-dock">
        ${emojiPickerOpen ? renderEmojiPicker() : ""}
        <button class="emoji-toggle" data-action="toggle-emoji" title="发送表情" aria-label="发送表情">
          <span class="emoji-icon">☺</span><span>表情</span>
        </button>
      </section>

      <section class="my-zone">
        <div class="my-profile">
          <div class="my-avatar" aria-hidden="true">你</div>
          <div class="my-profile-copy">
            <strong>你</strong>
            <span>${state.myTurn ? "轮到你出牌" : "等待对手出牌"}</span>
          </div>
          <div class="my-score">${players[0].score} <small>分</small></div>
          ${activeReaction ? `<div class="reaction-bubble" role="status"><b>${activeReaction.emoji}</b>${escapeHtml(activeReaction.label)}</div>` : ""}
        </div>
        <div class="hand-rack" aria-label="你的手牌">
          ${players[0].hand.map((card) => renderHandCard(card, state.myTurn)).join("")}
        </div>
      </section>
    </section>
  `;
}

function renderSeat(player, position) {
  const location = position === "left" ? "桂林" : position === "right" ? "柳州" : "城中区";
  return `
    <section class="seat seat-${position}">
      <div class="avatar avatar-${player.id}" aria-hidden="true">${escapeHtml(player.name.slice(0, 1))}</div>
      <div class="seat-copy">
        <div class="seat-location">● ${location}</div>
        <strong>${escapeHtml(player.name)}</strong>
        <span>正在对局</span>
      </div>
      <div class="seat-stats">
        <span class="cards-left">${player.hand.length}</span>
        <span class="score-chip">${player.score} 分</span>
      </div>
      <div class="back-fan" aria-label="${escapeHtml(player.name)}剩余 ${player.hand.length} 张牌">
        ${renderCardBacks(player.hand.length)}
      </div>
    </section>
  `;
}

function renderCardBacks(cardCount) {
  const shown = Math.min(5, Math.max(2, Math.ceil(cardCount / 3)));
  return Array.from({ length: shown }, (_, index) => `<i class="card-back card-back-${index}"></i>`).join("");
}

function renderTableActions(actions) {
  if (!actions || actions.length === 0) {
    return '<section class="table-action table-action-empty">等待首出</section>';
  }
  return actions.map((action) => renderTableAction(action)).join("");
}

function renderTableAction(action) {
  const isPass = action.kind === "pass";
  return `
    <section class="table-action table-action-${action.playerId} ${isPass ? "is-pass" : "is-play"}">
      <div class="table-action-label">${escapeHtml(action.playerName)}${isPass ? "" : " 出牌"}</div>
      ${isPass
        ? '<div class="pass-stamp">要不起</div>'
        : `<div class="played-hand">${(action.cards || []).map((card) => renderTableCard(card)).join("")}</div>`}
    </section>
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

function showReaction(emoji, label) {
  activeReaction = { emoji, label };
  emojiPickerOpen = false;
  if (reactionTimer) {
    clearTimeout(reactionTimer);
  }
  reactionTimer = window.setTimeout(() => {
    activeReaction = null;
    if (currentState) {
      render(currentState);
    }
  }, 2200);
}

function bindEvents(state) {
  app.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", async () => {
      const action = element.dataset.action;
      if (action === "toggle-emoji") {
        emojiPickerOpen = !emojiPickerOpen;
        render(state);
        return;
      }
      if (action === "emoji") {
        showReaction(element.dataset.emoji, element.dataset.label);
        render(state);
        return;
      }

      let nextState;
      clientNotice = "";
      try {
        if (action === "target") {
          nextState = await api("/api/target", { score: Number(element.dataset.score) });
        } else if (action === "start") {
          nextState = await api("/api/start", {});
        } else if (action === "toggle") {
          nextState = await api("/api/toggle", { cardId: element.dataset.cardId });
        } else if (action === "hint") {
          nextState = await api("/api/hint", {});
        } else if (action === "play") {
          nextState = await api("/api/play", {});
        } else if (action === "pass") {
          nextState = await api("/api/pass", {});
        } else if (action === "reset") {
          nextState = await api("/api/reset", {});
        }
      } catch {
        clientNotice = "操作没有完成，请重试。";
      }

      render(nextState || currentState);
    });
  });
}

api("/api/state")
  .then(render)
  .catch(() => {
    app.innerHTML = '<p class="load-error">牌桌没有启动，请确认本地预览服务正在运行。</p>';
  });
