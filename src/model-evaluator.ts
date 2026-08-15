import type { LogisticRegressionModel, ModelMetrics, RegressionTrainingRow } from "./regression-types.js";
import { predictHomeWinProbability, trainLogisticRegression } from "./regression-trainer.js";

function clampProbability(value: number) {
  return Math.max(0.0001, Math.min(0.9999, value));
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
    const probability = clampProbability(1 / (1 + Math.exp(-row.heuristicEdge * 0.14)));
    const homeProbability = row.heuristicPick === row.home ? probability : 1 - probability;
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
  minimumTrainingRows = 60
): { metrics: ModelMetrics | null; firstTestDate: string | null } {
  const dates = [...new Set(rows.map((row) => row.snapshotDate))].sort();
  const predictions: Array<{ probability: number; outcome: 0 | 1 }> = [];
  let firstTestDate: string | null = null;

  dates.forEach((date) => {
    const training = rows.filter((row) => row.snapshotDate < date);
    if (training.length < minimumTrainingRows) return;
    const model = trainLogisticRegression(training);
    if (!model) return;
    if (!firstTestDate) firstTestDate = date;
    rows.filter((row) => row.snapshotDate === date).forEach((row) => {
      predictions.push({ probability: clampProbability(predictHomeWinProbability(model, row)), outcome: row.homeWin });
    });
  });

  if (!predictions.length) return { metrics: null, firstTestDate };
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
    firstTestDate,
    metrics: {
      sampleSize: predictions.length,
      accuracy: correct / predictions.length,
      logLoss: logLoss / predictions.length,
      brierScore: brierScore / predictions.length,
      averageProbability: probabilitySum / predictions.length
    }
  };
}
