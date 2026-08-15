// Pure scoring math for the wine night.
//
// Core principle: all input modes are converted to a per-participant rank ordering
// of wines (rank 1 = best). All aggregation happens over ranks, never raw scores,
// which removes cross-person scale/anchoring differences.

export type Ballot = {
  participantId: string;
  // wineId -> rank (1 = best, lower is better). Ties share the average rank.
  ranks: Map<string, number>;
  // Raw scores on the participant's chosen scale (numeric mode only; kept for analytics).
  rawScores?: Map<string, number>;
};

/**
 * Convert a set of raw numeric scores (wineId -> score) into a rank map.
 * Higher score = better rank. Ties share the average rank.
 */
export function scoresToRanks(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()].sort(
    (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
  );
  const ranks = new Map<string, number>();
  const n = sorted.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1][1] === sorted[i][1]) j++;
    const avgRank = (i + 1 + j + 1) / 2; // average of positions i+1..j+1
    for (let k = i; k <= j; k++) ranks.set(sorted[k][0], avgRank);
    i = j + 1;
  }
  return ranks;
}

/**
 * Convert an ordered list of wine ids (best first) into a rank map.
 * Unlisted wines are not given a rank (treated as unranked, worst).
 */
export function orderedToRanks(
  order: string[],
): { ranks: Map<string, number>; rankedCount: number } {
  const ranks = assignRanks(order);
  return { ranks, rankedCount: order.length };
}

/** Assign ranks to an ordered id list (best first), using average rank for ties. */
function assignRanks(order: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let i = 0;
  while (i < order.length) {
    const share = i + 1; // rank = position + 1 (1-indexed, no ties in pure ordering)
    ranks.set(order[i], share);
    i += 1;
  }
  return ranks;
}

/**
 * Partial Borda tally. For n wines, first place receives n-1 points and last
 * receives 0. Unranked wines on a top-truncated ballot are treated as tied
 * across the remaining positions, so every ballot distributes the same total
 * number of points and every participant has equal aggregate weight.
 * Returns wineId -> borda points.
 *
 * @param ballots      all ballots
 * @param allWineIds   complete set of wines being rated this evening
 */
export function bordaTally(
  ballots: Ballot[],
  allWineIds: string[],
): Map<string, number> {
  const n = allWineIds.length;
  const points = new Map<string, number>(allWineIds.map((id) => [id, 0]));
  for (const ballot of ballots) {
    const rankedCount = allWineIds.filter((id) => ballot.ranks.has(id)).length;
    const missingCount = n - rankedCount;
    const missingRank = missingCount
      ? (rankedCount + 1 + n) / 2
      : n;
    for (const id of allWineIds) {
      const rank = ballot.ranks.get(id) ?? missingRank;
      points.set(id, (points.get(id) ?? 0) + Math.max(0, n - rank));
    }
  }
  return points;
}

export type Pairwise = {
  // who beat whom: key "A>B" -> votes where A ranked above B
  matrix: Map<string, Map<string, number>>;
};

/**
 * Build a pairwise preference matrix from ballots. winCounts[winner][loser] = number
 * of raters who placed winner above loser.
 */
export function pairwiseMatrix(
  ballots: Ballot[],
  allWineIds: string[],
): Pairwise {
  const matrix = new Map<string, Map<string, number>>();
  for (const winner of allWineIds) {
    matrix.set(winner, new Map());
  }
  for (const ballot of ballots) {
    // Missing entries in a partial ballot are tied below every explicitly-ranked
    // wine. Two missing entries and explicit ties express no pairwise preference.
    const unranked = allWineIds.length + 1;
    for (let a = 0; a < allWineIds.length; a++) {
      for (let b = a + 1; b < allWineIds.length; b++) {
        const aId = allWineIds[a];
        const bId = allWineIds[b];
        const ra = ballot.ranks.get(aId) ?? unranked;
        const rb = ballot.ranks.get(bId) ?? unranked;
        if (ra === rb) continue;
        const [higher, lower] = ra < rb ? [aId, bId] : [bId, aId];
        matrix.get(higher)!.set(lower, (matrix.get(higher)!.get(lower) ?? 0) + 1);
      }
    }
  }
  return { matrix };
}

