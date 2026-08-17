// Tiny dependency-free SVG chart helpers for Wine Night.
// Attaches to window.WNcharts (loaded as a classic script before app.js).
// All outputs are inline SVG strings (mobile-friendly, no canvas needed).

(function () {
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  const WINE = "#4c1d36";
  const GOLD = "#8a641f";
  const INK = "#2b1a24";
  const MUTED = "#65575e";
  const TRACK = "#eee5df";

  /**
   * Horizontal bar chart rows: { label (name), value (bar length), meta? (score text), color? }.
   * Layout fits in the card: truncates names and pins the score on the right so nothing
   * overflows the containing box.
   */
  function hbarChart(rows, opts = {}) {
    const maxV = Math.max(...rows.map((r) => r.value), 1);
    const rowHeight = 40;
    const h = rows.length * rowHeight + 16;
    const w = 340;
    const nameW = opts.nameW ?? 112;
    const scoreW = opts.scoreW ?? 58;
    const barStart = nameW + 10;
    const scoreX = w - 4;
    const barMaxW = w - barStart - scoreW - 12;
    let y = 8;
    let svg = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(opts.aria || "chart")}">`;
    for (const r of rows) {
      const bw = Math.max(2, (r.value / maxV) * barMaxW);
      const name = truncate(String(r.label ?? ""), 14);
      svg += `
        <title>${esc(String(r.label ?? ""))}: ${esc(String(r.meta ?? r.value))}</title>
        <text x="${nameW}" y="${y + 15}" text-anchor="end" font-size="14" fill="${INK}" font-weight="700">${esc(name)}</text>
        <rect x="${barStart}" y="${y}" width="${barMaxW}" height="20" rx="5" fill="${TRACK}"></rect>
        <rect x="${barStart}" y="${y}" width="${bw}" height="20" rx="5" fill="${r.color || opts.barColor || WINE}"></rect>
        <text x="${scoreX}" y="${y + 15}" font-size="13" fill="${MUTED}" text-anchor="end" font-weight="650">${esc(String(r.meta ?? r.value))}</text>`;
      y += rowHeight;
    }
    svg += "</svg>";
    return svg;
  }

  /** Anonymous rank distribution with voter dots, full range, and an average marker. */
  function rankDistributionChart(rows, opts = {}) {
    const maxRank = Math.max(2, Number(opts.maxRank) || 2);
    const rowHeight = 48;
    const top = 34;
    const h = top + rows.length * rowHeight + 16;
    const plotStart = 12;
    const axisWidth = Math.max(216, (maxRank - 1) * 20);
    const plotEnd = plotStart + axisWidth;
    const w = plotEnd + 12;
    const xFor = (rank) => plotStart + ((Number(rank) - 1) / (maxRank - 1)) * axisWidth;
    const tickStep = maxRank <= 12 ? 1 : Math.ceil(maxRank / 10);
    const ticks = [];
    for (let rank = 1; rank <= maxRank; rank += tickStep) ticks.push(rank);
    if (ticks[ticks.length - 1] !== maxRank) ticks.push(maxRank);
    const rankGroups = (ranks) => {
      const counts = new Map();
      for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
      return [...counts.entries()].sort((a, b) => a[0] - b[0]);
    };
    const description = rows
      .map((row) => {
        const ranks = Array.isArray(row.ranks) ? row.ranks.map(Number).filter(Number.isFinite) : [];
        if (!ranks.length) return `${row.label}: no submitted placements`;
        const placements = rankGroups(ranks)
          .map(([rank, count]) => `rank ${rank}, ${count} ballot${count === 1 ? "" : "s"}`)
          .join("; ");
        return `${row.label}: ${placements}; average ${Number(row.average).toFixed(1)}`;
      })
      .join(". ");
    let svg = `<svg viewBox="0 0 ${w} ${h}" class="chart rank-distribution-chart" style="width:${w}px" role="img" aria-label="${esc(opts.aria || "Anonymous ballot rank distribution")}"><desc>${esc(description)}</desc>`;
    for (const rank of ticks) {
      const x = xFor(rank);
      svg += `<line x1="${x}" y1="22" x2="${x}" y2="${h - 16}" stroke="${TRACK}" stroke-width="1"></line>
        <text x="${x}" y="14" text-anchor="middle" font-size="11" fill="${MUTED}">${rank}</text>`;
    }
    rows.forEach((row, rowIndex) => {
      const ranks = Array.isArray(row.ranks) ? row.ranks.map(Number).filter(Number.isFinite) : [];
      if (!ranks.length) return;
      const y = top + rowIndex * rowHeight + rowHeight / 2;
      const minimum = Math.min(...ranks);
      const maximum = Math.max(...ranks);
      const average = Number(row.average);
      svg += `<line x1="${xFor(minimum)}" y1="${y}" x2="${xFor(maximum)}" y2="${y}" stroke="${MUTED}" stroke-width="3" stroke-linecap="round"></line>`;
      const avgX = xFor(average);
      svg += `<polygon points="${avgX},${y - 13} ${avgX + 8},${y} ${avgX},${y + 13} ${avgX - 8},${y}" fill="${GOLD}" stroke="#ffffff" stroke-width="1.5"></polygon>`;
      rankGroups(ranks).forEach(([rank, count]) => {
        const x = xFor(rank);
        if (count === 1) {
          svg += `<circle cx="${x}" cy="${y}" r="4" fill="${row.color || WINE}" opacity="0.9"></circle>`;
          return;
        }
        const countLabel = String(count);
        const badgeWidth = Math.max(18, countLabel.length * 7 + 8);
        svg += `<rect x="${x - badgeWidth / 2}" y="${y - 9}" width="${badgeWidth}" height="18" rx="9" fill="${row.color || WINE}"></rect>
          <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" fill="#ffffff" font-weight="800">${countLabel}</text>`;
      });
    });
    svg += "</svg>";
    const labels = rows
      .map((row) => `<div class="rank-chart-label" title="${esc(String(row.label ?? ""))}">${esc(truncate(String(row.label ?? ""), 20))}</div>`)
      .join("");
    const scrollHint = maxRank > 12
      ? `<div class="chart-scroll-hint">Scroll sideways to see all ${maxRank} placements.</div>`
      : "";
    return `<div class="rank-distribution">
      <div class="rank-chart-labels" aria-hidden="true"><div class="rank-chart-label-spacer"></div>${labels}</div>
      <div class="rank-chart-scroll" tabindex="0" role="region" aria-label="Ballot placement chart. Scroll horizontally if needed.">${svg}</div>
    </div>${scrollHint}`;
  }

  function truncate(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)) + "\u2026";
  }

  /** Spread dot-bars: values -> an HTML "who voted them where" mini bar. */
  function miniSpreadHTML(values) {
    const bucket = {};
    for (const v of values) bucket[Math.round(v)] = (bucket[Math.round(v)] || 0) + 1;
    const maxC = Math.max(...Object.values(bucket), 1);
    const n = Math.max(...values, 1);
    let cells = "";
    for (let i = 1; i <= n; i++) {
      const c = bucket[i] || 0;
      const hgt = c ? 8 + (c / maxC) * 22 : 4;
      cells += `<div class="spread-cell" style="height:${hgt}px;opacity:${c ? 1 : 0.12}"></div>`;
    }
    return `<div class="spread">${cells}</div>`;
  }

  /** Daily counts -> a small HTML bar sparkline, e.g. rooms created per day. */
  function sparklineHTML(daily) {
    const counts = daily.map((d) => Number(d.count) || 0);
    const maxC = Math.max(...counts, 1);
    const bars = daily
      .map((d) => {
        const count = Number(d.count) || 0;
        const hgt = count ? 6 + (count / maxC) * 30 : 2;
        return `<div class="sparkline-bar" style="height:${hgt}px" title="${esc(String(d.day))}: ${count} room${count === 1 ? "" : "s"}"></div>`;
      })
      .join("");
    const total = counts.reduce((a, b) => a + b, 0);
    const label = daily.length
      ? `Rooms created per day, last ${daily.length} day${daily.length === 1 ? "" : "s"}: ${total} total`
      : "No rooms created yet";
    return `<div class="sparkline" role="img" aria-label="${esc(label)}">${bars}</div>`;
  }

  window.WNcharts = { hbarChart, rankDistributionChart, miniSpreadHTML, sparklineHTML, esc };
})();
