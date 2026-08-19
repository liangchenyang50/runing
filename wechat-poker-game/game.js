"use strict";

const poker = require("./js/poker_core");

const wxApi = typeof wx !== "undefined" ? wx : null;
const canvas = wxApi ? wxApi.createCanvas() : null;
const ctx = canvas ? canvas.getContext("2d") : null;

let dpr = 1;
let width = 375;
let height = 667;
let state = null;
let selectedTargetScore = 100;
let buttons = [];
let cardHitAreas = [];

function setupCanvas() {
  if (!canvas || !ctx) {
    return;
  }

  const info = wxApi.getSystemInfoSync();
  dpr = info.pixelRatio || 1;
  width = info.windowWidth || 375;
  height = info.windowHeight || 667;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function startGame() {
  state = poker.createGame({ targetScore: selectedTargetScore });
  runAutoPlayers();
  render();
}

function chooseTargetScore(score) {
  selectedTargetScore = score;
  render();
}

function resetRound() {
  if (!state) {
    startGame();
    return;
  }
  if (state.phase === "finished") {
    state = poker.createNextRound(state);
  } else if (state.phase === "gameOver") {
    state = null;
  } else {
    state = poker.createGame({ targetScore: state.targetScore || selectedTargetScore });
  }
  runAutoPlayers();
  render();
}

function playSelected() {
  poker.playSelected(state);
  runAutoPlayers();
  render();
}

function passTurn() {
  poker.passTurn(state);
  runAutoPlayers();
  render();
}

function cardLabel(card) {
  return card.rank + card.suit;
}

function roundedRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundedRect(x, y, w, h, r, color) {
  roundedRect(x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeRoundedRect(x, y, w, h, r, color, lineWidth) {
  roundedRect(x, y, w, h, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth || 1;
  ctx.stroke();
}

function drawCard(card, x, y, options) {
  const cardOptions = options || {};
  const cardWidth = Math.min(72, Math.max(54, width * 0.17));
  const cardHeight = cardWidth * 1.38;
  const offsetY = card.selected ? -14 : 0;
  const drawY = y + offsetY;

  fillRoundedRect(x, drawY, cardWidth, cardHeight, 7, "#fffaf0");
  strokeRoundedRect(x, drawY, cardWidth, cardHeight, 7, card.selected ? "#fdb022" : "rgba(16, 24, 40, 0.18)", card.selected ? 3 : 1);

  if (cardOptions.hidden) {
    fillRoundedRect(x + 6, drawY + 6, cardWidth - 12, cardHeight - 12, 5, "#1f4b99");
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.font = "700 22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", x + cardWidth / 2, drawY + cardHeight / 2);
    return { width: cardWidth, height: cardHeight };
  }

  const color = card.color === "red" ? "#d92d20" : "#101828";
  ctx.fillStyle = color;
  ctx.font = "700 18px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(card.rank, x + 8, drawY + 8);
  ctx.font = "700 24px sans-serif";
  ctx.fillText(card.suit, x + 8, drawY + 32);

  ctx.font = "700 24px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(cardLabel(card), x + cardWidth / 2, drawY + cardHeight / 2 + 6);

  return { width: cardWidth, height: cardHeight };
}

function drawOpponent(player, x, y, align) {
  const active = state.currentPlayer === player.id && state.phase === "playing";
  ctx.fillStyle = active ? "#fdb022" : "rgba(255, 255, 255, 0.86)";
  ctx.font = "700 14px sans-serif";
  ctx.textAlign = align || "center";
  ctx.textBaseline = "top";
  ctx.fillText(player.name + " " + player.hand.length + " 张 / " + (player.score || 0) + " 分", x, y);

  const cardW = 28;
  const maxVisible = Math.min(player.hand.length, 8);
  const startX = align === "right" ? x - maxVisible * 10 - cardW : x - (maxVisible * 10 + cardW) / 2;
  for (let index = 0; index < maxVisible; index += 1) {
    fillRoundedRect(startX + index * 10, y + 24, cardW, 40, 4, "#fffaf0");
    fillRoundedRect(startX + index * 10 + 4, y + 28, cardW - 8, 32, 3, "#1f4b99");
  }
}

function drawPlayerHand(player) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.font = "700 16px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const active = state.currentPlayer === player.id && state.phase === "playing";
  ctx.fillText((active ? "轮到你" : "你的手牌") + "  " + player.hand.length + " 张 / " + (player.score || 0) + " 分", 22, height - 232);

  const cardGap = Math.min(9, Math.max(4, width * 0.012));
  const cardWidth = Math.min(72, Math.max(54, width * 0.17));
  const visibleWidth = width - 40;
  const totalWidth = cardWidth * player.hand.length + cardGap * (player.hand.length - 1);
  const overlapGap = player.hand.length > 1 ? Math.min(cardGap, Math.max(2, (visibleWidth - cardWidth) / (player.hand.length - 1))) : cardGap;
  let cursorX = 20 + Math.max(0, (visibleWidth - Math.min(totalWidth, visibleWidth)) / 2);
  let cardSize = { width: 62, height: 86 };
  for (let index = 0; index < player.hand.length; index += 1) {
    const card = player.hand[index];
    cardSize = drawCard(card, cursorX, height - 194, { hidden: false });
    cardHitAreas.push({
      playerId: player.id,
      cardId: card.id,
      x: cursorX,
      y: height - 208,
      w: cardSize.width,
      h: cardSize.height + 18
    });
    cursorX += overlapGap;
  }
}

function makeButton(label, x, y, w, h, action, enabled) {
  const button = { label, x, y, w, h, action, enabled };
  buttons.push(button);
  fillRoundedRect(x, y, w, h, 8, enabled ? "#fdb022" : "rgba(255, 255, 255, 0.22)");
  ctx.fillStyle = enabled ? "#1a1a1a" : "rgba(255, 255, 255, 0.55)";
  ctx.font = "700 17px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
}

function drawHeader() {
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 26px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("四人扑克", 22, 20);

  ctx.font = "600 13px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.76)";
  const target = state ? state.targetScore : selectedTargetScore;
  const turn = state ? state.turnCount : 0;
  ctx.fillText("3 最小，2 最大 · 目标 " + target + " 分 · 第 " + turn + " 手", 24, 56);
}

function drawMessage(panelY) {
  fillRoundedRect(20, panelY, width - 40, 60, 8, "rgba(255, 255, 255, 0.13)");
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 15px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  wrapText(state.message, width / 2, panelY + 20, width - 64, 19);
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  let line = "";
  const chars = String(text).split("");
  const lines = [];
  for (let index = 0; index < chars.length; index += 1) {
    const testLine = line + chars[index];
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = chars[index];
    } else {
      line = testLine;
    }
  }
  lines.push(line);

  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    ctx.fillText(lines[lineIndex], x, startY + lineIndex * lineHeight);
  }
}

