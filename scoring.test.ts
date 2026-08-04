import {
  scoresToRanks,
  orderedToRanks,
  bordaTally,
  pairwiseMatrix,
  condorcetWinner,
  consensusRanking,
  spearmanCorrelation,
  matchPartners,
  consensusCorrelation,
  computeAnalytics,
  presentationRevealOrder,
} from "./src/scoring";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", name);
  }
}

// 1. scoresToRanks converts numeric scores to ranks
const ranks = scoresToRanks(new Map([
  ["a", 90], ["b", 70], ["c", 80], ["d", 70],
]));
// a:1, c:2, b and d tie for 3
check("numeric->rank a=1", ranks.get("a") === 1);
check("numeric->rank c=2", ranks.get("c") === 2);
check("numeric->rank b=3.5", ranks.get("b") === 3.5);
check("numeric->rank d=3.5", ranks.get("d") === 3.5);

// 2. Conventional Borda tally: with 4 wines, first=3 pts and last=0.
const ballots = [
  { participantId: "1", ranks: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) },
  { participantId: "2", ranks: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) },
  { participantId: "3", ranks: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) },
];
const ids = ["a", "b", "c", "d"];
const borda = bordaTally(ballots, ids);
check("borda a=9", borda.get("a") === 9); // 3 ballots * 3
check("borda d=0", borda.get("d") === 0);

// 3. Condorcet winner: all prefer a -> a is winner
const pw = pairwiseMatrix(ballots, ids);
check("condorcet winner a", condorcetWinner(pw, ids, 3) === "a");

// 4. consensusRanking with clear Condorcet winner
const cr = consensusRanking(ballots, ids);
check("consensus first a", cr[0].wineId === "a");

// 5. Consensus ranking in a cycle (no Condorcet winner) falls back to Borda
// A>B, B>C, C>A (rock paper scissors)
const cyc = [
  { participantId: "1", ranks: new Map([["a", 1], ["b", 2], ["c", 3]]) },
  { participantId: "2", ranks: new Map([["b", 1], ["c", 2], ["a", 3]]) },
  { participantId: "3", ranks: new Map([["c", 1], ["a", 2], ["b", 3]]) },
];
const cycPw = pairwiseMatrix(cyc, ["a", "b", "c"]);
check("cycle has no condorcet winner", condorcetWinner(cycPw, ["a", "b", "c"], 3) === null);
const cycRank = consensusRanking(cyc, ["a", "b", "c"]);
// Borda tie among all -> all score 3, deterministic order by input order
check("cycle borda all tie", cycRank.every((r) => r.score === 3));

// 6. Spearman correlation
const ra = { participantId: "1", ranks: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) };
const rb = { participantId: "2", ranks: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) };
check("perfect correlation=1", spearmanCorrelation(ra, rb, ["a", "b", "c", "d"]) === 1);

const rc = { participantId: "3", ranks: new Map([["a", 4], ["b", 3], ["c", 2], ["d", 1]]) };
check("reverse correlation=-1", spearmanCorrelation(ra, rc, ["a", "b", "c", "d"]) === -1);

// 7. matchPartners picks the closest
const m = matchPartners([ra, rb], ["a", "b", "c", "d"]);
check("match partner correlation 1", m.get("1").correlation === 1);

function assertEqual(name, actual, expected) {
  if (actual === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  }
}
// orderedToRanks
assertEqual("orderedToRanks", [...orderedToRanks(["x", "y", "z"]).ranks.values()].join(""), "123");

// 8. Explicit ties do not invent a pairwise preference.
const tiedBallot = [{ participantId: "tie", ranks: new Map([["a", 1.5], ["b", 1.5]]) }];
const tiedPw = pairwiseMatrix(tiedBallot, ["a", "b"]);
assertEqual("tie has no a>b vote", tiedPw.matrix.get("a").get("b") || 0, 0);
assertEqual("tie has no b>a vote", tiedPw.matrix.get("b").get("a") || 0, 0);

// 9. A listed top-N choice beats unlisted wines; unlisted wines tie each other.
const partial = [{ participantId: "top", ranks: new Map([["a", 1], ["b", 2], ["c", 3]]) }];
const partialPw = pairwiseMatrix(partial, ["a", "b", "c", "d", "e"]);
assertEqual("ranked beats unranked", partialPw.matrix.get("c").get("d"), 1);
assertEqual("unranked tie", partialPw.matrix.get("d").get("e") || 0, 0);

