"use strict";

const rules = require("./rules/custom_rules");

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = rules.RANK_ORDER || ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const PLAYER_NAMES = ["你", "左家", "对家", "右家"];

function createDeck() {
  const deck = [];
  for (let suitIndex = 0; suitIndex < SUITS.length; suitIndex += 1) {
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      const rank = RANKS[rankIndex];
      const suit = SUITS[suitIndex];
      deck.push({
        id: suit + rank,
        suit,
        rank,
        rankValue: typeof rules.getRankValue === "function" ? rules.getRankValue(rank) : rankIndex,
        suitValue: suitIndex,
        color: suit === "♥" || suit === "♦" ? "red" : "black",
        selected: false
      });
    }
  }
  return deck;
}

function shuffle(deck, rng) {
  const random = rng || Math.random;
  const shuffled = deck.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function sortHand(hand) {
  hand.sort(function compareCards(a, b) {
    if (a.rankValue !== b.rankValue) {
      return a.rankValue - b.rankValue;
    }
    return a.suitValue - b.suitValue;
  });
}

function deal(deck, scores) {
  const players = PLAYER_NAMES.map(function makePlayer(name, index) {
    return {
      id: index,
      name,
      hand: [],
      score: scores && scores[index] ? scores[index] : 0,
      roundScore: 0
    };
  });

  for (let index = 0; index < deck.length; index += 1) {
    players[index % players.length].hand.push(deck[index]);
  }

  for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
    sortHand(players[playerIndex].hand);
  }

  return players;
}

function normalizeOptions(options) {
  if (typeof options === "function") {
    return { rng: options };
  }
  return options || {};
}

function createGame(options) {
  const settings = normalizeOptions(options);
  const rng = settings.rng || Math.random;
  const deck = settings.deck ? settings.deck.slice() : shuffle(createDeck(), rng || Math.random);
  const scores = settings.scores || (settings.previousState
    ? settings.previousState.players.map(function mapScore(player) { return player.score || 0; })
    : null);
  const players = deal(deck, scores);
  const requestedStarter = typeof settings.startingPlayer === "number"
    ? settings.startingPlayer
    : settings.previousState && typeof settings.previousState.winnerId === "number"
      ? settings.previousState.winnerId
      : undefined;
  const firstPlayer = typeof rules.getStartingPlayer === "function"
    ? rules.getStartingPlayer({ players, startingPlayer: requestedStarter })
    : 0;
  const targetScore = settings.targetScore || (settings.previousState && settings.previousState.targetScore) || 100;

  const state = {
    rng,
    ruleInfo: rules.ruleInfo || {},
    targetScore,
    players,
    currentPlayer: firstPlayer,
    discardPile: [],
    selectedCards: [],
    trick: {
      leaderId: firstPlayer,
      lastPlayerId: null,
      lastPlay: null,
      passesSincePlay: 0
    },
    phase: "playing",
    message: players[firstPlayer].name + " 先出牌。请选择单张、对子、三张、四张，或四张顺子。",
    winnerId: null,
    turnCount: 1,
    roundResult: null,
    specialDeal: null,
    finalSettlement: null
  };

  applySpecialDealIfNeeded(state);
  return state;
}

function getPlayer(state, playerId) {
  return state.players[playerId];
}

function clearSelection(state) {
  for (let playerIndex = 0; playerIndex < state.players.length; playerIndex += 1) {
    const hand = state.players[playerIndex].hand;
    for (let cardIndex = 0; cardIndex < hand.length; cardIndex += 1) {
      hand[cardIndex].selected = false;
    }
  }
  state.selectedCards = [];
}

function toggleCardSelection(state, playerId, cardId) {
  if (!state || state.phase !== "playing" || state.currentPlayer !== playerId) {
    return state;
  }

  const player = getPlayer(state, playerId);
  for (let index = 0; index < player.hand.length; index += 1) {
    const card = player.hand[index];
    if (card.id === cardId) {
      card.selected = !card.selected;
      break;
    }
  }

  state.selectedCards = player.hand.filter(function selected(card) {
    return card.selected;
  });

  return state;
}

function selectCardIds(state, playerId, cardIds) {
  if (!state || state.phase !== "playing" || state.currentPlayer !== playerId) {
    return state;
  }

  const selectedIds = {};
  for (let index = 0; index < cardIds.length; index += 1) {
    selectedIds[cardIds[index]] = true;
  }

  const player = getPlayer(state, playerId);
  for (let cardIndex = 0; cardIndex < player.hand.length; cardIndex += 1) {
    player.hand[cardIndex].selected = Boolean(selectedIds[player.hand[cardIndex].id]);
  }

  state.selectedCards = player.hand.filter(function selected(card) {
    return card.selected;
  });

  return state;
}

function getLastPlay(state) {
  if (state.trick && state.trick.lastPlay) {
    return state.trick.lastPlay;
  }
  return null;
}

