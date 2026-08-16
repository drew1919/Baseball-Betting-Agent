import type { FirstInningFeatureSnapshot, FirstInningPerformance, FirstInningResultRow } from "./first-inning-types.js";

export const FIRST_INNING_MIN_GRADED = 30;
export const FIRST_INNING_MIN_ACCURACY = 0.55;
export const FIRST_INNING_MIN_QUALIFIED = 15;
export const FIRST_INNING_MIN_QUALIFIED_ACCURACY = 0.60;

export function evaluateFirstInningPerformance(
  snapshots: FirstInningFeatureSnapshot[],
  resultRows: FirstInningResultRow[]
): FirstInningPerformance {
  const results = new Map(resultRows.map((result) => [result.gameId, result]));
  const graded = snapshots
    .map((snapshot) => {
      const result = results.get(snapshot.gameId);
      if (!result) return null;
      const actualPick = result.nrfiHit ? "NRFI" : "YRFI";
      return { ...snapshot, correct: snapshot.pick === actualPick };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const gradedDates = [...new Set(graded.map((row) => row.snapshotDate))].sort();
  const recentDates = new Set(gradedDates.slice(-5));
  const qualified = graded.filter((row) => row.dataQuality >= 0.85 && Math.abs(row.nrfiScore - 58) >= 3);
  const recent = graded.filter((row) => recentDates.has(row.snapshotDate));
  const nrfi = graded.filter((row) => row.pick === "NRFI");
  const yrfi = graded.filter((row) => row.pick === "YRFI");
  const countCorrect = (rows: typeof graded) => rows.filter((row) => row.correct).length;
  const accuracy = (rows: typeof graded) => rows.length ? countCorrect(rows) / rows.length : null;
  const correctCount = countCorrect(graded);
  const qualifiedCorrectCount = countCorrect(qualified);
  const recentCorrectCount = countCorrect(recent);
  const qualifiedAccuracy = accuracy(qualified);
  const recentAccuracy = accuracy(recent);
  const approved = graded.length >= FIRST_INNING_MIN_GRADED
    && (accuracy(graded) ?? 0) >= FIRST_INNING_MIN_ACCURACY
    && qualified.length >= FIRST_INNING_MIN_QUALIFIED
    && (qualifiedAccuracy ?? 0) >= FIRST_INNING_MIN_QUALIFIED_ACCURACY
    && recent.length >= 15
    && (recentAccuracy ?? 0) >= FIRST_INNING_MIN_ACCURACY;

  return {
    gradedCount: graded.length,
    correctCount,
    accuracy: accuracy(graded),
    qualifiedCount: qualified.length,
    qualifiedCorrectCount,
    qualifiedAccuracy,
    recentCount: recent.length,
    recentCorrectCount,
    recentAccuracy,
    nrfiCount: nrfi.length,
    nrfiCorrectCount: countCorrect(nrfi),
    nrfiAccuracy: accuracy(nrfi),
    yrfiCount: yrfi.length,
    yrfiCorrectCount: countCorrect(yrfi),
    yrfiAccuracy: accuracy(yrfi),
    approved,
    minimumGraded: FIRST_INNING_MIN_GRADED,
    minimumAccuracy: FIRST_INNING_MIN_ACCURACY,
    minimumQualified: FIRST_INNING_MIN_QUALIFIED,
    minimumQualifiedAccuracy: FIRST_INNING_MIN_QUALIFIED_ACCURACY
  };
}
