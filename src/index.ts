import { WineNightEvent } from "./event";
import { MAX_ARCHIVE_BYTES } from "./archive";
import type { Phase } from "./types";

const ROOM_PREFIX = "wn:";
const ROOM_RE = /^[A-Z0-9]{2,8}$/;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function normalizedRoom(room: unknown): string | null {
  const value = String(room ?? "").trim().toUpperCase();
  return ROOM_RE.test(value) ? value : null;
}

function roomStub(env: Env, room: string) {
  const name = ROOM_PREFIX + room;
  return env.EVENTS.get(env.EVENTS.idFromName(name));
}

/** Ensure a host key is valid for the room; returns the stub or null. */
async function authorizedStub(
  env: Env,
  room: string,
  key: string | null,
): Promise<ReturnType<typeof roomStub> | null> {
  const validRoom = normalizedRoom(room);
  if (!validRoom || !key) return null;
  const stub = roomStub(env, validRoom);
  const ok = await stub.verifyHostKey({ key });
  return ok ? stub : null;
}

const hostKey = (request: Request) => request.headers.get("X-Host-Key");
const participantId = (request: Request) => request.headers.get("X-Participant-Id");
const participantKey = (request: Request) => request.headers.get("X-Participant-Key");

async function authorizedParticipantStub(
  env: Env,
  room: string,
  request: Request,
): Promise<{ stub: ReturnType<typeof roomStub>; participantId: string } | null> {
  const validRoom = normalizedRoom(room);
  const id = participantId(request);
  const key = participantKey(request);
  if (!validRoom || !id || !key) return null;
  const stub = roomStub(env, validRoom);
  const ok = await stub.verifyParticipantKey({ participantId: id, key });
  return ok ? { stub, participantId: id } : null;
}

// --- light anti-abuse: per-IP rate limiting for room creation (per-edge node).
// This is an effort deterrent, not a hard guarantee. A platform rate-limit rule or
// server-validated Turnstile challenge is still needed for determined abuse.
const attempts = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8; // creates per minute per IP

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

function allowRequest(ip: string, bucket: string, max: number): boolean {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const cur = attempts.get(key);
  if (!cur || cur.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (attempts.size > 10_000) {
      for (const [entry, value] of attempts) {
        if (value.resetAt < now) attempts.delete(entry);
      }
    }
    return true;
  }
  if (cur.count >= max) return false;
  cur.count++;
  return true;
}

async function readJson<T>(request: Request, maximumBytes = MAX_REQUEST_BODY_BYTES): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new RequestError("content type must be application/json", 415);
  }
  const contentEncoding = request.headers.get("content-encoding")?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new RequestError("compressed request bodies are not supported", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maximumBytes) {
      throw new RequestError("request body too large", 413);
    }
  }
  if (!request.body) throw new RequestError("JSON request body required", 400);

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new RequestError("request body too large", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestError("invalid JSON request body", 400);
  }
}

