import type { LogisticRegressionModel, RegressionTrainingRow, WinnerFeatureSnapshot, WinnerResultRow } from "./regression-types.js";

const FEATURE_NAMES = [
  "offenseDiff",
  "pitchingDiff",
  "bullpenDiff",
  "trendDiff",
  "winProbDiff",
  "defenseDiff",
  "parkDiff",
  "impliedDiff",
  "totalValue",
  "coverageDiff",
  "homeField"
] as const;

export const MIN_REGRESSION_SAMPLE = 30;

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export function buildRegressionTrainingRows(rows: Array<WinnerFeatureSnapshot & WinnerResultRow>): RegressionTrainingRow[] {
  return rows.map((row) => ({
    ...row,
    offenseDiff: row.homeOffense - row.awayOffense,
    pitchingDiff: row.homePitching - row.awayPitching,
    bullpenDiff: row.homeBullpen - row.awayBullpen,
    trendDiff: row.homeTrend - row.awayTrend,
    winProbDiff: row.homeWinProb - row.awayWinProb,
    defenseDiff: row.homeDefense - row.awayDefense,
    parkDiff: row.homePark - row.awayPark,
    impliedDiff: ((row.homeMoneyline ?? 0) - (row.awayMoneyline ?? 0)) * -1,
    totalValue: row.total ?? 8.5,
    coverageDiff: row.lineupCoverageHome - row.lineupCoverageAway,
    homeField: 1
  }));
}

export function trainLogisticRegression(rows: RegressionTrainingRow[]): LogisticRegressionModel | null {
  if (rows.length < MIN_REGRESSION_SAMPLE) return null;

  const matrix = rows.map((row) => FEATURE_NAMES.map((name) => row[name]));
  const targets = rows.map((row) => row.homeWin);

  const means = FEATURE_NAMES.map((_, featureIndex) =>
    matrix.reduce((sum, row) => sum + row[featureIndex], 0) / matrix.length
  );
  const stds = FEATURE_NAMES.map((_, featureIndex) => {
    const variance = matrix.reduce((sum, row) => {
      const diff = row[featureIndex] - means[featureIndex];
      return sum + diff * diff;
    }, 0) / matrix.length;
    return Math.sqrt(variance) || 1;
  });

  const normalized = matrix.map((row) =>
    row.map((value, index) => (value - means[index]) / stds[index])
  );

  const weights = new Array(FEATURE_NAMES.length).fill(0);
  let intercept = 0;
  const learningRate = 0.045;
  const regularization = 0.001;
  const iterations = 1800;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const weightGradients = new Array(FEATURE_NAMES.length).fill(0);
    let interceptGradient = 0;

    for (let rowIndex = 0; rowIndex < normalized.length; rowIndex += 1) {
      const row = normalized[rowIndex];
      let linear = intercept;
      for (let featureIndex = 0; featureIndex < row.length; featureIndex += 1) {
        linear += row[featureIndex] * weights[featureIndex];
      }
      const prediction = sigmoid(linear);
      const error = prediction - targets[rowIndex];
      interceptGradient += error;

      for (let featureIndex = 0; featureIndex < row.length; featureIndex += 1) {
        weightGradients[featureIndex] += error * row[featureIndex];
      }
    }

    intercept -= learningRate * (interceptGradient / normalized.length);
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      const regularized = (weightGradients[featureIndex] / normalized.length) + (regularization * weights[featureIndex]);
      weights[featureIndex] -= learningRate * regularized;
    }
  }

  return {
    featureNames: [...FEATURE_NAMES],
    means,
    stds,
    weights,
    intercept,
    trainedAt: new Date().toISOString(),
    trainingSampleSize: rows.length
  };
}

export function predictHomeWinProbability(model: LogisticRegressionModel, row: RegressionTrainingRow) {
  const values = model.featureNames.map((name) => row[name as keyof RegressionTrainingRow] as number);
  let linear = model.intercept;
  for (let index = 0; index < values.length; index += 1) {
    linear += ((values[index] - model.means[index]) / (model.stds[index] || 1)) * model.weights[index];
  }
  return sigmoid(linear);
}
