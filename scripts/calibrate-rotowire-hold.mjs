import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = path.resolve(process.argv[2] || "data/app.db");
const database = new DatabaseSync(dbPath, { readOnly: true });
const rows = database.prepare(`
  SELECT f.away_moneyline AS awayMoneyline,
         f.home_moneyline AS homeMoneyline,
         r.home_win AS homeWin
  FROM winner_feature_snapshots f
  JOIN winner_results r ON r.game_id = f.game_id
  WHERE f.away_moneyline IS NOT NULL
    AND f.home_moneyline IS NOT NULL
`).all();

function impliedProbability(american) {
  if (!Number.isFinite(american) || american === 0) return null;
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

const samples = rows.map((row) => {
  const away = impliedProbability(Number(row.awayMoneyline));
  const home = impliedProbability(Number(row.homeMoneyline));
  if (away === null || home === null || away + home === 0) return null;
  const listedFavorite = Math.max(away, home);
  const noVigFavorite = Math.max(away, home) / (away + home);
  return {
    listedFavorite,
    noVigFavorite,
    marketCorrect: (home >= away ? 1 : 0) === Number(row.homeWin)
  };
}).filter(Boolean);

const numerator = samples.reduce((sum, row) => sum + (row.listedFavorite - 0.5) * (row.noVigFavorite - 0.5), 0);
const denominator = samples.reduce((sum, row) => sum + (row.listedFavorite - 0.5) ** 2, 0);
const fittedShrink = denominator ? numerator / denominator : null;
const marketCorrect = samples.filter((row) => row.marketCorrect).length;
const productionArtifact = database.prepare("SELECT payload FROM artifacts WHERE kind = 'regression-production'").get();
const productionModel = productionArtifact ? JSON.parse(String(productionArtifact.payload)) : null;
const impliedFeatureIndex = productionModel?.featureNames?.indexOf("impliedDiff") ?? -1;

console.log(JSON.stringify({
  database: dbPath,
  sampleSize: samples.length,
  fittedShrink,
  marketAccuracy: samples.length ? marketCorrect / samples.length : null,
  meanListedFavoriteProbability: samples.length
    ? samples.reduce((sum, row) => sum + row.listedFavorite, 0) / samples.length
    : null,
  meanNoVigFavoriteProbability: samples.length
    ? samples.reduce((sum, row) => sum + row.noVigFavorite, 0) / samples.length
    : null,
  productionImpliedDiffWeight: impliedFeatureIndex >= 0 ? productionModel.weights[impliedFeatureIndex] : null
}, null, 2));
