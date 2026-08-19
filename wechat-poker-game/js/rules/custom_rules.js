"use strict";

// 用户规则：
// 一副牌四个人；每局重新洗牌；3 最小、2 最大。
// 可出的牌型：单张、对子、三张、四张、四张顺子（A234 到 JQKA）。
// 出牌顺序固定为：你 -> 右家 -> 对家 -> 左家 -> 你；有能接上的牌必须打，不能过牌。
// 先出完者获胜，下一轮由赢家先出。输家按剩牌张数计分。
// 特殊规则：一人四张 2、全小于等于 10、全大于 10 时，其余每人加 52 分。
// 整场结束：每个分数多的人向分数少的人给出两者差值作为结算积分。

const ruleInfo = {
  name: "四人接牌扑克",
  playerCount: 4,
  deckCount: 1,
  cardsPerPlayer: 13,
  summary: "按你、右家、对家、左家的顺序循环；单张、对子、三张、四张、四张顺子；必须接牌；先出完者获胜。"
};

const RANK_ORDER = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const STRAIGHT_SEQUENCES = [
  ["A", "2", "3", "4"],
  ["2", "3", "4", "5"],
  ["3", "4", "5", "6"],
  ["4", "5", "6", "7"],
  ["5", "6", "7", "8"],
  ["6", "7", "8", "9"],
  ["7", "8", "9", "10"],
  ["8", "9", "10", "J"],
  ["9", "10", "J", "Q"],
  ["10", "J", "Q", "K"],
  ["J", "Q", "K", "A"]
];

function getRankValue(rank) {
  return RANK_ORDER.indexOf(rank);
}

function getStartingPlayer(context) {
  if (typeof context.startingPlayer === "number") {
    return context.startingPlayer;
  }
  return 0;
}

function groupByRank(cards) {
  const groups = {};
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!groups[card.rank]) {
      groups[card.rank] = [];
    }
    groups[card.rank].push(card);
  }
  return groups;
}

function sameRankCombo(cards) {
  if (cards.length !== 1 && cards.length !== 2 && cards.length !== 3 && cards.length !== 4) {
    return null;
  }

  const rank = cards[0].rank;
  for (let index = 1; index < cards.length; index += 1) {
    if (cards[index].rank !== rank) {
      return null;
    }
  }

  return {
    type: cards.length === 1 ? "single" : cards.length === 2 ? "pair" : cards.length === 3 ? "triple" : "quad",
    rank,
    strength: getRankValue(rank),
    label: cards.length === 1 ? "单张" : cards.length === 2 ? "对子" : cards.length === 3 ? "三张" : "四张"
  };
}

function straightCombo(cards) {
  if (cards.length !== 4) {
    return null;
  }

  const rankSet = {};
  for (let index = 0; index < cards.length; index += 1) {
    rankSet[cards[index].rank] = true;
  }

  for (let seqIndex = 0; seqIndex < STRAIGHT_SEQUENCES.length; seqIndex += 1) {
    const sequence = STRAIGHT_SEQUENCES[seqIndex];
    let matched = true;
    for (let rankIndex = 0; rankIndex < sequence.length; rankIndex += 1) {
      if (!rankSet[sequence[rankIndex]]) {
        matched = false;
        break;
      }
    }

    if (matched && Object.keys(rankSet).length === 4) {
      return {
        type: "straight4",
        rank: sequence.join(""),
        strength: seqIndex,
        label: "四张顺子"
      };
    }
  }

  return null;
}

function analyzeCards(cards) {
  if (!cards || cards.length === 0) {
    return null;
  }

  return sameRankCombo(cards) || straightCombo(cards);
}

function canBeat(combo, previousCombo) {
  if (!combo || !previousCombo) {
    return Boolean(combo);
  }
  return combo.type === previousCombo.type && combo.strength > previousCombo.strength;
}

function canPlay(context) {
  const combo = analyzeCards(context.selectedCards);
  if (!combo) {
    return {
      ok: false,
      reason: "只能出单张、对子、三张、四张，或 A234 到 JQKA 的四张顺子。"
    };
  }

  if (context.lastPlay && context.lastPlay.combo && !canBeat(combo, context.lastPlay.combo)) {
    return {
      ok: false,
      reason: "接牌必须同牌型并且更大。"
    };
  }

  return {
    ok: true,
    reason: "",
    combo
  };
}

