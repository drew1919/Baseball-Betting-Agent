import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STATS } from "../dist/stats.js";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-live-stats-"));
const batterPath = path.join(tempDirectory, "batters.csv");
const pitcherPath = path.join(tempDirectory, "pitchers.csv");

fs.writeFileSync(batterPath, [
  '"last_name, first_name",player_id,year,pa,k_percent,bb_percent,batting_avg,xba,xslg,woba,xwoba,xobp,xiso,hard_hit_percent,barrel_batted_rate,whiff_percent,data_source,data_updated_at,statcast_measured',
  '"Judge, Aaron",592450,2026,261,27.6,16.1,.248,.270,.600,.385,.415,.380,.330,57.3,21.7,32.2,baseball_savant_custom,2026-08-25T12:00:00.000Z,true'
].join("\n"));
fs.writeFileSync(pitcherPath, [
  '"last_name, first_name",player_id,year,pa,k_percent,bb_percent,xba,xslg,woba,xwoba,xobp,xiso,hard_hit_percent,barrel_batted_rate,whiff_percent,swords,out_zone_swing_miss,out_zone_swing_miss_percent,swords_per_100_pa,data_source,data_updated_at,statcast_measured',
  '"Gilbert, Logan",669302,2026,616,26.3,6.3,.234,.394,.284,.298,.289,.160,41.5,10.0,29.7,24,191,42.1,3.896,baseball_savant_custom,2026-08-25T12:00:00.000Z,true'
].join("\n"));

process.env.EXPECTED_BATTERS_CSV_PATH = batterPath;
process.env.EXPECTED_PITCHERS_CSV_PATH = pitcherPath;

try {
  const moduleUrl = `${pathToFileURL(path.resolve("dist/augmented-stats.js")).href}?test=${Date.now()}`;
  const { getAugmentedStats } = await import(moduleUrl);
  const stats = getAugmentedStats(STATS);
  const judge = stats.batters.find((player) => player.player_id === 592450);
  const gilbert = stats.pitchers.find((player) => player.player_id === 669302);

  assert.ok(judge);
  assert.equal(judge.pa, 261);
  assert.equal(judge.k_percent, 27.6);
  assert.equal(judge.hard_hit_percent, 57.3);
  assert.equal(judge.xwoba, 0.415);
  assert.equal(judge.statcast_measured, true);
  assert.equal(stats.batters.some((player) => player.player_id === 608070), false, "static seed players must not leak into a live season feed");

  assert.ok(gilbert);
  assert.equal(gilbert.pa, 616);
  assert.equal(gilbert.k_percent, 26.3);
  assert.equal(gilbert.out_zone_swing_miss_percent, 42.1);
  assert.equal(gilbert.swords_per_100_pa, 3.896);
  assert.equal(stats.coverage.measuredBatters, 1);
  assert.equal(stats.coverage.measuredPitchers, 1);
} finally {
  delete process.env.EXPECTED_BATTERS_CSV_PATH;
  delete process.env.EXPECTED_PITCHERS_CSV_PATH;
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("live player-stat overlay assertions passed");