const json = (data: unknown, status = 200, extraHeaders?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
const bad = (error: string) => json({ error }, 400);

export { WineNightEvent };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- WebSocket: live sync ---------------------------------------------
    if (path === "/ws" && request.headers.get("Upgrade") === "websocket") {
      const room = normalizedRoom(url.searchParams.get("room"));
      if (!room) return bad("room required");
      if (!allowRequest(clientIp(request), "ws", 60)) {
        return json({ error: "too many connections; wait a minute" }, 429);
      }
      return roomStub(env, room).fetch(request);
    }

    // ---- HTTP API: host + fallback polling --------------------------------
    try {
      if (path.startsWith("/api/") && request.method === "POST") {
        const contentLength = Number(request.headers.get("content-length") || 0);
        const maximumBytes = path === "/api/host/restore" ? MAX_ARCHIVE_BYTES : MAX_REQUEST_BODY_BYTES;
        if (contentLength > maximumBytes) {
          return json({ error: "request body too large" }, 413);
        }
        if (!allowRequest(clientIp(request), "mutation", 240)) {
          return json({ error: "too many requests; wait a minute" }, 429);
        }
      }
      if (request.method === "GET" && path === "/api/snapshot") {
        const room = normalizedRoom(url.searchParams.get("room"));
        if (!room) return bad("room required");
        if (!allowRequest(clientIp(request), "snapshot", 180)) {
          return json({ error: "too many requests; wait a minute" }, 429);
        }
        return json(
          await roomStub(env, room).getSnapshot({
            participantId: participantId(request) ?? undefined,
            participantKey: participantKey(request) ?? undefined,
            hostKey: hostKey(request) ?? undefined,
          }),
        );
      }

      if (request.method === "GET" && path === "/api/host/archive") {
        const room = normalizedRoom(url.searchParams.get("room"));
        if (!room) return bad("room required");
        const stub = await authorizedStub(env, room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        const archive = await stub.exportHostArchive();
        if ("error" in archive) return bad(archive.error);
        const date = archive.exportedAt.slice(0, 10);
        return json(archive, 200, {
          "content-disposition": `attachment; filename="wine-night-${room}-${date}.json"`,
        });
      }

      if (request.method === "POST" && path === "/api/host/restore") {
        if (
          !allowRequest(clientIp(request), "create", RATE_MAX) ||
          !allowRequest(clientIp(request), "restore", 2)
        ) {
          return json({ error: "too many restores from this device; wait a minute" }, 429);
        }
        const body = await readJson<{ room: string; archive: unknown }>(request, MAX_ARCHIVE_BYTES);
        const room = normalizedRoom(body.room);
        if (!room) return bad("room codes must be 2-8 letters or numbers");
        const result = await roomStub(env, room).restoreHostArchive({
          roomId: room,
          archive: body.archive,
        });
        return result.ok ? json(result, 201) : bad(result.error ?? "restore failed");
      }

      if (request.method === "POST" && path === "/api/host/create") {
        if (!allowRequest(clientIp(request), "create", RATE_MAX)) {
          return json({ error: "too many rooms from this device; wait a minute" }, 429);
        }
        const body = await readJson<{
          room: string;
          theme?: string;
          pot?: number;
          hostName?: string;
        }>(request);
        const room = normalizedRoom(body.room);
        if (!room) return bad("room codes must be 2-8 letters or numbers");
        const r = await roomStub(env, room).initEvent({
          roomId: room,
          theme: body.theme ?? "",
          pot: body.pot ?? 0,
          hostName: body.hostName ?? "",
        });
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/participant/join") {
        if (!allowRequest(clientIp(request), "join", 30)) {
          return json({ error: "too many joins; wait a minute" }, 429);
        }
        const body = await readJson<{
          room: string;
          name: string;
          mode: "ranked" | "numeric" | "top3";
          numericMax?: number;
        }>(request);
        const room = normalizedRoom(body.room);
        if (!room) return bad("valid room required");
        const result = await roomStub(env, room).addParticipant({
          name: body.name,
          mode: body.mode,
          numericMax: body.numericMax,
        });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/participant/ballot") {
        const body = await readJson<{
          room: string;
          mode: "ranked" | "numeric" | "top3";
          numericMax?: number;
          ratings: { wineId: string; value: number }[];
          notes?: { wineId: string; note: string }[];
        }>(request);
        const auth = await authorizedParticipantStub(env, body.room, request);
        if (!auth) return json({ error: "unauthorized" }, 403);
        const result = await auth.stub.submitBallot({
          participantId: auth.participantId,
          mode: body.mode,
          numericMax: body.numericMax,
          ratings: body.ratings,
          notes: body.notes,
        });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/participant/clear") {
        const body = await readJson<{ room: string; mode: "ranked" | "numeric" | "top3" }>(request);
        const auth = await authorizedParticipantStub(env, body.room, request);
        if (!auth) return json({ error: "unauthorized" }, 403);
        const result = await auth.stub.clearBallot({ participantId: auth.participantId, mode: body.mode });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/participant/rename") {
        const body = await readJson<{ room: string; name: string }>(request);
        const auth = await authorizedParticipantStub(env, body.room, request);
        if (!auth) return json({ error: "unauthorized" }, 403);
        const result = await auth.stub.renameParticipant({ participantId: auth.participantId, name: body.name });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/participant/leave") {
        const body = await readJson<{ room: string }>(request);
        const auth = await authorizedParticipantStub(env, body.room, request);
        if (!auth) return json({ error: "unauthorized" }, 403);
        const result = await auth.stub.leaveVoting({ participantId: auth.participantId });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/wine") {
        const body = await readJson<{
          room: string;
          bagNumber: number;
          name: string;
          producer?: string;
          price?: number;
          broughtBy?: string;
        }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.name?.trim() || !body.bagNumber) {
          return bad("room, bag number, and wine name required");
        }
        const r = await stub.addWine({
          bagNumber: body.bagNumber,
          name: body.name,
          producer: body.producer ?? "",
          price: body.price ?? 0,
          broughtBy: body.broughtBy ?? "",
        });
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/phase") {
        const body = await readJson<{ room: string; phase: Phase }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.phase) return bad("room and phase required");
        const r = await stub.setPhase(body.phase);
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/reveal-next") {
        const body = await readJson<{ room: string }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        const result = await stub.advanceReveal();
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/current-pour") {
        const body = await readJson<{ room: string; wineId: string }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.wineId) return bad("wineId required");
        const result = await stub.setCurrentPour({ wineId: body.wineId });
        return result.ok ? json(result) : bad(result.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/remove-wine") {
        const body = await readJson<{ room: string; wineId: string }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.wineId) return bad("room and wineId required");
        const r = await stub.removeWine({ wineId: body.wineId });
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/edit-wine") {
        const body = await readJson<{
          room: string;
          wineId: string;
          bagNumber?: number;
          name?: string;
          producer?: string;
          price?: number;
          broughtBy?: string;
        }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.wineId) return bad("room and wineId required");
        const r = await stub.editWine({
          wineId: body.wineId,
          bagNumber: body.bagNumber,
          name: body.name,
          producer: body.producer,
          price: body.price,
          broughtBy: body.broughtBy,
        });
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/remove-participant") {
        const body = await readJson<{ room: string; participantId: string }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        if (!body.participantId) return bad("room and participantId required");
        const r = await stub.leaveVoting({ participantId: body.participantId });
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }

      if (request.method === "POST" && path === "/api/host/reset") {
        const body = await readJson<{ room: string; mode: "setup" | "all" }>(request);
        const stub = await authorizedStub(env, body.room, hostKey(request));
        if (!stub) return json({ error: "unauthorized" }, 403);
        const r: { ok: boolean; error?: string } =
          body.mode === "all" ? await stub.resetAll() : await stub.resetToSetup();
        return r.ok ? json(r) : bad(r.error ?? "failed");
      }
    } catch (e) {
      if (e instanceof RequestError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }

    // ---- Static assets ------------------------------------------------------
    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "same-origin");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