/**
 * Find a Condorcet winner (the wine that beats every other wine pairwise).
 * Returns null if no such wine exists (cycle).
 */
export function condorcetWinner(
  pw: Pairwise,
  allWineIds: string[],
  _totalRaters: number,
): string | null {
  for (const candidate of allWineIds) {
    let beats = true;
    for (const other of allWineIds) {
      if (candidate === other) continue;
      const favored = pw.matrix.get(candidate)!.get(other) ?? 0;
      const unfavored = pw.matrix.get(other)!.get(candidate) ?? 0;
      if (favored <= unfavored) {
        beats = false;
        break;
      }
    }
    if (beats) return candidate;
  }
  return null;
}

/**
 * Produce a final consensus ranking of wines.
 * Uses Condorcet winner if one exists (definitive), otherwise Borda count.
 * Returns an ordered list of { wineId, score } best-to-worst, where score is
 * the metric used (borda points), ties broken deterministically.
 */
export function consensusRanking(
  ballots: Ballot[],
  allWineIds: string[],
): { wineId: string; score: number }[] {
  if (ballots.length === 0 || allWineIds.length === 0) return [];
  const pw = pairwiseMatrix(ballots, allWineIds);
  const winner = condorcetWinner(pw, allWineIds, ballots.length);
  const borda = bordaTally(ballots, allWineIds);

  if (winner) {
    // First place is definitive; rank the rest by Borda for an overall ordering.
    const rest = allWineIds
      .filter((id) => id !== winner)
      .sort((a, b) =>
        (borda.get(b) ?? 0) - (borda.get(a) ?? 0) ||
        allWineIds.indexOf(a) - allWineIds.indexOf(b),
      );
    return [
      { wineId: winner, score: borda.get(winner) ?? 0 },
      ...rest.map((id) => ({ wineId: id, score: borda.get(id) ?? 0 })),
    ];
  }

  // No Condorcet winner (cycle) -> pure Borda ranking.
  return allWineIds
    .map((id) => ({ wineId: id, score: borda.get(id) ?? 0 }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        allWineIds.indexOf(a.wineId) - allWineIds.indexOf(b.wineId),
    );
}

/** z-score (mean 0, sd 1) of a participant's raw numeric scores across their wines. */
export function zScore(
  rawScores: Map<string, number>,
): { wineId: string; score: number }[] {
  const values = [...rawScores.values()];
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const sd = Math.sqrt(variance) || 1;
  const out: { wineId: string; score: number }[] = [];
  for (const [id, v] of rawScores) {
    out.push({ wineId: id, score: (v - mean) / sd });
  }
  return out;
}

/**
 * Spearman rank correlation between two participants' rank vectors over the common
 * set of wines they both ranked (or all wines). Returns -1..1.
 */
export function spearmanCorrelation(
  a: Ballot,
  b: Ballot,
  allWineIds: string[],
): number {
  if (a.ranks.size === 0 || b.ranks.size === 0 || allWineIds.length < 2) return 0;
  // Compare the entire field. Missing wines in a top-N ballot are tied at the
  // average of the remaining rank positions (the standard midrank treatment).
  const missingA = implicitRank(a, allWineIds);
  const missingB = implicitRank(b, allWineIds);
  const av = allWineIds.map((id) => a.ranks.get(id) ?? missingA);
  const bv = allWineIds.map((id) => b.ranks.get(id) ?? missingB);
  return pearson(av, bv);
}

function implicitRank(ballot: Ballot, allWineIds: string[]): number {
  const rankedCount = allWineIds.filter((id) => ballot.ranks.has(id)).length;
  return rankedCount < allWineIds.length
    ? (rankedCount + 1 + allWineIds.length) / 2
    : allWineIds.length;
}

/** Consensus ranks with score ties represented as midranks. */
function consensusRanks(ballots: Ballot[], allWineIds: string[]): Map<string, number> {
  const ranking = consensusRanking(ballots, allWineIds);
  const winner = condorcetWinner(pairwiseMatrix(ballots, allWineIds), allWineIds, ballots.length);
  const ranks = new Map<string, number>();
  let i = 0;
  while (i < ranking.length) {
    // A definitive Condorcet winner remains uniquely first even if its Borda
    // total happens to equal the next wine's total.
    if (i === 0 && ranking[i].wineId === winner) {
      ranks.set(ranking[i].wineId, 1);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < ranking.length && ranking[j + 1].score === ranking[i].score) j += 1;
    const midrank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks.set(ranking[k].wineId, midrank);
    i = j + 1;
  }
  return ranks;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
    denA += (a[i] - meanA) ** 2;
    denB += (b[i] - meanB) ** 2;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

/**
 * For each participant, find who matches them best (highest Spearman correlation).
 * Returns participantId -> { matchId, correlation } over everyone else.
 */
/**
 * How close each participant's ranking is to the group consensus ranking
 * (Spearman correlation between their ranks and the consensus order).
 * Returns pid -> correlation in -1..1.
 */
export function consensusCorrelation(ballots: Ballot[], allWineIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of ballots) {
    // Leave the participant out of the reference result so alignment is not
    // inflated by comparing a ballot to a consensus containing itself.
    const peers = ballots.filter((other) => other.participantId !== b.participantId);
    const ranks = consensusRanks(peers, allWineIds);
    if (ranks.size === 0) continue;
    const consensusBallot: Ballot = {
      participantId: "__consensus__",
      ranks,
    };
    out.set(b.participantId, spearmanCorrelation(b, consensusBallot, allWineIds));
  }
  return out;
}

/** The participant whose ranking matched the group consensus most closely. */
export function mostConsensual(ballots: Ballot[], allWineIds: string[]): {
  participantId: string;
  correlation: number;
} | null {
  const corr = consensusCorrelation(ballots, allWineIds);
  let best: { participantId: string; correlation: number } | null = null;
  for (const [pid, c] of corr) {
    if (!best || c > best.correlation) best = { participantId: pid, correlation: c };
  }
  return best;
}

export function matchPartners(
  ballots: Ballot[],
  allWineIds: string[],
): Map<string, { matchId: string; correlation: number }> {
  const out = new Map<string, { matchId: string; correlation: number }>();
  for (const a of ballots) {
    let bestId: string | null = null;
    let bestCorr = -Infinity;
    for (const b of ballots) {
      if (b.participantId === a.participantId) continue;
      const corr = spearmanCorrelation(a, b, allWineIds);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestId = b.participantId;
      }
    }
    if (bestId !== null) {
      out.set(a.participantId, { matchId: bestId, correlation: bestCorr });
    }
  }
  return out;
}

