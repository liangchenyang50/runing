import assert from "node:assert/strict";
import { readPort, startLocalDebug } from "../preview/local-debug.mjs";

assert.equal(readPort(5188), 5188, "a valid debug port is preserved");
assert.equal(readPort("bad"), 5178, "an invalid debug port uses the default");

const preview = await startLocalDebug(0);
try {
  assert.equal(preview.host, "127.0.0.1", "the debug server only listens on loopback");
  assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, "the debug server exposes a loopback URL");

  const page = await fetch(preview.url);
  assert.equal(page.ok, true, "the local debug page loads");
  assert.match(await page.text(), /四人扑克/, "the local debug page serves the game UI");
  console.log("local debug server test passed");
} finally {
  await new Promise((resolve) => preview.server.close(resolve));
}
