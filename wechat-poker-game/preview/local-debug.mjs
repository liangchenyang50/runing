import { listenWithFallback } from "./server.mjs";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 5178;

export function readPort(value) {
  const supplied = Number(value);
  return Number.isInteger(supplied) && supplied > 0 && supplied < 65536
    ? supplied
    : DEFAULT_PORT;
}

export function startLocalDebug(port = DEFAULT_PORT) {
  const requestedPort = Number(port);
  const startPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort < 65536
    ? requestedPort
    : DEFAULT_PORT;
  return listenWithFallback(startPort, "127.0.0.1");
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && normalize(process.argv[1]) === normalize(filename)) {
  const preview = await startLocalDebug(process.argv[2]);
  console.log(`Local debug server running at ${preview.url}`);
  console.log("This server only accepts connections from this computer.");
}
