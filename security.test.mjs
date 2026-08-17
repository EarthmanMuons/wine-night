import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) pass++;
  else {
    fail++;
    console.error("FAIL:", name);
  }
}

const index = readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
const event = readFileSync(new URL("./src/event.ts", import.meta.url), "utf8");
const stats = readFileSync(new URL("./src/stats.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

check("request bodies are read through the streaming size guard", index.includes("request.body.getReader()"));
check("routes do not bypass the guarded JSON reader", !index.includes("request.json()"));
check("compressed request bodies are rejected", index.includes("compressed request bodies are not supported"));
check("unknown rooms do not initialize SQLite storage", event.includes("if (this.hasSchema()) this.initializeSchema()"));
check("unknown rooms cannot open WebSockets", event.includes('return new Response("Room not found", { status: 404 })'));
check("WebSocket connections are capped per room", event.includes("MAX_ROOM_SOCKETS"));
check("unused WebSocket snapshot requests are not accepted", !event.includes('case "getSnapshot"'));
check("public snapshots do not expose the participant roster", event.includes("const participants = caller.isHost"));
check("automatic room codes use browser cryptography", app.includes("crypto.getRandomValues(bytes)"));
check("host archive downloads require host authorization", index.includes('path === "/api/host/archive"') && index.includes("authorizedStub(env, room, hostKey(request))"));
check("removing a participant from the roster requires host authorization", index.slice(index.indexOf('/api/host/remove-participant'), index.indexOf('/api/host/reset')).includes("authorizedStub(env, body.room, hostKey(request))"));
check("host archives do not serialize private notes", !event.slice(event.indexOf("exportHostArchive"), event.indexOf("restoreHostArchive")).includes("SELECT wine_id, note FROM notes"));
check("restores issue fresh participant credentials", event.slice(event.indexOf("restoreHostArchive")).includes("crypto.randomUUID() + crypto.randomUUID()"));
check("restore payloads have a dedicated size ceiling", index.includes("MAX_ARCHIVE_BYTES"));
check("host backups cannot expose ballots before the full reveal", event.includes("room backups with ballots are available after the full reveal"));
check("the public site-stats table only ever stores aggregate day/count columns, never room-identifying data", /CREATE TABLE IF NOT EXISTS daily_counts \(\s*day TEXT PRIMARY KEY,\s*count INTEGER NOT NULL DEFAULT 0\s*\);/.test(stats));
check("site stats are intentionally public with only a rate limit, no host authorization", /path === "\/api\/site-stats"[\s\S]{0,200}allowRequest/.test(index) && !/path === "\/api\/site-stats"[\s\S]{0,400}authorizedStub/.test(index));
check("a room is only counted in site stats after it is actually created, not on a failed attempt", index.includes("if (r.ok) await recordRoomCreated(env)") && index.includes("if (result.ok) await recordRoomCreated(env)"));
check("a site-stats hiccup can never break room creation", index.includes("async function recordRoomCreated(env: Env) {\n  try {"));

console.log(`\n${pass} security tests passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
