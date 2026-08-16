import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] || "data/app.db";
const database = new DatabaseSync(dbPath, { readOnly: true });

const rows = database.prepare(`
  SELECT
    f.snapshot_date AS date,
    f.away,
    f.home,
    f.heuristic_pick AS heuristicPick,
    f.heuristic_edge AS heuristicEdge,
    f.home_offense - f.away_offense AS offenseDiff,
    f.home_pitching - f.away_pitching AS pitchingDiff,
    f.home_bullpen - f.away_bullpen AS bullpenDiff,
    f.home_trend - f.away_trend AS trendDiff,
    f.home_win_prob - f.away_win_prob AS winProbDiff,
    f.home_defense - f.away_defense AS defenseDiff,
    f.home_park - f.away_park AS parkDiff,
    f.away_moneyline AS awayMoneyline,
    f.home_moneyline AS homeMoneyline,
    r.home_win AS homeWin
  FROM winner_feature_snapshots f
  JOIN winner_results r ON r.game_id = f.game_id
  ORDER BY f.snapshot_date, f.game_id
`).all();

function americanImplied(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

function probabilities(row, marketWeight) {
  const signedEdge = row.heuristicPick === row.home ? row.heuristicEdge : -row.heuristicEdge;
  const rawStatistical = 1 / (1 + Math.exp(-signedEdge * 0.14));
  const statistical = 0.5 + (rawStatistical - 0.5) * 0.35;
  const awayImplied = americanImplied(row.awayMoneyline);
  const homeImplied = americanImplied(row.homeMoneyline);
  const totalImplied = (awayImplied || 0) + (homeImplied || 0);
  const market = awayImplied !== null && homeImplied !== null && totalImplied > 0
    ? homeImplied / totalImplied
    : null;
  const blended = market === null
    ? statistical
    : statistical * (1 - marketWeight) + market * marketWeight;
  return { statistical, market, blended };
}

function metrics(values, marketWeight) {
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let marketRows = 0;
  for (const row of values) {
    const probabilitiesForRow = probabilities(row, marketWeight);
    const probability = Math.max(0.001, Math.min(0.999, probabilitiesForRow.blended));
    const predictedHome = probability >= 0.5 ? 1 : 0;
    if (predictedHome === row.homeWin) correct += 1;
    if (probabilitiesForRow.market !== null) marketRows += 1;
    logLoss += -(row.homeWin * Math.log(probability) + (1 - row.homeWin) * Math.log(1 - probability));
    brier += (probability - row.homeWin) ** 2;
  }
  return {
    marketWeight,
    sampleSize: values.length,
    marketRows,
    accuracy: values.length ? correct / values.length : null,
    logLoss: values.length ? logLoss / values.length : null,
    brierScore: values.length ? brier / values.length : null
  };
}

function directionalMetrics(values) {
  const featureNames = [
    "offenseDiff",
    "pitchingDiff",
    "bullpenDiff",
    "trendDiff",
    "winProbDiff",
    "defenseDiff",
    "parkDiff"
  ];
  return Object.fromEntries(featureNames.map((featureName) => {
    const usable = values.filter((row) => Number.isFinite(row[featureName]) && row[featureName] !== 0);
    const correct = usable.filter((row) => (row[featureName] > 0 ? 1 : 0) === row.homeWin).length;
    return [featureName, {
      sampleSize: usable.length,
      accuracy: usable.length ? correct / usable.length : null
    }];
  }));
}

const dates = [...new Set(rows.map((row) => row.date))];
const recentDates = dates.slice(-5);
const recentRows = rows.filter((row) => recentDates.includes(row.date));
const weights = Array.from({ length: 21 }, (_, index) => index * 0.05);

console.log(JSON.stringify({
  dbPath,
  dates: { first: dates[0] || null, last: dates.at(-1) || null, recentDates },
  directional: {
    all: directionalMetrics(rows),
    recent: directionalMetrics(recentRows)
  },
  all: weights.map((weight) => metrics(rows, weight)),
  recent: weights.map((weight) => metrics(recentRows, weight))
}, null, 2));
