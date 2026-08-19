"use strict";

const assert = require("assert");

let pageConfig = null;

global.Page = function Page(config) {
  pageConfig = config;
};

require("../pages/index/index");

assert.ok(pageConfig, "mini program page registers");
assert.strictEqual(typeof pageConfig.startGame, "function", "startGame handler exists");
assert.strictEqual(typeof pageConfig.playSelected, "function", "playSelected handler exists");

const pageInstance = Object.assign({}, pageConfig, {
  data: Object.assign({}, pageConfig.data),
  setData: function setData(patch) {
    this.data = Object.assign({}, this.data, patch);
  }
});

pageInstance.startGame();
assert.ok(pageInstance.data.state, "startGame creates game state");
assert.strictEqual(pageInstance.data.players.length, 4, "page exposes four players");

console.log("mini program page smoke test passed");