// A partial ballot gives every unranked wine the average of the remaining
// Borda positions and distributes the same total weight as a full ballot.
const sixIds = ["a", "b", "c", "d", "e", "f"];
const partialBorda = bordaTally(partial, sixIds);
assertEqual("top-three first gets 5", partialBorda.get("a"), 5);
assertEqual("top-three third gets 3", partialBorda.get("c"), 3);
assertEqual("each unranked wine gets 1", partialBorda.get("f"), 1);
assertEqual(
  "partial ballot has full-ballot weight",
  [...partialBorda.values()].reduce((sum, score) => sum + score, 0),
  15,
);
const partialAnalytics = computeAnalytics(partial, sixIds);
const unrankedStats = partialAnalytics.wineStats.find((wine) => wine.wineId === "f");
assertEqual("analytics includes an unranked wine", unrankedStats.n, 1);
assertEqual("analytics gives unranked wine its tied midrank", unrankedStats.avgRank, 5);
const unrankedComparison = partialAnalytics.participants.top.comparison.find((wine) => wine.wineId === "f");
assertEqual("private comparison labels an omitted wine unranked", unrankedComparison.yourRank, null);
assertEqual("private comparison retains its effective tied rank", unrankedComparison.effectiveRank, 5);

// Partial numeric input follows the same rule after its entered scores become ranks.
const partialNumeric = [{
  participantId: "numeric-partial",
  ranks: scoresToRanks(new Map([["a", 5], ["b", 3]])),
  rawScores: new Map([["a", 5], ["b", 3]]),
}];
const numericBorda = bordaTally(partialNumeric, ["a", "b", "c", "d"]);
assertEqual("partial numeric first gets 3", numericBorda.get("a"), 3);
assertEqual("partial numeric second gets 2", numericBorda.get("b"), 2);
assertEqual("partial numeric blanks share remaining points", numericBorda.get("c"), 0.5);
assertEqual("partial numeric keeps full ballot weight", [...numericBorda.values()].reduce((a, b) => a + b, 0), 6);

// 10. No ballots means no manufactured winner.
assertEqual("empty consensus", consensusRanking([], ["a", "b"]).length, 0);

// 11. Group alignment is leave-one-out rather than self-inflated.
const oppositeGroup = consensusCorrelation([ra, rc], ["a", "b", "c", "d"]);
assertEqual("leave-one-out opposite correlation", oppositeGroup.get("1"), -1);

// 12. Numeric analytics retain meaningful raw-score spread.
const numericAnalytics = computeAnalytics(
  [{ participantId: "numeric", ranks: new Map([["a", 1], ["b", 2]]), rawScores: new Map([["a", 90], ["b", 60]]) }],
  ["a", "b"],
);
assertEqual("raw spread minimum", numericAnalytics.participants.numeric.rawSpread.min, 60);
assertEqual("raw spread maximum", numericAnalytics.participants.numeric.rawSpread.max, 90);
assertEqual("raw spread range", numericAnalytics.participants.numeric.rawSpread.range, 30);

// 13. Rank variance is the population variance shown for debate wines.
const varianceAnalytics = computeAnalytics(
  [
    { participantId: "v1", ranks: new Map([["a", 1], ["b", 2], ["c", 3]]) },
    { participantId: "v2", ranks: new Map([["a", 2], ["b", 1], ["c", 3]]) },
    { participantId: "v3", ranks: new Map([["a", 3], ["b", 2], ["c", 1]]) },
  ],
  ["a", "b", "c"],
);
const varianceA = varianceAnalytics.wineStats.find((wine) => wine.wineId === "a");
check("rank variance uses mean squared distance", Math.abs(varianceA.variance - 2 / 3) < 1e-12);
assertEqual("rank distribution retains one anonymous value per ballot", varianceA.ranks.join(","), "1,2,3");
// 14. The seeded demo has one clear leader rather than a first-place tie.
const demoIds = ["a", "b", "c", "d", "e", "f"];
const demoBallots = [
  { participantId: "Sam", ranks: scoresToRanks(new Map(demoIds.map((id, i) => [id, [92, 84, 78, 60, 40, 30][i]]))) },
  { participantId: "Mina", ranks: scoresToRanks(new Map(demoIds.map((id, i) => [id, [70, 62, 55, 45, 60, 35][i]]))) },
  { participantId: "Pat", ranks: orderedToRanks(["a", "b", "c", "d", "e", "f"]).ranks },
  { participantId: "Lee", ranks: orderedToRanks(["d", "b", "a"]).ranks },
  { participantId: "Ivo", ranks: scoresToRanks(new Map(demoIds.map((id, i) => [id, [30, 45, 88, 92, 85, 78][i]]))) },
  { participantId: "Nina", ranks: orderedToRanks(["a", "b", "d", "c", "f", "e"]).ranks },
];
const demoRanking = consensusRanking(demoBallots, demoIds);
check("demo has a unique Comet Reserve winner", demoRanking[0].wineId === "a" && demoRanking[0].score > demoRanking[1].score);

// 15. Presentation previews last place and second place before the full reveal.
assertEqual(
  "six-wine reveal order is last, second, full results",
  presentationRevealOrder([1, 2, 3, 4, 5, 6].map((place) => ({ place }))).join(","),
  "6,2,1",
);
assertEqual(
  "three-wine reveal order is last, second, full results",
  presentationRevealOrder([1, 2, 3].map((place) => ({ place }))).join(","),
  "3,2,1",
);
assertEqual(
  "two-wine reveal does not duplicate second and last",
  presentationRevealOrder([1, 2].map((place) => ({ place }))).join(","),
  "2,1",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
