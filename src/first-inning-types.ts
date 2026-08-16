export type FirstInningPick = "NRFI" | "YRFI";

export type FirstInningFeatureSnapshot = {
  gameId: string;
  snapshotDate: string;
  away: string;
  home: string;
  awayHalfScore: number;
  homeHalfScore: number;
  nrfiScore: number;
  pick: FirstInningPick;
  pickScore: number;
  total: number | null;
  dataQuality: number;
  analysisVersion: string;
};

export type FirstInningResultRow = {
  gameId: string;
  date: string;
  away: string;
  home: string;
  awayFirstRuns: number;
  homeFirstRuns: number;
  nrfiHit: 0 | 1;
};

export type FirstInningPerformance = {
  gradedCount: number;
  correctCount: number;
  accuracy: number | null;
  qualifiedCount: number;
  qualifiedCorrectCount: number;
  qualifiedAccuracy: number | null;
  recentCount: number;
  recentCorrectCount: number;
  recentAccuracy: number | null;
  nrfiCount: number;
  nrfiCorrectCount: number;
  nrfiAccuracy: number | null;
  yrfiCount: number;
  yrfiCorrectCount: number;
  yrfiAccuracy: number | null;
  approved: boolean;
  minimumGraded: number;
  minimumAccuracy: number;
  minimumQualified: number;
  minimumQualifiedAccuracy: number;
};
