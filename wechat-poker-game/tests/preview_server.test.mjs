import assert from "node:assert/strict";
import { createPreviewServer } from "../preview/server.mjs";

const server = createPreviewServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, body) {
  const options = body == null
    ? {}
    : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
  const response = await fetch(`${baseUrl}${path}`, options);
  assert.equal(response.ok, true, `${path} should succeed`);
  return response.json();
}

try {
  const setup = await request("/api/state");
  assert.equal(setup.active, false, "preview starts at setup screen");

  const started = await request("/api/start", {});
  assert.equal(started.active, true, "start activates a game");
  assert.equal(started.players.length, 4, "start returns four players");
  assert.equal(started.players[0].hand.length, 13, "local player has 13 cards");

  const hinted = await request("/api/hint", {});
  assert.equal(
    hinted.players[0].hand.some((card) => card.selected),
    true,
    "hint selects a legal local move"
  );

  const firstCardId = hinted.players[0].hand.find((card) => !card.selected).id;
  const toggled = await request("/api/toggle", { cardId: firstCardId });
  const selectedCard = toggled.players[0].hand.find((card) => card.id === firstCardId);
  assert.equal(selectedCard.selected, true, "toggle selects a local card");

  await request("/api/hint", {});
  const played = await request("/api/play", {});
  assert.equal(typeof played.message, "string", "play returns updated state");
  assert.notEqual(played.message, "", "play updates message even if combo is invalid");
  assert.equal(played.lastPlay === null || Array.isArray(played.lastPlay.cards), true, "play exposes visible cards for the table");
  assert.equal(Array.isArray(played.tableActions), true, "play returns a visible action for each seat");
  assert.equal(played.tableActions.length > 0, true, "the current trick keeps its table actions");

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.ok, true, "preview page loads");
  assert.match(await page.text(), /四人扑克/, "preview page contains title");

  console.log("preview server smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