function playSelected(state) {
  if (!state || state.phase !== "playing") {
    return state;
  }

  const player = getPlayer(state, state.currentPlayer);
  state.selectedCards = player.hand.filter(function selected(card) {
    return card.selected;
  });

  const decision = rules.canPlay({
    state,
    player,
    selectedCards: state.selectedCards,
    discardPile: state.discardPile,
    lastPlay: getLastPlay(state)
  });

  if (!decision.ok) {
    state.message = decision.reason || "当前选择不符合规则。";
    return state;
  }

  const selectedIds = {};
  for (let index = 0; index < state.selectedCards.length; index += 1) {
    selectedIds[state.selectedCards[index].id] = true;
  }

  const playedCards = [];
  player.hand = player.hand.filter(function keepUnplayed(card) {
    if (selectedIds[card.id]) {
      card.selected = false;
      playedCards.push(card);
      return false;
    }
    return true;
  });

  state.discardPile.push({
    playerId: player.id,
    playerName: player.name,
    cards: playedCards,
    label: rules.getPlayLabel(playedCards),
    combo: decision.combo
  });

  state.trick.lastPlayerId = player.id;
  state.trick.lastPlay = state.discardPile[state.discardPile.length - 1];
  state.trick.passesSincePlay = 0;

  clearSelection(state);

  const over = rules.isGameOver(state);
  if (over.over) {
    state.phase = "finished";
    state.winnerId = over.winnerId;
    state.roundResult = typeof rules.scoreRound === "function"
      ? rules.scoreRound(state, over.winnerId)
      : null;
    if (isMatchOver(state)) {
      state.phase = "gameOver";
      state.finalSettlement = calculateFinalSettlement(state);
      state.message = over.message + " 已达到目标分，整场结束。";
    } else {
      state.message = over.message + " 点击下一局，赢家先出。";
    }
    return state;
  }

  state.message = player.name + " 出了 " + rules.getPlayLabel(playedCards) + "。";
  nextTurn(state);
  return state;
}

function passTurn(state) {
  if (!state || state.phase !== "playing") {
    return state;
  }

  const player = getPlayer(state, state.currentPlayer);
  const lastPlay = getLastPlay(state);
  const decision = typeof rules.canPass === "function"
    ? rules.canPass({
      state,
      player,
      discardPile: state.discardPile,
      lastPlay
    })
    : { ok: true, reason: "" };

  if (!decision.ok) {
    state.message = decision.reason || "当前不能过牌。";
    return state;
  }

  state.discardPile.push({
    playerId: player.id,
    playerName: player.name,
    cards: [],
    label: "过"
  });
  clearSelection(state);

  if (lastPlay && state.trick) {
    state.trick.passesSincePlay += 1;
    if (state.trick.passesSincePlay >= state.players.length - 1) {
      state.currentPlayer = state.trick.lastPlayerId;
      state.trick = {
        leaderId: state.trick.lastPlayerId,
        lastPlayerId: null,
        lastPlay: null,
        passesSincePlay: 0
      };
      state.turnCount += 1;
      state.message = "一轮结束，" + state.players[state.currentPlayer].name + " 获得新一轮先手。";
      return state;
    }
  }

  state.message = player.name + " 无牌可接，选择过牌。";
  nextTurn(state);
  return state;
}

function nextTurn(state) {
  // Seats are rendered as: you (bottom), left, opposite, right. Play moves right -> opposite -> left.
  state.currentPlayer = (state.currentPlayer + state.players.length - 1) % state.players.length;
  state.turnCount += 1;
  return state;
}

function autoPlayOneCard(state) {
  if (!state || state.phase !== "playing" || state.currentPlayer === 0) {
    return state;
  }

  const player = getPlayer(state, state.currentPlayer);
  if (player.hand.length === 0) {
    return state;
  }

  clearSelection(state);
  const move = typeof rules.chooseAutoMove === "function"
    ? rules.chooseAutoMove({
      state,
      player,
      discardPile: state.discardPile,
      lastPlay: getLastPlay(state)
    })
    : { type: "play", cardIds: [player.hand[0].id] };

  if (!move || move.type === "pass") {
    return passTurn(state);
  }

  selectCardIds(state, player.id, move.cardIds || []);
  return playSelected(state);
}

function createNextRound(previousState, rng) {
  return createGame({
    rng: rng || previousState.rng || Math.random,
    previousState,
    startingPlayer: previousState.winnerId,
    targetScore: previousState.targetScore
  });
}

function applySpecialDealIfNeeded(state) {
  if (typeof rules.findSpecialDeal !== "function") {
    return state;
  }

  const special = rules.findSpecialDeal(state.players);
  if (!special) {
    return state;
  }

  state.specialDeal = special;
  state.phase = "finished";
  state.winnerId = special.playerId;
  state.roundResult = typeof rules.scoreSpecialDeal === "function"
    ? rules.scoreSpecialDeal(state, special)
    : null;

  if (isMatchOver(state)) {
    state.phase = "gameOver";
    state.finalSettlement = calculateFinalSettlement(state);
    state.message = special.message + " 已达到目标分，整场结束。";
  } else {
    state.message = special.message + " 点击下一局，由触发者先出。";
  }

  return state;
}

function isMatchOver(state) {
  for (let index = 0; index < state.players.length; index += 1) {
    if ((state.players[index].score || 0) >= state.targetScore) {
      return true;
    }
  }
  return false;
}

function calculateFinalSettlement(state) {
  if (typeof rules.calculateFinalSettlement !== "function") {
    return null;
  }
  return rules.calculateFinalSettlement(state.players);
}

module.exports = {
  createDeck,
  shuffle,
  deal,
  createGame,
  toggleCardSelection,
  selectCardIds,
  playSelected,
  passTurn,
  autoPlayOneCard,
  clearSelection,
  getLastPlay,
  createNextRound,
  isMatchOver,
  calculateFinalSettlement
};
