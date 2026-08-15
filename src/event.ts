import { DurableObject } from "cloudflare:workers";
import type { Mode, Phase, Rating } from "./types";
import {
  HOST_ARCHIVE_KIND,
  HOST_ARCHIVE_VERSION,
  type HostArchive,
  validateHostArchive,
} from "./archive";
import {
  Ballot,
  matchPartners,
  consensusRanking,
  consensusCorrelation,
  mostConsensual,
  pairwiseMatrix,
  condorcetWinner,
  scoresToRanks,
  computeAnalytics,
  presentationRevealOrder,
} from "./scoring";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'setup',
  pot REAL NOT NULL DEFAULT 0,
  host_name TEXT NOT NULL DEFAULT '',
  host_key TEXT NOT NULL DEFAULT '',
  reveal_step INTEGER NOT NULL DEFAULT 0,
  pour_position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS wines (
  id TEXT PRIMARY KEY,
  blind_code TEXT,
  name TEXT,
  producer TEXT,
  price REAL NOT NULL DEFAULT 0,
  brought_by TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT,
  mode TEXT,
  auth_key TEXT,
  numeric_max INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS ratings (
  participant_id TEXT,
  wine_id TEXT,
  value REAL NOT NULL,
  PRIMARY KEY (participant_id, wine_id)
);
CREATE TABLE IF NOT EXISTS notes (
  participant_id TEXT NOT NULL,
  wine_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (participant_id, wine_id)
);
`;

const MODES = new Set<Mode>(["ranked", "numeric", "top3"]);
const MAX_PARTICIPANTS = 100;
const MAX_WINES = 50;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ROOM_SOCKETS = 150;
const ROOM_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type SocketAttachment = {
  participantId: string | null;
  isHost: boolean;
  messageCount: number;
  messageWindow: number;
};

type SnapshotCaller = { participantId?: string; participantKey?: string; hostKey?: string };

/** A wine's blind code equals the physical bag number (1, 2, 3, ...) it lives in. */

export class WineNightEvent extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Do not create storage for random room probes. Existing rooms are migrated
    // when accessed, while new rooms initialize storage only after validation.
    if (this.hasSchema()) this.initializeSchema();
    // Hibernation-friendly: answer pings without waking the object.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  private hasSchema() {
    return Boolean(
      this.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event' LIMIT 1")
        .toArray()[0],
    );
  }

  private initializeSchema() {
    this.sql.exec(SCHEMA);
    this.ensureColumns();
  }

  private ensureColumns() {
    const eventColumns = new Set(
      (this.sql.exec("PRAGMA table_info(event)").toArray() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    if (!eventColumns.has("reveal_step")) {
      this.sql.exec("ALTER TABLE event ADD COLUMN reveal_step INTEGER NOT NULL DEFAULT 0");
    }
    if (!eventColumns.has("updated_at")) {
      this.sql.exec("ALTER TABLE event ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("UPDATE event SET updated_at = unixepoch() WHERE updated_at = 0");
    }
    if (!eventColumns.has("pour_position")) {
      this.sql.exec("ALTER TABLE event ADD COLUMN pour_position INTEGER NOT NULL DEFAULT 0");
    }
    const participantColumns = new Set(
      (
        this.sql.exec("PRAGMA table_info(participants)").toArray() as { name: string }[]
      ).map((column) => column.name),
    );
    if (!participantColumns.has("auth_key")) {
      this.sql.exec("ALTER TABLE participants ADD COLUMN auth_key TEXT");
    }
    if (!participantColumns.has("numeric_max")) {
      this.sql.exec(
        "ALTER TABLE participants ADD COLUMN numeric_max INTEGER NOT NULL DEFAULT 100",
      );
    }
  }

  // -------------------------------------------------------------------------
  // RPC: setup
  // -------------------------------------------------------------------------

  initEvent(input: { roomId: string; theme: string; pot: number; hostName: string }) {
    const roomId = String(input.roomId ?? "").trim().toUpperCase();
    const theme = String(input.theme ?? "").trim();
    const hostName = String(input.hostName ?? "").trim();
    const pot = Number(input.pot ?? 0);
    if (!/^[A-Z0-9]{2,8}$/.test(roomId)) {
      return { ok: false, error: "room codes must be 2-8 letters or numbers" };
    }
    if (theme.length > 120 || hostName.length > 40) {
      return { ok: false, error: "theme or host name is too long" };
    }
    if (!Number.isFinite(pot) || pot < 0 || pot > 100_000) {
      return { ok: false, error: "pot contribution must be between 0 and 100000" };
    }
    if (!this.hasSchema()) this.initializeSchema();
    const existing = this.sql
      .exec("SELECT id FROM event WHERE id = ?", roomId)
      .toArray()[0];
    if (existing) return { ok: false, error: "room already exists" };
    const hostKey = crypto.randomUUID() + crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO event (id, theme, pot, host_name, host_key) VALUES (?, ?, ?, ?, ?)",
      roomId,
      theme,
      pot,
      hostName,
      hostKey,
    );
    this.touchRoom();
    // The host key is returned exactly once (at creation); nothing reveals it afterward.
    return { ok: true, hostKey };
  }

  /**
   * Create a portable host archive. Only submitted participants are included.
   * Authentication keys and the separate private-notes table never leave storage.
   */
  exportHostArchive(): HostArchive | { error: string } {
    const ev = this.getEventRow();
    if (!ev) return { error: "event not created" };
    const wines = this.sql.exec("SELECT * FROM wines ORDER BY position").toArray() as {
      id: string;
      blind_code: string;
      name: string;
      producer: string;
      price: number;
      brought_by: string;
      position: number;
    }[];
    const participants = this.sql
      .exec(
        `SELECT p.id, p.name, p.mode, p.numeric_max
         FROM participants p
         WHERE p.auth_key IS NOT NULL
           AND EXISTS (SELECT 1 FROM ratings r WHERE r.participant_id = p.id)
         ORDER BY p.name, p.id`,
      )
      .toArray() as { id: string; name: string; mode: Mode; numeric_max: number }[];
    const submittedIds = new Set(participants.map((participant) => participant.id));
    const ratings = (
      this.sql.exec("SELECT participant_id, wine_id, value FROM ratings ORDER BY participant_id, wine_id").toArray() as {
        participant_id: string;
        wine_id: string;
        value: number;
      }[]
    ).filter((rating) => submittedIds.has(rating.participant_id));

    if (ratings.length) {
      const scoringWines = wines.map((wine) => ({ id: wine.id, blindCode: wine.blind_code }));
      const scoringRatings = ratings.map((rating) => ({
        participantId: rating.participant_id,
        wineId: rating.wine_id,
        value: rating.value,
      }));
      const revealCount = presentationRevealOrder(
        this.computeResults(scoringWines, scoringRatings),
      ).length;
      if (ev.phase !== "revealed" || ev.reveal_step < revealCount) {
        return { error: "room backups with ballots are available after the full reveal" };
      }
    }

    return {
      kind: HOST_ARCHIVE_KIND,
      version: HOST_ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      source: { room: ev.id, phase: ev.phase },
      event: { theme: ev.theme, pot: ev.pot, hostName: ev.host_name },
      wines: wines.map((wine, index) => ({
        archiveId: wine.id,
        blindCode: wine.blind_code,
        name: wine.name,
        producer: wine.producer,
        price: wine.price,
        broughtBy: wine.brought_by,
        position: index + 1,
      })),
      participants: participants.map((participant) => ({
        archiveId: participant.id,
        name: participant.name,
        mode: participant.mode,
        numericMax: participant.numeric_max,
      })),
      ratings: ratings.map((rating) => ({
        participantArchiveId: rating.participant_id,
        wineArchiveId: rating.wine_id,
        value: rating.value,
      })),
    };
  }

  /** Restore into a new room with fresh, undisclosed participant credentials. */
  restoreHostArchive(input: { roomId: string; archive: unknown }): {
    ok: boolean;
    hostKey?: string;
    phase?: "setup" | "revealed";
    error?: string;
  } {
    const roomId = String(input.roomId ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(roomId)) {
      return { ok: false, error: "room codes must be 2-8 letters or numbers" };
    }
    const checked = validateHostArchive(input.archive);
    if (!checked.ok) return checked;
    if (!this.hasSchema()) this.initializeSchema();
    if (this.sql.exec("SELECT id FROM event WHERE id = ?", roomId).toArray()[0]) {
      return { ok: false, error: "room already exists" };
    }

    const archive = checked.archive;
    const restoredPhase = archive.ratings.length ? "revealed" : "setup";
    const hostKey = crypto.randomUUID() + crypto.randomUUID();
    const wineIds = new Map(archive.wines.map((wine) => [wine.archiveId, crypto.randomUUID()]));
    const participantIds = new Map(
      archive.participants.map((participant) => [participant.archiveId, crypto.randomUUID()]),
    );

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO event
          (id, theme, phase, pot, host_name, host_key, reveal_step, pour_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        roomId,
        archive.event.theme,
        restoredPhase,
        archive.event.pot,
        archive.event.hostName,
        hostKey,
        restoredPhase === "revealed" ? 999 : 0,
      );
      for (const wine of archive.wines) {
        this.sql.exec(
          `INSERT INTO wines
            (id, blind_code, name, producer, price, brought_by, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          wineIds.get(wine.archiveId),
          wine.blindCode,
          wine.name,
          wine.producer,
          wine.price,
          wine.broughtBy,
          wine.position,
        );
      }
      for (const participant of archive.participants) {
        this.sql.exec(
          `INSERT INTO participants (id, name, mode, auth_key, numeric_max)
           VALUES (?, ?, ?, ?, ?)`,
          participantIds.get(participant.archiveId),
          participant.name,
          participant.mode,
          crypto.randomUUID() + crypto.randomUUID(),
          participant.numericMax,
        );
      }
      for (const rating of archive.ratings) {
        this.sql.exec(
          "INSERT INTO ratings (participant_id, wine_id, value) VALUES (?, ?, ?)",
          participantIds.get(rating.participantArchiveId),
          wineIds.get(rating.wineArchiveId),
          rating.value,
        );
      }
    });
    this.touchRoom();
    return { ok: true, hostKey, phase: restoredPhase };
  }

  /** Verify a host key for host-only mutations. Always false if the event lacks a key. */
  verifyHostKey(input: { key?: string }) {
    const ev = this.getEventRow();
    if (!ev || !ev.host_key || !input.key) return false;
    return ev.host_key === input.key;
  }

  verifyParticipantKey(input: { participantId?: string; key?: string }) {
    if (!input.participantId || !input.key) return false;
    if (!this.hasSchema()) return false;
    const row = this.sql
      .exec(
        "SELECT id FROM participants WHERE id = ? AND auth_key = ?",
        input.participantId,
        input.key,
      )
      .toArray()[0];
    return Boolean(row);
  }

  addWine(input: {
    bagNumber: number;
    name: string;
    producer: string;
    price: number;
    broughtBy: string;
  }): { ok: boolean; error?: string } {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (ev.phase !== "setup") return { ok: false, error: "past setup phase" };
    if (this.countRows("wines") >= MAX_WINES) {
      return { ok: false, error: `a room can have at most ${MAX_WINES} wines` };
    }
    const bag = Math.floor(Number(input.bagNumber));
    if (!Number.isFinite(bag) || bag < 1) {
      return { ok: false, error: "bag number must be 1 or higher" };
    }
    // Each physical bag can only hold one bottle.
    const taken = this.sql
      .exec("SELECT id FROM wines WHERE blind_code = ?", String(bag))
      .toArray()[0];
    if (taken) return { ok: false, error: `bag ${bag} is already assigned` };
    const name = String(input.name ?? "").trim();
    const producer = String(input.producer ?? "").trim();
    const broughtBy = String(input.broughtBy ?? "").trim();
    const price = Number(input.price ?? 0);
    if (!name || name.length > 120) return { ok: false, error: "wine name must be 1-120 characters" };
    if (producer.length > 120 || broughtBy.length > 120) {
      return { ok: false, error: "producer and brought-by must be 120 characters or fewer" };
    }
    if (!Number.isFinite(price) || price < 0 || price > 100_000) {
      return { ok: false, error: "price must be between 0 and 100000" };
    }
    const id = crypto.randomUUID();
    const position = this.sql
      .exec("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM wines")
      .one().p as number;
    this.sql.exec(
      "INSERT INTO wines (id, blind_code, name, producer, price, brought_by, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      String(bag),
      name,
      producer,
      price,
      broughtBy,
      position,
    );
    this.broadcastSnapshot();
    return { ok: true };
  }

  addParticipant(input: { name: string; mode: Mode; numericMax?: number }): {
    ok: boolean;
    participantId?: string;
    participantKey?: string;
    error?: string;
  } {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (ev.phase !== "tasting") return { ok: false, error: "joining is only open during tasting" };
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    if (name.length > 40) return { ok: false, error: "name must be 40 characters or fewer" };
    if (!MODES.has(input.mode)) return { ok: false, error: "unknown scoring mode" };
    if (this.countRows("participants") >= MAX_PARTICIPANTS) {
      return { ok: false, error: `a room can have at most ${MAX_PARTICIPANTS} participants` };
    }
    const id = crypto.randomUUID();
    const participantKey = crypto.randomUUID() + crypto.randomUUID();
    const mode = input.mode;
    const numericMax = this.validNumericMax(input.numericMax ?? 100);
    if (numericMax === null) {
      return { ok: false, error: "numeric scale maximum must be a whole number from 2 to 1000" };
    }
    this.sql.exec(
      "INSERT INTO participants (id, name, mode, auth_key, numeric_max) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      mode,
      participantKey,
      numericMax,
    );
    this.broadcastSnapshot();
    return { ok: true, participantId: id, participantKey };
  }

  setPhase(phase: string) {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (phase === "tasting") {
      if (ev.phase !== "setup") return { ok: false, error: "tasting can only start from setup" };
      if (this.countRows("wines") < 2) return { ok: false, error: "add at least two wines first" };
    } else if (phase === "revealed") {
      if (ev.phase !== "tasting") return { ok: false, error: "results can only be revealed from tasting" };
      const validRatings = Number(
        this.sql
          .exec(
            "SELECT COUNT(*) AS count FROM ratings r JOIN participants p ON p.id = r.participant_id WHERE p.auth_key IS NOT NULL",
          )
          .one().count,
      );
      if (validRatings === 0) return { ok: false, error: "at least one ballot is required" };
    } else {
      return { ok: false, error: "unknown or unsupported phase transition" };
    }
    this.sql.exec(
      "UPDATE event SET phase = ?, reveal_step = 0, pour_position = ? WHERE id = ?",
      phase,
      phase === "tasting" ? 1 : ev.pour_position,
      ev.id,
    );
    this.broadcastSnapshot();
    return { ok: true };
  }

  advanceReveal() {
    const ev = this.getEventRow();
    if (!ev || ev.phase !== "revealed") return { ok: false, error: "reveal has not started" };
    const wines = (
      this.sql.exec("SELECT id, blind_code FROM wines ORDER BY position").toArray() as {
        id: string;
        blind_code: string;
      }[]
    ).map((wine) => ({ id: wine.id, blindCode: wine.blind_code }));
    const ratings = (
      this.sql
        .exec(
          "SELECT r.* FROM ratings r JOIN participants p ON p.id = r.participant_id WHERE p.auth_key IS NOT NULL",
        )
        .toArray() as {
        participant_id: string;
        wine_id: string;
        value: number;
      }[]
    ).map((rating) => ({
      participantId: rating.participant_id,
      wineId: rating.wine_id,
      value: rating.value,
    }));
    const order = presentationRevealOrder(this.computeResults(wines, ratings));
    const next = Math.min(order.length, ev.reveal_step + 1);
    this.sql.exec("UPDATE event SET reveal_step = ? WHERE id = ?", next, ev.id);
    this.broadcastSnapshot();
    return { ok: true, complete: next >= order.length };
  }

  setCurrentPour(input: { wineId: string }) {
    const ev = this.getEventRow();
    if (!ev || ev.phase !== "tasting") return { ok: false, error: "tasting is not active" };
    const orderedIds = (
      this.sql.exec("SELECT id FROM wines ORDER BY CAST(blind_code AS INTEGER)").toArray() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const pourPosition = orderedIds.indexOf(input.wineId) + 1;
    if (pourPosition < 1) return { ok: false, error: "wine not found" };
    this.sql.exec("UPDATE event SET pour_position = ? WHERE id = ?", pourPosition, ev.id);
    this.broadcastSnapshot();
    return { ok: true };
  }

  removeWine(input: { wineId: string }) {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (ev.phase !== "setup") return { ok: false, error: "edit only during setup" };
    this.sql.exec("DELETE FROM ratings WHERE wine_id = ?", input.wineId);
    this.sql.exec("DELETE FROM notes WHERE wine_id = ?", input.wineId);
    this.sql.exec("DELETE FROM wines WHERE id = ?", input.wineId);
    this.broadcastSnapshot();
    return { ok: true };
  }

  editWine(input: {
    wineId: string;
    bagNumber?: number;
    name?: string;
    producer?: string;
    price?: number;
    broughtBy?: string;
  }) {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (ev.phase !== "setup") return { ok: false, error: "edit only during setup" };
    const cur = this.sql
      .exec("SELECT * FROM wines WHERE id = ?", input.wineId)
      .toArray()[0] as
      | { blind_code: string; name: string; producer: string; price: number; brought_by: string }
      | undefined;
    if (!cur) return { ok: false, error: "wine not found" };
    const bagNumber = input.bagNumber != null ? Math.floor(Number(input.bagNumber)) : Number(cur.blind_code);
    if (!Number.isFinite(bagNumber) || bagNumber < 1) {
      return { ok: false, error: "bag number must be 1 or higher" };
    }
    const bag = String(bagNumber);
    if (bag !== cur.blind_code) {
      const taken = this.sql
        .exec("SELECT id FROM wines WHERE blind_code = ? AND id <> ?", bag, input.wineId)
        .toArray()[0];
      if (taken) return { ok: false, error: `bag ${bag} is already assigned` };
    }
    const name = input.name != null ? String(input.name).trim() : cur.name;
    const producer = input.producer != null ? String(input.producer).trim() : cur.producer;
    const broughtBy = input.broughtBy != null ? String(input.broughtBy).trim() : cur.brought_by;
    const price = input.price != null ? Number(input.price) : cur.price;
    if (!name || name.length > 120) return { ok: false, error: "wine name must be 1-120 characters" };
    if (producer.length > 120 || broughtBy.length > 120) {
      return { ok: false, error: "producer and brought-by must be 120 characters or fewer" };
    }
    if (!Number.isFinite(price) || price < 0 || price > 100_000) {
      return { ok: false, error: "price must be between 0 and 100000" };
    }
    this.sql.exec(
      "UPDATE wines SET blind_code = ?, name = ?, producer = ?, price = ?, brought_by = ? WHERE id = ?",
      bag,
      name,
      producer,
      price,
      broughtBy,
      input.wineId,
    );
    this.broadcastSnapshot();
    return { ok: true };
  }

  /** Back to setup, clearing everyone's scores (keeps wines so the host can edit). */
  resetToSetup() {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    this.sql.exec("DELETE FROM ratings");
    this.sql.exec("DELETE FROM notes");
    this.sql.exec("UPDATE event SET phase = 'setup', pour_position = 0 WHERE id = ?", ev.id);
    this.broadcastSnapshot();
    return { ok: true };
  }

  /** Wipe everything and start over (new empty event in the same room). */
  resetAll() {
    this.sql.exec("DELETE FROM ratings");
    this.sql.exec("DELETE FROM notes");
    this.sql.exec("DELETE FROM participants");
    this.sql.exec("DELETE FROM wines");
    const ev = this.getEventRow();
    if (ev) {
      this.sql.exec("UPDATE event SET phase = 'setup', reveal_step = 0, pour_position = 0 WHERE id = ?", ev.id);
    }
    this.broadcastSnapshot();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // RPC: ratings
  // -------------------------------------------------------------------------

  submitBallot(input: {
    participantId: string;
    mode: Mode;
    numericMax?: number;
    ratings: { wineId: string; value: number }[];
    notes?: { wineId: string; note: string }[];
  }) {
    const ev = this.getEventRow();
    if (!ev) return { ok: false, error: "event not created" };
    if (ev.phase !== "tasting") return { ok: false, error: "voting is closed" };
    if (!MODES.has(input.mode)) return { ok: false, error: "unknown scoring mode" };
    const numericMax = this.validNumericMax(input.numericMax ?? 100);
    if (numericMax === null) {
      return { ok: false, error: "numeric scale maximum must be a whole number from 2 to 1000" };
    }
    const participant = this.sql
      .exec("SELECT id FROM participants WHERE id = ?", input.participantId)
      .toArray()[0];
    if (!participant) return { ok: false, error: "participant not found" };

    const wineIds = (
      this.sql.exec("SELECT id FROM wines ORDER BY position").toArray() as { id: string }[]
    ).map((wine) => wine.id);
    const allowed = new Set(wineIds);
    const ratings = Array.isArray(input.ratings) ? input.ratings : [];
    const seenWines = new Set<string>();
    const seenValues = new Set<number>();
    for (const rating of ratings) {
      if (!allowed.has(rating.wineId) || seenWines.has(rating.wineId)) {
        return { ok: false, error: "ballot contains an unknown or duplicate wine" };
      }
      if (!Number.isFinite(rating.value)) return { ok: false, error: "rating must be a number" };
      seenWines.add(rating.wineId);
      if (input.mode === "numeric") {
        if (!Number.isInteger(rating.value) || rating.value < 1 || rating.value > numericMax) {
          return { ok: false, error: `numeric ratings must be whole numbers from 1 to ${numericMax}` };
        }
      } else {
        if (!Number.isInteger(rating.value) || rating.value < 1 || seenValues.has(rating.value)) {
          return { ok: false, error: "rank values must be unique positive integers" };
        }
        seenValues.add(rating.value);
      }
    }
    if (ratings.length === 0) return { ok: false, error: "score at least one wine" };
    if (input.mode === "ranked") {
      if (ratings.length !== wineIds.length || Math.max(...seenValues) !== wineIds.length) {
        return { ok: false, error: "a full ranking must rank every wine exactly once" };
      }
    }
    if (input.mode === "top3") {
      const expected = Math.min(3, wineIds.length);
      if (ratings.length !== expected || Math.max(...seenValues) !== expected) {
        return { ok: false, error: `top-three ballots must rank exactly ${expected} wines` };
      }
    }

    const notes = Array.isArray(input.notes) ? input.notes : [];
    const seenNotes = new Set<string>();
    for (const note of notes) {
      if (!allowed.has(note.wineId) || seenNotes.has(note.wineId)) {
        return { ok: false, error: "notes contain an unknown or duplicate wine" };
      }
      if (String(note.note ?? "").length > 1000) {
        return { ok: false, error: "each tasting note must be 1000 characters or fewer" };
      }
      seenNotes.add(note.wineId);
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ratings WHERE participant_id = ?", input.participantId);
      for (const rating of ratings) {
        this.sql.exec(
          "INSERT INTO ratings (participant_id, wine_id, value) VALUES (?, ?, ?)",
          input.participantId,
          rating.wineId,
          rating.value,
        );
      }
      this.sql.exec("DELETE FROM notes WHERE participant_id = ?", input.participantId);
      for (const note of notes) {
        const text = String(note.note ?? "").trim();
        if (text) {
          this.sql.exec(
            "INSERT INTO notes (participant_id, wine_id, note) VALUES (?, ?, ?)",
            input.participantId,
            note.wineId,
            text,
          );
        }
      }
      this.sql.exec(
        "UPDATE participants SET mode = ?, numeric_max = ? WHERE id = ?",
        input.mode,
        numericMax,
        input.participantId,
      );
    });
    this.broadcastSnapshot();
    return { ok: true };
  }

  /** Update a participant's display name (typos / edits before the reveal). */
  renameParticipant(input: { participantId: string; name: string }) {
    const ev = this.getEventRow();
    if (!ev || ev.phase !== "tasting") return { ok: false, error: "names are locked after reveal" };
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    if (name.length > 40) return { ok: false, error: "name must be 40 characters or fewer" };
    this.sql.exec(
      "UPDATE participants SET name = ? WHERE id = ?",
      name,
      input.participantId,
    );
    this.broadcastSnapshot();
    return { ok: true };
  }

  /** Clear a participant's ratings (used when they switch scoring method). */
  clearBallot(input: { participantId: string; mode: Mode }) {
    const ev = this.getEventRow();
    if (!ev || ev.phase !== "tasting") return { ok: false, error: "voting is closed" };
    if (!MODES.has(input.mode)) return { ok: false, error: "unknown scoring mode" };
    this.sql.exec(
      "DELETE FROM ratings WHERE participant_id = ?",
      input.participantId,
    );
    this.sql.exec(
      "UPDATE participants SET mode = ? WHERE id = ?",
      input.mode,
      input.participantId,
    );
    this.broadcastSnapshot();
    return { ok: true };
  }

  /**
   * Remove only this voter and their private voting data from an active tasting.
   * Used both for self-service leaving and for host cleanup of an abandoned or
   * duplicate join (e.g. someone who lost their session and had to rejoin).
   */
  leaveVoting(input: { participantId: string }) {
    const ev = this.getEventRow();
    if (!ev || ev.phase !== "tasting") return { ok: false, error: "voting is closed" };
    const participant = this.sql
      .exec("SELECT id FROM participants WHERE id = ? AND auth_key IS NOT NULL", input.participantId)
      .toArray()[0];
    if (!participant) return { ok: false, error: "participant not found" };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ratings WHERE participant_id = ?", input.participantId);
      this.sql.exec("DELETE FROM notes WHERE participant_id = ?", input.participantId);
      this.sql.exec("DELETE FROM participants WHERE id = ?", input.participantId);
    });
    this.broadcastSnapshot();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // RPC: snapshot / results (also used by polling fallback)
  // -------------------------------------------------------------------------

  getSnapshot(caller: SnapshotCaller = {}) {
    const isHost = Boolean(caller.hostKey && this.verifyHostKey({ key: caller.hostKey }));
    const participantId =
      caller.participantId &&
      caller.participantKey &&
      this.verifyParticipantKey({ participantId: caller.participantId, key: caller.participantKey })
        ? caller.participantId
        : null;
    return this.buildSnapshot({ participantId, isHost });
  }

  // -------------------------------------------------------------------------
  // WebSocket handling (Hibernation API)
  // -------------------------------------------------------------------------

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.getEventRow()) return new Response("Room not found", { status: 404 });
      if (this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS) {
        return new Response("Too many room connections", { status: 429 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        participantId: null,
        isHost: false,
        messageCount: 0,
        messageWindow: Date.now(),
      } satisfies SocketAttachment);
      this.send(server, {
        type: "snapshot",
        data: this.buildSnapshot({ participantId: null, isHost: false }),
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (
      (typeof message === "string" && message.length > MAX_MESSAGE_BYTES) ||
      (message instanceof ArrayBuffer && message.byteLength > MAX_MESSAGE_BYTES)
    ) {
      ws.close(1009, "message too large");
      return;
    }
    const stored = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
    const attachment: SocketAttachment = {
      participantId: stored?.participantId ?? null,
      isHost: stored?.isHost ?? false,
      messageCount: Number(stored?.messageCount ?? 0),
      messageWindow: Number(stored?.messageWindow ?? Date.now()),
    };
    const now = Date.now();
    if (now - attachment.messageWindow > 10_000) {
      attachment.messageWindow = now;
      attachment.messageCount = 0;
    }
    attachment.messageCount += 1;
    if (attachment.messageCount > 20) {
      ws.close(1008, "rate limit exceeded");
      return;
    }
    ws.serializeAttachment(attachment);
    let msg: any;
    try {
      msg = typeof message === "string" ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "rejoin": {
        if (this.verifyParticipantKey({ participantId: msg.participantId, key: msg.participantKey })) {
          attachment.participantId = msg.participantId;
          ws.serializeAttachment(attachment);
          this.send(ws, { type: "joined", participantId: msg.participantId });
          this.send(ws, {
            type: "snapshot",
            data: this.buildSnapshot({ participantId: attachment.participantId, isHost: attachment.isHost }),
          });
        } else {
          this.send(ws, { type: "error", error: "unknown participant" });
        }
        break;
      }
      case "hostAuth": {
        if (!this.verifyHostKey({ key: msg.hostKey })) {
          this.send(ws, { type: "error", error: "host authentication failed" });
          return;
        }
        attachment.isHost = true;
        ws.serializeAttachment(attachment);
        this.send(ws, {
          type: "snapshot",
          data: this.buildSnapshot({ participantId: attachment.participantId, isHost: true }),
        });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    ws.close();
  }

  async alarm() {
    const ev = this.getEventRow();
    if (!ev) return;
    const expiresAt = ev.updated_at * 1000 + ROOM_TTL_MS;
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(expiresAt);
  }

  private send(ws: WebSocket, obj: unknown) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      try {
        ws.close(1011, "connection failed");
      } catch {}
    }
  }

  private broadcastSnapshot() {
    this.touchRoom();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const stored = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      this.send(ws, {
        type: "snapshot",
        data: this.buildSnapshot({
          participantId: stored?.participantId ?? null,
          isHost: stored?.isHost ?? false,
        }),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot construction
  // -------------------------------------------------------------------------

  private getEventRow() {
    if (!this.hasSchema()) return undefined;
    return this.sql.exec("SELECT * FROM event WHERE id = ?", this.ctx.id.name?.replace(/^wn:/, "") ?? "").toArray()[0] as
      | {
          id: string;
          theme: string;
          phase: Phase;
          pot: number;
          host_name: string;
          host_key: string;
          reveal_step: number;
          pour_position: number;
          updated_at: number;
        }
      | undefined;
  }

  private buildSnapshot(caller: { participantId: string | null; isHost: boolean }) {
    const ev = this.getEventRow();
    if (!ev) return { exists: false };
    const phase = ev.phase;

    const wineRows = this.sql
      .exec("SELECT * FROM wines ORDER BY CAST(blind_code AS INTEGER)")
      .toArray() as {
        id: string;
        blind_code: string;
        name: string;
        producer: string;
        price: number;
        brought_by: string;
      }[];

    const allRatings = (
      this.sql
        .exec(
          "SELECT r.* FROM ratings r JOIN participants p ON p.id = r.participant_id WHERE p.auth_key IS NOT NULL",
        )
        .toArray() as {
        participant_id: string;
        wine_id: string;
        value: number;
      }[]
    ).map((rating) => ({
      participantId: rating.participant_id,
      wineId: rating.wine_id,
      value: rating.value,
    }));

    const scoringWines = wineRows.map((wine) => ({
      id: wine.id,
      blindCode: wine.blind_code,
    }));
    const fullResults = phase === "revealed" ? this.computeResults(scoringWines, allRatings) : [];
    const revealOrder = presentationRevealOrder(fullResults);
    const revealStep = Math.min(ev.reveal_step, revealOrder.length);
    const revealedPlaces = new Set(revealOrder.slice(0, revealStep));
    const presentationComplete = phase === "revealed" && revealStep >= revealOrder.length;
    const revealedWineIds = new Set(
      fullResults.filter((result) => revealedPlaces.has(result.place)).map((result) => result.wineId),
    );

    const wines = wineRows.map((w) => {
      const canSeeDetails =
        (phase === "setup" && caller.isHost) ||
        (phase === "revealed" && (presentationComplete || revealedWineIds.has(w.id)));
      return {
        id: w.id,
        blindCode: w.blind_code,
        name: canSeeDetails ? w.name : null,
        producer: canSeeDetails ? w.producer : null,
        price: canSeeDetails ? w.price : null,
        broughtBy: canSeeDetails ? w.brought_by : null,
      };
    });

    const submittedParticipantIds = new Set(allRatings.map((rating) => rating.participantId));
    const allParticipants = (
      this.sql.exec("SELECT * FROM participants WHERE auth_key IS NOT NULL ORDER BY name").toArray() as {
        id: string;
        name: string;
        mode: Mode;
        numeric_max: number;
      }[]
    ).map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      numericMax: p.numeric_max,
      ...(caller.isHost ? { hasSubmitted: submittedParticipantIds.has(p.id) } : {}),
    }));
    const participants = caller.isHost
      ? allParticipants
      : caller.participantId
        ? allParticipants.filter((participant) => participant.id === caller.participantId)
        : [];

    // A participant sees only their own ballot. The host receives all raw votes
    // only after the staged reveal has finished.
    const visibleRatings =
      caller.isHost && presentationComplete
        ? allRatings
        : allRatings.filter((rating) => rating.participantId === caller.participantId);
    const ratingsBy = new Map<string, Record<string, number>>();
    for (const r of visibleRatings) {
      const obj = ratingsBy.get(r.participantId) ?? {};
      obj[r.wineId] = r.value;
      ratingsBy.set(r.participantId, obj);
    }
    const ratings = Object.fromEntries(ratingsBy);

    const noteRows = caller.participantId
      ? (this.sql
          .exec(
            "SELECT wine_id, note FROM notes WHERE participant_id = ?",
            caller.participantId,
          )
          .toArray() as { wine_id: string; note: string }[])
      : [];
    const notes = Object.fromEntries(noteRows.map((note) => [note.wine_id, note.note]));

    const completedResults = presentationComplete ? fullResults : [];
    const visibleResults = presentationComplete
      ? fullResults
      : fullResults.filter((result) => revealedPlaces.has(result.place));
    const progress = {
      ballotsSubmitted: submittedParticipantIds.size,
      participantCount: allParticipants.length,
      wineCount: wineRows.length,
    };
    const fullAnalytics = presentationComplete
      ? this.computeAnalytics(wines, allRatings)
      : null;
    const analytics = fullAnalytics
      ? {
          wineStats: fullAnalytics.wineStats,
          participants: caller.isHost
            ? fullAnalytics.participants
            : caller.participantId && fullAnalytics.participants[caller.participantId]
              ? {
                  [caller.participantId]:
                    fullAnalytics.participants[caller.participantId],
                }
              : {},
        }
      : null;
    const fullCorrelation = presentationComplete
      ? this.computeCorrelations(wines, allRatings, allParticipants)
      : null;
    const correlation = fullCorrelation
      ? {
          wineIds: fullCorrelation.wineIds,
          matchByName: caller.isHost
            ? fullCorrelation.matchByName
            : caller.participantId && fullCorrelation.matchByName[caller.participantId]
              ? { [caller.participantId]: fullCorrelation.matchByName[caller.participantId] }
              : {},
          groupMatch: caller.isHost
            ? fullCorrelation.groupMatch
            : caller.participantId && fullCorrelation.groupMatch[caller.participantId] != null
              ? { [caller.participantId]: fullCorrelation.groupMatch[caller.participantId] }
              : {},
          mostConsensual: fullCorrelation.mostConsensual,
        }
      : null;

    const currentPourWine = phase === "tasting"
      ? wineRows[Math.max(0, Math.min(wineRows.length - 1, ev.pour_position - 1))]
      : null;

    return {
      exists: true,
      viewer: {
        isHost: caller.isHost,
        participantId: caller.participantId,
      },
      event: {
        room: ev.id,
        theme: ev.theme,
        phase,
        pot: ev.pot,
        contributionCount: wineRows.length,
        hostName: ev.host_name,
        pour: currentPourWine
          ? {
              position: ev.pour_position,
              total: wineRows.length,
              wineId: currentPourWine.id,
              wineCode: currentPourWine.blind_code,
            }
          : null,
        presentation:
          phase === "revealed"
            ? {
                complete: presentationComplete,
                revealedPlaces: [...revealedPlaces],
                nextPlace: revealOrder[revealStep] ?? null,
                lastPlace: Math.max(0, ...fullResults.map((result) => result.place)),
                step: revealStep,
                totalSteps: revealOrder.length,
              }
            : null,
      },
      wines,
      participants,
      ratings,
      notes,
      progress,
      results: phase === "revealed" ? visibleResults : null,
      analytics,
      correlation,
      confidence: presentationComplete
        ? this.computeConfidence(scoringWines, allRatings, completedResults)
        : null,
    };
  }

  /** Build rank ballots from stored ratings, converting per-participant mode. */
  private buildBallots(wineIds: string[], allRatings: Rating[]): Ballot[] {
    const byParticipant = new Map<string, Rating[]>();
    for (const r of allRatings) {
      const arr = byParticipant.get(r.participantId) ?? [];
      arr.push(r);
      byParticipant.set(r.participantId, arr);
    }
    const modeById = new Map<string, Mode>(
      (
        this.sql.exec("SELECT id, mode FROM participants WHERE auth_key IS NOT NULL").toArray() as {
          id: string;
          mode: Mode;
        }[]
      ).map((p) => [p.id, p.mode]),
    );
    const ballots: Ballot[] = [];
    for (const [pid, ratings] of byParticipant) {
      const mode = modeById.get(pid);
      if (mode === "numeric") {
        const scores = new Map<string, number>();
        for (const r of ratings) scores.set(r.wineId, r.value);
        ballots.push({ participantId: pid, ranks: scoresToRanks(scores), rawScores: scores });
      } else {
        const ranks = new Map<string, number>();
        for (const r of ratings) ranks.set(r.wineId, r.value);
        ballots.push({ participantId: pid, ranks });
      }
    }
    return ballots;
  }

  private computeCorrelations(
    wines: { id: string }[],
    allRatings: Rating[],
    participants: { id: string; name: string }[],
  ) {
    const wineIds = wines.map((w) => w.id);
    const ballots = this.buildBallots(wineIds, allRatings);
    const matches = matchPartners(ballots, wineIds);
    const group = consensusCorrelation(ballots, wineIds);
    const consensus = mostConsensual(ballots, wineIds);
    const names = new Map(participants.map((p) => [p.id, p.name]));
    const out: Record<string, { matchName: string; correlation: number }> = {};
    for (const [pid, m] of matches) {
      out[pid] = { matchName: names.get(m.matchId) ?? m.matchId, correlation: m.correlation };
    }
    return {
      wineIds,
      matchByName: out,
      groupMatch: Object.fromEntries(group),
      mostConsensual: consensus
        ? { name: names.get(consensus.participantId) ?? consensus.participantId, correlation: consensus.correlation }
        : null,
    };
  }

  private computeResults(
    wines: { id: string; blindCode: string }[],
    allRatings: Rating[],
  ) {
    const wineIds = wines.map((w) => w.id);
    const ballots = this.buildBallots(wineIds, allRatings);
    const ranking = consensusRanking(ballots, wineIds);
    const pairwise = pairwiseMatrix(ballots, wineIds);
    const definitiveWinner = condorcetWinner(pairwise, wineIds, ballots.length);
    const codeById = new Map(wines.map((w) => [w.id, w.blindCode]));
    let previousScore: number | null = null;
    let previousPlace = 0;
    return ranking.map((r, idx) => {
      let place = idx + 1;
      if (
        previousScore !== null &&
        r.score === previousScore &&
        !(idx === 1 && definitiveWinner === ranking[0]?.wineId)
      ) {
        place = previousPlace;
      }
      previousScore = r.score;
      previousPlace = place;
      return {
        place,
        wineId: r.wineId,
        blindCode: codeById.get(r.wineId),
        score: r.score,
        condorcetWinner: definitiveWinner === r.wineId,
      };
    });
  }

  private computeAnalytics(
    wines: { id: string; blindCode: string }[],
    allRatings: Rating[],
  ) {
    const wineIds = wines.map((w) => w.id);
    const ballots = this.buildBallots(wineIds, allRatings);
    const analytics = computeAnalytics(ballots, wineIds);
    // Restore blind codes so the client can label things without wine names leaking pre-reveal
    // (analytics is only shown at reveal anyway).
    const codeById = new Map(wines.map((w) => [w.id, w.blindCode]));
    return {
      wineStats: analytics.wineStats.map((s) => ({ ...s, blindCode: codeById.get(s.wineId) })),
      participants: analytics.participants,
    };
  }

  private computeConfidence(
    wines: { id: string }[],
    allRatings: Rating[],
    results: { wineId: string; score: number; place: number }[],
  ) {
    if (results.length < 2) return null;
    const wineIds = wines.map((wine) => wine.id);
    const ballots = this.buildBallots(wineIds, allRatings);
    const tiedWinners = results.filter((result) => result.place === 1);
    if (tiedWinners.length > 1) {
      return {
        level: "tied" as const,
        summary: "A true tie for first place",
        winnerShare: 0.5,
        compared: ballots.length,
        bordaMargin: 0,
        condorcetWinner: false,
      };
    }
    const winner = results[0].wineId;
    const runnerUp = results[1].wineId;
    const pairwise = pairwiseMatrix(ballots, wineIds);
    const favored = pairwise.matrix.get(winner)?.get(runnerUp) ?? 0;
    const opposed = pairwise.matrix.get(runnerUp)?.get(winner) ?? 0;
    const compared = favored + opposed;
    const winnerShare = compared ? favored / compared : 0.5;
    const bordaMargin = results[0].score - results[1].score;
    const maximum = Math.max(1, ballots.length * Math.max(1, wineIds.length - 1));
    const marginShare = bordaMargin / maximum;
    const hasCondorcetWinner =
      condorcetWinner(pairwise, wineIds, ballots.length) === winner;

    let level: "close" | "clear" | "decisive" = "close";
    if (ballots.length >= 3) {
      if (winnerShare >= 0.67 && marginShare >= 0.1) level = "decisive";
      else if (winnerShare >= 0.58 || marginShare >= 0.05 || hasCondorcetWinner) level = "clear";
    }

    const summary =
      ballots.length < 3
        ? "Too few ballots for a confident result"
        : level === "decisive"
        ? "A decisive crowd favorite"
        : level === "clear"
          ? "A clear winner, though not unanimous"
          : "A close result that could have gone either way";
    return {
      level,
      summary,
      winnerShare,
      compared,
      bordaMargin,
      condorcetWinner: hasCondorcetWinner,
    };
  }

  private countRows(table: "wines" | "participants") {
    if (table === "participants") {
      return Number(
        this.sql
          .exec("SELECT COUNT(*) AS count FROM participants WHERE auth_key IS NOT NULL")
          .one().count,
      );
    }
    return Number(this.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count);
  }

  private touchRoom() {
    const ev = this.getEventRow();
    if (!ev) return;
    this.sql.exec("UPDATE event SET updated_at = unixepoch() WHERE id = ?", ev.id);
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS));
  }

  private validNumericMax(value: number) {
    const maximum = Number(value);
    return Number.isInteger(maximum) && maximum >= 2 && maximum <= 1000
      ? maximum
      : null;
  }
}
