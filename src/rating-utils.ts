export const PLAYER_RATING_STABILIZATION_PA = 120;

export function clampPlayerRating(value: number, minimum = 30, maximum = 75) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function sampleAdjustedPlayerRating(
  rawRating: number,
  sampleSize: number,
  priorRating = 50,
  stabilizationSample = PLAYER_RATING_STABILIZATION_PA,
  minimum = 30,
  maximum = 75
) {
  const boundedSample = Math.max(0, Number.isFinite(sampleSize) ? sampleSize : 0);
  const reliability = boundedSample / (boundedSample + stabilizationSample);
  const boundedRating = clampPlayerRating(rawRating, minimum, maximum);
  return priorRating + (boundedRating - priorRating) * reliability;
}

export function lineupAdjustedTeamRating(
  playerRatings: number[],
  expectedPlayers = 9,
  neutralRating = 50
) {
  const boundedExpectedPlayers = Math.max(1, Math.floor(expectedPlayers));
  const observedRatings = playerRatings.slice(0, boundedExpectedPlayers);
  const missingPlayers = Math.max(0, boundedExpectedPlayers - observedRatings.length);
  const total = observedRatings.reduce((sum, rating) => sum + rating, 0)
    + missingPlayers * neutralRating;
  return total / boundedExpectedPlayers;
}

export function lineupCategoryRating(
  playerRatings: number[],
  expectedPlayers = 9,
  neutralRating = 50
) {
  const boundedExpectedPlayers = Math.max(1, Math.floor(expectedPlayers));
  const lineupAverage = lineupAdjustedTeamRating(playerRatings, boundedExpectedPlayers, neutralRating);
  // Averaging nine hitters compresses category variance by roughly sqrt(n).
  // Restore that team-level scale before applying the category weight.
  return clampPlayerRating(
    neutralRating + (lineupAverage - neutralRating) * Math.sqrt(boundedExpectedPlayers),
    35,
    70
  );
}
