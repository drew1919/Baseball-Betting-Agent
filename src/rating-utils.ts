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
