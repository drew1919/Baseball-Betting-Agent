export type StrikeoutProjectionInput = {
  seasonKPercent: number;
  seasonBattersFaced: number;
  recentKPercent: number | null;
  recentBattersFaced: number;
  recentInnings: number;
  recentStarts: number;
  lineupKPercent: number | null;
  lineupCoverage: number;
  whiffPercent: number;
  chaseMissPercent: number;
  swordsPer100BattersFaced: number;
  walkPercent: number;
  umpireKPerGame: number | null;
  externalProjection: number | null;
  propLine: number | null;
};

export type StrikeoutProjection = {
  internalProjection: number;
  projectedStrikeouts: number;
  projectedBattersFaced: number;
  projectedInnings: number;
  adjustedKPercent: number;
  opponentKPercent: number | null;
  propLine: number | null;
  edge: number | null;
  pick: "Over" | "Under" | "Projection";
  strength: number;
  dataQuality: number;
};

export type FirstInningProbabilityInput = {
  awayHalfPreventionScore: number;
  homeHalfPreventionScore: number;
  gameTotal: number | null;
};

export type FirstInningProbability = {
  awayHalfNoRunProbability: number;
  homeHalfNoRunProbability: number;
  nrfiProbability: number;
  yrfiProbability: number;
  pick: "NRFI" | "YRFI";
  pickProbability: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function logistic(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function logit(probability: number) {
  return Math.log(probability / (1 - probability));
}

export function estimateStrikeoutProjection(input: StrikeoutProjectionInput): StrikeoutProjection {
  const recentReliability = input.recentBattersFaced > 0
    ? Math.min(0.35, input.recentBattersFaced / 120 * 0.35)
    : 0;
  const pitcherKPercent = input.seasonKPercent * (1 - recentReliability)
    + (input.recentKPercent ?? input.seasonKPercent) * recentReliability;
  const opponentAdjustment = input.lineupKPercent === null
    ? 0
    : (input.lineupKPercent - 22) * (0.18 + input.lineupCoverage * 0.17);
  const batMissingAdjustment = clamp(
    (input.whiffPercent - 24) * 0.12
    + (input.chaseMissPercent - 35) * 0.045
    + (input.swordsPer100BattersFaced - 4) * 0.10,
    -2.5,
    2.5
  );
  const commandAdjustment = clamp((8 - input.walkPercent) * 0.08, -0.8, 0.8);
  const umpireAdjustment = input.umpireKPerGame === null
    ? 0
    : clamp((input.umpireKPerGame - 15) * 0.10, -0.9, 0.9);
  const adjustedKPercent = clamp(
    pitcherKPercent + opponentAdjustment + batMissingAdjustment + commandAdjustment + umpireAdjustment,
    10,
    45
  );

  const workloadReliability = Math.min(0.8, Math.max(0, input.recentStarts) / 5 * 0.8);
  const recentBattersPerStart = input.recentStarts > 0
    ? input.recentBattersFaced / input.recentStarts
    : 22;
  const recentInningsPerStart = input.recentStarts > 0
    ? input.recentInnings / input.recentStarts
    : 5.4;
  const projectedBattersFaced = clamp(
    22 + (recentBattersPerStart - 22) * workloadReliability - Math.max(0, input.walkPercent - 10) * 0.08,
    17,
    28
  );
  const projectedInnings = clamp(
    5.4 + (recentInningsPerStart - 5.4) * workloadReliability,
    4.2,
    7.2
  );
  const internalProjection = projectedBattersFaced * adjustedKPercent / 100;
  const projectedStrikeouts = input.externalProjection === null
    ? internalProjection
    : internalProjection * 0.88 + input.externalProjection * 0.12;
  const edge = input.propLine === null ? null : projectedStrikeouts - input.propLine;
  const pick = edge === null ? "Projection" : edge >= 0 ? "Over" : "Under";
  const sampleQuality = clamp(input.seasonBattersFaced / 300, 0, 1);
  const recentQuality = clamp(input.recentStarts / 5, 0, 1);
  const dataQuality = clamp(
    sampleQuality * 0.30
    + input.lineupCoverage * 0.30
    + recentQuality * 0.20
    + Number(input.umpireKPerGame !== null) * 0.08
    + Number(input.propLine !== null) * 0.08
    + Number(input.externalProjection !== null) * 0.04,
    0,
    1
  );
  const strength = edge === null
    ? clamp(45 + (projectedStrikeouts - 5) * 3 + dataQuality * 10, 40, 75)
    : clamp(50 + Math.abs(edge) * 9 + (dataQuality - 0.5) * 10, 45, 82);

  return {
    internalProjection,
    projectedStrikeouts,
    projectedBattersFaced,
    projectedInnings,
    adjustedKPercent,
    opponentKPercent: input.lineupKPercent,
    propLine: input.propLine,
    edge,
    pick,
    strength,
    dataQuality
  };
}

export function estimateFirstInningProbability(input: FirstInningProbabilityInput): FirstInningProbability {
  // The prevention formula's neutral matchup centers near 45. Anchor that
  // matchup near a 74% no-run rate. The two halves
  // are estimated independently before multiplication, which encodes the
  // requirement that both must be scoreless for an NRFI ticket to win.
  const neutralHalfLogit = logit(0.74);
  const awayHalfNoRunProbability = clamp(
    logistic(neutralHalfLogit + (input.awayHalfPreventionScore - 45) * 0.035),
    0.55,
    0.88
  );
  const homeHalfNoRunProbability = clamp(
    logistic(neutralHalfLogit + (input.homeHalfPreventionScore - 45) * 0.035),
    0.55,
    0.88
  );
  const totalAdjustment = input.gameTotal === null
    ? 0
    : clamp((8.5 - input.gameTotal) * 0.018, -0.045, 0.045);
  const nrfiProbability = clamp(
    awayHalfNoRunProbability * homeHalfNoRunProbability + totalAdjustment,
    0.28,
    0.74
  );
  const yrfiProbability = 1 - nrfiProbability;
  const pick = nrfiProbability >= 0.5 ? "NRFI" : "YRFI";

  return {
    awayHalfNoRunProbability,
    homeHalfNoRunProbability,
    nrfiProbability,
    yrfiProbability,
    pick,
    pickProbability: Math.max(nrfiProbability, yrfiProbability)
  };
}
