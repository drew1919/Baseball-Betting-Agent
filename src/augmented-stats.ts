import fs from "node:fs";
import path from "node:path";
import { type BatterStat, type PitcherStat } from "./stats.js";

type BaseStats = { batters: BatterStat[]; pitchers: PitcherStat[] };

export type AugmentedStats = {
  batters: BatterStat[];
  pitchers: PitcherStat[];
  coverage: {
    baseBatters: number;
    basePitchers: number;
    expectedBatters: number;
    expectedPitchers: number;
    measuredBatters: number;
    measuredPitchers: number;
    mergedBatters: number;
    mergedPitchers: number;
    overriddenBatters: number;
    overriddenPitchers: number;
  };
  sourceFiles: {
    batterCsvPath: string;
    pitcherCsvPath: string;
    batterCsvLoaded: boolean;
    pitcherCsvLoaded: boolean;
    batterCsvUpdatedAt: string | null;
    pitcherCsvUpdatedAt: string | null;
  };
};

type CacheEntry = {
  batterPath: string;
  pitcherPath: string;
  batterStamp: number;
  pitcherStamp: number;
  value: AugmentedStats;
};

let cache: CacheEntry | null = null;
const WORKSPACE_BATTER_CSV_PATH = path.join(process.cwd(), "data", "expected_stats_batters.csv");
const WORKSPACE_PITCHER_CSV_PATH = path.join(process.cwd(), "data", "expected_stats_pitchers.csv");

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeName(value: string) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseCsv(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") { cell += "\""; index += 1; } else inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) { row.push(cell); cell = ""; continue; }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

function parseCsvObjects(filePath: string) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  if (!rows.length) return [];
  const [headers, ...dataRows] = rows;
  return dataRows.map((dataRow) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => { record[cleanText(header)] = cleanText(dataRow[index] || ""); });
    return record;
  });
}

