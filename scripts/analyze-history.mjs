import { DatabaseSync } from "node:sqlite";

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

function impliedProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

function featureVector(row) {
  const awayImplied = impliedProbability(row.away_moneyline);
  const homeImplied = impliedProbability(row.home_moneyline);
  const impliedTotal = awayImplied !== null && homeImplied !== null ? awayImplied + homeImplied : 0;
  const noVigHome = impliedTotal ? homeImplied / impliedTotal : 0.5;
  return [
    row.home_offense - row.away_offense,
    row.home_pitching - row.away_pitching,
    row.home_bullpen - row.away_bullpen,
    row.home_trend - row.away_trend,
    row.home_win_prob - row.away_win_prob,
    row.home_defense - row.away_defense,
    row.home_park - row.away_park,
    noVigHome - 0.5,
    (row.total ?? 8.5) - 8.5,
    row.lineup_coverage_home - row.lineup_coverage_away
  ];
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function trainRegression(trainingRows) {
  const matrix = trainingRows.map(featureVector);
  const targets = trainingRows.map((row) => row.home_win);
  const means = matrix[0].map((_, index) => average(matrix.map((row) => row[index])));
  const stds = means.map((mean, index) =>
    Math.sqrt(average(matrix.map((row) => (row[index] - mean) ** 2))) || 1
  );
  const normalized = matrix.map((row) => row.map((value, index) => (value - means[index]) / stds[index]));
  const weights = new Array(means.length).fill(0);
  let intercept = 0;
  for (let iteration = 0; iteration < 1200; iteration += 1) {
    const gradients = new Array(weights.length).fill(0);
    let interceptGradient = 0;
    normalized.forEach((row, rowIndex) => {
      const probability = sigmoid(intercept + row.reduce((sum, value, index) => sum + value * weights[index], 0));
      const error = probability - targets[rowIndex];
      interceptGradient += error;
      row.forEach((value, index) => { gradients[index] += error * value; });
    });
    intercept -= 0.035 * interceptGradient / normalized.length;
    weights.forEach((weight, index) => {
      weights[index] -= 0.035 * (gradients[index] / normalized.length + 0.02 * weight);
    });
  }
  return { means, stds, weights, intercept };
}

function regressionProbability(model, row) {
  const values = featureVector(row);
  return sigmoid(model.intercept + values.reduce((sum, value, index) =>
    sum + ((value - model.means[index]) / model.stds[index]) * model.weights[index], 0));
}

function walkForwardBacktest(allRows, minimumTrainingRows = 60) {
  const predictions = [];
  const testDates = [...new Set(allRows.map((row) => row.snapshot_date))];
  testDates.forEach((date) => {
    const training = allRows.filter((row) => row.snapshot_date < date);
    if (training.length < minimumTrainingRows) return;
    const model = trainRegression(training);
    allRows.filter((row) => row.snapshot_date === date).forEach((row) => {
      const probability = regressionProbability(model, row);
      predictions.push({ ...row, regressionPick: probability >= 0.5 ? row.home : row.away, probability });
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
  featureDiagnostics
}, null, 2));
