import assert from "node:assert/strict";
import {
  HOST_ARCHIVE_KIND,
  HOST_ARCHIVE_VERSION,
  validateHostArchive,
} from "./src/archive";

function archive(): any {
  return {
    kind: HOST_ARCHIVE_KIND,
    version: HOST_ARCHIVE_VERSION,
    exportedAt: "2026-08-04T20:00:00.000Z",
    source: { room: "GRAPE", phase: "revealed" },
    event: { theme: "Washington Whites", pot: 10, hostName: "Alex" },
    wines: [
      { archiveId: "w1", blindCode: "1", name: "One", producer: "A", price: 20, broughtBy: "Alex", position: 1 },
      { archiveId: "w2", blindCode: "2", name: "Two", producer: "B", price: 0, broughtBy: "Blair", position: 2 },
      { archiveId: "w3", blindCode: "3", name: "Three", producer: "", price: 18, broughtBy: "Casey", position: 3 },
    ],
    participants: [
      { archiveId: "p1", name: "Alex", mode: "numeric", numericMax: 5 },
      { archiveId: "p2", name: "Blair", mode: "ranked", numericMax: 100 },
      { archiveId: "p3", name: "Casey", mode: "top3", numericMax: 100 },
    ],
    ratings: [
      { participantArchiveId: "p1", wineArchiveId: "w1", value: 5 },
      { participantArchiveId: "p1", wineArchiveId: "w2", value: 3 },
      { participantArchiveId: "p2", wineArchiveId: "w1", value: 1 },
      { participantArchiveId: "p2", wineArchiveId: "w2", value: 2 },
      { participantArchiveId: "p2", wineArchiveId: "w3", value: 3 },
      { participantArchiveId: "p3", wineArchiveId: "w3", value: 1 },
      { participantArchiveId: "p3", wineArchiveId: "w2", value: 2 },
      { participantArchiveId: "p3", wineArchiveId: "w1", value: 3 },
    ],
  };
}

const valid = validateHostArchive(archive());
assert.equal(valid.ok, true, valid.ok ? undefined : valid.error);

const setup = archive();
setup.source.phase = "setup";
setup.participants = [];
setup.ratings = [];
assert.equal(validateHostArchive(setup).ok, true, "setup-only archives should be restorable");

const wrongVersion = archive();
wrongVersion.version = 2;
assert.equal(validateHostArchive(wrongVersion).ok, false, "unknown archive versions must fail closed");

const unknownWine = archive();
unknownWine.ratings[0].wineArchiveId = "missing";
assert.equal(validateHostArchive(unknownWine).ok, false, "ratings must reference archived wines");

const highNumeric = archive();
highNumeric.ratings[0].value = 6;
assert.equal(validateHostArchive(highNumeric).ok, false, "numeric ratings must respect the archived scale");

const incompleteRank = archive();
incompleteRank.ratings = incompleteRank.ratings.filter(
  (rating) => !(rating.participantArchiveId === "p2" && rating.wineArchiveId === "w3"),
);
assert.equal(validateHostArchive(incompleteRank).ok, false, "full-ranking ballots must remain complete");

const participantWithoutBallot = archive();
participantWithoutBallot.ratings = participantWithoutBallot.ratings.filter(
  (rating) => rating.participantArchiveId !== "p3",
);
assert.equal(validateHostArchive(participantWithoutBallot).ok, false, "only submitted participants may be archived");

const duplicateRating = archive();
duplicateRating.ratings.push({ ...duplicateRating.ratings[0] });
assert.equal(validateHostArchive(duplicateRating).ok, false, "duplicate rating pairs must be rejected");

console.log("8 archive validation tests passed");