function canPass(context) {
  const moves = findLegalMoves(context.player.hand, context.lastPlay);
  if (moves.length > 0) {
    return {
      ok: false,
      reason: "手上有能接应的牌，必须打出来。"
    };
  }

  return {
    ok: true,
    reason: ""
  };
}

function chooseAutoMove(context) {
  if (!context.player || context.player.hand.length === 0) {
    return { type: "pass", cardIds: [] };
  }

  const moves = findLegalMoves(context.player.hand, context.lastPlay);
  if (moves.length === 0) {
    return { type: "pass", cardIds: [] };
  }

  return {
    type: "play",
    cardIds: moves[0].cards.map(function cardId(card) {
      return card.id;
    })
  };
}

function findLegalMoves(hand, lastPlay) {
  const combos = [];
  const groups = groupByRank(hand);
  const ranks = Object.keys(groups);
  const previousCombo = lastPlay && lastPlay.combo ? lastPlay.combo : null;

  for (let rankIndex = 0; rankIndex < ranks.length; rankIndex += 1) {
    const rank = ranks[rankIndex];
    const cards = groups[rank].slice().sort(compareSuit);
    for (let size = 1; size <= Math.min(4, cards.length); size += 1) {
      const comboCards = cards.slice(0, size);
      const combo = analyzeCards(comboCards);
      if (canBeat(combo, previousCombo)) {
        combos.push({ cards: comboCards, combo });
      }
    }
  }

  for (let seqIndex = 0; seqIndex < STRAIGHT_SEQUENCES.length; seqIndex += 1) {
    const sequence = STRAIGHT_SEQUENCES[seqIndex];
    const straightCards = [];
    for (let rankIndex = 0; rankIndex < sequence.length; rankIndex += 1) {
      const rankCards = groups[sequence[rankIndex]];
      if (!rankCards || rankCards.length === 0) {
        straightCards.length = 0;
        break;
      }
      straightCards.push(rankCards.slice().sort(compareSuit)[0]);
    }
    if (straightCards.length === 4) {
      const combo = analyzeCards(straightCards);
      if (canBeat(combo, previousCombo)) {
        combos.push({ cards: straightCards, combo });
      }
    }
  }

  combos.sort(compareMoves);
  return combos;
}

function compareSuit(a, b) {
  return a.suitValue - b.suitValue;
}

function compareMoves(a, b) {
  if (a.combo.strength !== b.combo.strength) {
    return a.combo.strength - b.combo.strength;
  }
  if (a.cards.length !== b.cards.length) {
    return a.cards.length - b.cards.length;
  }
  return typeOrder(a.combo.type) - typeOrder(b.combo.type);
}

function typeOrder(type) {
  if (type === "single") {
    return 0;
  }
  if (type === "pair") {
    return 1;
  }
  if (type === "triple") {
    return 2;
  }
  if (type === "straight4") {
    return 3;
  }
  if (type === "quad") {
    return 4;
  }
  return 9;
}

function getPlayLabel(cards) {
  if (!cards || cards.length === 0) {
    return "过";
  }
  const combo = analyzeCards(cards);
  const cardsLabel = cards.slice().sort(compareCardsForLabel).map(function mapCard(card) {
    return card.rank + card.suit;
  }).join(" ");
  return combo ? combo.label + " " + cardsLabel : cardsLabel;
}

function isGameOver(state) {
  for (let index = 0; index < state.players.length; index += 1) {
    if (state.players[index].hand.length === 0) {
      return {
        over: true,
        winnerId: state.players[index].id,
        message: state.players[index].name + " 率先出完手牌，游戏结束。"
      };
    }
  }
  return { over: false, winnerId: null, message: "" };
}

function scorePenalty(cardCount) {
  if (cardCount <= 0) {
    return 0;
  }
  if (cardCount <= 7) {
    return cardCount;
  }
  if (cardCount <= 9) {
    return cardCount * 2;
  }
  if (cardCount <= 12) {
    return cardCount * 3;
  }
  return 52;
}

function scoreRound(state, winnerId) {
  const details = [];
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    const penalty = player.id === winnerId ? 0 : scorePenalty(player.hand.length);
    player.roundScore = penalty;
    player.score = (player.score || 0) + penalty;
    details.push({
      playerId: player.id,
      playerName: player.name,
      cardsLeft: player.hand.length,
      penalty,
      total: player.score
    });
  }
  return details;
}

