export type WinnerEvidenceInput = {
  awayLineupCoverage: number;
  homeLineupCoverage: number;
  awayStarterQuality: number;
  homeStarterQuality: number;
  awayBullpenAvailable: boolean;
  homeBullpenAvailable: boolean;
  marketAvailable: boolean;
  marketEstimated?: boolean;
  lineupsConfirmed: boolean;
};

export type WinnerEvidenceQuality = {
  score: number;
  reliability: number;
  notes: string[];
};

export const MIN_TRAINING_LINEUP_COVERAGE = 7 / 9;
export const ESTIMATED_MARKET_RELIABILITY = 0.6;

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function winnerEvidenceQuality(input: WinnerEvidenceInput): WinnerEvidenceQuality {
  const lineupCoverage = (clampUnit(input.awayLineupCoverage) + clampUnit(input.homeLineupCoverage)) / 2;
  const starterCoverage = (clampUnit(input.awayStarterQuality) + clampUnit(input.homeStarterQuality)) / 2;
  const bullpenCoverage = (Number(input.awayBullpenAvailable) + Number(input.homeBullpenAvailable)) / 2;
  const marketCoverage = input.marketAvailable ? (input.marketEstimated ? ESTIMATED_MARKET_RELIABILITY : 1) : 0;
  const score = lineupCoverage * 0.45
    + starterCoverage * 0.25
    + bullpenCoverage * 0.15
    + marketCoverage * 0.10
    + Number(input.lineupsConfirmed) * 0.05;
  const notes: string[] = [];

  if (input.awayLineupCoverage < MIN_TRAINING_LINEUP_COVERAGE
    || input.homeLineupCoverage < MIN_TRAINING_LINEUP_COVERAGE) {
    notes.push("partial lineup coverage");
  }
  if (starterCoverage < 1) notes.push("at least one starter lacks full Statcast coverage");
  if (bullpenCoverage < 1) notes.push("at least one bullpen feed is missing");
  if (!input.marketAvailable) notes.push("no two-sided market sanity check");
  if (input.marketAvailable && input.marketEstimated) notes.push("market sanity check is estimated from one listed line");
  if (!input.lineupsConfirmed) notes.push("lineups are projected rather than confirmed");

  return {
    score,
    // Even thin games retain a forced lean, but their probability edge is reduced.
    reliability: 0.45 + score * 0.55,
    notes
  };
}

export function shrinkProbabilityToEven(probability: number, reliability: number) {
  const boundedProbability = clampUnit(probability);
  return 0.5 + (boundedProbability - 0.5) * clampUnit(reliability);
}
