import assert from "node:assert/strict";
import test from "node:test";
import { clampPlayerRating, sampleAdjustedPlayerRating } from "../dist/rating-utils.js";

test("a four-PA extreme rating cannot control a lineup", () => {
  const adjusted = sampleAdjustedPlayerRating(153.46, 4);
  assert.ok(adjusted > 50 && adjusted < 51, `expected near-average rating, received ${adjusted}`);
});

test("an established player's signal remains meaningful", () => {
  const adjusted = sampleAdjustedPlayerRating(60.67, 516);
  assert.ok(adjusted > 58 && adjusted < 59, `expected most of the signal to remain, received ${adjusted}`);
});

test("zero-sample and extreme recent ratings are bounded", () => {
  assert.equal(sampleAdjustedPlayerRating(153.46, 0), 50);
  assert.equal(clampPlayerRating(191.5), 75);
  assert.equal(clampPlayerRating(-25), 30);
});
