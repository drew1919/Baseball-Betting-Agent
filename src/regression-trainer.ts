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
  "coverageDiff"
] as const;

export const REGRESSION_FEATURE_VERSION = 2;
export const MIN_REGRESSION_SAMPLE = 60;
const PROBABILITY_CALIBRATION_FACTOR = 0.5;

function impliedProbability(odds: number | null) {
  if (odds === null || !Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

function regressionFeatures(row: WinnerFeatureSnapshot) {
  const awayImplied = impliedProbability(row.awayMoneyline);
  const homeImplied = impliedProbability(row.homeMoneyline);
  const impliedTotal = (awayImplied || 0) + (homeImplied || 0);
  const noVigHome = awayImplied !== null && homeImplied !== null && impliedTotal
    ? homeImplied / impliedTotal
    : 0.5;
  return {
    offenseDiff: row.homeOffense - row.awayOffense,
    pitchingDiff: row.homePitching - row.awayPitching,
    bullpenDiff: row.homeBullpen - row.awayBullpen,
    trendDiff: row.homeTrend - row.awayTrend,
    winProbDiff: row.homeWinProb - row.awayWinProb,
    defenseDiff: row.homeDefense - row.awayDefense,
    parkDiff: row.homePark - row.awayPark,
    impliedDiff: noVigHome - 0.5,
    totalValue: (row.total ?? 8.5) - 8.5,
    coverageDiff: row.lineupCoverageHome - row.lineupCoverageAway,
    homeField: 1
  };
}

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export function buildRegressionTrainingRows(rows: Array<WinnerFeatureSnapshot & WinnerResultRow>): RegressionTrainingRow[] {
  return rows.map((row) => ({ ...row, ...regressionFeatures(row) }));
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
  const regularization = 0.02;
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
    featureVersion: REGRESSION_FEATURE_VERSION,
    featureNames: [...FEATURE_NAMES],
    means,
    stds,
    weights,
    intercept,
    trainedAt: new Date().toISOString(),
    trainingSampleSize: rows.length
  };
}

export function predictHomeWinProbability(model: LogisticRegressionModel, row: WinnerFeatureSnapshot) {
  const features = regressionFeatures(row);
  const values = model.featureNames.map((name) => features[name as keyof typeof features] as number);
  let linear = model.intercept;
  for (let index = 0; index < values.length; index += 1) {
    linear += ((values[index] - model.means[index]) / (model.stds[index] || 1)) * model.weights[index];
  }
  const rawProbability = sigmoid(linear);
  return 0.5 + (rawProbability - 0.5) * PROBABILITY_CALIBRATION_FACTOR;
}