/**
 * Consensus ranking from already-normalized numeric z-scores. Callers must first
 * normalize each participant with zScore(), then group those values by wine.
 */
export function zScoreConsensus(zScoresByWine: Map<string, number[]>): {
  wineId: string;
  score: number;
}[] {
  const avg: { wineId: string; score: number }[] = [];
  for (const [id, vals] of zScoresByWine) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    avg.push({ wineId: id, score: mean });
  }
  return avg.sort((a, b) => b.score - a.score);
}

/** Staged presentation: last place, second place, then the full results. */
export function presentationRevealOrder(results: { place: number }[]): number[] {
  const places = new Set(results.map((result) => result.place));
  const lastPlace = Math.max(0, ...places);
  const requested = [lastPlace, 2, 1];
  return requested.filter(
    (place, index) => places.has(place) && requested.indexOf(place) === index,
  );
}

// ---------------------------------------------------------------------------
// Post-reveal "fun data": all computed over RANKS for a uniform, mode-agnostic view.
// ---------------------------------------------------------------------------

export type WineAnalytics = {
  wineId: string;
  n: number; // how many submitted ballots contributed an explicit or implicit rank
  avgRank: number;
  minRank: number;
  maxRank: number;
  variance: number; // variance of the ranks it received (polarization)
  ranks: number[]; // anonymous effective rank from every ballot
};

