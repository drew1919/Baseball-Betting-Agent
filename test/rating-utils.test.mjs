import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clampPlayerRating, lineupAdjustedTeamRating, sampleAdjustedPlayerRating } from "../dist/rating-utils.js";
import { shrinkProbabilityToEven, winnerEvidenceQuality } from "../dist/prediction-quality.js";
import { evaluateFirstInningPerformance } from "../dist/first-inning-evaluator.js";
import { MIN_REGRESSION_SAMPLE, regressionFeatureDiagnostics, regressionTrainingEligible, trainLogisticRegression } from "../dist/regression-trainer.js";

const tinySample = sampleAdjustedPlayerRating(153.46, 4);
assert.ok(tinySample > 50 && tinySample < 51, `expected near-average rating, received ${tinySample}`);

const establishedSample = sampleAdjustedPlayerRating(60.67, 516);
assert.ok(establishedSample > 58 && establishedSample < 59, `expected most of the signal to remain, received ${establishedSample}`);

assert.equal(sampleAdjustedPlayerRating(153.46, 0), 50);
assert.equal(clampPlayerRating(191.5), 75);
assert.equal(clampPlayerRating(-25), 30);

assert.equal(lineupAdjustedTeamRating([70], 9), 470 / 9);
assert.equal(lineupAdjustedTeamRating(Array(9).fill(55), 9), 55);

const completeEvidence = winnerEvidenceQuality({
  awayLineupCoverage: 1,
  homeLineupCoverage: 1,
  awayStarterQuality: 1,
  homeStarterQuality: 1,
  awayBullpenAvailable: true,
  homeBullpenAvailable: true,
  marketAvailable: true,
  lineupsConfirmed: true
});
assert.equal(completeEvidence.score, 1);
assert.equal(completeEvidence.reliability, 1);

const partialEvidence = winnerEvidenceQuality({
  awayLineupCoverage: 2 / 9,
  homeLineupCoverage: 0,
  awayStarterQuality: 1,
  homeStarterQuality: 0,
  awayBullpenAvailable: true,
  homeBullpenAvailable: false,
  marketAvailable: false,
  lineupsConfirmed: false
});
assert.ok(partialEvidence.score < 0.3);
assert.ok(shrinkProbabilityToEven(0.6, partialEvidence.reliability) < 0.56);

function firstInningRows(totalGames, correctnessForIndex) {
  const snapshots = [];
  const results = [];
  for (let index = 0; index < totalGames; index += 1) {
    const day = String(1 + Math.floor(index / 6)).padStart(2, "0");
    const gameId = `2026-08-${day}-A${index}-H${index}`;
    const pick = index % 2 ? "NRFI" : "YRFI";
    const correct = correctnessForIndex(index);
    snapshots.push({
      gameId,
      snapshotDate: `2026-08-${day}`,
      away: `A${index}`,
      home: `H${index}`,
      awayHalfScore: 60,
      homeHalfScore: 60,
      nrfiScore: pick === "NRFI" ? 62 : 54,
      pick,
      pickScore: 62,
      total: 8,
      dataQuality: 0.95,
      analysisVersion: "test"
    });
    const actualNrfi = correct ? pick === "NRFI" : pick !== "NRFI";
    results.push({
      gameId,
      date: `2026-08-${day}`,
      away: `A${index}`,
      home: `H${index}`,
      awayFirstRuns: actualNrfi ? 0 : 1,
      homeFirstRuns: 0,
      nrfiHit: actualNrfi ? 1 : 0
    });
  }
  return { snapshots, results };
}

const approvedFirstInningRows = firstInningRows(30, () => true);
const approvedFirstInning = evaluateFirstInningPerformance(
  approvedFirstInningRows.snapshots,
  approvedFirstInningRows.results
);
assert.equal(approvedFirstInning.accuracy, 1);
assert.equal(approvedFirstInning.approved, true);

const slumpingFirstInningRows = firstInningRows(60, (index) => index < 35 || index >= 50);
const slumpingFirstInning = evaluateFirstInningPerformance(
  slumpingFirstInningRows.snapshots,
  slumpingFirstInningRows.results
);
assert.ok(slumpingFirstInning.accuracy >= 0.7);
assert.ok(slumpingFirstInning.recentAccuracy < 0.55);
assert.equal(slumpingFirstInning.approved, false);

