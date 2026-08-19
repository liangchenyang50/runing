"use strict";

const assert = require("assert");

function noop() {}

const context = {
  setTransform: noop,
  clearRect: noop,
  fillRect: noop,
  beginPath: noop,
  arc: noop,
  fill: noop,
  moveTo: noop,
  lineTo: noop,
  quadraticCurveTo: noop,
  closePath: noop,
  stroke: noop,
  fillText: noop,
  measureText: function measureText(text) {
    return { width: String(text).length * 8 };
  },
  createLinearGradient: function createLinearGradient() {
    return { addColorStop: noop };
  }
};

global.wx = {
  createCanvas: function createCanvas() {
    return {
      width: 0,
      height: 0,
      getContext: function getContext() {
        return context;
      }
    };
  },
  getSystemInfoSync: function getSystemInfoSync() {
    return { pixelRatio: 1, windowWidth: 375, windowHeight: 667 };
  },
  onTouchEnd: noop,
  onShow: noop
};

require("../game");

assert.ok(true, "game entry loads with a mocked WeChat canvas");
console.log("game smoke test passed");
