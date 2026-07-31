import fs from "node:fs";
import path from "node:path";
import { type BatterStat, type PitcherStat } from "./stats.js";

type BaseStats = {
  batters: BatterStat[];
  pitchers: PitcherStat[];
};

type ExpectedBatterRow = {
  ["last_name, first_name"]: string;
  player_id: number;
  year: number;
  pa: number;
  bip: number;
  ba: number;
  est_ba: number;
  est_ba_minus_ba_diff: number;
  slg: number;
  est_slg: number;
  est_slg_minus_slg_diff: number;
  woba: number;
  est_woba: number;
  est_woba_minus_woba_diff: number;
};

type ExpectedPitcherRow = {
  ["last_name, first_name"]: string;
  player_id: number;
  year: number;
  pa: number;
  bip: number;
  ba: number;
  est_ba: number;
  est_ba_minus_ba_diff: number;
  slg: number;
  est_slg: number;
  est_slg_minus_slg_diff: number;
  woba: number;
  est_woba: number;
  est_woba_minus_woba_diff: number;
  era: number;
  xera: number;
  era_minus_xera_diff: number;
};

export type AugmentedStats = {
  batters: BatterStat[];
  pitchers: PitcherStat[];
  coverage: {
    baseBatters: number;
    basePitchers: number;
    expectedBatters: number;
    expectedPitchers: number;
    mergedBatters: number;
    mergedPitchers: number;
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
const LEGACY_BATTER_CSV_PATH = "C:\\Users\\dk7so\\Downloads\\expected_stats.csv";
const LEGACY_PITCHER_CSV_PATH = "C:\\Users\\dk7so\\Downloads\\expected_stats (1).csv";
const WORKSPACE_BATTER_CSV_PATH = path.join(process.cwd(), "data", "expected_stats_batters.csv");
const WORKSPACE_PITCHER_CSV_PATH = path.join(process.cwd(), "data", "expected_stats_pitchers.csv");

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeName(value: string) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value: string) {
  const cleaned = cleanText(value).replace(/,/g, "");
  if (!cleaned) return 0;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
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
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function parseCsvObjects(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(content);
  if (!rows.length) return [];
  const [headerRow, ...dataRows] = rows;

  return dataRows.map((dataRow) => {
    const record: Record<string, string> = {};
    headerRow.forEach((header, index) => {
      record[cleanText(header)] = cleanText(dataRow[index] || "");
    });
    return record;
  });
}

function readExpectedBatters(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsvObjects(filePath).map((row) => ({
    ["last_name, first_name"]: row["last_name, first_name"] || "",
    player_id: toNumber(row["player_id"]),
    year: toNumber(row["year"]),
    pa: toNumber(row["pa"]),
    bip: toNumber(row["bip"]),
    ba: toNumber(row["ba"]),
    est_ba: toNumber(row["est_ba"]),
    est_ba_minus_ba_diff: toNumber(row["est_ba_minus_ba_diff"]),
    slg: toNumber(row["slg"]),
    est_slg: toNumber(row["est_slg"]),
    est_slg_minus_slg_diff: toNumber(row["est_slg_minus_slg_diff"]),
    woba: toNumber(row["woba"]),
    est_woba: toNumber(row["est_woba"]),
    est_woba_minus_woba_diff: toNumber(row["est_woba_minus_woba_diff"])
  })) satisfies ExpectedBatterRow[];
}

function readExpectedPitchers(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsvObjects(filePath).map((row) => ({
    ["last_name, first_name"]: row["last_name, first_name"] || "",
    player_id: toNumber(row["player_id"]),
    year: toNumber(row["year"]),
    pa: toNumber(row["pa"]),
    bip: toNumber(row["bip"]),
    ba: toNumber(row["ba"]),
    est_ba: toNumber(row["est_ba"]),
    est_ba_minus_ba_diff: toNumber(row["est_ba_minus_ba_diff"]),
    slg: toNumber(row["slg"]),
    est_slg: toNumber(row["est_slg"]),
    est_slg_minus_slg_diff: toNumber(row["est_slg_minus_slg_diff"]),
    woba: toNumber(row["woba"]),
    est_woba: toNumber(row["est_woba"]),
    est_woba_minus_woba_diff: toNumber(row["est_woba_minus_woba_diff"]),
    era: toNumber(row["era"]),
    xera: toNumber(row["xera"]),
    era_minus_xera_diff: toNumber(row["era_minus_xera_diff"])
  })) satisfies ExpectedPitcherRow[];
}

function playerKey(value: { ["last_name, first_name"]: string; player_id: number }) {
  return `${value.player_id}:${normalizeName(value["last_name, first_name"])}`;
}

function synthesizeBatter(row: ExpectedBatterRow): BatterStat {
  const xiso = Math.max(0, row.est_slg - row.est_ba);
  const powerGap = Math.max(0, row.est_slg - 0.36);
  const hardHitPercent = clamp(28 + powerGap * 110, 20, 64);
  const barrelRate = clamp(xiso * 42, 0, 24);
  const kPercent = clamp(20 + (0.245 - row.est_ba) * 140 + Math.max(0.44 - row.est_slg, 0) * 18, 8, 34);
  const bbPercent = clamp(7.5 + (row.est_woba - 0.32) * 45, 4, 16);
  const exitVelocity = clamp(86 + powerGap * 34, 84, 98);
  const avgSwingSpeed = clamp(67 + xiso * 28, 63, 78);

  return {
    ["last_name, first_name"]: row["last_name, first_name"],
    player_id: row.player_id,
    year: row.year,
    pa: row.pa,
    hit: Math.max(0, Math.round(row.ba * row.pa)),
    home_run: Math.max(0, Math.round(xiso * row.pa * 0.32)),
    k_percent: Number(kPercent.toFixed(1)),
    bb_percent: Number(bbPercent.toFixed(1)),
    batting_avg: row.ba,
    xba: row.est_ba,
    xslg: row.est_slg,
    woba: row.woba,
    xwoba: row.est_woba,
    xobp: clamp(0.24 + row.est_ba * 0.38 + bbPercent * 0.0035, 0.26, 0.47),
    xiso: Number(xiso.toFixed(3)),
    avg_swing_speed: Number(avgSwingSpeed.toFixed(1)),
    fast_swing_rate: Number(clamp(powerGap * 130, 0, 60).toFixed(1)),
    blasts_contact: Number(clamp(powerGap * 55, 0, 28).toFixed(1)),
    blasts_swing: Number(clamp(powerGap * 38, 0, 22).toFixed(1)),
    squared_up_contact: Number(clamp(20 + (row.est_woba - 0.3) * 110, 16, 56).toFixed(1)),
    squared_up_swing: Number(clamp(14 + (row.est_woba - 0.3) * 80, 12, 38).toFixed(1)),
    avg_swing_length: 7.2,
    swords: 0,
    attack_angle: Number(clamp(9 + xiso * 22, 6, 18).toFixed(1)),
    attack_direction: 0,
    ideal_angle_rate: Number(clamp(48 + powerGap * 60, 40, 76).toFixed(1)),
    vertical_swing_path: 31,
    exit_velocity_avg: Number(exitVelocity.toFixed(1)),
    launch_angle_avg: Number(clamp(8 + xiso * 36, 5, 22).toFixed(1)),
    sweet_spot_percent: Number(clamp(28 + (row.est_woba - 0.3) * 85, 22, 50).toFixed(1)),
    barrel_batted_rate: Number(barrelRate.toFixed(1)),
    solidcontact_percent: Number(clamp(barrelRate * 0.42, 0, 10).toFixed(1)),
    hard_hit_percent: Number(hardHitPercent.toFixed(1)),
    avg_best_speed: Number((exitVelocity + 8.5).toFixed(2)),
    avg_hyper_speed: Number((exitVelocity + 4.8).toFixed(2)),
    whiff_percent: Number(clamp(14 + kPercent * 0.62, 12, 38).toFixed(1)),
    swing_percent: Number(clamp(42 + xiso * 28, 38, 56).toFixed(1))
  };
}

function synthesizePitcher(row: ExpectedPitcherRow): PitcherStat {
  const xiso = Math.max(0, row.est_slg - row.est_ba);
  const kPercent = clamp(20 + (0.235 - row.est_ba) * 130 + (3.9 - row.xera) * 2.2, 14, 35);
  const bbPercent = clamp(7.6 + (row.xera - row.era) * 1.1, 4, 12);
  const hardHitAllowed = clamp(28 + Math.max(0, row.est_slg - 0.31) * 95, 22, 56);
  const barrelAllowed = clamp(xiso * 28, 0, 17);
  const whiffPercent = clamp(20 + (kPercent - 18) * 0.8, 18, 36);

  return {
    ["last_name, first_name"]: row["last_name, first_name"],
    player_id: row.player_id,
    year: row.year,
    pa: row.pa,
    k_percent: Number(kPercent.toFixed(1)),
    bb_percent: Number(bbPercent.toFixed(1)),
    xba: row.est_ba,
    xslg: row.est_slg,
    woba: row.woba,
    xwoba: row.est_woba,
    xobp: clamp(0.23 + row.est_ba * 0.36 + bbPercent * 0.004, 0.24, 0.38),
    xiso: Number(xiso.toFixed(3)),
    avg_swing_speed: 71.5,
    fast_swing_rate: Number(clamp((row.est_slg - 0.3) * 100, 14, 34).toFixed(1)),
    blasts_contact: Number(clamp((row.est_slg - 0.3) * 48, 4, 24).toFixed(1)),
    blasts_swing: Number(clamp((row.est_slg - 0.3) * 36, 3, 18).toFixed(1)),
    squared_up_contact: Number(clamp(28 + (row.est_woba - 0.29) * 75, 22, 42).toFixed(1)),
    squared_up_swing: Number(clamp(20 + (row.est_woba - 0.29) * 55, 16, 32).toFixed(1)),
    avg_swing_length: 7.3,
    swords: Number(clamp((kPercent - 17) / 2.6, 0, 8).toFixed(0)),
    attack_angle: Number(clamp(10 + xiso * 18, 7, 16).toFixed(1)),
    attack_direction: 0,
    ideal_angle_rate: Number(clamp(46 + (row.est_slg - 0.3) * 52, 40, 64).toFixed(1)),
    vertical_swing_path: 31.5,
    exit_velocity_avg: Number(clamp(85 + Math.max(0, row.est_slg - 0.3) * 30, 84, 94).toFixed(1)),
    launch_angle_avg: Number(clamp(10 + xiso * 22, 8, 18).toFixed(1)),
    sweet_spot_percent: Number(clamp(26 + (row.est_slg - 0.3) * 45, 22, 38).toFixed(1)),
    barrel_batted_rate: Number(barrelAllowed.toFixed(1)),
    hard_hit_percent: Number(hardHitAllowed.toFixed(1)),
    avg_best_speed: Number((88 + Math.max(0, row.est_slg - 0.3) * 28).toFixed(2)),
    avg_hyper_speed: Number((92 + Math.max(0, row.est_slg - 0.3) * 18).toFixed(2)),
    z_swing_percent: Number(clamp(60 + (kPercent - 20) * 0.4, 58, 72).toFixed(1)),
    out_zone_swing_miss: Number(clamp(8 + (kPercent - 18) * 0.7, 6, 22).toFixed(0)),
    whiff_percent: Number(whiffPercent.toFixed(1)),
    swing_percent: 45
  };
}

function resolveCsvPath(envKey: string, workspacePath: string, legacyPath: string) {
  const envValue = process.env[envKey];
  if (cleanText(envValue)) return cleanText(envValue);
  if (fs.existsSync(workspacePath)) return workspacePath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  return workspacePath;
}

function fileStamp(filePath: string) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

export function getExpectedStatsCsvPaths() {
  return {
    batterPath: resolveCsvPath("EXPECTED_BATTERS_CSV_PATH", WORKSPACE_BATTER_CSV_PATH, LEGACY_BATTER_CSV_PATH),
    pitcherPath: resolveCsvPath("EXPECTED_PITCHERS_CSV_PATH", WORKSPACE_PITCHER_CSV_PATH, LEGACY_PITCHER_CSV_PATH)
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

  if (
    cache
    && cache.batterPath === batterPath
    && cache.pitcherPath === pitcherPath
    && cache.batterStamp === batterStamp
    && cache.pitcherStamp === pitcherStamp
  ) {
    return cache.value;
  }

  const expectedBatters = readExpectedBatters(batterPath);
  const expectedPitchers = readExpectedPitchers(pitcherPath);

  const batterKeys = new Set(base.batters.map(playerKey));
  const pitcherKeys = new Set(base.pitchers.map(playerKey));

  const mergedBatters = [...base.batters];
  const mergedPitchers = [...base.pitchers];

  expectedBatters.forEach((row) => {
    const key = playerKey(row);
    if (batterKeys.has(key)) return;
    batterKeys.add(key);
    mergedBatters.push(synthesizeBatter(row));
  });

  expectedPitchers.forEach((row) => {
    const key = playerKey(row);
    if (pitcherKeys.has(key)) return;
    pitcherKeys.add(key);
    mergedPitchers.push(synthesizePitcher(row));
  });

  const value: AugmentedStats = {
    batters: mergedBatters,
    pitchers: mergedPitchers,
    coverage: {
      baseBatters: base.batters.length,
      basePitchers: base.pitchers.length,
      expectedBatters: expectedBatters.length,
      expectedPitchers: expectedPitchers.length,
      mergedBatters: mergedBatters.length,
      mergedPitchers: mergedPitchers.length
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

  cache = {
    batterPath,
    pitcherPath,
    batterStamp,
    pitcherStamp,
    value
  };

  return value;
}
