export type WinnerEvidenceInput = {
  awayLineupCoverage: number;
  homeLineupCoverage: number;
  awayStarterQuality: number;
  homeStarterQuality: number;
  awayBullpenAvailable: boolean;
  homeBullpenAvailable: boolean;
  marketAvailable: boolean;
  lineupsConfirmed: boolean;
};

export type WinnerEvidenceQuality = {
  score: number;
  reliability: number;
  notes: string[];
};

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function winnerEvidenceQuality(input: WinnerEvidenceInput): WinnerEvidenceQuality {
  const lineupCoverage = (clampUnit(input.awayLineupCoverage) + clampUnit(input.homeLineupCoverage)) / 2;
  const starterCoverage = (clampUnit(input.awayStarterQuality) + clampUnit(input.homeStarterQuality)) / 2;
  const bullpenCoverage = (Number(input.awayBullpenAvailable) + Number(input.homeBullpenAvailable)) / 2;
  const score = lineupCoverage * 0.45
    + starterCoverage * 0.25
    + bullpenCoverage * 0.15
    + Number(input.marketAvailable) * 0.10
    + Number(input.lineupsConfirmed) * 0.05;
  const notes: string[] = [];

  if (lineupCoverage < 0.78) notes.push("partial lineup coverage");
  if (starterCoverage < 1) notes.push("at least one starter lacks full Statcast coverage");
  if (bullpenCoverage < 1) notes.push("at least one bullpen feed is missing");
  if (!input.marketAvailable) notes.push("no two-sided market sanity check");
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
