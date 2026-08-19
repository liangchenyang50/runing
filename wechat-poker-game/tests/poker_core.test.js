"use strict";

const assert = require("assert");
const poker = require("../js/poker_core");
const rules = require("../js/rules/custom_rules");

function makeCard(rank, suit, suitValue) {
  const cardSuit = suit || "♠";
  const value = typeof suitValue === "number" ? suitValue : ["♠", "♥", "♦", "♣"].indexOf(cardSuit);
  return {
    id: cardSuit + rank,
    suit: cardSuit,
    rank,
    rankValue: rules.getRankValue(rank),
    suitValue: value,
    color: cardSuit === "♥" || cardSuit === "♦" ? "red" : "black",
    selected: false
  };
}

function cardsOf(rank, count) {
  return ["♠", "♥", "♦", "♣"].slice(0, count).map(function mapSuit(suit, index) {
    return makeCard(rank, suit, index);
  });
}

function deckForPlayerZero(playerZeroCards) {
  const selected = {};
  for (let index = 0; index < playerZeroCards.length; index += 1) {
    selected[playerZeroCards[index].id] = true;
  }

  const remaining = poker.createDeck().filter(function keep(card) {
    return !selected[card.id];
  });
  const deck = [];
  let cursor = 0;
  for (let round = 0; round < 13; round += 1) {
    deck.push(playerZeroCards[round]);
    for (let player = 1; player < 4; player += 1) {
      deck.push(remaining[cursor]);
      cursor += 1;
    }
  }
  return deck;
}

const deck = poker.createDeck();
assert.strictEqual(deck.length, 52, "one deck has 52 cards");
assert.strictEqual(new Set(deck.map(function id(card) { return card.id; })).size, 52, "cards are unique");
assert.strictEqual(deck.some(function hasJoker(card) { return card.rank === "joker"; }), false, "deck has no jokers");
assert.strictEqual(rules.getRankValue("3"), 0, "3 is the smallest rank");
assert.strictEqual(rules.getRankValue("2"), 12, "2 is the largest rank");

assert.strictEqual(rules.analyzeCards([makeCard("3")]).type, "single", "single card is legal");
assert.strictEqual(rules.analyzeCards(cardsOf("4", 2)).type, "pair", "pair is legal");
assert.strictEqual(rules.analyzeCards(cardsOf("5", 3)).type, "triple", "triple is legal");
assert.strictEqual(rules.analyzeCards(cardsOf("6", 4)).type, "quad", "four of a kind is legal");
assert.strictEqual(
  rules.analyzeCards([makeCard("A"), makeCard("2"), makeCard("3"), makeCard("4")]).type,
  "straight4",
  "A234 straight is legal"
);
assert.strictEqual(
  rules.analyzeCards([makeCard("J"), makeCard("Q"), makeCard("K"), makeCard("A")]).type,
  "straight4",
  "JQKA straight is legal"
);

const game = poker.createGame({ rng: function fixedRandom() { return 0.42; }, targetScore: 200 });
assert.strictEqual(game.players.length, 4, "game has four players");
assert.strictEqual(game.currentPlayer, 0, "default rule starts from local player");
assert.strictEqual(game.targetScore, 200, "target score is configurable");
assert.deepStrictEqual(
  game.players.map(function handSize(player) { return player.hand.length; }),
  [13, 13, 13, 13],
  "one deck is dealt evenly to four players"
);

const flow = poker.createGame({ rng: function fixedRandom() { return 0.6; }, targetScore: 200 });
flow.players[0].hand = cardsOf("3", 2).concat(cardsOf("9", 2));
flow.players[1].hand = cardsOf("6", 2).concat(cardsOf("8", 2));
flow.players[2].hand = cardsOf("5", 2).concat(cardsOf("7", 2));
flow.players[3].hand = cardsOf("4", 2).concat(cardsOf("6", 2));

poker.selectCardIds(flow, 0, [flow.players[0].hand[0].id, flow.players[0].hand[1].id]);
poker.playSelected(flow);
assert.strictEqual(flow.players[0].hand.length, 2, "playing a pair removes two cards");
assert.strictEqual(flow.discardPile[0].combo.type, "pair", "played combo is recorded");
assert.strictEqual(flow.currentPlayer, 3, "turn moves from local player to right player");
assert.strictEqual(flow.trick.actions[0].playerId, 0, "local play is stored for the table");

poker.passTurn(flow);
assert.strictEqual(flow.currentPlayer, 3, "right player cannot pass when a response is available");
assert.match(flow.message, /必须打出来/, "forced response message is shown");

poker.selectCardIds(flow, 3, [flow.players[3].hand[0].id, flow.players[3].hand[1].id]);
poker.playSelected(flow);
assert.strictEqual(flow.currentPlayer, 2, "right player hands the turn to the opposite player");
assert.strictEqual(poker.getLastPlay(flow).playerId, 3, "last non-pass play is tracked");

poker.selectCardIds(flow, 2, [flow.players[2].hand[0].id, flow.players[2].hand[1].id]);
poker.playSelected(flow);
assert.strictEqual(flow.currentPlayer, 1, "opposite player hands the turn to the left player");

poker.selectCardIds(flow, 1, [flow.players[1].hand[0].id, flow.players[1].hand[1].id]);
poker.playSelected(flow);
assert.strictEqual(flow.currentPlayer, 0, "left player hands the turn back to the local player");
assert.deepStrictEqual(
  flow.trick.actions.map(function playerId(action) { return action.playerId; }),
  [0, 3, 2, 1],
  "every player play is retained in clockwise table order"
);