function drawDiscardPile() {
  fillRoundedRect(width / 2 - 82, height / 2 - 48, 164, 76, 8, "rgba(255, 255, 255, 0.14)");
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.font = "600 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("上一手", width / 2, height / 2 - 38);

  const last = state.discardPile[state.discardPile.length - 1];
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 18px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(last ? last.playerName + "：" + last.label : "等待出牌", width / 2, height / 2 - 5);
}

function drawScores() {
  if (!state.roundResult || (state.phase !== "finished" && state.phase !== "gameOver")) {
    return;
  }

  const top = 82;
  fillRoundedRect(width - 112, top, 92, 92, 8, "rgba(255, 255, 255, 0.13)");
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "600 12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("本局计分", width - 100, top + 10);
  for (let index = 0; index < state.roundResult.length; index += 1) {
    const item = state.roundResult[index];
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 11px sans-serif";
    ctx.fillText(item.playerName + " +" + item.penalty, width - 100, top + 30 + index * 14);
  }
}

function drawFinalSettlement() {
  if (!state.finalSettlement || state.phase !== "gameOver") {
    return;
  }

  const panelX = 24;
  const panelY = 92;
  const panelW = width - 48;
  const panelH = 128;
  fillRoundedRect(panelX, panelY, panelW, panelH, 8, "rgba(255, 255, 255, 0.15)");

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 15px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("最终结算", panelX + 14, panelY + 12);

  ctx.font = "600 12px sans-serif";
  for (let index = 0; index < state.finalSettlement.net.length; index += 1) {
    const item = state.finalSettlement.net[index];
    const amountLabel = item.amount > 0 ? "+" + item.amount : String(item.amount);
    ctx.fillStyle = item.amount >= 0 ? "#d1fadf" : "#fee4e2";
    ctx.fillText(
      item.playerName + " 总分 " + item.score + " / 净结算 " + amountLabel,
      panelX + 14,
      panelY + 38 + index * 20
    );
  }
}

