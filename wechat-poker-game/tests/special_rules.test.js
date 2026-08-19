"use strict";

const assert = require("assert");
const rules = require("../js/rules/custom_rules");

function card(rank, suitIndex) {
  const suits = ["♠", "♥", "♦", "♣"];
  const suit = suits[suitIndex || 0];
  return {
    id: suit + rank,
    rank,
    suit,
    rankValue: rules.getRankValue(rank),
    suitValue: suitIndex || 0
  };
}

function player(id, hand) {
  return { id, name: "P" + id, hand, score: 0 };
}

const allSmall = ["3", "4", "5", "6", "7", "8", "9", "10", "3", "4", "5", "6", "7"].map(function rankAt(rank, index) {
  return card(rank, index % 4);
});
assert.strictEqual(
  rules.findSpecialDeal([player(0, allSmall), player(1, []), player(2, []), player(3, [])]).type,
  "all_small",
  "all <= 10 special is detected"
);

const allBig = ["J", "Q", "K", "A", "J", "Q", "K", "A", "J", "Q", "K", "A", "J"].map(function rankAt(rank, index) {
  return card(rank, index % 4);
});
assert.strictEqual(
  rules.findSpecialDeal([player(0, allBig), player(1, []), player(2, []), player(3, [])]).type,
  "all_big",
  "all > 10 special is detected"
);

const pairThree = { combo: rules.analyzeCards([card("3", 0), card("3", 1)]) };
const moves = rules.findLegalMoves([card("4", 0), card("4", 1), card("8", 0), card("8", 1)], pairThree);
assert.strictEqual(moves[0].combo.rank, "4", "auto move chooses the smallest valid response");

const singleThree = { combo: rules.analyzeCards([card("3", 0)]) };
const singleMoves = rules.findLegalMoves([card("4", 0), card("8", 0)], singleThree);
assert.strictEqual(singleMoves[0].combo.type, "single", "single can answer single");
assert.strictEqual(singleMoves[0].combo.rank, "4", "auto move chooses smallest single response");

const passDecision = rules.canPass({
  player: player(1, [card("4", 0), card("4", 1)]),
  lastPlay: pairThree
});
assert.strictEqual(passDecision.ok, false, "player cannot pass with a valid response");

const singlePassDecision = rules.canPass({
  player: player(1, [card("4", 0)]),
  lastPlay: singleThree
});
assert.strictEqual(singlePassDecision.ok, false, "player cannot pass with a valid single response");

console.log("special poker rule tests passed");
