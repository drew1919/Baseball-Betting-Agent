import type { LogisticRegressionModel, RegressionFeatureDiagnostic, RegressionTrainingRow, WinnerFeatureSnapshot, WinnerResultRow } from "./regression-types.js";

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
export type RegressionFeatureName = typeof FEATURE_NAMES[number];
export const REGRESSION_FEATURE_NAMES: readonly RegressionFeatureName[] = FEATURE_NAMES;

// Version 4 adds sample-size and feature-stability guards to the clean cohort.
export const REGRESSION_FEATURE_VERSION = 4;
export const MIN_REGRESSION_SAMPLE = 200;
export const MIN_REGRESSION_DATA_QUALITY = 0.75;
export const FALLBACK_MARKET_WEIGHT = 0.15;
export const MAX_REGRESSION_FEATURE_CORRELATION = 0.92;
const PROBABILITY_CALIBRATION_FACTOR = 0.5;

export function regressionTrainingEligible(row: WinnerFeatureSnapshot) {
  const finiteFeatures = [
    row.awayOffense,
    row.homeOffense,
    row.awayPitching,
    row.homePitching,
    row.awayBullpen,
    row.homeBullpen,
    row.awayTrend,
    row.homeTrend,
    row.awayWinProb,
    row.homeWinProb,
    row.awayDefense,
    row.homeDefense,
    row.awayPark,
    row.homePark,
    row.lineupCoverageAway,
    row.lineupCoverageHome,
    row.heuristicEdge,
    row.heuristicConfidence
  ];
  return Boolean(
    row.analysisVersion
    && row.analysisVersion !== "legacy"
    && row.predictionMethod
    && row.predictionMethod !== "legacy snapshot"
    && Array.isArray(row.dataQualityNotes)
    && !row.dataQualityNotes.some((note) => /projected rather than confirmed/i.test(note))
    && Number.isFinite(row.dataQuality)
    && (row.dataQuality as number) >= MIN_REGRESSION_DATA_QUALITY
    && finiteFeatures.every(Number.isFinite)
  );
}

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

function standardDeviation(values: number[]) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function correlation(left: number[], right: number[]) {
  const leftDeviation = standardDeviation(left);
  const rightDeviation = standardDeviation(right);
  if (!leftDeviation || !rightDeviation || left.length !== right.length || !left.length) return 0;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const covariance = left.reduce((sum, value, index) =>
    sum + (value - leftMean) * (right[index] - rightMean), 0) / left.length;
  return covariance / (leftDeviation * rightDeviation);
}

export function regressionFeatureDiagnostics(
  rows: RegressionTrainingRow[],
  requestedFeatureNames: readonly RegressionFeatureName[] = FEATURE_NAMES
): RegressionFeatureDiagnostic[] {
  const values = new Map(requestedFeatureNames.map((name) => [name, rows.map((row) => row[name])]));
  const selected: RegressionFeatureName[] = [];

  return requestedFeatureNames.map((name) => {
    const featureValues = values.get(name) || [];
    const featureDeviation = standardDeviation(featureValues);
    let maxAbsoluteCorrelation: number | null = null;
    let redundantWith: string | null = null;

    selected.forEach((selectedName) => {
      const candidateCorrelation = Math.abs(correlation(featureValues, values.get(selectedName) || []));
      if (maxAbsoluteCorrelation === null || candidateCorrelation > maxAbsoluteCorrelation) {
        maxAbsoluteCorrelation = candidateCorrelation;
        redundantWith = selectedName;
      }
    });

    const isConstant = featureDeviation <= 1e-9;
    const isRedundant = maxAbsoluteCorrelation !== null
      && maxAbsoluteCorrelation >= MAX_REGRESSION_FEATURE_CORRELATION;
    const isSelected = !isConstant && !isRedundant;
    if (isSelected) selected.push(name);

    return {
      name,
      standardDeviation: featureDeviation,
      maxAbsoluteCorrelation,
      redundantWith: isRedundant ? redundantWith : null,
      selected: isSelected
    };
  });
}

export function selectRegressionFeatureNames(
  rows: RegressionTrainingRow[],
  requestedFeatureNames: readonly RegressionFeatureName[] = FEATURE_NAMES
) {
  return regressionFeatureDiagnostics(rows, requestedFeatureNames)
    .filter((diagnostic) => diagnostic.selected)
    .map((diagnostic) => diagnostic.name as RegressionFeatureName);
}

export function fallbackHomeWinProbability(
  row: WinnerFeatureSnapshot,
  marketWeight = FALLBACK_MARKET_WEIGHT
) {
  const signedEdge = row.heuristicPick === row.home ? row.heuristicEdge : -row.heuristicEdge;
  const rawStatistical = sigmoid(signedEdge * 0.14);
  const statistical = 0.5 + (rawStatistical - 0.5) * 0.35;
  const awayImplied = impliedProbability(row.awayMoneyline);
  const homeImplied = impliedProbability(row.homeMoneyline);
  const impliedTotal = (awayImplied || 0) + (homeImplied || 0);
  if (awayImplied === null || homeImplied === null || !impliedTotal) return statistical;
  const market = homeImplied / impliedTotal;
  return statistical * (1 - marketWeight) + market * marketWeight;
}

export function buildRegressionTrainingRows(rows: Array<WinnerFeatureSnapshot & WinnerResultRow>): RegressionTrainingRow[] {
  return rows.map((row) => ({ ...row, ...regressionFeatures(row) }));
}

export function trainLogisticRegression(
  rows: RegressionTrainingRow[],
  featureNames: readonly RegressionFeatureName[] = FEATURE_NAMES
): LogisticRegressionModel | null {
  if (rows.length < MIN_REGRESSION_SAMPLE) return null;

  featureNames = selectRegressionFeatureNames(rows, featureNames);
  if (!featureNames.length) return null;

  const matrix = rows.map((row) => featureNames.map((name) => row[name]));
  const targets = rows.map((row) => row.homeWin);

  const means = featureNames.map((_, featureIndex) =>
    matrix.reduce((sum, row) => sum + row[featureIndex], 0) / matrix.length
  );
  const stds = featureNames.map((_, featureIndex) => {
    const variance = matrix.reduce((sum, row) => {
      const diff = row[featureIndex] - means[featureIndex];
      return sum + diff * diff;
    }, 0) / matrix.length;
    return Math.sqrt(variance) || 1;
  });

  const normalized = matrix.map((row) =>
    row.map((value, index) => (value - means[index]) / stds[index])
  );

  const weights = new Array(featureNames.length).fill(0);
  let intercept = 0;
  const learningRate = 0.045;
  const regularization = 0.02;
  const iterations = 1800;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const weightGradients = new Array(featureNames.length).fill(0);
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
    featureNames: [...featureNames],
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
