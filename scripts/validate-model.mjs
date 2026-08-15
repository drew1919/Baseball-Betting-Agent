import { DatabaseSync } from "node:sqlite";
import { buildRegressionTrainingRows, predictHomeWinProbability, REGRESSION_FEATURE_NAMES, REGRESSION_FEATURE_VERSION, trainLogisticRegression } from "../dist/regression-trainer.js";
import { evaluateHeuristicBaseline, evaluateWalkForwardRegression } from "../dist/model-evaluator.js";

const databasePath = process.argv[2] || "data/app.db";
const db = new DatabaseSync(databasePath, { readOnly: true });
const rawRows = db.prepare(`
  SELECT f.*, r.date, r.away_score, r.home_score, r.home_win
  FROM winner_feature_snapshots f
  JOIN winner_results r ON r.game_id = f.game_id
  ORDER BY f.snapshot_date, f.game_id
`).all();

const joined = rawRows.map((row) => ({
  snapshotDate: row.snapshot_date,
  gameId: row.game_id,
  away: row.away,
  home: row.home,
  awayOffense: row.away_offense,
  homeOffense: row.home_offense,
  awayPitching: row.away_pitching,
  homePitching: row.home_pitching,
  awayBullpen: row.away_bullpen,
  homeBullpen: row.home_bullpen,
  awayTrend: row.away_trend,
  homeTrend: row.home_trend,
  awayWinProb: row.away_win_prob,
  homeWinProb: row.home_win_prob,
  awayDefense: row.away_defense,
  homeDefense: row.home_defense,
  parkIndex: row.park_index,
  venueName: row.venue_name,
  awayPark: row.away_park,
  homePark: row.home_park,
  awayMoneyline: row.away_moneyline,
  homeMoneyline: row.home_moneyline,
  total: row.total,
  lineupCoverageAway: row.lineup_coverage_away,
  lineupCoverageHome: row.lineup_coverage_home,
  heuristicPick: row.heuristic_pick,
  heuristicEdge: row.heuristic_edge,
  heuristicConfidence: row.heuristic_confidence,
  marketLean: row.market_lean,
  date: row.date,
  awayScore: row.away_score,
  homeScore: row.home_score,
  homeWin: row.home_win
}));

const trainingRows = buildRegressionTrainingRows(joined);
const forward = evaluateWalkForwardRegression(trainingRows);
const noOddsRows = buildRegressionTrainingRows(joined.map((row) => ({
  ...row,
  awayMoneyline: null,
  homeMoneyline: null,
  total: null,
  marketLean: null
})));
const noOddsForward = evaluateWalkForwardRegression(noOddsRows);
const testRows = forward.firstTestDate
  ? trainingRows.filter((row) => row.snapshotDate >= forward.firstTestDate)
  : [];
const recentTestRows = forward.recentStartDate
  ? trainingRows.filter((row) => row.snapshotDate >= forward.recentStartDate)
  : [];
const candidate = trainLogisticRegression(trainingRows);
const dates = [...new Set(trainingRows.map((row) => row.snapshotDate))].sort();
const predictions = [];
const selectivePredictions = [];
const noOddsDeploymentPredictions = [];
const selectiveFeatureNames = REGRESSION_FEATURE_NAMES.filter((name) => name !== "totalValue");
dates.forEach((date) => {
  const earlier = trainingRows.filter((row) => row.snapshotDate < date);
  if (earlier.length < 60) return;
  const model = trainLogisticRegression(earlier);
  const selectiveModel = trainLogisticRegression(earlier, selectiveFeatureNames);
  trainingRows.filter((row) => row.snapshotDate === date).forEach((row) => {
    const probability = predictHomeWinProbability(model, row);
    const regressionPick = probability >= 0.5 ? row.home : row.away;
    predictions.push({ row, probability, regressionPick });
    const selectiveProbability = predictHomeWinProbability(selectiveModel, row);
    selectivePredictions.push({
      row,
      probability: selectiveProbability,
      regressionPick: selectiveProbability >= 0.5 ? row.home : row.away
    });
    const noOddsRow = { ...row, awayMoneyline: null, homeMoneyline: null, total: null, marketLean: null };
    const noOddsProbability = predictHomeWinProbability(model, noOddsRow);
    noOddsDeploymentPredictions.push({
      row,
      probability: noOddsProbability,
      regressionPick: noOddsProbability >= 0.5 ? row.home : row.away
    });
  });
});

function segmentMetrics(segment, picker) {
  if (!segment.length) return null;
  const correct = segment.filter((entry) => picker(entry) === (entry.row.homeWin ? entry.row.home : entry.row.away)).length;
  return { games: segment.length, correct, accuracy: correct / segment.length };
}

const highConfidence = predictions.filter(({ probability }) => Math.max(probability, 1 - probability) >= 0.55);
const veryHighConfidence = predictions.filter(({ probability }) => Math.max(probability, 1 - probability) >= 0.60);
const lowerConfidence = predictions.filter(({ probability }) => Math.max(probability, 1 - probability) < 0.55);
const recentPredictions = forward.recentStartDate
  ? predictions.filter(({ row }) => row.snapshotDate >= forward.recentStartDate)
  : [];
