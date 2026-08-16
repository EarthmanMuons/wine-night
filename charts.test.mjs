globalThis.window = {};
await import("./public/charts.js");

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) pass++;
  else {
    fail++;
    console.error("FAIL:", name);
  }
}

const denseTwelve = Array.from({ length: 12 }, (_, index) => ({
  label: `Wine ${index + 1}`,
  ranks: Array(24).fill(index + 1),
  average: index + 1,
}));
const twelveWineChart = window.WNcharts.rankDistributionChart(denseTwelve, { maxRank: 12 });
check("12-wine axis fits without a scroll instruction", !twelveWineChart.includes("Scroll sideways"));
check("dense consensus is shown as a count", twelveWineChart.includes(">24</text>"));
check("wine labels remain outside the scrolling plot", twelveWineChart.includes('class="rank-chart-labels"'));
check("count markers are centered on their range line", twelveWineChart.includes('y="49" width="22" height="18"'));
check("average diamond stays behind ballot markers", twelveWineChart.indexOf("<polygon") < twelveWineChart.indexOf("<rect"));

const longNameChart = window.WNcharts.rankDistributionChart(
  [
    { label: "Bacchus Vinyard", ranks: [1, 2], average: 1.5 },
    { label: "Bacchus Vinyard Estate Reserve", ranks: [1, 2], average: 1.5 },
  ],
  { maxRank: 6 },
);
check(
  "a typical wine name fits the widened label column without truncation",
  longNameChart.includes(">Bacchus Vinyard<"),
);
check(
  "only names past the new, wider limit are truncated, still with a visible ellipsis and full title",
  longNameChart.includes(">Bacchus Vinyard Est…<") && longNameChart.includes('title="Bacchus Vinyard Estate Reserve"'),
);

const largeChart = window.WNcharts.rankDistributionChart([
  { label: "Large tasting", ranks: [1, 25, 50], average: 25.3 },
], { maxRank: 50 });
check("large tasting expands its placement axis", largeChart.includes('style="width:1004px"'));
check("large tasting explains horizontal scrolling", largeChart.includes("Scroll sideways to see all 50 placements"));

console.log(`\n${pass} chart tests passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