export type ParticipantAnalytics = {
  participantId: string;
  spread: { min: number; max: number; range: number };
  rawSpread?: { min: number; max: number; range: number };
  outliers: { wineId: string; yourRank: number; consensusRank: number; delta: number }[];
  comparison: {
    wineId: string;
    yourRank: number | null;
    effectiveRank: number;
    consensusRank: number;
    delta: number;
  }[];
};

export type Analytics = {
  wineStats: WineAnalytics[];
  participants: Record<string, ParticipantAnalytics>;
};

/** Build per-wine rank lists, using an implicit tied midrank for unranked wines. */
function rankMatrix(ballots: Ballot[], allWineIds: string[]) {
  const byWine = new Map<string, number[]>(allWineIds.map((id) => [id, []]));
  const byParticipant = new Map<string, Map<string, number>>();
  for (const b of ballots) {
    const p = new Map<string, number>();
    const unranked = implicitRank(b, allWineIds);
    for (const id of allWineIds) {
      const rank = b.ranks.get(id) ?? unranked;
      byWine.get(id)!.push(rank);
      if (b.ranks.has(id)) {
        p.set(id, rank);
      }
    }
    byParticipant.set(b.participantId, p);
  }
  return { byWine, byParticipant };
}

export function computeAnalytics(ballots: Ballot[], allWineIds: string[]): Analytics {
  const { byWine, byParticipant } = rankMatrix(ballots, allWineIds);

  // Average rank remains useful for the per-wine debate statistics.
  const avgRank = new Map<string, number>();
  for (const id of allWineIds) {
    const vals = byWine.get(id)!;
    avgRank.set(
      id,
      vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : allWineIds.length + 1,
    );
  }
  const consensusPos = consensusRanks(ballots, allWineIds);

  const wineStats: WineAnalytics[] = allWineIds.map((id) => {
      const vals = byWine.get(id)!;
      const n = vals.length;
      const mean = avgRank.get(id)!;
      let variance = 0;
      if (n > 1) variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      return {
        wineId: id,
        n,
        avgRank: mean,
        minRank: n ? Math.min(...vals) : 0,
        maxRank: n ? Math.max(...vals) : 0,
        variance,
        ranks: [...vals],
      };
    });

  // Per-participant spread & outliers.
  const participants: Record<string, ParticipantAnalytics> = {};
  for (const [pid, ranks] of byParticipant) {
    const values = [...ranks.values()];
    const outliers: ParticipantAnalytics["outliers"] = [];
    const ballot = ballots.find((entry) => entry.participantId === pid);
    const missingRank = ballot ? implicitRank(ballot, allWineIds) : allWineIds.length;
    const comparison: ParticipantAnalytics["comparison"] = allWineIds.map((wineId) => {
      const yourRank = ranks.get(wineId) ?? null;
      const effectiveRank = yourRank ?? missingRank;
      const consensusRank = consensusPos.get(wineId)!;
      return {
        wineId,
        yourRank,
        effectiveRank,
        consensusRank,
        delta: effectiveRank - consensusRank,
      };
    });
    if (values.length) {
      for (const [wineId, yourRank] of ranks) {
        const consensus = consensusPos.get(wineId)!;
        const delta = yourRank - consensus;
        const abs = Math.abs(delta);
        if (abs >= 2) {
          outliers.push({ wineId, yourRank, consensusRank: consensus, delta });
        }
      }
      // sort by biggest deviation first
      outliers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const min = Math.min(...values);
      const max = Math.max(...values);
      participants[pid] = {
        participantId: pid,
        spread: { min, max, range: max - min },
        rawSpread: (() => {
          const raw = ballots.find((ballot) => ballot.participantId === pid)?.rawScores;
          if (!raw?.size) return undefined;
          const scores = [...raw.values()];
          const rawMin = Math.min(...scores);
          const rawMax = Math.max(...scores);
          return { min: rawMin, max: rawMax, range: rawMax - rawMin };
        })(),
        outliers,
        comparison,
      };
    }
  }

  return { wineStats, participants };
}