const recentHighConfidence = recentPredictions.filter(({ probability }) => Math.max(probability, 1 - probability) >= 0.55);
const recentLowerConfidence = recentPredictions.filter(({ probability }) => Math.max(probability, 1 - probability) < 0.55);
const selectiveQualified = selectivePredictions.filter(({ probability }) => Math.max(probability, 1 - probability) >= 0.55);
const selectiveByGame = new Map(selectivePredictions.map((entry) => [entry.row.gameId, entry]));
const primaryQualifiedWithSelective = highConfidence.map((primary) => ({
  ...primary,
  selective: selectiveByGame.get(primary.row.gameId)
})).filter((entry) => entry.selective);
const dualQualifiedAgree = primaryQualifiedWithSelective.filter((entry) =>
  Math.max(entry.selective.probability, 1 - entry.selective.probability) >= 0.55
  && entry.regressionPick === entry.selective.regressionPick
);
const dualQualifiedDisagree = primaryQualifiedWithSelective.filter((entry) =>
  Math.max(entry.selective.probability, 1 - entry.selective.probability) >= 0.55
  && entry.regressionPick !== entry.selective.regressionPick
);
const recentSelectiveQualified = forward.recentStartDate
  ? selectiveQualified.filter(({ row }) => row.snapshotDate >= forward.recentStartDate)
  : [];
const recentDualQualifiedAgree = forward.recentStartDate
  ? dualQualifiedAgree.filter(({ row }) => row.snapshotDate >= forward.recentStartDate)
  : [];
const marketAvailable = predictions.filter(({ row }) => row.marketLean);
const regressionMarketAgree = marketAvailable.filter((entry) => entry.regressionPick === entry.row.marketLean);
const regressionMarketDisagree = marketAvailable.filter((entry) => entry.regressionPick !== entry.row.marketLean);
const hybridPicker = (entry) => Math.max(entry.probability, 1 - entry.probability) >= 0.55
  ? entry.regressionPick
  : (entry.row.marketLean || entry.regressionPick);
const calibrationChecks = [0.35, 0.5, 0.65, 0.8, 1].map((factor) => {
  let logLoss = 0;
  let brierScore = 0;
  predictions.forEach(({ probability, row }) => {
    const adjusted = 0.5 + (probability - 0.5) * factor;
    logLoss += -(row.homeWin * Math.log(adjusted) + (1 - row.homeWin) * Math.log(1 - adjusted));
    brierScore += (adjusted - row.homeWin) ** 2;
  });
  return { factor, logLoss: logLoss / predictions.length, brierScore: brierScore / predictions.length };
});
const byDate = Object.fromEntries(dates.map((date) => [
  date,
  segmentMetrics(predictions.filter((entry) => entry.row.snapshotDate === date), (entry) => entry.regressionPick)
]).filter(([, metrics]) => metrics));

console.log(JSON.stringify({
  featureVersion: REGRESSION_FEATURE_VERSION,
  trainingRows: trainingRows.length,
  candidateVersion: candidate?.featureVersion || null,
  firstForwardTestDate: forward.firstTestDate,
  forwardMetrics: forward.metrics,
  recentForwardMetrics: forward.recentMetrics,
  recentQualifiedForwardMetrics: forward.recentQualifiedMetrics,
  recentForcedForwardMetrics: forward.recentForcedMetrics,
  recentForwardStartDate: forward.recentStartDate,
  recentHeuristicMetrics: evaluateHeuristicBaseline(recentTestRows),
  noOddsForwardMetrics: noOddsForward.metrics,
  oddsCoverage: {
    gamesWithMoneylines: joined.filter((row) => row.awayMoneyline !== null && row.homeMoneyline !== null).length,
    totalGames: joined.length
  },
  heuristicOnForwardWindow: evaluateHeuristicBaseline(testRows),
  strategyChecks: {
    regressionHighConfidence: segmentMetrics(highConfidence, (entry) => entry.regressionPick),
    regressionCalibrated60Plus: segmentMetrics(veryHighConfidence, (entry) => entry.regressionPick),
    regressionLowerConfidence: segmentMetrics(lowerConfidence, (entry) => entry.regressionPick),
    recentRegressionHighConfidence: segmentMetrics(recentHighConfidence, (entry) => entry.regressionPick),
    recentRegressionLowerConfidence: segmentMetrics(recentLowerConfidence, (entry) => entry.regressionPick),
    selectiveNoTotalQualified: segmentMetrics(selectiveQualified, (entry) => entry.regressionPick),
    dualQualifiedAgree: segmentMetrics(dualQualifiedAgree, (entry) => entry.regressionPick),
    dualQualifiedDisagree: segmentMetrics(dualQualifiedDisagree, (entry) => entry.regressionPick),
    recentSelectiveNoTotalQualified: segmentMetrics(recentSelectiveQualified, (entry) => entry.regressionPick),
    recentDualQualifiedAgree: segmentMetrics(recentDualQualifiedAgree, (entry) => entry.regressionPick),
    market: segmentMetrics(marketAvailable, (entry) => entry.row.marketLean),
    regressionMarketAgree: segmentMetrics(regressionMarketAgree, (entry) => entry.regressionPick),
    regressionMarketDisagree: segmentMetrics(regressionMarketDisagree, (entry) => entry.regressionPick),
    trainedWithOddsDeployedWithoutOdds: segmentMetrics(noOddsDeploymentPredictions, (entry) => entry.regressionPick),
    noOddsCalibrated55Plus: segmentMetrics(
      noOddsDeploymentPredictions.filter(({ probability }) => Math.max(probability, 1 - probability) >= 0.55),
      (entry) => entry.regressionPick
    ),
    highRegressionOtherwiseMarket: segmentMetrics(predictions, hybridPicker)
  },
  calibrationChecks,
  byDate,
  candidateFeatureNames: candidate?.featureNames || [],
  candidateWeights: candidate ? Object.fromEntries(candidate.featureNames.map((name, index) => [name, candidate.weights[index]])) : null
}, null, 2));
