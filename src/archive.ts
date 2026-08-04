import type { Mode, Phase } from "./types";

export const HOST_ARCHIVE_KIND = "wine-night-host-archive";
export const HOST_ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_WINES = 50;
export const MAX_ARCHIVE_PARTICIPANTS = 100;

export type HostArchive = {
  kind: typeof HOST_ARCHIVE_KIND;
  version: typeof HOST_ARCHIVE_VERSION;
  exportedAt: string;
  source: {
    room: string;
    phase: Phase;
  };
  event: {
    theme: string;
    pot: number;
    hostName: string;
  };
  wines: {
    archiveId: string;
    blindCode: string;
    name: string;
    producer: string;
    price: number;
    broughtBy: string;
    position: number;
  }[];
  participants: {
    archiveId: string;
    name: string;
    mode: Mode;
    numericMax: number;
  }[];
  ratings: {
    participantArchiveId: string;
    wineArchiveId: string;
    value: number;
  }[];
};

type ValidationResult =
  | { ok: true; archive: HostArchive }
  | { ok: false; error: string };

const MODES = new Set<Mode>(["ranked", "numeric", "top3"]);
const PHASES = new Set<Phase>(["setup", "tasting", "revealed"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

/** Validate an untrusted versioned host archive before any storage is created. */
export function validateHostArchive(value: unknown): ValidationResult {
  const root = record(value);
  if (!root || root.kind !== HOST_ARCHIVE_KIND || root.version !== HOST_ARCHIVE_VERSION) {
    return { ok: false, error: "this is not a supported Wine Night host backup" };
  }

  const source = record(root.source);
  const event = record(root.event);
  const sourceRoom = text(source?.room, 8, true);
  const sourcePhase = source?.phase;
  const exportedAt = text(root.exportedAt, 40, true);
  const theme = text(event?.theme, 120);
  const hostName = text(event?.hostName, 40);
  const pot = finiteNumber(event?.pot, 0, 100_000);
  if (
    !source ||
    !event ||
    !sourceRoom ||
    !/^[A-Z0-9]{2,8}$/.test(sourceRoom) ||
    !PHASES.has(sourcePhase as Phase) ||
    !exportedAt ||
    !Number.isFinite(Date.parse(exportedAt)) ||
    theme === null ||
    hostName === null ||
    pot === null
  ) {
    return { ok: false, error: "the backup event details are invalid" };
  }

  if (!Array.isArray(root.wines) || root.wines.length > MAX_ARCHIVE_WINES) {
    return { ok: false, error: `a backup can contain at most ${MAX_ARCHIVE_WINES} wines` };
  }
  const wineIds = new Set<string>();
  const blindCodes = new Set<string>();
  const positions = new Set<number>();
  const wines: HostArchive["wines"] = [];
  for (const value of root.wines) {
    const wine = record(value);
    const archiveId = text(wine?.archiveId, 80, true);
    const blindCode = text(wine?.blindCode, 12, true);
    const name = text(wine?.name, 120, true);
    const producer = text(wine?.producer, 120);
    const broughtBy = text(wine?.broughtBy, 120);
    const price = finiteNumber(wine?.price, 0, 100_000);
    const position = finiteNumber(wine?.position, 1, MAX_ARCHIVE_WINES);
    if (
      !wine ||
      !archiveId ||
      !blindCode ||
      !/^\d+$/.test(blindCode) ||
      Number(blindCode) < 1 ||
      !name ||
      producer === null ||
      broughtBy === null ||
      price === null ||
      position === null ||
      !Number.isInteger(position) ||
      wineIds.has(archiveId) ||
      blindCodes.has(blindCode) ||
      positions.has(position)
    ) {
      return { ok: false, error: "the backup contains an invalid or duplicate wine" };
    }
    wineIds.add(archiveId);
    blindCodes.add(blindCode);
    positions.add(position);
    wines.push({ archiveId, blindCode, name, producer, price, broughtBy, position });
  }

  if (!Array.isArray(root.participants) || root.participants.length > MAX_ARCHIVE_PARTICIPANTS) {
    return {
      ok: false,
      error: `a backup can contain at most ${MAX_ARCHIVE_PARTICIPANTS} submitted participants`,
    };
  }
  const participantIds = new Set<string>();
  const participants: HostArchive["participants"] = [];
  for (const value of root.participants) {
    const participant = record(value);
    const archiveId = text(participant?.archiveId, 80, true);
    const name = text(participant?.name, 40, true);
    const mode = participant?.mode as Mode;
    const numericMax = finiteNumber(participant?.numericMax, 2, 1000);
    if (
      !participant ||
      !archiveId ||
      !name ||
      !MODES.has(mode) ||
      numericMax === null ||
      !Number.isInteger(numericMax) ||
      participantIds.has(archiveId)
    ) {
      return { ok: false, error: "the backup contains an invalid or duplicate participant" };
    }
    participantIds.add(archiveId);
    participants.push({ archiveId, name, mode, numericMax });
  }

  if (!Array.isArray(root.ratings) || root.ratings.length > wines.length * participants.length) {
    return { ok: false, error: "the backup contains too many ratings" };
  }
  const participantById = new Map(participants.map((participant) => [participant.archiveId, participant]));
  const ratingsByParticipant = new Map<string, HostArchive["ratings"]>();
  const ratingPairs = new Set<string>();
  const ratings: HostArchive["ratings"] = [];
  for (const value of root.ratings) {
    const rating = record(value);
    const participantArchiveId = text(rating?.participantArchiveId, 80, true);
    const wineArchiveId = text(rating?.wineArchiveId, 80, true);
    const score = finiteNumber(rating?.value, 1, 1000);
    const participant = participantArchiveId ? participantById.get(participantArchiveId) : undefined;
    const pair = `${participantArchiveId ?? ""}\u0000${wineArchiveId ?? ""}`;
    if (
      !rating ||
      !participantArchiveId ||
      !wineArchiveId ||
      !participant ||
      !wineIds.has(wineArchiveId) ||
      score === null ||
      !Number.isInteger(score) ||
      (participant.mode === "numeric" && score > participant.numericMax) ||
      ratingPairs.has(pair)
    ) {
      return { ok: false, error: "the backup contains an invalid or duplicate rating" };
    }
    ratingPairs.add(pair);
    const normalized = { participantArchiveId, wineArchiveId, value: score };
    ratings.push(normalized);
    const participantRatings = ratingsByParticipant.get(participantArchiveId) ?? [];
    participantRatings.push(normalized);
    ratingsByParticipant.set(participantArchiveId, participantRatings);
  }

  for (const participant of participants) {
    const ballot = ratingsByParticipant.get(participant.archiveId) ?? [];
    const values = new Set(ballot.map((rating) => rating.value));
    if (!ballot.length) {
      return { ok: false, error: "every archived participant must have a submitted ballot" };
    }
    if (participant.mode === "ranked") {
      if (ballot.length !== wines.length || values.size !== wines.length || Math.max(...values) !== wines.length) {
        return { ok: false, error: "the backup contains an incomplete full-ranking ballot" };
      }
    }
    if (participant.mode === "top3") {
      const expected = Math.min(3, wines.length);
      if (ballot.length !== expected || values.size !== expected || Math.max(...values) !== expected) {
        return { ok: false, error: "the backup contains an invalid top-three ballot" };
      }
    }
  }

  if ((participants.length === 0) !== (ratings.length === 0)) {
    return { ok: false, error: "the backup participant and rating data do not match" };
  }

  return {
    ok: true,
    archive: {
      kind: HOST_ARCHIVE_KIND,
      version: HOST_ARCHIVE_VERSION,
      exportedAt,
      source: { room: sourceRoom, phase: sourcePhase as Phase },
      event: { theme, pot, hostName },
      wines: wines.sort((a, b) => a.position - b.position),
      participants,
      ratings,
    },
  };
}