const autoPassFlow = poker.createGame({ rng: function fixedRandom() { return 0.51; }, targetScore: 200 });
autoPassFlow.players[3].hand = [makeCard("3")];
autoPassFlow.currentPlayer = 3;
autoPassFlow.trick = {
  leaderId: 0,
  lastPlayerId: 0,
  lastPlay: { combo: rules.analyzeCards(cardsOf("9", 2)) },
  passesSincePlay: 0,
  actions: []
};
poker.autoPlayOneCard(autoPassFlow);
assert.strictEqual(autoPassFlow.currentPlayer, 2, "auto player skips to the opposite player when it cannot beat the last play");
assert.strictEqual(autoPassFlow.trick.actions[0].label, "要不起", "an automatic skip records the visible pass label");

const singleFlow = poker.createGame({ rng: function fixedRandom() { return 0.7; }, targetScore: 200 });
singleFlow.players[0].hand = [makeCard("3")];
singleFlow.players[1].hand = [makeCard("4")];
singleFlow.players[2].hand = [makeCard("5")];
singleFlow.players[3].hand = [makeCard("6")];
poker.selectCardIds(singleFlow, 0, [singleFlow.players[0].hand[0].id]);
poker.playSelected(singleFlow);
assert.strictEqual(singleFlow.discardPile[0].combo.type, "single", "single play is recorded");
assert.strictEqual(singleFlow.phase, "finished", "single card can finish a hand");

const p0FourTwos = cardsOf("2", 4)
  .concat(cardsOf("3", 2))
  .concat(cardsOf("4", 2))
  .concat(cardsOf("5", 2))
  .concat(cardsOf("6", 2))
  .concat([makeCard("7")]);
const specialGame = poker.createGame({ deck: deckForPlayerZero(p0FourTwos), targetScore: 500 });
assert.strictEqual(specialGame.phase, "finished", "four twos ends the round immediately");
assert.strictEqual(specialGame.specialDeal.type, "four_twos", "four twos special is detected");
assert.match(specialGame.message, /下一轮/, "a finished round clearly invites the next round");
assert.deepStrictEqual(
  specialGame.players.map(function score(player) { return player.score; }),
  [0, 52, 52, 52],
  "other players receive 52 points for four twos"
);

const targetGame = poker.createGame({ deck: deckForPlayerZero(p0FourTwos), targetScore: 52 });
assert.strictEqual(targetGame.phase, "gameOver", "target score ends the full game");
assert.ok(targetGame.finalSettlement, "final settlement is created when match ends");
assert.deepStrictEqual(
  targetGame.finalSettlement.net.map(function net(item) { return item.amount; }),
  [156, -52, -52, -52],
  "higher scores pay lower scores by score difference"
);

const nextRound = poker.createNextRound(specialGame, function nextRandom() { return 0.25; });
assert.strictEqual(nextRound.currentPlayer, specialGame.winnerId, "winner starts the next round");
assert.strictEqual(nextRound.targetScore, 500, "target score carries into the next round");
assert.deepStrictEqual(
  nextRound.players.map(function score(player) { return player.score; }),
  [0, 52, 52, 52],
  "scores carry into the next round"
);
assert.deepStrictEqual(
  nextRound.players.map(function handSize(player) { return player.hand.length; }),
  [13, 13, 13, 13],
  "next round is dealt again"
);

assert.strictEqual(rules.scorePenalty(7), 7, "seven cards score x1");
assert.strictEqual(rules.scorePenalty(8), 16, "eight cards score x2");
assert.strictEqual(rules.scorePenalty(10), 30, "ten cards score x3");
assert.strictEqual(rules.scorePenalty(13), 52, "thirteen cards score 52");

const settlement = rules.calculateFinalSettlement([
  { id: 0, name: "A", score: 0 },
  { id: 1, name: "B", score: 10 },
  { id: 2, name: "C", score: 20 },
  { id: 3, name: "D", score: 20 }
]);
assert.deepStrictEqual(
  settlement.net.map(function net(item) { return item.amount; }),
  [50, 10, -30, -30],
  "pairwise settlement nets all score differences"
);
assert.strictEqual(
  settlement.net.reduce(function sum(total, item) { return total + item.amount; }, 0),
  0,
  "settlement net balances to zero"
);

const fractionalPlayers = [
  { id: 0, name: "A", score: 0.49 },
  { id: 1, name: "B", score: 1.5 },
  { id: 2, name: "C", score: 2.49 },
  { id: 3, name: "D", score: 3.5 }
];
rules.roundPlayerScores(fractionalPlayers);
const roundedSettlement = rules.calculateFinalSettlement(fractionalPlayers);
assert.deepStrictEqual(
  fractionalPlayers.map(function score(player) { return player.score; }),
  [0, 2, 2, 4],
  "final settlement rounds every player score first"
);
assert.deepStrictEqual(
  roundedSettlement.net.map(function net(item) { return item.score; }),
  [0, 2, 2, 4],
  "settlement displays rounded player scores"
);
assert.deepStrictEqual(
  roundedSettlement.net.map(function net(item) { return item.amount; }),
  [8, 0, 0, -8],
  "pairwise settlement uses rounded scores"
);

console.log("four-player poker rules tests passed");