function findSpecialDeal(players) {
  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    if (hasAllTwos(player.hand)) {
      return {
        playerId: player.id,
        playerName: player.name,
        type: "four_twos",
        message: player.name + " 拿到四张 2，其余每人加 52 分。"
      };
    }
    if (allCardsAtMostTen(player.hand)) {
      return {
        playerId: player.id,
        playerName: player.name,
        type: "all_small",
        message: player.name + " 拿到全部小于等于 10 的牌，其余每人加 52 分。"
      };
    }
    if (allCardsGreaterThanTen(player.hand)) {
      return {
        playerId: player.id,
        playerName: player.name,
        type: "all_big",
        message: player.name + " 拿到全部大于 10 的牌，其余每人加 52 分。"
      };
    }
  }
  return null;
}

function hasAllTwos(hand) {
  let twos = 0;
  for (let index = 0; index < hand.length; index += 1) {
    if (hand[index].rank === "2") {
      twos += 1;
    }
  }
  return twos === 4;
}

function allCardsAtMostTen(hand) {
  if (!hand || hand.length === 0) {
    return false;
  }
  for (let index = 0; index < hand.length; index += 1) {
    if (numericRank(hand[index].rank) > 10) {
      return false;
    }
  }
  return true;
}

function allCardsGreaterThanTen(hand) {
  if (!hand || hand.length === 0) {
    return false;
  }
  for (let index = 0; index < hand.length; index += 1) {
    if (numericRank(hand[index].rank) <= 10) {
      return false;
    }
  }
  return true;
}

function numericRank(rank) {
  if (rank === "A") {
    return 14;
  }
  if (rank === "K") {
    return 13;
  }
  if (rank === "Q") {
    return 12;
  }
  if (rank === "J") {
    return 11;
  }
  return Number(rank);
}

function scoreSpecialDeal(state, special) {
  const details = [];
  for (let index = 0; index < state.players.length; index += 1) {
    const player = state.players[index];
    const penalty = player.id === special.playerId ? 0 : 52;
    player.roundScore = penalty;
    player.score = (player.score || 0) + penalty;
    details.push({
      playerId: player.id,
      playerName: player.name,
      cardsLeft: player.hand.length,
      penalty,
      total: player.score
    });
  }
  return details;
}

function roundScoreForFinalSettlement(score) {
  const numericScore = Number(score);
  return Number.isFinite(numericScore) ? Math.round(numericScore) : 0;
}

function roundPlayerScores(players) {
  for (let index = 0; index < players.length; index += 1) {
    players[index].score = roundScoreForFinalSettlement(players[index].score);
  }
  return players;
}

function calculateFinalSettlement(players) {
  const entries = [];
  const netByPlayerId = {};
  const scoreByPlayerId = {};

  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    netByPlayerId[player.id] = 0;
    scoreByPlayerId[player.id] = roundScoreForFinalSettlement(player.score);
  }

  for (let left = 0; left < players.length; left += 1) {
    for (let right = left + 1; right < players.length; right += 1) {
      const a = players[left];
      const b = players[right];
      const aScore = scoreByPlayerId[a.id];
      const bScore = scoreByPlayerId[b.id];
      if (aScore === bScore) {
        continue;
      }

      const payer = aScore > bScore ? a : b;
      const receiver = aScore > bScore ? b : a;
      const amount = Math.abs(aScore - bScore);

      netByPlayerId[payer.id] -= amount;
      netByPlayerId[receiver.id] += amount;
      entries.push({
        fromPlayerId: payer.id,
        fromPlayerName: payer.name,
        toPlayerId: receiver.id,
        toPlayerName: receiver.name,
        amount
      });
    }
  }

  return {
    entries,
    net: players.map(function mapNet(player) {
      return {
        playerId: player.id,
        playerName: player.name,
        score: scoreByPlayerId[player.id],
        amount: netByPlayerId[player.id]
      };
    })
  };
}

function compareCardsForLabel(a, b) {
  if (getRankValue(a.rank) !== getRankValue(b.rank)) {
    return getRankValue(a.rank) - getRankValue(b.rank);
  }
  return a.suitValue - b.suitValue;
}

module.exports = {
  ruleInfo,
  RANK_ORDER,
  STRAIGHT_SEQUENCES,
  getStartingPlayer,
  getRankValue,
  analyzeCards,
  canBeat,
  canPlay,
  canPass,
  chooseAutoMove,
  findLegalMoves,
  getPlayLabel,
  isGameOver,
  scorePenalty,
  scoreRound,
  findSpecialDeal,
  scoreSpecialDeal,
  roundPlayerScores,
  calculateFinalSettlement
};