function rowNumber(row: Record<string, string>, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = cleanText(row[key] || "").replace(/,/g, "");
    if (!value) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function measuredRow(row: Record<string, string>) {
  return row.statcast_measured === "true" || row.data_source === "baseball_savant_custom";
}

function provenance(row: Record<string, string>) {
  const measured = measuredRow(row);
  return {
    data_source: row.data_source || (measured ? "baseball_savant_custom" : "savant_expected_only"),
    data_updated_at: row.data_updated_at || "",
    statcast_measured: measured
  };
}

function materializeBatter(row: Record<string, string>): BatterStat {
  const pa = rowNumber(row, ["pa"], 0);
  const battingAvg = rowNumber(row, ["batting_avg", "ba"], 0);
  const xba = rowNumber(row, ["xba", "est_ba"], battingAvg);
  const xslg = rowNumber(row, ["xslg", "est_slg"], Math.max(xba, 0.38));
  const woba = rowNumber(row, ["woba"], 0.31);
  const xwoba = rowNumber(row, ["xwoba", "est_woba"], woba);
  return {
    ["last_name, first_name"]: row["last_name, first_name"] || "",
    player_id: rowNumber(row, ["player_id"], 0),
    year: rowNumber(row, ["year"], new Date().getFullYear()),
    pa,
    hit: rowNumber(row, ["hit"], Math.round(battingAvg * pa)),
    home_run: rowNumber(row, ["home_run"], 0),
    k_percent: rowNumber(row, ["k_percent"], 22.5),
    bb_percent: rowNumber(row, ["bb_percent"], 8.5),
    batting_avg: battingAvg,
    xba,
    xslg,
    woba,
    xwoba,
    xobp: rowNumber(row, ["xobp"], 0.32),
    xiso: rowNumber(row, ["xiso"], Math.max(0, xslg - xba)),
    avg_swing_speed: rowNumber(row, ["avg_swing_speed"], 71.5),
    fast_swing_rate: rowNumber(row, ["fast_swing_rate"], 20),
    blasts_contact: rowNumber(row, ["blasts_contact"], 10),
    blasts_swing: rowNumber(row, ["blasts_swing"], 7),
    squared_up_contact: rowNumber(row, ["squared_up_contact"], 30),
    squared_up_swing: rowNumber(row, ["squared_up_swing"], 22),
    avg_swing_length: rowNumber(row, ["avg_swing_length"], 7.2),
    swords: rowNumber(row, ["swords"], 0),
    attack_angle: rowNumber(row, ["attack_angle"], 10),
    attack_direction: rowNumber(row, ["attack_direction"], 0),
    ideal_angle_rate: rowNumber(row, ["ideal_angle_rate"], 50),
    vertical_swing_path: rowNumber(row, ["vertical_swing_path"], 31),
    exit_velocity_avg: rowNumber(row, ["exit_velocity_avg"], 88.5),
    launch_angle_avg: rowNumber(row, ["launch_angle_avg"], 12),
    sweet_spot_percent: rowNumber(row, ["sweet_spot_percent"], 33),
    barrel_batted_rate: rowNumber(row, ["barrel_batted_rate"], 7),
    solidcontact_percent: rowNumber(row, ["solidcontact_percent"], 5),
    hard_hit_percent: rowNumber(row, ["hard_hit_percent"], 38),
    avg_best_speed: rowNumber(row, ["avg_best_speed"], 99),
    avg_hyper_speed: rowNumber(row, ["avg_hyper_speed"], 94),
    whiff_percent: rowNumber(row, ["whiff_percent"], 24),
    swing_percent: rowNumber(row, ["swing_percent"], 47),
    ...provenance(row)
  };
}

function materializePitcher(row: Record<string, string>): PitcherStat {
  const pa = rowNumber(row, ["pa"], 0);
  const swords = rowNumber(row, ["swords"], 0);
  const outZoneSwingMiss = rowNumber(row, ["out_zone_swing_miss"], 0);
  const xba = rowNumber(row, ["xba", "est_ba"], 0.245);
  const xslg = rowNumber(row, ["xslg", "est_slg"], 0.4);
  const woba = rowNumber(row, ["woba"], 0.31);
  const xwoba = rowNumber(row, ["xwoba", "est_woba"], woba);
  return {
    ["last_name, first_name"]: row["last_name, first_name"] || "",
    player_id: rowNumber(row, ["player_id"], 0),
    year: rowNumber(row, ["year"], new Date().getFullYear()),
    pa,
    k_percent: rowNumber(row, ["k_percent"], 22.5),
    bb_percent: rowNumber(row, ["bb_percent"], 8.5),
    xba,
    xslg,
    woba,
    xwoba,
    xobp: rowNumber(row, ["xobp"], 0.32),
    xiso: rowNumber(row, ["xiso"], Math.max(0, xslg - xba)),
    avg_swing_speed: rowNumber(row, ["avg_swing_speed"], 71.5),
    fast_swing_rate: rowNumber(row, ["fast_swing_rate"], 20),
    blasts_contact: rowNumber(row, ["blasts_contact"], 10),
    blasts_swing: rowNumber(row, ["blasts_swing"], 7),
    squared_up_contact: rowNumber(row, ["squared_up_contact"], 30),
    squared_up_swing: rowNumber(row, ["squared_up_swing"], 22),
    avg_swing_length: rowNumber(row, ["avg_swing_length"], 7.2),
    swords,
    attack_angle: rowNumber(row, ["attack_angle"], 10),
    attack_direction: rowNumber(row, ["attack_direction"], 0),
    ideal_angle_rate: rowNumber(row, ["ideal_angle_rate"], 50),
    vertical_swing_path: rowNumber(row, ["vertical_swing_path"], 31),
    exit_velocity_avg: rowNumber(row, ["exit_velocity_avg"], 88.5),
    launch_angle_avg: rowNumber(row, ["launch_angle_avg"], 12),
    sweet_spot_percent: rowNumber(row, ["sweet_spot_percent"], 33),
    barrel_batted_rate: rowNumber(row, ["barrel_batted_rate"], 7),
    hard_hit_percent: rowNumber(row, ["hard_hit_percent"], 38),
    avg_best_speed: rowNumber(row, ["avg_best_speed"], 79),
    avg_hyper_speed: rowNumber(row, ["avg_hyper_speed"], 94),
    z_swing_percent: rowNumber(row, ["z_swing_percent"], 67),
    out_zone_swing_miss: outZoneSwingMiss,
    out_zone_swing_miss_percent: rowNumber(row, ["out_zone_swing_miss_percent"], pa ? outZoneSwingMiss / pa * 100 : 0),
    swords_per_100_pa: rowNumber(row, ["swords_per_100_pa"], pa ? swords / pa * 100 : 0),
    whiff_percent: rowNumber(row, ["whiff_percent"], 24),
    swing_percent: rowNumber(row, ["swing_percent"], 47),
    ...provenance(row)
  };
}

function readExpectedBatters(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsvObjects(filePath).map(materializeBatter)
    .filter((row) => row.player_id > 0 && row["last_name, first_name"]);
}

function readExpectedPitchers(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsvObjects(filePath).map(materializePitcher)
    .filter((row) => row.player_id > 0 && row["last_name, first_name"]);
}

function playerKey(value: { ["last_name, first_name"]: string; player_id: number }) {
  return value.player_id > 0 ? `id:${value.player_id}` : `name:${normalizeName(value["last_name, first_name"])}`;
}

function resolveCsvPath(envKey: string, workspacePath: string) {
  return cleanText(process.env[envKey]) || workspacePath;
}

function fileStamp(filePath: string) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return -1; }
}

