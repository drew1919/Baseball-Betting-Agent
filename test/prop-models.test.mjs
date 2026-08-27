import assert from "node:assert/strict";
import { estimateFirstInningProbability, estimateStrikeoutProjection } from "../dist/prop-models.js";

const commonPitcher = {
  seasonBattersFaced: 500,
  recentBattersFaced: 110,
  recentInnings: 27,
  recentStarts: 5,
  lineupCoverage: 1,
  walkPercent: 7,
  umpireKPerGame: 16,
  externalProjection: null,
  propLine: 5.5
};

const highUpside = estimateStrikeoutProjection({
  ...commonPitcher,
  seasonKPercent: 30,
  recentKPercent: 32,
  lineupKPercent: 26,
  whiffPercent: 32,
  chaseMissPercent: 48,
  swordsPer100BattersFaced: 6
});
const contactProfile = estimateStrikeoutProjection({
  ...commonPitcher,
  seasonKPercent: 18,
  recentKPercent: 17,
  lineupKPercent: 18,
  whiffPercent: 20,
  chaseMissPercent: 28,
  swordsPer100BattersFaced: 2
});

assert.ok(highUpside.projectedStrikeouts > contactProfile.projectedStrikeouts + 2);
assert.equal(highUpside.pick, "Over");
assert.equal(contactProfile.pick, "Under");
assert.ok(highUpside.dataQuality > 0.8);

const balanced = estimateFirstInningProbability({
  awayHalfPreventionScore: 55,
  homeHalfPreventionScore: 55,
  gameTotal: 8
});
const weakBottomHalf = estimateFirstInningProbability({
  awayHalfPreventionScore: 55,
  homeHalfPreventionScore: 25,
  gameTotal: 8
});
const highTotal = estimateFirstInningProbability({
  awayHalfPreventionScore: 55,
  homeHalfPreventionScore: 55,
  gameTotal: 10
});

assert.ok(balanced.nrfiProbability > weakBottomHalf.nrfiProbability);
assert.ok(balanced.nrfiProbability > highTotal.nrfiProbability);
assert.ok(Math.abs(
  (balanced.awayHalfNoRunProbability * balanced.homeHalfNoRunProbability + 0.009)
  - balanced.nrfiProbability
) < 0.0001);
assert.equal(weakBottomHalf.pick, "YRFI");

console.log("strikeout and full-inning probability assertions passed");
