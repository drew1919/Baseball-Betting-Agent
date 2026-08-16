import { DatabaseSync } from "node:sqlite";
import { buildRegressionTrainingRows, predictHomeWinProbability, regressionTrainingEligible, trainLogisticRegression } from "../dist/regression-trainer.js";

const databasePath = process.argv[2] || "data/app.db";
const db = new DatabaseSync(databasePath, { readOnly: true });

const rows = db.prepare(`
  SELECT
    f.*,
    r.away_score,
    r.home_score,
    r.home_win
  FROM winner_feature_snapshots f
  JOIN winner_results r ON r.game_id = f.game_id
  ORDER BY f.snapshot_date, f.game_id
`).all();

const featurePairs = [
  ["offense", "away_offense", "home_offense"],
  ["pitching", "away_pitching", "home_pitching"],
  ["bullpen", "away_bullpen", "home_bullpen"],
  ["trend", "away_trend", "home_trend"],
  ["winProb", "away_win_prob", "home_win_prob"],
  ["defense", "away_defense", "home_defense"],
  ["park", "away_park", "home_park"]
];

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function accuracy(group, selector = (row) => row.heuristic_pick) {
  if (!group.length) return null;
  const correct = group.filter((row) => selector(row) === (row.home_win ? row.home : row.away)).length;
  return correct / group.length;
}

function summarize(group, selector = (row) => row.heuristic_pick) {
  const groupAccuracy = accuracy(group, selector);
  return {
    games: group.length,
    wins: Math.round((groupAccuracy || 0) * group.length),
    accuracy: round(groupAccuracy),
    marketAccuracy: round(accuracy(group.filter((row) => row.market_lean), (row) => row.market_lean)),
    homePickRate: round(group.filter((row) => row.heuristic_pick === row.home).length / Math.max(1, group.length)),
    averageEdge: round(average(group.map((row) => row.heuristic_edge)))
  };
}

function pointBiserial(values, outcomes) {
  const mean = average(values);
  const std = Math.sqrt(average(values.map((value) => (value - mean) ** 2)) || 0);
  const positives = values.filter((_, index) => outcomes[index] === 1);
  const negatives = values.filter((_, index) => outcomes[index] === 0);
  if (!std || !positives.length || !negatives.length) return 0;
  return ((average(positives) - average(negatives)) / std)
    * Math.sqrt((positives.length / values.length) * (negatives.length / values.length));
}

function trainingInput(row) {
  return {
    snapshotDate: row.snapshot_date,
    analysisVersion: row.analysis_version,
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
    dataQuality: row.data_quality,
    heuristicPick: row.heuristic_pick,
    heuristicEdge: row.heuristic_edge,
    heuristicConfidence: row.heuristic_confidence,
    predictionMethod: row.prediction_method,
    marketLean: row.market_lean,
    date: row.snapshot_date,
    awayScore: row.away_score,
    homeScore: row.home_score,
    homeWin: row.home_win
  };
}

function walkForwardBacktest(allRows, minimumTrainingRows = 60) {
  const predictions = [];
  const trainingRows = buildRegressionTrainingRows(allRows.map(trainingInput).filter(regressionTrainingEligible));
  const sourceByGameId = new Map(allRows.map((row) => [row.game_id, row]));
  const testDates = [...new Set(trainingRows.map((row) => row.snapshotDate))];
  testDates.forEach((date) => {
    const training = trainingRows.filter((row) => row.snapshotDate < date);
    if (training.length < minimumTrainingRows) return;
    const model = trainLogisticRegression(training);
    trainingRows.filter((row) => row.snapshotDate === date).forEach((row) => {
      const probability = predictHomeWinProbability(model, row);
      const source = sourceByGameId.get(row.gameId);
      predictions.push({ ...source, regressionPick: probability >= 0.5 ? row.home : row.away, probability });
    });
  });
  return predictions;
}

const dates = [...new Set(rows.map((row) => row.snapshot_date))];
const latestDates = dates.slice(-3);
const recent = rows.filter((row) => latestDates.includes(row.snapshot_date));
const prior = rows.filter((row) => !latestDates.includes(row.snapshot_date));

const featureDiagnostics = Object.fromEntries(featurePairs.map(([name, awayKey, homeKey]) => {
  const differences = rows.map((row) => row[homeKey] - row[awayKey]);
  return [name, {
    meanDifference: round(average(differences)),
    standardDeviation: round(Math.sqrt(average(differences.map((value) => (value - average(differences)) ** 2)) || 0)),
    correlationWithHomeWin: round(pointBiserial(differences, rows.map((row) => row.home_win)))
  }];
}));

const marketAgree = rows.filter((row) => row.market_lean && row.market_lean === row.heuristic_pick);
const marketDisagree = rows.filter((row) => row.market_lean && row.market_lean !== row.heuristic_pick);
const awayPicks = rows.filter((row) => row.heuristic_pick === row.away);
const homePicks = rows.filter((row) => row.heuristic_pick === row.home);
const walkForward = walkForwardBacktest(rows);
const cleanTrainingRows = rows.map(trainingInput).filter(regressionTrainingEligible);
const disagreementByEdge = Object.fromEntries([
  ["under3", (row) => row.heuristic_edge < 3],
  ["3to5", (row) => row.heuristic_edge >= 3 && row.heuristic_edge < 5],
  ["5plus", (row) => row.heuristic_edge >= 5]
].map(([name, predicate]) => [name, summarize(marketDisagree.filter(predicate))]));
const regressionConfidenceSegments = Object.fromEntries([
  ["50to55", (row) => Math.abs(row.probability - 0.5) < 0.05],
  ["55to60", (row) => Math.abs(row.probability - 0.5) >= 0.05 && Math.abs(row.probability - 0.5) < 0.10],
  ["60plus", (row) => Math.abs(row.probability - 0.5) >= 0.10]
].map(([name, predicate]) => [name, summarize(walkForward.filter(predicate), (row) => row.regressionPick)]));

console.log(JSON.stringify({
  databasePath,
  dateRange: { first: dates[0] || null, last: dates.at(-1) || null, gradedDates: dates.length },
  overall: summarize(rows),
  recentDates: latestDates,
  recent: summarize(recent),
  prior: summarize(prior),
  segments: {
    marketAgree: summarize(marketAgree),
    marketDisagree: summarize(marketDisagree),
    homePicks: summarize(homePicks),
    awayPicks: summarize(awayPicks)
  },
  marketDisagreementByEdge: disagreementByEdge,
  walkForward: {
    ...summarize(walkForward, (row) => row.regressionPick),
    firstTestDate: walkForward[0]?.snapshot_date || null,
    regressionAccuracy: round(accuracy(walkForward, (row) => row.regressionPick)),
    heuristicAccuracyOnSameGames: round(accuracy(walkForward)),
    marketAccuracyOnSameGames: round(accuracy(walkForward.filter((row) => row.market_lean), (row) => row.market_lean)),
    confidenceSegments: regressionConfidenceSegments
  },
  trainingEligibility: {
    allJoinedRows: rows.length,
    eligibleJoinedRows: cleanTrainingRows.length,
    excludedJoinedRows: rows.length - cleanTrainingRows.length
  },
  featureDiagnostics
}, null, 2));