function renderSetup() {
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 24px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("设置目标分", width / 2, 142);

  ctx.fillStyle = "rgba(255, 255, 255, 0.76)";
  ctx.font = "600 14px sans-serif";
  wrapText("有人累计达到目标分后，整场游戏结束。每局开始前重新洗牌。", width / 2, 190, width - 70, 20);

  const scoreTop = 260;
  const scoreW = (width - 64) / 3;
  const options = [100, 200, 500];
  for (let index = 0; index < options.length; index += 1) {
    const score = options[index];
    const x = 22 + index * (scoreW + 10);
    const selected = selectedTargetScore === score;
    makeButton(String(score), x, scoreTop, scoreW, 52, function chooseScore() {
      chooseTargetScore(score);
    }, true);
    if (selected) {
      strokeRoundedRect(x, scoreTop, scoreW, 52, 8, "#ffffff", 2);
    }
  }

  makeButton("开始游戏", 42, scoreTop + 92, width - 84, 56, startGame, true);

  fillRoundedRect(24, scoreTop + 178, width - 48, 96, 8, "rgba(255, 255, 255, 0.12)");
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = "600 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  wrapText("可出单张、对子、三张、四张、四张顺子；有牌能接必须出，不能不要。", width / 2, scoreTop + 226, width - 82, 18);
}

function render() {
  if (!ctx) {
    return;
  }

  buttons = [];
  cardHitAreas = [];
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#103f31");
  gradient.addColorStop(0.62, "#0b6b50");
  gradient.addColorStop(1, "#10231e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.beginPath();
  ctx.arc(width - 52, 92, 80, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(28, height - 110, 74, 0, Math.PI * 2);
  ctx.fill();

  drawHeader();

  if (!state) {
    renderSetup();
    return;
  }

  drawOpponent(state.players[2], width / 2, 88, "center");
  drawOpponent(state.players[1], 68, 190, "center");
  drawOpponent(state.players[3], width - 68, 190, "center");
  drawDiscardPile();
  drawScores();
  drawFinalSettlement();
  drawPlayerHand(state.players[0]);

  const messageY = height - 312;
  drawMessage(messageY);

  const buttonTop = height - 92;
  const gap = 10;
  const buttonW = (width - 40 - gap * 2) / 3;
  const myTurn = state.phase === "playing" && state.currentPlayer === 0;
  makeButton("出牌", 20, buttonTop, buttonW, 54, playSelected, myTurn);
  makeButton("过牌", 20 + buttonW + gap, buttonTop, buttonW, 54, passTurn, myTurn);
  makeButton(state.phase === "finished" ? "下一轮" : state.phase === "gameOver" ? "新游戏" : "重开", 20 + (buttonW + gap) * 2, buttonTop, buttonW, 54, resetRound, true);
}

function handleTouch(x, y) {
  for (let cardIndex = cardHitAreas.length - 1; cardIndex >= 0; cardIndex -= 1) {
    const area = cardHitAreas[cardIndex];
    if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) {
      poker.toggleCardSelection(state, area.playerId, area.cardId);
      render();
      return;
    }
  }

  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (
      button.enabled &&
      x >= button.x &&
      x <= button.x + button.w &&
      y >= button.y &&
      y <= button.y + button.h
    ) {
      button.action();
      return;
    }
  }
}

function runAutoPlayers() {
  let guard = 0;
  while (state && state.phase === "playing" && state.currentPlayer !== 0 && guard < 32) {
    poker.autoPlayOneCard(state);
    guard += 1;
  }
}

function bindEvents() {
  if (!wxApi) {
    return;
  }

  wxApi.onTouchEnd(function onTouchEnd(event) {
    const touch = event.changedTouches && event.changedTouches[0];
    if (touch) {
      handleTouch(touch.clientX, touch.clientY);
    }
  });

  if (wxApi.onShow) {
    wxApi.onShow(render);
  }
}

setupCanvas();
bindEvents();
render();
