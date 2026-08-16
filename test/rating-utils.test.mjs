import assert from "node:assert/strict";
import { clampPlayerRating, sampleAdjustedPlayerRating } from "../dist/rating-utils.js";

const tinySample = sampleAdjustedPlayerRating(153.46, 4);
assert.ok(tinySample > 50 && tinySample < 51, `expected near-average rating, received ${tinySample}`);

const establishedSample = sampleAdjustedPlayerRating(60.67, 516);
assert.ok(establishedSample > 58 && establishedSample < 59, `expected most of the signal to remain, received ${establishedSample}`);

assert.equal(sampleAdjustedPlayerRating(153.46, 0), 50);
assert.equal(clampPlayerRating(191.5), 75);
assert.equal(clampPlayerRating(-25), 30);

console.log("rating-utils assertions passed");
