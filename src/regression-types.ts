export type WinnerFeatureSnapshot = {
  analysisVersion?: string;
  snapshotDate: string;
  gameId: string;
  away: string;
  home: string;
  awayOffense: number;
  homeOffense: number;
  awayPitching: number;
  homePitching: number;
  awayBullpen: number;
  homeBullpen: number;
  awayTrend: number;
  homeTrend: number;
  awayWinProb: number;
  homeWinProb: number;
  awayDefense: number;
  homeDefense: number;
  parkIndex: number | null;
  venueName: string | null;
  awayPark: number;
  homePark: number;
  awayMoneyline: number | null;
  homeMoneyline: number | null;
  total: number | null;
  lineupCoverageAway: number;
  lineupCoverageHome: number;
  heuristicPick: string;
  heuristicEdge: number;
  heuristicConfidence: number;
  marketLean: string | null;
};

export type WinnerResultRow = {
  date: string;
  gameId: string;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  homeWin: 0 | 1;
};

export type RegressionTrainingRow = WinnerFeatureSnapshot & WinnerResultRow & {
  offenseDiff: number;
  pitchingDiff: number;
  bullpenDiff: number;
  trendDiff: number;
  winProbDiff: number;
  defenseDiff: number;
  parkDiff: number;
  impliedDiff: number;
  totalValue: number;
  coverageDiff: number;
  homeField: number;
};

export type LogisticRegressionModel = {
  featureVersion?: number;
  featureNames: string[];
  means: number[];
  stds: number[];
  weights: number[];
  intercept: number;
  trainedAt: string;
  trainingSampleSize: number;
};

export type ModelMetrics = {
  sampleSize: number;
  accuracy: number;
  logLoss: number;
  brierScore: number;
  averageProbability: number;
};

export type RegressionReport = {
  generatedAt: string;
  trainingRows: number;
  resultRows: number;
  featureRows: number;
  parkFactorCoverage: {
    populatedRows: number;
    coverageRate: number;
    averageParkIndex: number | null;
    averageAwayParkRating: number | null;
    averageHomeParkRating: number | null;
  };
  bullpenCoverage: {
    populatedRows: number;
    coverageRate: number;
    averageAwayBullpenRating: number | null;
    averageHomeBullpenRating: number | null;
  };
  heuristicMetrics: ModelMetrics | null;
  productionMetrics: ModelMetrics | null;
  candidateMetrics: ModelMetrics | null;
  walkForwardMetrics?: ModelMetrics | null;
  walkForwardStartDate?: string | null;
  recentWalkForwardMetrics?: ModelMetrics | null;
  recentQualifiedMetrics?: ModelMetrics | null;
  recentForcedMetrics?: ModelMetrics | null;
  recentHeuristicMetrics?: ModelMetrics | null;
  recentValidationStartDate?: string | null;
  productionApproved?: boolean;
  selectiveProductionApproved?: boolean;
  selectiveWalkForwardMetrics?: ModelMetrics | null;
  selectiveQualifiedMetrics?: ModelMetrics | null;
  selectiveRecentQualifiedMetrics?: ModelMetrics | null;
  promotedCandidate: boolean;
  notes: string[];
};