const regressionRows = Array.from({ length: MIN_REGRESSION_SAMPLE }, (_, index) => ({
  offenseDiff: (index % 17) - 8,
  pitchingDiff: ((index * 3) % 19) - 9,
  bullpenDiff: Math.sin(index / 3),
  trendDiff: ((index * 5) % 23) - 11,
  winProbDiff: ((index % 17) - 8) * 2,
  defenseDiff: Math.cos(index / 5),
  parkDiff: ((index * 7) % 13) / 10,
  impliedDiff: ((index * 11) % 29) / 100 - 0.14,
  totalValue: (index % 7) / 2 - 1.5,
  coverageDiff: 0,
  homeWin: index % 3 === 0 ? 1 : 0
}));
const regressionDiagnostics = regressionFeatureDiagnostics(regressionRows);
assert.equal(regressionDiagnostics.find((row) => row.name === "coverageDiff").selected, false);
assert.equal(regressionDiagnostics.find((row) => row.name === "winProbDiff").selected, false);
assert.equal(regressionDiagnostics.find((row) => row.name === "winProbDiff").redundantWith, "offenseDiff");
assert.equal(trainLogisticRegression(regressionRows.slice(0, MIN_REGRESSION_SAMPLE - 1)), null);
const stableRegression = trainLogisticRegression(regressionRows);
assert.ok(stableRegression);
assert.equal(stableRegression.trainingSampleSize, MIN_REGRESSION_SAMPLE);
assert.ok(!stableRegression.featureNames.includes("coverageDiff"));
assert.ok(!stableRegression.featureNames.includes("winProbDiff"));

const originalCwd = process.cwd();
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-feature-store-"));
let featureStore = null;
process.chdir(temporaryDirectory);
try {
  const featureStoreUrl = `${pathToFileURL(path.join(originalCwd, "dist", "feature-store.js")).href}?test=${Date.now()}`;
  featureStore = await import(featureStoreUrl);
  const modernFeatureSnapshot = {
    analysisVersion: "test",
    snapshotDate: "2026-08-17",
    gameId: "2026-08-17-AWAY-HOME",
    away: "AWAY",
    home: "HOME",
    awayOffense: 50,
    homeOffense: 51,
    awayPitching: 50,
    homePitching: 51,
    awayBullpen: 50,
    homeBullpen: 51,
    awayTrend: 50,
    homeTrend: 51,
    awayWinProb: 50,
    homeWinProb: 51,
    awayDefense: 50,
    homeDefense: 51,
    parkIndex: 100,
    venueName: "Test Park",
    awayPark: 50,
    homePark: 50,
    awayMoneyline: 110,
    homeMoneyline: -120,
    total: 8.5,
    lineupCoverageAway: 8 / 9,
    lineupCoverageHome: 1,
    dataQuality: 0.91,
    dataQualityNotes: ["partial lineup coverage"],
    heuristicPick: "HOME",
    heuristicEdge: 1,
    heuristicConfidence: 51,
    predictionPick: "HOME",
    predictionConfidence: 51,
    predictionMethod: "test",
    wagerQualified: true,
    selectiveConfidence: 57,
    marketWeight: 0.15,
    marketLean: "HOME"
  };
  assert.equal(regressionTrainingEligible(modernFeatureSnapshot), true);
  assert.equal(regressionTrainingEligible({ ...modernFeatureSnapshot, analysisVersion: "legacy" }), false);
  assert.equal(regressionTrainingEligible({ ...modernFeatureSnapshot, dataQuality: 0.74 }), false);
  assert.equal(regressionTrainingEligible({ ...modernFeatureSnapshot, predictionMethod: "legacy snapshot" }), false);
  assert.equal(regressionTrainingEligible({
    ...modernFeatureSnapshot,
    dataQualityNotes: ["lineups are projected rather than confirmed"]
  }), false);
  const rows = featureStore.upsertWinnerFeatureSnapshots([modernFeatureSnapshot]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataQuality, 0.91);
  assert.deepEqual(rows[0].dataQualityNotes, ["partial lineup coverage"]);
  assert.equal(rows[0].wagerQualified, true);
  assert.equal(rows[0].selectiveConfidence, 57);
  featureStore.upsertFirstInningFeatureSnapshots([approvedFirstInningRows.snapshots[0]]);
  featureStore.upsertFirstInningResults([approvedFirstInningRows.results[0]]);
  assert.equal(featureStore.readFirstInningFeatureSnapshots().length, 1);
  assert.equal(featureStore.readFirstInningResults()[0].nrfiHit, approvedFirstInningRows.results[0].nrfiHit);
} finally {
  featureStore?.closeFeatureStore();
  process.chdir(originalCwd);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("rating, evidence-quality, and first-inning assertions passed");