export function getExpectedStatsCsvPaths() {
  return {
    batterPath: resolveCsvPath("EXPECTED_BATTERS_CSV_PATH", WORKSPACE_BATTER_CSV_PATH),
    pitcherPath: resolveCsvPath("EXPECTED_PITCHERS_CSV_PATH", WORKSPACE_PITCHER_CSV_PATH)
  };
}

export function getExpectedStatsCsvWritePaths() {
  return {
    batterPath: cleanText(process.env.EXPECTED_BATTERS_CSV_PATH || WORKSPACE_BATTER_CSV_PATH),
    pitcherPath: cleanText(process.env.EXPECTED_PITCHERS_CSV_PATH || WORKSPACE_PITCHER_CSV_PATH)
  };
}

export function getAugmentedStats(base: BaseStats): AugmentedStats {
  const { batterPath, pitcherPath } = getExpectedStatsCsvPaths();
  const batterStamp = fileStamp(batterPath);
  const pitcherStamp = fileStamp(pitcherPath);
  if (cache && cache.batterPath === batterPath && cache.pitcherPath === pitcherPath
    && cache.batterStamp === batterStamp && cache.pitcherStamp === pitcherStamp) return cache.value;

  const expectedBatters = readExpectedBatters(batterPath);
  const expectedPitchers = readExpectedPitchers(pitcherPath);
  const baseBatterKeys = new Set(base.batters.map(playerKey));
  const basePitcherKeys = new Set(base.pitchers.map(playerKey));
  // Once a persisted season feed exists, it is the complete player universe.
  // Static seed rows are only an emergency fallback when no feed can be read.
  const batterByKey = new Map<string, BatterStat>(expectedBatters.length
    ? []
    : base.batters.map((player): [string, BatterStat] => [playerKey(player), player]));
  const pitcherByKey = new Map<string, PitcherStat>(expectedPitchers.length
    ? []
    : base.pitchers.map((player): [string, PitcherStat] => [playerKey(player), player]));
  let overriddenBatters = 0;
  let overriddenPitchers = 0;
  expectedBatters.forEach((row) => {
    const key = playerKey(row);
    if (baseBatterKeys.has(key)) overriddenBatters += 1;
    batterByKey.set(key, row);
  });
  expectedPitchers.forEach((row) => {
    const key = playerKey(row);
    if (basePitcherKeys.has(key)) overriddenPitchers += 1;
    pitcherByKey.set(key, row);
  });

  const mergedBatters = [...batterByKey.values()];
  const mergedPitchers = [...pitcherByKey.values()];
  const value: AugmentedStats = {
    batters: mergedBatters,
    pitchers: mergedPitchers,
    coverage: {
      baseBatters: base.batters.length,
      basePitchers: base.pitchers.length,
      expectedBatters: expectedBatters.length,
      expectedPitchers: expectedPitchers.length,
      measuredBatters: expectedBatters.filter((row) => row.statcast_measured).length,
      measuredPitchers: expectedPitchers.filter((row) => row.statcast_measured).length,
      mergedBatters: mergedBatters.length,
      mergedPitchers: mergedPitchers.length,
      overriddenBatters,
      overriddenPitchers
    },
    sourceFiles: {
      batterCsvPath: batterPath,
      pitcherCsvPath: pitcherPath,
      batterCsvLoaded: batterStamp > 0,
      pitcherCsvLoaded: pitcherStamp > 0,
      batterCsvUpdatedAt: batterStamp > 0 ? new Date(batterStamp).toISOString() : null,
      pitcherCsvUpdatedAt: pitcherStamp > 0 ? new Date(pitcherStamp).toISOString() : null
    }
  };
  cache = { batterPath, pitcherPath, batterStamp, pitcherStamp, value };
  return value;
}
