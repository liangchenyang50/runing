"use strict";

const poker = require("../../js/poker_core");

function viewState(state, selectedTargetScore) {
  if (!state) {
    return {
      state: null,
      players: [],
      handGroups: [],
      targetScore: selectedTargetScore,
      message: "",
      lastPlayText: "等待出牌",
      roundResult: [],
      finalSettlement: null,
      myTurn: false,
      resetLabel: "重开"
    };
  }

  const last = state.discardPile[state.discardPile.length - 1];
  const finalSettlement = state.finalSettlement ? {
    entries: state.finalSettlement.entries,
    net: state.finalSettlement.net.map(function mapNet(item) {
      return {
        playerId: item.playerId,
        playerName: item.playerName,
        score: item.score,
        amount: item.amount,
        amountText: item.amount > 0 ? "+" + item.amount : String(item.amount)
      };
    })
  } : null;

  return {
    state,
    players: state.players,
    handGroups: groupHand(state.players[0].hand),
    targetScore: state.targetScore,
    message: state.message,
    lastPlayText: last ? last.playerName + "：" + last.label : "等待出牌",
    roundResult: state.roundResult || [],
    finalSettlement,
    myTurn: state.phase === "playing" && state.currentPlayer === 0,
    resetLabel: state.phase === "finished" ? "下一轮" : state.phase === "gameOver" ? "新游戏" : "重开"
  };
}

function groupHand(cards) {
  const groups = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const last = groups[groups.length - 1];
    if (last && last.rank === card.rank) {
      last.cards.push(card);
    } else {
      groups.push({
        key: card.rank + "-" + groups.length,
        rank: card.rank,
        cards: [card],
        heightRpx: 132
      });
    }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    group.heightRpx = 72 + (group.cards.length - 1) * 28;
    for (let cardIndex = 0; cardIndex < group.cards.length; cardIndex += 1) {
      group.cards[cardIndex].stackTopRpx = cardIndex * 28;
    }
  }

  return groups;
}

Page({
  data: {
    state: null,
    players: [],
    handGroups: [],
    selectedTargetScore: 100,
    targetScore: 100,
    targetOptions: [100, 200, 500],
    message: "",
    lastPlayText: "等待出牌",
    roundResult: [],
    finalSettlement: null,
    myTurn: false,
    resetLabel: "重开"
  },

  chooseTargetScore: function chooseTargetScore(event) {
    const score = Number(event.currentTarget.dataset.score);
    this.setData({
      selectedTargetScore: score,
      targetScore: score
    });
  },

  startGame: function startGame() {
    const state = poker.createGame({ targetScore: this.data.selectedTargetScore });
    this.runAutoPlayers(state);
    this.commitState(state);
  },

  resetRound: function resetRound() {
    const current = this.data.state;
    if (!current) {
      this.startGame();
      return;
    }

    if (current.phase === "gameOver") {
      this.setData(viewState(null, this.data.selectedTargetScore));
      return;
    }

    const state = current.phase === "finished"
      ? poker.createNextRound(current)
      : poker.createGame({ targetScore: current.targetScore || this.data.selectedTargetScore });
    this.runAutoPlayers(state);
    this.commitState(state);
  },

  toggleCard: function toggleCard(event) {
    const state = this.data.state;
    if (!state) {
      return;
    }
    poker.toggleCardSelection(state, 0, event.currentTarget.dataset.cardId);
    this.commitState(state);
  },

  playSelected: function playSelected() {
    const state = this.data.state;
    if (!state) {
      return;
    }
    poker.playSelected(state);
    this.runAutoPlayers(state);
    this.commitState(state);
  },

  passTurn: function passTurn() {
    const state = this.data.state;
    if (!state) {
      return;
    }
    poker.passTurn(state);
    this.runAutoPlayers(state);
    this.commitState(state);
  },

  runAutoPlayers: function runAutoPlayers(state) {
    let guard = 0;
    while (state && state.phase === "playing" && state.currentPlayer !== 0 && guard < 32) {
      poker.autoPlayOneCard(state);
      guard += 1;
    }
  },

  commitState: function commitState(state) {
    this.setData(viewState(state, this.data.selectedTargetScore));
  }
});
