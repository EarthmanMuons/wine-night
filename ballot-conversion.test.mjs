import "./public/ballot-conversion.js";

const { orderedWineIdsFromNumeric, proportionalScoresFromOrder } = globalThis.WineNightBallotConversion;

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) pass++;
  else {
    fail++;
    console.error("FAIL:", name);
  }
}

const wines = ["w1", "w2", "w3", "w4", "w5", "w6"];

check(
  "numeric scores become a descending order",
  orderedWineIdsFromNumeric({ w1: 2, w2: 5, w3: 4 }, wines).join(",") === "w2,w3,w1,w4,w5,w6",
);
check(
  "numeric ties keep the supplied prior order",
  orderedWineIdsFromNumeric({ w1: 5, w2: 5, w3: 2 }, wines, ["w2", "w1", "w3", "w4", "w5", "w6"]).join(",") ===
    "w2,w1,w3,w4,w5,w6",
);
check(
  "a full ranking fills the chosen scale proportionally",
  JSON.stringify(proportionalScoresFromOrder(wines, wines.length, 100)) ===
    JSON.stringify({ w1: 100, w2: 80, w3: 60, w4: 41, w5: 21, w6: 1 }),
);
check(
  "a small scale degrades gracefully with tied integer scores",
  JSON.stringify(proportionalScoresFromOrder(wines, wines.length, 3)) ===
    JSON.stringify({ w1: 3, w2: 3, w3: 2, w4: 2, w5: 1, w6: 1 }),
);
check(
  "Top 3 conversion leaves every unranked wine blank",
  JSON.stringify(proportionalScoresFromOrder(wines, 3, 5)) === JSON.stringify({ w1: 5, w2: 3, w3: 1 }),
);

console.log(`\n${pass} ballot conversion tests passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
