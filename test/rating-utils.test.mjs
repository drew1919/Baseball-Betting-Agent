import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clampPlayerRating, lineupAdjustedTeamRating, sampleAdjustedPlayerRating } from "../dist/rating-utils.js";
import { shrinkProbabilityToEven, winnerEvidenceQuality } from "../dist/prediction-quality.js";

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

const originalCwd = process.cwd();
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-feature-store-"));
let featureStore = null;
process.chdir(temporaryDirectory);
try {
  const featureStoreUrl = `${pathToFileURL(path.join(originalCwd, "dist", "feature-store.js")).href}?test=${Date.now()}`;
  featureStore = await import(featureStoreUrl);
  const rows = featureStore.upsertWinnerFeatureSnapshots([{
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
    marketWeight: 0.15,
    marketLean: "HOME"
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataQuality, 0.91);
  assert.deepEqual(rows[0].dataQualityNotes, ["partial lineup coverage"]);
} finally {
  featureStore?.closeFeatureStore();
  process.chdir(originalCwd);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("rating and evidence-quality assertions passed");
