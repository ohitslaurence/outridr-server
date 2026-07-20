// Standalone process for the WS_MAX_CONNECTIONS / WS_IDLE_MS tests in
// websocket.test.mjs. Those knobs are read once, at module load of
// lib/websocket.mjs (via lib/server.mjs), and the rest of websocket.test.mjs
// shares one process whose first startTestServer() call already froze the
// defaults (32 / 10 min) into that module instance — so a non-default value
// needs its own process, set via env before this script's first import that
// pulls lib/websocket.mjs in. Invoked by the parent test via spawnSync with
// OUTRIDR_WS_MAX_CONNECTIONS / OUTRIDR_WS_IDLE_MS already set in its env.
//
// Does not wait on server.close()'s callback: an upgraded (post-101) raw
// socket that the client abruptly destroys is not always reaped from
// http.Server's internal connection bookkeeping promptly, matching the
// fire-and-forget `t.after(() => server.close())` style already used
// elsewhere in this suite. The result is written with a synchronous fd
// write (not process.stdout.write) and process.exit(0) called explicitly,
// since an async stdout write racing an immediate exit can be truncated
// when stdout is a pipe (as it is under spawnSync).
import { writeSync } from "node:fs";

import { connectRawWs, startTestServer } from "./helpers.mjs";

const mode = process.argv[2];

function report(result) {
  writeSync(1, JSON.stringify(result));
  process.exit(0);
}

async function runCap() {
  const { server, port } = await startTestServer();
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const client = await connectRawWs(port, "/herdr");
    if (client.statusCode !== 101) {
      throw new Error(`connection ${i}: expected 101, got ${client.statusCode}`);
    }
    clients.push(client);
  }
  const third = await connectRawWs(port, "/herdr");
  const result = { thirdStatusCode: third.statusCode };
  for (const client of clients) {
    client.close();
  }
  third.close();
  server.close();
  report(result);
}

async function runIdle() {
  const { server, port } = await startTestServer();
  const client = await connectRawWs(port, "/herdr");
  if (client.statusCode !== 101) {
    throw new Error(`expected 101, got ${client.statusCode}`);
  }
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("idle timeout did not close the connection in time")), 5000);
    client.socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    client.socket.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const result = { elapsedMs: Date.now() - start };
  server.close();
  report(result);
}

function run() {
  if (mode === "cap") {
    return runCap();
  }
  if (mode === "idle") {
    return runIdle();
  }
  throw new Error(`unknown mode: ${mode}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
