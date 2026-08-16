import type { LogisticRegressionModel, ModelMetrics, RegressionTrainingRow } from "./regression-types.js";
import { fallbackHomeWinProbability, predictHomeWinProbability, trainLogisticRegression, type RegressionFeatureName } from "./regression-trainer.js";

export const RECENT_VALIDATION_DATES = 5;
export const QUALIFIED_CONFIDENCE_THRESHOLD = 0.55;

function clampProbability(value: number) {
  return Math.max(0.0001, Math.min(0.9999, value));
}

function predictionMetrics(predictions: Array<{ probability: number; outcome: 0 | 1 }>): ModelMetrics | null {
  if (!predictions.length) return null;
  let correct = 0;
  let logLoss = 0;
  let brierScore = 0;
  let probabilitySum = 0;
  predictions.forEach(({ probability, outcome }) => {
    if ((probability >= 0.5 ? 1 : 0) === outcome) correct += 1;
    logLoss += -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability));
    brierScore += (probability - outcome) ** 2;
    probabilitySum += probability;
  });
  return {
    sampleSize: predictions.length,
    accuracy: correct / predictions.length,
    logLoss: logLoss / predictions.length,
    brierScore: brierScore / predictions.length,
    averageProbability: probabilitySum / predictions.length
  };
}

export function evaluateRegressionModel(model: LogisticRegressionModel, rows: RegressionTrainingRow[]): ModelMetrics | null {
  if (!rows.length) return null;

  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let probabilitySum = 0;

  rows.forEach((row) => {
    const probability = clampProbability(predictHomeWinProbability(model, row));
    const prediction = probability >= 0.5 ? 1 : 0;
    if (prediction === row.homeWin) correct += 1;
    logLoss += -(row.homeWin * Math.log(probability) + (1 - row.homeWin) * Math.log(1 - probability));
    brier += (probability - row.homeWin) ** 2;
    probabilitySum += probability;
  });

  return {
    sampleSize: rows.length,
    accuracy: correct / rows.length,
    logLoss: logLoss / rows.length,
    brierScore: brier / rows.length,
    averageProbability: probabilitySum / rows.length
  };
}

export function evaluateHeuristicBaseline(rows: RegressionTrainingRow[]): ModelMetrics | null {
  if (!rows.length) return null;

  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let probabilitySum = 0;

  rows.forEach((row) => {
    const homeProbability = clampProbability(fallbackHomeWinProbability(row));
    const prediction = homeProbability >= 0.5 ? 1 : 0;
    if (prediction === row.homeWin) correct += 1;
    logLoss += -(row.homeWin * Math.log(homeProbability) + (1 - row.homeWin) * Math.log(1 - homeProbability));
    brier += (homeProbability - row.homeWin) ** 2;
    probabilitySum += homeProbability;
  });

  return {
    sampleSize: rows.length,
    accuracy: correct / rows.length,
    logLoss: logLoss / rows.length,
    brierScore: brier / rows.length,
    averageProbability: probabilitySum / rows.length
  };
}

export function evaluateWalkForwardRegression(
  rows: RegressionTrainingRow[],
  minimumTrainingRows = 60,
  featureNames?: readonly RegressionFeatureName[],
  incompleteRecentDate?: string
): {
  metrics: ModelMetrics | null;
  qualifiedMetrics: ModelMetrics | null;
  forcedMetrics: ModelMetrics | null;
  firstTestDate: string | null;
  recentMetrics: ModelMetrics | null;
  recentQualifiedMetrics: ModelMetrics | null;
  recentForcedMetrics: ModelMetrics | null;
  recentStartDate: string | null;
} {
  const dates = [...new Set(rows.map((row) => row.snapshotDate))].sort();
  const predictions: Array<{ probability: number; outcome: 0 | 1; date: string }> = [];
  let firstTestDate: string | null = null;

  dates.forEach((date) => {
    const training = rows.filter((row) => row.snapshotDate < date);
    if (training.length < minimumTrainingRows) return;
    const model = trainLogisticRegression(training, featureNames);
    if (!model) return;
    if (!firstTestDate) firstTestDate = date;
    rows.filter((row) => row.snapshotDate === date).forEach((row) => {
      predictions.push({ probability: clampProbability(predictHomeWinProbability(model, row)), outcome: row.homeWin, date });
    });
  });

  if (!predictions.length) return {
    metrics: null,
    qualifiedMetrics: null,
    forcedMetrics: null,
    firstTestDate,
    recentMetrics: null,
    recentQualifiedMetrics: null,
    recentForcedMetrics: null,
    recentStartDate: null
  };
  const qualifiedPredictions = predictions.filter(({ probability }) =>
    Math.max(probability, 1 - probability) >= QUALIFIED_CONFIDENCE_THRESHOLD
  );
  const forcedPredictions = predictions.filter(({ probability }) =>
    Math.max(probability, 1 - probability) < QUALIFIED_CONFIDENCE_THRESHOLD
  );
  const predictionDates = [...new Set(predictions.map((prediction) => prediction.date))]
    .filter((date) => date !== incompleteRecentDate)
    .sort();
  const recentDates = predictionDates.slice(-RECENT_VALIDATION_DATES);
  const recentStartDate = recentDates[0] || null;
  const recentPredictions = recentStartDate
    ? predictions.filter((prediction) =>
        prediction.date >= recentStartDate && prediction.date !== incompleteRecentDate
      )
    : [];
  const recentQualified = recentPredictions.filter(({ probability }) =>
    Math.max(probability, 1 - probability) >= QUALIFIED_CONFIDENCE_THRESHOLD
  );
  const recentForced = recentPredictions.filter(({ probability }) =>
    Math.max(probability, 1 - probability) < QUALIFIED_CONFIDENCE_THRESHOLD
  );
  return {
    firstTestDate,
    metrics: predictionMetrics(predictions),
    qualifiedMetrics: predictionMetrics(qualifiedPredictions),
    forcedMetrics: predictionMetrics(forcedPredictions),
    recentMetrics: predictionMetrics(recentPredictions),
    recentQualifiedMetrics: predictionMetrics(recentQualified),
    recentForcedMetrics: predictionMetrics(recentForced),
    recentStartDate
  };
}
