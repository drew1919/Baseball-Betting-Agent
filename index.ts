import express from "express";
import dotenv from "dotenv";
import * as cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs/promises";
import { renderPage } from "./page.js";
import { STATS, type BatterStat, type PitcherStat } from "./stats.js";
import { getAugmentedStats, getExpectedStatsCsvPaths, getExpectedStatsCsvWritePaths } from "./augmented-stats.js";
import { upsertWinnerFeatureSnapshots, upsertWinnerResults, readWinnerFeatureSnapshots, readWinnerResults, readProductionRegressionModel, readCandidateRegressionModel, writeCandidateRegressionModel, writeProductionRegressionModel, readRegressionReport, writeRegressionReport, getStorageStatus } from "./feature-store.js";
import { buildWinnerGameId, fetchWinnerResults } from "./results-fetcher.js";
import { buildRegressionTrainingRows, MIN_REGRESSION_SAMPLE, trainLogisticRegression } from "./regression-trainer.js";
import { evaluateHeuristicBaseline, evaluateRegressionModel } from "./model-evaluator.js";
import type { RegressionReport, WinnerFeatureSnapshot } from "./regression-types.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 3000;
const ANALYSIS_VERSION = "models-v6";

const SCHEDULE_URL = "https://www.mlb.com/schedule";
const ROTOWIRE_LINEUPS_URL = "https://www.rotowire.com/baseball/daily-lineups.php";
const SAVANT_TOP_URL = "https://baseballsavant.mlb.com/leaderboard/top";
const SAVANT_EXPECTED_URL = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";
const SAVANT_EXPECTED_BATTER_URL = "https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=2026&position=&team=&filterType=bip&min=q&sort=9&sortDir=desc";
const SAVANT_EXPECTED_PITCHER_URL = "https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2026&position=&team=&filterType=bip&min=q&sort=9&sortDir=desc";
const SAVANT_PARK_FACTORS_URL = "https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=2026&batSide=&stat=index_wOBA&condition=All&rolling=3&parks=mlb";
const TEAMRANKINGS_RUN_DIFF_URL = "https://www.teamrankings.com/mlb/stat/run-differential";
const BR_WIN_PROB_BATTING_URL = "https://www.baseball-reference.com/leagues/majors/2026-win_probability-batting.shtml";
const BR_WIN_PROB_PITCHING_URL = "https://www.baseball-reference.com/leagues/majors/2026-win_probability-pitching.shtml";
const SAVANT_FIRST_INNING_PITCHERS_URL = "https://baseballsavant.mlb.com/statcast_search?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=2026%7C2025%7C&hfSit=&player_type=pitcher&hfOuts=&home_road=&pitcher_throws=&batter_stands=&hfSA=&hfEventOuts=&hfEventRuns=&game_date_gt=&game_date_lt=&hfMo=&hfTeam=&hfOpponent=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=1%7C&hfBBT=&hfFlag=is%5C.%5C.bunt%5C.%5C.not%7C&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&chk_stats_abs=on&chk_stats_hits=on&chk_stats_singles=on&chk_stats_hrs=on&chk_stats_k_percent=on&chk_stats_hbp=on&chk_stats_whiffs=on&chk_stats_ba=on&chk_stats_xba=on&chk_stats_barrels_total=on&chk_stats_swing_miss_percent=on&chk_stats_unadj_run_exp=on&chk_stats_unadj_pitcher_run_exp=on&chk_stats_unadj_pitcher_run_value_per_100=on&chk_stats_launch_speed=on&chk_stats_barrels_per_pa_percent=on#results";
const SAVANT_FIRST_INNING_BATTERS_URL = "https://baseballsavant.mlb.com/statcast_search?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=2026%7C2025%7C&hfSit=&player_type=batter&hfOuts=&home_road=&pitcher_throws=&batter_stands=&hfSA=&hfEventOuts=&hfEventRuns=&game_date_gt=&game_date_lt=&hfMo=&hfTeam=&hfOpponent=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=1%7C&hfBBT=&hfFlag=is%5C.%5C.bunt%5C.%5C.not%7Cis%5C.%5C.competitive%7C&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&chk_stats_abs=on&chk_stats_hits=on&chk_stats_singles=on&chk_stats_hrs=on&chk_stats_k_percent=on&chk_stats_hbp=on&chk_stats_whiffs=on&chk_stats_ba=on&chk_stats_xba=on&chk_stats_barrels_total=on&chk_stats_swing_miss_percent=on&chk_stats_unadj_run_exp=on&chk_stats_launch_speed=on&chk_stats_hardhit_percent=on&chk_stats_barrels_per_pa_percent=on&chk_stats_sweetspot_speed_mph=on#results";
const SEARCH_CACHE_MS = 1000 * 60 * 20;
const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";
const ODDS_BOOKMAKER = process.env.ODDS_BOOKMAKER || "fanduel";
const MORNING_REFRESH_HOUR = 6;
const MORNING_REFRESH_MINUTE = 5;
const TEAM_ALIASES: Record<string, string[]> = {
  ARI: ["ARI", "Arizona", "Arizona Diamondbacks", "Diamondbacks", "D-backs"],
  ATL: ["ATL", "Atlanta", "Atlanta Braves", "Braves"],
  BAL: ["BAL", "Baltimore", "Baltimore Orioles", "Orioles"],
  BOS: ["BOS", "Boston", "Boston Red Sox", "Red Sox"],
  CHC: ["CHC", "Chi Cubs", "Chicago Cubs", "Cubs"],
  CWS: ["CWS", "Chi Sox", "Chicago White Sox", "White Sox"],
  CIN: ["CIN", "Cincinnati", "Cincinnati Reds", "Reds"],
  CLE: ["CLE", "Cleveland", "Cleveland Guardians", "Guardians"],
  COL: ["COL", "Colorado", "Colorado Rockies", "Rockies"],
  DET: ["DET", "Detroit", "Detroit Tigers", "Tigers"],
  HOU: ["HOU", "Houston", "Houston Astros", "Astros"],
  KC: ["KC", "Kansas City", "Kansas City Royals", "Royals"],
  LAA: ["LAA", "LA Angels", "Los Angeles Angels", "Angels"],
  LAD: ["LAD", "LA Dodgers", "Los Angeles Dodgers", "Dodgers"],
  MIA: ["MIA", "Miami", "Miami Marlins", "Marlins"],
  MIL: ["MIL", "Milwaukee", "Milwaukee Brewers", "Brewers"],
  MIN: ["MIN", "Minnesota", "Minnesota Twins", "Twins"],
  NYM: ["NYM", "New York Mets", "Mets"],
  NYY: ["NYY", "New York Yankees", "Yankees"],
  ATH: ["ATH", "Sacramento", "Sacramento Athletics", "Athletics", "A's"],
  PHI: ["PHI", "Philadelphia", "Philadelphia Phillies", "Phillies"],
  PIT: ["PIT", "Pittsburgh", "Pittsburgh Pirates", "Pirates"],
  SD: ["SD", "San Diego", "San Diego Padres", "Padres"],
  SEA: ["SEA", "Seattle", "Seattle Mariners", "Mariners"],
  SF: ["SF", "SF Giants", "San Francisco Giants", "Giants"],
  STL: ["STL", "St. Louis", "St. Louis Cardinals", "Cardinals"],
  TB: ["TB", "Tampa Bay", "Tampa Bay Rays", "Rays"],
  TEX: ["TEX", "Texas", "Texas Rangers", "Rangers"],
  TOR: ["TOR", "Toronto", "Toronto Blue Jays", "Blue Jays"],
  WSH: ["WSH", "Washington", "Washington Nationals", "Nationals", "Nats"]
};
const MLB_TEAM_IDS: Record<string, number> = {
  ARI: 109,
  ATL: 144,
  BAL: 110,
  BOS: 111,
  CHC: 112,
  CWS: 145,
  CIN: 113,
  CLE: 114,
  COL: 115,
  DET: 116,
  HOU: 117,
  KC: 118,
  LAA: 108,
  LAD: 119,
  MIA: 146,
  MIL: 158,
  MIN: 142,
  NYM: 121,
  NYY: 147,
  ATH: 133,
  PHI: 143,
  PIT: 134,
  SD: 135,
  SEA: 136,
  SF: 137,
  STL: 138,
  TB: 139,
  TEX: 140,
  TOR: 141,
  WSH: 120
};
const MLB_TEAM_ID_TO_KEY = new Map(Object.entries(MLB_TEAM_IDS).map(([teamKey, teamId]) => [String(teamId), teamKey]));

type GamePitcher = {
  name: string;
  era: string | null;
  hand: string | null;
  record: string | null;
};

type GameBatter = {
  name: string;
  pos: string;
  hand: string;
};

type GameCard = {
  away: string;
  home: string;
  awayP: GamePitcher | null;
  homeP: GamePitcher | null;
  awayLineup: GameBatter[];
  homeLineup: GameBatter[];
  confirmed: boolean;
  ou: string | null;
  line: string | null;
  umpireKpg: string | null;
  weather: string | null;
};

type SourceSummary = {
  key: string;
  label: string;
  url: string;
  ok: boolean;
  pageTitle: string;
  headings: string[];
  preview: string;
  sampleRows: string[][];
};

type ScheduleGame = {
  away: string;
  home: string;
  gameTime: string | null;
};

type BetType = "general" | "nrfi" | "strikeouts" | "winner";

type MatchedGameContext = {
  away: string;
  home: string;
  awayPitcher: PitcherStat | null;
  homePitcher: PitcherStat | null;
  awayBatters: BatterStat[];
  homeBatters: BatterStat[];
};

type FirstInningPitcherSplit = {
  name: string;
  ab: number;
  hits: number;
  hr: number;
  kPercent: number;
  whiffPercent: number;
  ba: number;
  xba: number;
  barrels: number;
  pitcherRunValuePer100: number;
  launchSpeed: number;
  barrelsPerPaPercent: number;
};

type FirstInningBatterSplit = {
  name: string;
  ab: number;
  hits: number;
  hr: number;
  kPercent: number;
  whiffPercent: number;
  ba: number;
  xba: number;
  barrels: number;
  ev: number;
  hardHitPercent: number;
  barrelsPerPaPercent: number;
};

type CacheEntry<T> = {
  fetchedAt: number;
  value: T;
};

type TeamRunDifferential = {
  teamKey: string;
  teamName: string;
  season: number;
  last3: number;
  last1: number;
  home: number;
  away: number;
  previousSeason: number;
};

type GameOdds = {
  away: string;
  home: string;
  bookmaker: string;
  commenceTime: string | null;
  lastUpdate: string | null;
  awayMoneyline: number | null;
  homeMoneyline: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  runLine: number | null;
  awayRunLinePrice: number | null;
  homeRunLinePrice: number | null;
};

type TeamDefenseStat = {
  teamKey: string;
  teamName: string;
  fieldingPct: number;
  errors: number;
  chances: number;
  assists: number;
  putOuts: number;
  doublePlays: number;
  throwingErrors: number;
  passedBalls: number;
  rangeFactorPerGame: number;
  rangeFactorPer9: number;
  score: number;
};

type TeamWinProbStat = {
  teamKey: string;
  teamName: string;
  wpa: number;
  wpaLi: number;
  re24: number;
  re24BoLi: number;
  clutch: number;
  score: number;
};

type TeamParkFactorStat = {
  teamKey: string;
  teamName: string;
  venueName: string;
  indexWoba: number;
  indexRuns: number;
  indexHits: number;
  indexHr: number;
  indexHardHit: number;
  environment: number;
};

let firstInningPitcherCache: CacheEntry<Map<string, FirstInningPitcherSplit>> | null = null;
let firstInningBatterCache: CacheEntry<Map<string, FirstInningBatterSplit>> | null = null;
let teamRunDiffCache: CacheEntry<Map<string, TeamRunDifferential>> | null = null;
let teamLastFiveCache: CacheEntry<Map<string, number>> | null = null;
let oddsCache: CacheEntry<GameOdds[]> | null = null;
let teamDefenseCache: CacheEntry<Map<string, TeamDefenseStat>> | null = null;
let teamBattingWinProbCache: CacheEntry<Map<string, TeamWinProbStat>> | null = null;
let teamPitchingWinProbCache: CacheEntry<Map<string, TeamWinProbStat>> | null = null;
let teamParkFactorCache: CacheEntry<Map<string, TeamParkFactorStat>> | null = null;
let teamDefensePromise: Promise<Map<string, TeamDefenseStat>> | null = null;
let teamBattingWinProbPromise: Promise<Map<string, TeamWinProbStat>> | null = null;
let teamPitchingWinProbPromise: Promise<Map<string, TeamWinProbStat>> | null = null;
let teamParkFactorPromise: Promise<Map<string, TeamParkFactorStat>> | null = null;
let nextMorningRefreshAt: string | null = null;
let lastMorningRefreshAt: string | null = null;
let lastMorningRefreshStatus: "idle" | "ok" | "error" = "idle";
let lastMorningRefreshError: string | null = null;

function getCurrentStats() {
  return getAugmentedStats(STATS);
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

function statDisplayName(value: string) {
  const [last, first] = value.split(",").map((part) => cleanText(part));
  return first && last ? `${first} ${last}` : value;
}

function nameTokens(value: string) {
  return normalizeName(value).split(" ").filter(Boolean);
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value: number, digits = 1) {
  return Number(value).toFixed(digits);
}

function sampleTag(pa: number) {
  return pa < 30 ? `Small sample: ${pa} PA.` : `Sample: ${pa} PA.`;
}

async function fetchHtml(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  return await res.text();
}

function extractSampleRows($: cheerio.CheerioAPI) {
  const rows: string[][] = [];

  $("table")
    .slice(0, 2)
    .each((_, table) => {
      $(table)
        .find("tr")
        .slice(0, 3)
        .each((__, row) => {
          const cells = $(row)
            .find("th,td")
            .slice(0, 6)
            .map((___, cell) => cleanText($(cell).text()))
            .get()
            .filter(Boolean);

          if (cells.length) rows.push(cells);
        });
    });

  return rows.slice(0, 6);
}

function extractBaseballReferenceTable(html: string) {
  const direct = cheerio.load(html);
  const directTable = direct("table").filter((_, table) => {
    const headers = direct(table).find("th").slice(0, 12).map((__, th) => cleanText(direct(th).text())).get();
    return headers.includes("Tm") && headers.includes("WPA/LI");
  }).first();

  if (directTable.length) {
    return cheerio.load(directTable.toString())("table").first();
  }

  const comments = Array.from(html.matchAll(/<!--([\s\S]*?)-->/g)).map((match) => match[1]);
  for (const comment of comments) {
    const $ = cheerio.load(comment);
    const table = $("table").filter((_, el) => {
      const headers = $(el).find("th").slice(0, 12).map((__, th) => cleanText($(th).text())).get();
      return headers.includes("Tm") && headers.includes("WPA/LI");
    }).first();
    if (table.length) {
      return table;
    }
  }

  return null;
}

function extractSavantParkFactorData(html: string) {
  const match = html.match(/var data = (\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]) as Array<Record<string, string>>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractSavantLeaderboardData(html: string) {
  const match = html.match(/var data = (\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]) as Array<Record<string, string | number | null>>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseNumber(value: string) {
  const cleaned = String(value || "").replace(/,/g, "").replace(/%/g, "").trim();
  if (!cleaned) return 0;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseDecimal(value: string) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return 0;
  return parseNumber(cleaned.startsWith(".") ? `0${cleaned}` : cleaned);
}

function csvEscape(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function formatDecimal(value: number, digits = 3) {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(digits);
}

function formatExpectedStatsCsv(
  type: "batter" | "pitcher",
  rows: Array<Record<string, string | number | null>>
) {
  const headers = type === "batter"
    ? [
        "last_name, first_name",
        "player_id",
        "year",
        "pa",
        "bip",
        "ba",
        "est_ba",
        "est_ba_minus_ba_diff",
        "slg",
        "est_slg",
        "est_slg_minus_slg_diff",
        "woba",
        "est_woba",
        "est_woba_minus_woba_diff"
      ]
    : [
        "last_name, first_name",
        "player_id",
        "year",
        "pa",
        "bip",
        "ba",
        "est_ba",
        "est_ba_minus_ba_diff",
        "slg",
        "est_slg",
        "est_slg_minus_slg_diff",
        "woba",
        "est_woba",
        "est_woba_minus_woba_diff",
        "era",
        "xera",
        "era_minus_xera_diff"
      ];

  const lines = rows.map((row) => {
    const ba = Number(row.ba ?? 0);
    const estBa = Number(row.est_ba ?? 0);
    const slg = Number(row.slg ?? 0);
    const estSlg = Number(row.est_slg ?? 0);
    const woba = Number(row.woba ?? 0);
    const estWoba = Number(row.est_woba ?? 0);
    const baseValues: Array<string | number> = [
      String(row.entity_name ?? ""),
      String(row.entity_id ?? ""),
      String(row.year ?? ""),
      String(row.pa ?? ""),
      String(row.bip ?? ""),
      formatDecimal(ba),
      formatDecimal(estBa),
      formatDecimal(estBa - ba),
      formatDecimal(slg),
      formatDecimal(estSlg),
      formatDecimal(estSlg - slg),
      formatDecimal(woba),
      formatDecimal(estWoba),
      formatDecimal(estWoba - woba)
    ];

    if (type === "pitcher") {
      const era = Number(row.era ?? 0);
      const xera = Number(row.xera ?? 0);
      baseValues.push(
        formatDecimal(era),
        formatDecimal(xera),
        formatDecimal(era - xera)
      );
    }

    return baseValues.map(csvEscape).join(",");
  });

  return `${headers.map(csvEscape).join(",")}\n${lines.join("\n")}\n`;
}

async function refreshExpectedStatsCsvs() {
  const batterHtml = await fetchHtml(SAVANT_EXPECTED_BATTER_URL);
  const pitcherHtml = await fetchHtml(SAVANT_EXPECTED_PITCHER_URL);
  const batterRows = extractSavantLeaderboardData(batterHtml);
  const pitcherRows = extractSavantLeaderboardData(pitcherHtml);
  const { batterPath, pitcherPath } = getExpectedStatsCsvWritePaths();

  await fs.mkdir(path.dirname(batterPath), { recursive: true });
  await fs.mkdir(path.dirname(pitcherPath), { recursive: true });
  await fs.writeFile(batterPath, formatExpectedStatsCsv("batter", batterRows), "utf8");
  await fs.writeFile(pitcherPath, formatExpectedStatsCsv("pitcher", pitcherRows), "utf8");

  return {
    batterPath,
    pitcherPath,
    batterCount: batterRows.length,
    pitcherCount: pitcherRows.length
  };
}

function sanitizeSearchPlayerName(value: string) {
  return cleanText(value).replace(/\s+(LHP|RHP|SHP)$/i, "");
}

function resolveTeamKey(value: string) {
  const normalized = normalizeName(value);
  const entry = Object.entries(TEAM_ALIASES).find(([, aliases]) =>
    aliases.some((alias) => normalizeName(alias) === normalized)
  );
  return entry?.[0] || null;
}

function parseSearchTableRows(html: string) {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return [];

  const headers = table.find("th").map((_, th) => cleanText($(th).text())).get();
  const rows: Record<string, string>[] = [];

  table.find("tr").slice(1).each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => cleanText($(td).text())).get();
    if (!cells.length) return;

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header || `col_${index}`] = cells[index] || "";
    });
    rows.push(row);
  });

  return rows;
}

function isFresh<T>(entry: CacheEntry<T> | null) {
  return Boolean(entry && Date.now() - entry.fetchedAt < SEARCH_CACHE_MS);
}

async function loadFirstInningPitcherSplits() {
  if (isFresh(firstInningPitcherCache)) {
    return firstInningPitcherCache!.value;
  }

  const html = await fetchHtml(SAVANT_FIRST_INNING_PITCHERS_URL);
  const rows = parseSearchTableRows(html);
  const map = new Map<string, FirstInningPitcherSplit>();

  rows.forEach((row) => {
    const name = sanitizeSearchPlayerName(row["Player"]);
    if (!name) return;

    map.set(normalizeName(name), {
      name,
      ab: parseNumber(row["AB"]),
      hits: parseNumber(row["Hits"]),
      hr: parseNumber(row["HR"]),
      kPercent: parseNumber(row["K%"]),
      whiffPercent: parseNumber(row["Whiff%"]),
      ba: parseDecimal(row["BA"]),
      xba: parseDecimal(row["xBA"]),
      barrels: parseNumber(row["Barrels"]),
      pitcherRunValuePer100: parseNumber(row["Pitcher RV / 100 (Leveraged)"]),
      launchSpeed: parseNumber(row["Launch Speed"]),
      barrelsPerPaPercent: parseNumber(row["Barrels/PA"])
    });
  });

  firstInningPitcherCache = { fetchedAt: Date.now(), value: map };
  return map;
}

async function loadFirstInningBatterSplits() {
  if (isFresh(firstInningBatterCache)) {
    return firstInningBatterCache!.value;
  }

  const html = await fetchHtml(SAVANT_FIRST_INNING_BATTERS_URL);
  const rows = parseSearchTableRows(html);
  const map = new Map<string, FirstInningBatterSplit>();

  rows.forEach((row) => {
    const name = sanitizeSearchPlayerName(row["Player"]);
    if (!name) return;

    map.set(normalizeName(name), {
      name,
      ab: parseNumber(row["AB"]),
      hits: parseNumber(row["Hits"]),
      hr: parseNumber(row["HR"]),
      kPercent: parseNumber(row["K%"]),
      whiffPercent: parseNumber(row["Whiff%"]),
      ba: parseDecimal(row["BA"]),
      xba: parseDecimal(row["xBA"]),
      barrels: parseNumber(row["Barrels"]),
      ev: parseNumber(row["EV (MPH)"]),
      hardHitPercent: parseNumber(row["Hard Hit%"]),
      barrelsPerPaPercent: parseNumber(row["Barrels/PA"])
    });
  });

  firstInningBatterCache = { fetchedAt: Date.now(), value: map };
  return map;
}

async function loadTeamRunDifferentials() {
  if (isFresh(teamRunDiffCache)) {
    return teamRunDiffCache!.value;
  }

  const html = await fetchHtml(TEAMRANKINGS_RUN_DIFF_URL);
  const rows = parseSearchTableRows(html);
  const map = new Map<string, TeamRunDifferential>();

  rows.forEach((row) => {
    const teamName = cleanText(row["Team"]);
    const teamKey = resolveTeamKey(teamName);
    if (!teamKey) return;

    map.set(teamKey, {
      teamKey,
      teamName,
      season: parseNumber(row["2026"]),
      last3: parseNumber(row["Last 3"]),
      last1: parseNumber(row["Last 1"]),
      home: parseNumber(row["Home"]),
      away: parseNumber(row["Away"]),
      previousSeason: parseNumber(row["2025"])
    });
  });

  teamRunDiffCache = { fetchedAt: Date.now(), value: map };
  return map;
}

async function loadLastFiveRunDifferentials() {
  if (isFresh(teamLastFiveCache)) {
    return teamLastFiveCache!.value;
  }

  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  const start = startDate.toISOString().slice(0, 10);

  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${today}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for recent MLB schedule`);
  }

  const data = (await res.json()) as {
    dates?: Array<{
      games?: Array<{
        gameDate?: string;
        status?: { abstractGameState?: string };
        teams?: {
          away?: { team?: { name?: string }; score?: number };
          home?: { team?: { name?: string }; score?: number };
        };
      }>;
    }>;
  };

  const perTeam = new Map<string, Array<{ date: string; diff: number }>>();

  (data.dates || []).forEach((dateEntry) => {
    (dateEntry.games || []).forEach((game) => {
      if (game.status?.abstractGameState !== "Final") return;
      const awayName = cleanText(game.teams?.away?.team?.name || "");
      const homeName = cleanText(game.teams?.home?.team?.name || "");
      const awayKey = resolveTeamKey(awayName);
      const homeKey = resolveTeamKey(homeName);
      const awayScore = Number(game.teams?.away?.score || 0);
      const homeScore = Number(game.teams?.home?.score || 0);
      const gameDate = game.gameDate || "";
      if (!awayKey || !homeKey) return;

      if (!perTeam.has(awayKey)) perTeam.set(awayKey, []);
      if (!perTeam.has(homeKey)) perTeam.set(homeKey, []);
      perTeam.get(awayKey)!.push({ date: gameDate, diff: awayScore - homeScore });
      perTeam.get(homeKey)!.push({ date: gameDate, diff: homeScore - awayScore });
    });
  });

  const map = new Map<string, number>();
  perTeam.forEach((games, teamKey) => {
    const total = games
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .reduce((sum, game) => sum + game.diff, 0);
    map.set(teamKey, total);
  });

  teamLastFiveCache = { fetchedAt: Date.now(), value: map };
  return map;
}

async function loadTeamDefenseStats() {
  if (isFresh(teamDefenseCache)) {
    return teamDefenseCache!.value;
  }
  if (teamDefensePromise) {
    return await teamDefensePromise;
  }

  teamDefensePromise = (async () => {
    const season = new Date().getFullYear();
    const entries = await Promise.all(
      Object.entries(MLB_TEAM_IDS).map(async ([teamKey, teamId]) => {
        try {
          const res = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=fielding&season=${season}&sportIds=1`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
            }
          });

          if (!res.ok) {
            return null;
          }

          const data = (await res.json()) as {
            stats?: Array<{
              splits?: Array<{
                team?: { name?: string };
                stat?: Record<string, string | number | null | undefined>;
              }>;
            }>;
          };

          const split = data.stats?.flatMap((entry) => entry.splits || [])[0];
          const stat = split?.stat || {};
          const fieldingPct = parseDecimal(String(stat.fielding || stat.fieldingPct || "0"));
          const errors = parseNumber(String(stat.errors || 0));
          const chances = parseNumber(String(stat.chances || 0));
          const assists = parseNumber(String(stat.assists || 0));
          const putOuts = parseNumber(String(stat.putOuts || 0));
          const doublePlays = parseNumber(String(stat.doublePlays || 0));
          const throwingErrors = parseNumber(String(stat.throwingErrors || 0));
          const passedBalls = parseNumber(String(stat.passedBalls || 0));
          const rangeFactorPerGame = parseDecimal(String(stat.rangeFactorPerGame || 0));
          const rangeFactorPer9 = parseDecimal(String(stat.rangeFactorPer9Inn || 0));
          const errorRate = chances ? errors / chances : 0;
          const rawScore = (fieldingPct - 0.985) * 650
            + rangeFactorPerGame * 1.35
            + doublePlays * 0.05
            + assists * 0.003
            - errorRate * 900
            - throwingErrors * 0.35
            - passedBalls * 0.4;
          const score = Math.max(-4, Math.min(4, rawScore));

          return [
            teamKey,
            {
              teamKey,
              teamName: cleanText(split?.team?.name || teamKey),
              fieldingPct,
              errors,
              chances,
              assists,
              putOuts,
              doublePlays,
              throwingErrors,
              passedBalls,
              rangeFactorPerGame,
              rangeFactorPer9,
              score
            } satisfies TeamDefenseStat
          ] as const;
        } catch {
          return null;
        }
      })
    );

    const map = new Map<string, TeamDefenseStat>();
    entries.forEach((entry) => {
      if (!entry) return;
      map.set(entry[0], entry[1]);
    });

    teamDefenseCache = { fetchedAt: Date.now(), value: map };
    return map;
  })();

  try {
    return await teamDefensePromise;
  } finally {
    teamDefensePromise = null;
  }
}

async function loadTeamWinProbabilityStats(kind: "batting" | "pitching") {
  const cache = kind === "batting" ? teamBattingWinProbCache : teamPitchingWinProbCache;
  if (isFresh(cache)) {
    return cache!.value;
  }
  const pending = kind === "batting" ? teamBattingWinProbPromise : teamPitchingWinProbPromise;
  if (pending) {
    return await pending;
  }

  const promise = (async () => {
    const map = new Map<string, TeamWinProbStat>();
    try {
      const html = await fetchHtml(kind === "batting" ? BR_WIN_PROB_BATTING_URL : BR_WIN_PROB_PITCHING_URL);
      const table = extractBaseballReferenceTable(html);

      if (table && table.length) {
        const headers = table.find("thead tr").last().find("th").map((_, th) => cleanText(table.find("thead tr").last().find("th").eq(_).text())).get();
        table.find("tbody tr").each((_, tr) => {
          const row = table.find(tr);
          const cells = row.find("th,td").map((__, cell) => cleanText(row.find("th,td").eq(__).text())).get();
          if (!cells.length || cells[0] === "Tm" || /League Average/i.test(cells[0])) return;

          const record: Record<string, string> = {};
          headers.forEach((header, index) => {
            record[header || `col_${index}`] = cells[index] || "";
          });

          const teamName = cleanText(record["Tm"] || cells[0] || "");
          const teamKey = resolveTeamKey(teamName);
          if (!teamKey) return;

          const wpa = parseNumber(record["WPA"]);
          const wpaLi = parseNumber(record["WPA/LI"]);
          const re24 = parseNumber(record["RE24"]);
          const re24BoLi = parseNumber(record["RE24/boLI"]);
          const clutch = parseNumber(record["Clutch"]);
          const rawScore = wpaLi * 0.18 + re24BoLi * 0.006 + re24 * 0.002 + wpa * 0.05 + clutch * 0.08;
          const score = Math.max(-2.5, Math.min(2.5, rawScore));

          map.set(teamKey, {
            teamKey,
            teamName,
            wpa,
            wpaLi,
            re24,
            re24BoLi,
            clutch,
            score
          });
        });
      }
    } catch {
      if (cache?.value?.size) {
        return cache.value;
      }
    }

    const entry = { fetchedAt: Date.now(), value: map };
    if (kind === "batting") {
      teamBattingWinProbCache = entry;
    } else {
      teamPitchingWinProbCache = entry;
    }
    return map;
  })();

  if (kind === "batting") {
    teamBattingWinProbPromise = promise;
  } else {
    teamPitchingWinProbPromise = promise;
  }

  try {
    return await promise;
  } finally {
    if (kind === "batting") {
      teamBattingWinProbPromise = null;
    } else {
      teamPitchingWinProbPromise = null;
    }
  }
}

async function loadTeamParkFactors() {
  if (isFresh(teamParkFactorCache)) {
    return teamParkFactorCache!.value;
  }
  if (teamParkFactorPromise) {
    return await teamParkFactorPromise;
  }

  teamParkFactorPromise = (async () => {
    const map = new Map<string, TeamParkFactorStat>();
    try {
      const html = await fetchHtml(SAVANT_PARK_FACTORS_URL);
      const rows = extractSavantParkFactorData(html);

      rows.forEach((row) => {
        const teamKey = MLB_TEAM_ID_TO_KEY.get(String(row.main_team_id || ""));
        if (!teamKey) return;

        const indexWoba = parseNumber(row.index_woba);
        const indexRuns = parseNumber(row.index_runs);
        const indexHits = parseNumber(row.index_hits);
        const indexHr = parseNumber(row.index_hr);
        const indexHardHit = parseNumber(row.index_hardhit);
        const environment = (
          ((indexWoba - 100) * 0.55)
          + ((indexRuns - 100) * 0.25)
          + ((indexHits - 100) * 0.10)
          + ((indexHr - 100) * 0.10)
        ) / 100;

        map.set(teamKey, {
          teamKey,
          teamName: cleanText(row.name_display_club || teamKey),
          venueName: cleanText(row.venue_name || ""),
          indexWoba,
          indexRuns,
          indexHits,
          indexHr,
          indexHardHit,
          environment
        });
      });
    } catch {
      if (teamParkFactorCache?.value?.size) {
        return teamParkFactorCache.value;
      }
    }

    teamParkFactorCache = { fetchedAt: Date.now(), value: map };
    return map;
  })();

  try {
    return await teamParkFactorPromise;
  } finally {
    teamParkFactorPromise = null;
  }
}

function impliedProbability(american: number | null) {
  if (american === null || !Number.isFinite(american)) return null;
  if (american > 0) return 100 / (american + 100);
  if (american < 0) return Math.abs(american) / (Math.abs(american) + 100);
  return null;
}

async function loadGameOdds() {
  if (isFresh(oddsCache)) {
    return oddsCache!.value;
  }

  const apiKey = cleanText(process.env.ODDS_API_KEY || "");
  if (!apiKey) {
    oddsCache = { fetchedAt: Date.now(), value: [] };
    return [];
  }

  const url = `${ODDS_API_BASE}?regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${encodeURIComponent(ODDS_BOOKMAKER)}&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for odds API`);
  }

  const data = (await res.json()) as Array<{
    commence_time?: string;
    home_team?: string;
    away_team?: string;
    bookmakers?: Array<{
      key?: string;
      title?: string;
      last_update?: string;
      markets?: Array<{
        key?: string;
        outcomes?: Array<{ name?: string; price?: number; point?: number }>;
      }>;
    }>;
  }>;

  const odds = data.map((event) => {
    const home = resolveTeamKey(cleanText(event.home_team || ""));
    const away = resolveTeamKey(cleanText(event.away_team || ""));
    const bookmaker = (event.bookmakers || [])[0];
    if (!home || !away || !bookmaker) return null;

    const h2h = bookmaker.markets?.find((market) => market.key === "h2h");
    const spreads = bookmaker.markets?.find((market) => market.key === "spreads");
    const totals = bookmaker.markets?.find((market) => market.key === "totals");

    const awayMoneyline = h2h?.outcomes?.find((outcome) => resolveTeamKey(cleanText(outcome.name || "")) === away)?.price ?? null;
    const homeMoneyline = h2h?.outcomes?.find((outcome) => resolveTeamKey(cleanText(outcome.name || "")) === home)?.price ?? null;
    const overOutcome = totals?.outcomes?.find((outcome) => normalizeName(cleanText(outcome.name || "")) === "over");
    const underOutcome = totals?.outcomes?.find((outcome) => normalizeName(cleanText(outcome.name || "")) === "under");
    const homeSpread = spreads?.outcomes?.find((outcome) => resolveTeamKey(cleanText(outcome.name || "")) === home);
    const awaySpread = spreads?.outcomes?.find((outcome) => resolveTeamKey(cleanText(outcome.name || "")) === away);

    return {
      away,
      home,
      bookmaker: cleanText(bookmaker.title || bookmaker.key || ODDS_BOOKMAKER),
      commenceTime: event.commence_time || null,
      lastUpdate: bookmaker.last_update || null,
      awayMoneyline: awayMoneyline === null ? null : Number(awayMoneyline),
      homeMoneyline: homeMoneyline === null ? null : Number(homeMoneyline),
      total: overOutcome?.point ?? underOutcome?.point ?? null,
      overPrice: overOutcome?.price ?? null,
      underPrice: underOutcome?.price ?? null,
      runLine: homeSpread?.point ?? awaySpread?.point ?? null,
      awayRunLinePrice: awaySpread?.price ?? null,
      homeRunLinePrice: homeSpread?.price ?? null
    } satisfies GameOdds;
  }).filter((value): value is GameOdds => value !== null);

  oddsCache = { fetchedAt: Date.now(), value: odds };
  return odds;
}

async function findOddsForGame(away: string, home: string) {
  const odds = await loadGameOdds();
  const awayKey = resolveTeamKey(away);
  const homeKey = resolveTeamKey(home);
  if (!awayKey || !homeKey) return null;
  return odds.find((entry) => entry.away === awayKey && entry.home === homeKey) || null;
}

async function scrapePublicSources() {
  const sources = [
    { key: "schedule", label: "MLB Schedule", url: SCHEDULE_URL },
    { key: "lineups", label: "RotoWire Lineups", url: ROTOWIRE_LINEUPS_URL },
    { key: "team-rd", label: "TeamRankings Run Differential", url: TEAMRANKINGS_RUN_DIFF_URL },
    { key: "br-win-batting", label: "Baseball Reference Win Probability Batting", url: BR_WIN_PROB_BATTING_URL },
    { key: "br-win-pitching", label: "Baseball Reference Win Probability Pitching", url: BR_WIN_PROB_PITCHING_URL },
    { key: "savant-top", label: "Savant Top Performers", url: SAVANT_TOP_URL },
    { key: "savant-expected", label: "Savant Expected Statistics", url: SAVANT_EXPECTED_URL },
    { key: "savant-park-factors", label: "Savant Park Factors", url: SAVANT_PARK_FACTORS_URL },
    { key: "savant-1st-pitchers", label: "Savant 1st Inning Pitchers", url: SAVANT_FIRST_INNING_PITCHERS_URL },
    { key: "savant-1st-batters", label: "Savant 1st Inning Batters", url: SAVANT_FIRST_INNING_BATTERS_URL }
  ];

  return await Promise.all(
    sources.map(async (source): Promise<SourceSummary> => {
      try {
        const html = await fetchHtml(source.url);
        const $ = cheerio.load(html);
        const bodyText = cleanText($("body").text());

        return {
          ...source,
          ok: true,
          pageTitle: cleanText($("title").first().text()),
          headings: $("h1,h2,h3")
            .slice(0, 8)
            .map((_, el) => cleanText($(el).text()))
            .get()
            .filter(Boolean),
          preview: bodyText.slice(0, 280),
          sampleRows: extractSampleRows($)
        };
      } catch (error) {
        return {
          ...source,
          ok: false,
          pageTitle: "",
          headings: [],
          preview: getErrorMessage(error),
          sampleRows: []
        };
      }
    })
  );
}

function formatScheduleTime(dateTime?: string) {
  if (!dateTime) return null;
  try {
    return new Date(dateTime).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return null;
  }
}

function parseRotoWireGames(html: string) {
  const $ = cheerio.load(html);
  const games: GameCard[] = [];

  $(".lineup.is-mlb").each((_, gameEl) => {
    const game = $(gameEl);
    const text = cleanText(game.text());

    const teams = game
      .find("img[alt]")
      .map((__, img) => cleanText($(img).attr("alt")))
      .get()
      .filter((alt) => /^[A-Z]{2,4}$/.test(alt));

    const uniqueTeams = [...new Set(teams)].slice(0, 2);
    if (uniqueTeams.length < 2) return;

    const awayList = game.find("ul.lineup__list.is-visit").first();
    const homeList = game.find("ul.lineup__list.is-home").first();

    function parseList(list: cheerio.Cheerio<any>) {
      const pitcherName = cleanText(list.find(".lineup__player-highlight-name a").first().text());
      const pitcherHand = cleanText(list.find(".lineup__throws").first().text()) || null;
      const pitcherStats = cleanText(list.find(".lineup__player-highlight-stats").first().text());
      const eraMatch = pitcherStats.match(/([\d.]+)\s*ERA/i);
      const recordMatch = pitcherStats.match(/(\d+-\d+)/);

      const lineup = list
        .find(".lineup__player")
        .map((__, playerEl) => {
          const player = $(playerEl);
          return {
            name: cleanText(player.find("a[title]").attr("title") || player.find("a").first().text()),
            pos: cleanText(player.find(".lineup__pos").first().text()),
            hand: cleanText(player.find(".lineup__bats").first().text())
          } satisfies GameBatter;
        })
        .get()
        .filter((player) => player.name)
        .slice(0, 9);

      return {
        pitcher: pitcherName
          ? ({
              name: pitcherName,
              hand: pitcherHand,
              era: eraMatch?.[1] || null,
              record: recordMatch?.[1] || null
            } satisfies GamePitcher)
          : null,
        lineup,
        confirmed: /Confirmed Lineup/i.test(list.text())
      };
    }

    const awayParsed = parseList(awayList);
    const homeParsed = parseList(homeList);

    games.push({
      away: uniqueTeams[0],
      home: uniqueTeams[1],
      awayP: awayParsed.pitcher,
      homeP: homeParsed.pitcher,
      awayLineup: awayParsed.lineup,
      homeLineup: homeParsed.lineup,
      confirmed: awayParsed.confirmed && homeParsed.confirmed,
      ou: text.match(/O\/U\s*([\d.]+)/i)?.[1] || null,
      line: text.match(/LINE\s+([A-Z]{2,4})\s+([+-]?\d+)/i)?.slice(1).join(" ") || null,
      umpireKpg: text.match(/([\d.]+)\s*K\/G/i)?.[1] || null,
      weather: null
    });
  });

  const seen = new Set<string>();
  return games.filter((game) => {
    const key = `${game.away}-${game.home}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadDailyLineups() {
  const html = await fetchHtml(ROTOWIRE_LINEUPS_URL);
  return {
    source: ROTOWIRE_LINEUPS_URL,
    scrapedAt: new Date().toISOString(),
    games: parseRotoWireGames(html)
  };
}

async function loadSchedule() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for MLB schedule API`);
  }

  const data = (await res.json()) as {
    dates?: Array<{
      date: string;
      games?: Array<{
        gameDate?: string;
        teams?: {
          away?: { team?: { name?: string } };
          home?: { team?: { name?: string } };
        };
      }>;
    }>;
  };

  const games = (data.dates?.[0]?.games || [])
    .map((game) => ({
      away: cleanText(game.teams?.away?.team?.name || ""),
      home: cleanText(game.teams?.home?.team?.name || ""),
      gameTime: formatScheduleTime(game.gameDate)
    }))
    .filter((game) => game.away && game.home);

  return {
    source: "https://statsapi.mlb.com/api/v1/schedule",
    scrapedAt: new Date().toISOString(),
    games
  };
}

function findPitcherStat(name: string) {
  const stats = getCurrentStats();
  const target = normalizeName(name);
  const targetTokens = nameTokens(name);

  return (
    stats.pitchers.find((pitcher) => {
      const display = statDisplayName(pitcher["last_name, first_name"]);
      const displayNormalized = normalizeName(display);
      if (displayNormalized === target) return true;

      const pitcherTokens = new Set(nameTokens(display));
      return targetTokens.every((token) => pitcherTokens.has(token));
    }) || null
  );
}

function findBatterStat(name: string) {
  const stats = getCurrentStats();
  const target = normalizeName(name);
  const targetTokens = nameTokens(name);

  return (
    stats.batters.find((batter) => {
      const display = statDisplayName(batter["last_name, first_name"]);
      const displayNormalized = normalizeName(display);
      if (displayNormalized === target) return true;

      const batterTokens = new Set(nameTokens(display));
      return targetTokens.every((token) => batterTokens.has(token));
    }) || null
  );
}

function compactBatters(values: ReadonlyArray<BatterStat | null>) {
  return values.filter((value): value is BatterStat => value !== null);
}

function inferPlayerNameFromMessage(message: string) {
  const stats = getCurrentStats();
  const normalizedMessage = normalizeName(message);
  const allPlayers = [
    ...stats.pitchers.map((pitcher) => statDisplayName(pitcher["last_name, first_name"])),
    ...stats.batters.map((batter) => statDisplayName(batter["last_name, first_name"]))
  ];

  return allPlayers.find((name) => normalizedMessage.includes(normalizeName(name))) || null;
}

function normalizedMessage(message: string) {
  return normalizeName(message);
}

function messageHasAny(message: string, phrases: string[]) {
  const normalized = normalizedMessage(message);
  return phrases.some((phrase) => normalized.includes(normalizeName(phrase)));
}

function isSlateWideRequest(message: string) {
  return messageHasAny(message, [
    "today",
    "todays",
    "all",
    "slate",
    "games",
    "every game",
    "projected",
    "ranked",
    "best"
  ]);
}

function extractGameTeams(gameContext: string) {
  const match = gameContext.match(/GAME:\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})/i);
  if (!match) return null;
  return { away: match[1].toUpperCase(), home: match[2].toUpperCase() };
}

function collectNamedPlayersFromContext(gameContext: string, teamAbbreviation: string) {
  const line = gameContext
    .split("\n")
    .find((entry) => entry.toUpperCase().startsWith(`${teamAbbreviation} LINEUP:`));

  if (!line) return [];

  return line
    .split(":")
    .slice(1)
    .join(":")
    .split(", ")
    .map((entry) => entry.replace(/^\d+\.\s*/, ""))
    .map((entry) => entry.split(" (")[0]?.trim())
    .filter(Boolean);
}

function matchGameContext(gameContext: string): MatchedGameContext | null {
  const teams = extractGameTeams(gameContext);
  if (!teams) return null;

  const awayPitcherName = gameContext.match(/Away starter:\s*([^|]+)/i)?.[1]?.trim() || "";
  const homePitcherName = gameContext.match(/Home starter:\s*([^|]+)/i)?.[1]?.trim() || "";

  return {
    away: teams.away,
    home: teams.home,
    awayPitcher: awayPitcherName ? findPitcherStat(awayPitcherName) : null,
    homePitcher: homePitcherName ? findPitcherStat(homePitcherName) : null,
    awayBatters: compactBatters(collectNamedPlayersFromContext(gameContext, teams.away)
      .map((name) => findBatterStat(name))),
    homeBatters: compactBatters(collectNamedPlayersFromContext(gameContext, teams.home)
      .map((name) => findBatterStat(name)))
  };
}

function matchGameCard(card: GameCard): MatchedGameContext {
  return {
    away: card.away,
    home: card.home,
    awayPitcher: card.awayP?.name ? findPitcherStat(card.awayP.name) : null,
    homePitcher: card.homeP?.name ? findPitcherStat(card.homeP.name) : null,
    awayBatters: compactBatters((card.awayLineup || []).map((batter) => findBatterStat(batter.name))),
    homeBatters: compactBatters((card.homeLineup || []).map((batter) => findBatterStat(batter.name)))
  };
}

function rankPitcherForKs(pitcher: PitcherStat, lineup: BatterStat[]) {
  const lineupK = lineup.length ? average(lineup.map((batter) => batter.k_percent)) : 22;
  return pitcher.k_percent * 0.55
    + pitcher.whiff_percent * 0.35
    + pitcher.out_zone_swing_miss * 0.5
    + pitcher.swords * 0.8
    + Math.max(lineupK - 20, 0) * 0.45
    - pitcher.bb_percent * 0.35;
}

function rankPitcherForNrfi(pitcher: PitcherStat, topBats: BatterStat[]) {
  const topThreat = topBats.length
    ? average(topBats.map((batter) => batter.xwoba * 100 + batter.barrel_batted_rate + batter.hard_hit_percent * 0.25))
    : 38;

  return pitcher.k_percent * 0.55
    + pitcher.whiff_percent * 0.3
    + (35 - pitcher.bb_percent) * 0.35
    + (40 - pitcher.xwoba * 100) * 0.55
    + (18 - pitcher.barrel_batted_rate) * 0.45
    - topThreat * 0.3;
}

function fallbackBatterThreat(batter: BatterStat) {
  return 45
    + batter.xwoba * 30
    + batter.barrel_batted_rate * 0.45
    + batter.hard_hit_percent * 0.22
    + batter.exit_velocity_avg * 0.08
    - batter.k_percent * 0.2;
}

function firstInningPitcherScore(split: FirstInningPitcherSplit | null, pitcher: PitcherStat | null) {
  if (split) {
    return 55
      + (split.kPercent - 20) * 0.55
      + (split.whiffPercent - 24) * 0.25
      + (0.240 - split.xba) * 95
      + (0.240 - split.ba) * 80
      + (8 - split.barrelsPerPaPercent) * 0.65
      + (-split.pitcherRunValuePer100) * 2.2
      - split.hr * 2.1;
  }

  if (!pitcher) return 45;

  return 52
    + (pitcher.k_percent - 20) * 0.45
    + (pitcher.whiff_percent - 24) * 0.3
    + (0.280 - pitcher.xwoba) * 85
    + (10 - pitcher.barrel_batted_rate) * 0.5
    - pitcher.bb_percent * 0.3;
}

function firstInningBatterThreat(split: FirstInningBatterSplit | null, batter: BatterStat | null) {
  if (split) {
    return 42
      + split.xba * 70
      + split.ba * 45
      + split.hardHitPercent * 0.22
      + split.barrelsPerPaPercent * 0.6
      + split.ev * 0.08
      - split.kPercent * 0.16
      - split.whiffPercent * 0.08
      + split.hr * 1.4;
  }

  if (!batter) return 45;
  return fallbackBatterThreat(batter);
}

async function combinedNrfiScore(game: MatchedGameContext) {
  const pitcherSplits = await loadFirstInningPitcherSplits();
  const batterSplits = await loadFirstInningBatterSplits();

  function halfScore(pitcher: PitcherStat | null, offense: BatterStat[]) {
    const pitcherSplit = pitcher ? pitcherSplits.get(normalizeName(statDisplayName(pitcher["last_name, first_name"]))) || null : null;
    const topThree = offense.slice(0, 3);
    const offenseThreat = topThree.length
      ? average(topThree.map((batter) => {
          const split = batterSplits.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
          return firstInningBatterThreat(split, batter);
        }))
      : 45;

    return firstInningPitcherScore(pitcherSplit, pitcher) - (offenseThreat - 45) * 0.78;
  }

  const awayHalf = halfScore(game.homePitcher, game.awayBatters);
  const homeHalf = halfScore(game.awayPitcher, game.homeBatters);
  const combined = average([awayHalf, homeHalf]) - Math.abs(awayHalf - homeHalf) * 0.2;

  return {
    awayHalf,
    homeHalf,
    combined
  };
}

function rankOffense(lineup: BatterStat[]) {
  if (!lineup.length) return 0;
  return average(
    lineup.map((batter) =>
      batter.xwoba * 100
      + batter.hard_hit_percent * 0.4
      + batter.barrel_batted_rate * 0.8
      + batter.exit_velocity_avg * 0.15
      + batter.avg_swing_speed * 0.2
      - batter.k_percent * 0.2
    )
  );
}

function rankPitchingForWin(pitcher: PitcherStat | null) {
  if (!pitcher) return 50;
  const raw = 68
    + (0.300 - pitcher.xwoba) * 120
    + (10 - pitcher.barrel_batted_rate) * 0.7
    + (38 - pitcher.hard_hit_percent) * 0.22
    + (pitcher.k_percent - 22) * 0.32
    - Math.max(pitcher.bb_percent - 7, 0) * 0.65;
  return Math.max(35, Math.min(85, raw));
}

function trendRating(score: number) {
  return Math.max(30, Math.min(80, 50 + score * 2.2));
}

function winProbRating(batting: TeamWinProbStat | null, pitching: TeamWinProbStat | null) {
  const combined = ((batting?.score || 0) * 0.55) + ((pitching?.score || 0) * 0.45);
  return Math.max(35, Math.min(70, 50 + combined * 6));
}

function defenseRating(defense: TeamDefenseStat | null) {
  return Math.max(35, Math.min(70, 50 + (defense?.score || 0) * 4));
}

function parkRating(park: TeamParkFactorStat | null, offense: number, pitching: number) {
  if (!park) return 50;
  const profile = ((offense - 50) * 0.65) + ((50 - pitching) * 0.35);
  const score = 50 + (park.environment * profile * 2.4);
  return Math.max(40, Math.min(60, score));
}

function recommendation(score: number, strong = 65, medium = 55) {
  if (score >= strong) return "\uD83D\uDFE2";
  if (score >= medium) return "\uD83D\uDFE1";
  return "\uD83D\uDD34";
}

function confidenceTier(score: number) {
  if (score >= 72) return "high";
  if (score >= 62) return "good";
  if (score >= 56) return "medium";
  return "thin";
}

function winnerVerb(edge: number) {
  if (Math.abs(edge) >= 8) return "clearer";
  if (Math.abs(edge) >= 3) return "solid";
  return "slight";
}

async function winnerTrendScore(team: string, isHome: boolean) {
  const teamKey = resolveTeamKey(team);
  if (!teamKey) {
    return { score: 0, rawScore: 0, season: 0, last3: 0, last1: 0, last5: 0, split: 0, previousSeason: 0 };
  }

  const runDiffs = await loadTeamRunDifferentials();
  const lastFive = await loadLastFiveRunDifferentials();
  const row = runDiffs.get(teamKey);

  if (!row) {
    return { score: 0, rawScore: 0, season: 0, last3: 0, last1: 0, last5: lastFive.get(teamKey) || 0, split: 0, previousSeason: 0 };
  }

  const split = isHome ? row.home : row.away;
  const last5 = lastFive.get(teamKey) || 0;
  const rawScore = row.season * 0.14
    + row.last3 * 0.16
    + row.last1 * 0.08
    + last5 * 0.42
    + split * 0.16
    + row.previousSeason * 0.04;
  const score = Math.max(-12, Math.min(12, rawScore));

  return {
    score,
    rawScore,
    season: row.season,
    last3: row.last3,
    last1: row.last1,
    last5,
    split,
    previousSeason: row.previousSeason
  };
}

async function buildWinnerBreakdown(game: MatchedGameContext) {
  const awayTrend = await winnerTrendScore(game.away, false);
  const homeTrend = await winnerTrendScore(game.home, true);
  const defenses = await loadTeamDefenseStats();
  const battingWinProb = await loadTeamWinProbabilityStats("batting");
  const pitchingWinProb = await loadTeamWinProbabilityStats("pitching");
  const parkFactors = await loadTeamParkFactors();
  const awayDefense = defenses.get(resolveTeamKey(game.away) || "") || null;
  const homeDefense = defenses.get(resolveTeamKey(game.home) || "") || null;
  const awayBattingImpact = battingWinProb.get(resolveTeamKey(game.away) || "") || null;
  const homeBattingImpact = battingWinProb.get(resolveTeamKey(game.home) || "") || null;
  const awayPitchingImpact = pitchingWinProb.get(resolveTeamKey(game.away) || "") || null;
  const homePitchingImpact = pitchingWinProb.get(resolveTeamKey(game.home) || "") || null;
  const parkFactor = parkFactors.get(resolveTeamKey(game.home) || "") || null;
  const odds = await findOddsForGame(game.away, game.home);
  const awayImplied = impliedProbability(odds?.awayMoneyline ?? null);
  const homeImplied = impliedProbability(odds?.homeMoneyline ?? null);
  const marketLean = awayImplied === null || homeImplied === null ? null : (homeImplied >= awayImplied ? game.home : game.away);
  const awayOffense = rankOffense(game.awayBatters);
  const homeOffense = rankOffense(game.homeBatters);
  const awayPitching = rankPitchingForWin(game.awayPitcher);
  const homePitching = rankPitchingForWin(game.homePitcher);
  const awayTrendRating = trendRating(awayTrend.score);
  const homeTrendRating = trendRating(homeTrend.score);
  const awayWinProbRating = winProbRating(awayBattingImpact, awayPitchingImpact);
  const homeWinProbRating = winProbRating(homeBattingImpact, homePitchingImpact);
  const awayDefenseRating = defenseRating(awayDefense);
  const homeDefenseRating = defenseRating(homeDefense);
  const awayParkRating = parkRating(parkFactor, awayOffense, awayPitching);
  const homeParkRating = parkRating(parkFactor, homeOffense, homePitching);

  const awayScore = awayOffense * 0.39
    + awayPitching * 0.29
    + awayTrendRating * 0.15
    + awayWinProbRating * 0.10
    + awayDefenseRating * 0.05
    + awayParkRating * 0.02;
  const homeScore = homeOffense * 0.39
    + homePitching * 0.29
    + homeTrendRating * 0.15
    + homeWinProbRating * 0.10
    + homeDefenseRating * 0.05
    + homeParkRating * 0.02;
  const edge = homeScore - awayScore;

  return {
    awayOffense,
    homeOffense,
    awayPitching,
    homePitching,
    awayTrend,
    homeTrend,
    awayTrendRating,
    homeTrendRating,
    awayDefense,
    homeDefense,
    awayDefenseRating,
    homeDefenseRating,
    parkFactor,
    awayParkRating,
    homeParkRating,
    awayBattingImpact,
    homeBattingImpact,
    awayPitchingImpact,
    homePitchingImpact,
    awayWinProbRating,
    homeWinProbRating,
    awayScore,
    homeScore,
    edge,
    lean: edge >= 0 ? game.home : game.away,
    odds,
    marketLean,
    awayImplied,
    homeImplied
  };
}

function lineupCoverageRatio(teamAbbreviation: string, matchedBatters: BatterStat[]) {
  const expectedCount = 9;
  if (!teamAbbreviation) return matchedBatters.length / expectedCount;
  return Math.max(0, Math.min(1, matchedBatters.length / expectedCount));
}

async function buildWinnerFeatureSnapshot(game: MatchedGameContext, snapshotDate: string): Promise<WinnerFeatureSnapshot> {
  const breakdown = await buildWinnerBreakdown(game);
  const awayCoverage = lineupCoverageRatio(game.away, game.awayBatters);
  const homeCoverage = lineupCoverageRatio(game.home, game.homeBatters);
  const heuristicEdge = Math.abs(breakdown.edge);
  const heuristicConfidence = heuristicEdge * 8 + (breakdown.marketLean === breakdown.lean ? 4 : breakdown.marketLean ? -2 : 0);

  return {
    snapshotDate,
    gameId: buildWinnerGameId(snapshotDate, game.away, game.home),
    away: game.away,
    home: game.home,
    awayOffense: breakdown.awayOffense,
    homeOffense: breakdown.homeOffense,
    awayPitching: breakdown.awayPitching,
    homePitching: breakdown.homePitching,
    awayTrend: breakdown.awayTrendRating,
    homeTrend: breakdown.homeTrendRating,
    awayWinProb: breakdown.awayWinProbRating,
    homeWinProb: breakdown.homeWinProbRating,
    awayDefense: breakdown.awayDefenseRating,
    homeDefense: breakdown.homeDefenseRating,
    parkIndex: breakdown.parkFactor?.indexWoba ?? null,
    venueName: breakdown.parkFactor?.venueName ?? null,
    awayPark: breakdown.awayParkRating,
    homePark: breakdown.homeParkRating,
    awayMoneyline: breakdown.odds?.awayMoneyline ?? null,
    homeMoneyline: breakdown.odds?.homeMoneyline ?? null,
    total: breakdown.odds?.total ?? null,
    lineupCoverageAway: awayCoverage,
    lineupCoverageHome: homeCoverage,
    heuristicPick: breakdown.lean,
    heuristicEdge,
    heuristicConfidence,
    marketLean: breakdown.marketLean
  };
}

async function snapshotWinnerFeaturesForGames(games: MatchedGameContext[], snapshotDate: string) {
  const snapshots = await Promise.all(games.map((game) => buildWinnerFeatureSnapshot(game, snapshotDate)));
  return upsertWinnerFeatureSnapshots(snapshots);
}

function averageOrNull(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function refreshRegressionArtifacts() {
  const featureRows = readWinnerFeatureSnapshots();
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 60);
  const fetchedResultRows = await fetchWinnerResults(startDate.toISOString().slice(0, 10), endDate);
  const storedResultRows = upsertWinnerResults(fetchedResultRows);

  const featuresByGameId = new Map(featureRows.map((row) => [row.gameId, row]));
  const joined = storedResultRows
    .map((result) => {
      const feature = featuresByGameId.get(result.gameId);
      return feature ? { ...feature, ...result } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const trainingRows = buildRegressionTrainingRows(joined);
  const candidate = trainLogisticRegression(trainingRows);
  const heuristicMetrics = evaluateHeuristicBaseline(trainingRows);
  const production = readProductionRegressionModel();
  const productionMetrics = production ? evaluateRegressionModel(production, trainingRows) : null;
  const candidateMetrics = candidate ? evaluateRegressionModel(candidate, trainingRows) : null;
  const parkRows = featureRows.filter((row) => row.parkIndex !== null);
  const parkCoverage = {
    populatedRows: parkRows.length,
    coverageRate: featureRows.length ? parkRows.length / featureRows.length : 0,
    averageParkIndex: averageOrNull(parkRows.map((row) => row.parkIndex as number)),
    averageAwayParkRating: averageOrNull(featureRows.map((row) => row.awayPark)),
    averageHomeParkRating: averageOrNull(featureRows.map((row) => row.homePark))
  };
  let promotedCandidate = false;
  const notes: string[] = [];

  if (candidate) {
    writeCandidateRegressionModel(candidate);
    const beatsProduction = !productionMetrics || !candidateMetrics
      ? false
      : candidateMetrics.logLoss < productionMetrics.logLoss
        && candidateMetrics.brierScore <= productionMetrics.brierScore
        && candidateMetrics.accuracy >= productionMetrics.accuracy - 0.01;

    const beatsHeuristic = !heuristicMetrics || !candidateMetrics
      ? false
      : candidateMetrics.logLoss < heuristicMetrics.logLoss
        && candidateMetrics.brierScore <= heuristicMetrics.brierScore;

    if ((!production && candidateMetrics && candidateMetrics.sampleSize >= 30) || (beatsProduction && beatsHeuristic && candidateMetrics && candidateMetrics.sampleSize >= 30)) {
      writeProductionRegressionModel(candidate);
      promotedCandidate = true;
      notes.push("Candidate regression promoted to production.");
    } else {
      notes.push("Candidate regression stored but not promoted.");
    }
    } else {
      notes.push(`Regression needs at least ${MIN_REGRESSION_SAMPLE} completed games with matching pregame feature snapshots before training can begin.`);
    }

  if (trainingRows.length < MIN_REGRESSION_SAMPLE) {
    notes.push(`Currently stored: ${featureRows.length} pregame snapshots, ${storedResultRows.length} final results, ${trainingRows.length} joined training rows.`);
  }

  const report: RegressionReport = {
    generatedAt: new Date().toISOString(),
    trainingRows: trainingRows.length,
    resultRows: storedResultRows.length,
    featureRows: featureRows.length,
    parkFactorCoverage: parkCoverage,
    heuristicMetrics,
    productionMetrics,
    candidateMetrics,
    promotedCandidate,
    notes
  };

  writeRegressionReport(report);
  return report;
}

async function runMorningRefresh(reason: "startup" | "scheduled") {
  const startedAt = new Date().toISOString();
  try {
    await refreshExpectedStatsCsvs();
    await Promise.allSettled([
      loadSchedule(),
      loadTeamRunDifferentials(),
      loadLastFiveRunDifferentials(),
      loadTeamDefenseStats(),
      loadTeamWinProbabilityStats("batting"),
      loadTeamWinProbabilityStats("pitching"),
      loadTeamParkFactors(),
      loadGameOdds()
    ]);

    try {
      const payload = await loadDailyLineups();
      const snapshotDate = new Date().toISOString().slice(0, 10);
      const matchedGames = payload.games.map((game) => matchGameCard(game));
      await snapshotWinnerFeaturesForGames(matchedGames, snapshotDate);
    } catch (error) {
      console.warn(`Morning refresh lineup snapshot skipped (${reason}):`, getErrorMessage(error));
    }

    await refreshRegressionArtifacts();
    lastMorningRefreshAt = startedAt;
    lastMorningRefreshStatus = "ok";
    lastMorningRefreshError = null;
  } catch (error) {
    lastMorningRefreshAt = startedAt;
    lastMorningRefreshStatus = "error";
    lastMorningRefreshError = getErrorMessage(error);
    console.warn(`Morning refresh failed (${reason}):`, lastMorningRefreshError);
  }
}

function scheduleMorningRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(MORNING_REFRESH_HOUR, MORNING_REFRESH_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  nextMorningRefreshAt = next.toISOString();
  const delay = Math.max(1000, next.getTime() - now.getTime());
  setTimeout(async () => {
    await runMorningRefresh("scheduled");
    scheduleMorningRefresh();
  }, delay);
}

async function chooseBestGeneralBet(game: MatchedGameContext) {
  const nrfi = await combinedNrfiScore(game);
  const winnerBreakdown = await buildWinnerBreakdown(game);
  const winnerEdge = Math.abs(winnerBreakdown.edge);
  const total = winnerBreakdown.odds?.total ?? null;
  const nrfiConfidence = nrfi.combined + (total !== null ? (total <= 7.5 ? 3 : total >= 9 ? -3 : 0) : 0);
  const yrfiConfidence = (70 - nrfi.combined) + (total !== null ? (total >= 9 ? 3 : total <= 7.5 ? -3 : 0) : 0);
  const winnerConfidence = winnerEdge * 8 + (winnerBreakdown.marketLean === winnerBreakdown.lean ? 4 : winnerBreakdown.marketLean ? -2 : 0);

  if (nrfiConfidence >= 58) {
    return {
      type: "NRFI",
      tag: recommendation(nrfiConfidence, 62, 54),
      score: nrfi.combined,
      confidence: nrfiConfidence,
      reason: total !== null
        ? `Both halves of the first inning project clean enough, and the market total at **${formatNumber(total, 1)}** supports the lower-run environment.`
        : "Both halves of the first inning project clean enough, so the full-inning NRFI angle beats the side."
    };
  }

  if (winnerEdge >= 2) {
    return {
      type: "Winner",
      tag: recommendation(winnerConfidence, 24, 12),
      score: winnerEdge,
      confidence: winnerConfidence,
      reason: winnerBreakdown.marketLean
        ? `The lineup-vs-starter gap is giving the strongest edge on the side, and the ${winnerBreakdown.odds?.bookmaker || "market"} ${winnerBreakdown.marketLean === winnerBreakdown.lean ? "largely agrees" : "is the main point of disagreement to beat"}.`
        : "The lineup-vs-starter gap is giving the strongest edge on the side rather than the inning total."
    };
  }

  return {
    type: "YRFI",
    tag: recommendation(yrfiConfidence, 62, 54),
    score: 70 - nrfi.combined,
    confidence: yrfiConfidence,
    reason: total !== null
      ? `At least one half-inning looks too fragile, and the market total at **${formatNumber(total, 1)}** supports a livelier scoring environment.`
      : "At least one half-inning looks too fragile, so YRFI is the stronger forced first-inning recommendation."
  };
}

function analyzePitcherStrikeouts(pitcher: PitcherStat, lineup: BatterStat[]) {
  const lineupK = lineup.length ? average(lineup.map((batter) => batter.k_percent)) : null;
  const score = rankPitcherForKs(pitcher, lineup);
  const pick = score >= 60 ? "Over" : "Under";

  return [
    `**${statDisplayName(pitcher["last_name, first_name"])} strikeout outlook**`,
    `${sampleTag(pitcher.pa)} K% **${formatNumber(pitcher.k_percent)}**, whiff **${formatNumber(pitcher.whiff_percent)}%**, chase-miss **${formatNumber(pitcher.out_zone_swing_miss, 0)}**, swords **${formatNumber(pitcher.swords, 0)}**.`,
    `The swing-and-miss profile is ${pitcher.k_percent >= 28 || pitcher.whiff_percent >= 30 ? "strong" : "more contact-prone"}, while BB% at **${formatNumber(pitcher.bb_percent)}** ${pitcher.bb_percent > 10 ? "adds pitch-count risk." : "keeps the outing on track."} Savant-style support here is the whiff/chase side plus the strikeout-quality inputs like swords.`,
    lineupK !== null
      ? `Matched lineup K% is **${formatNumber(lineupK)}%**, so the opponent ${lineupK >= 24 ? "does give him extra upside." : "is not an especially soft strikeout target."}`
      : "No confirmed lineup match was available, so this leans more on the pitcher skill set than opponent tendencies.",
    `${recommendation(score)} Recommendation: **${pick}** the strikeout prop. ${pick === "Over" ? "The bat-missing skill set is strong enough to back the aggressive side." : "The risk around pitch count and weaker opponent strikeout support makes the conservative side better."}`
  ].join("\n\n");
}

function analyzePitcherNrfi(pitcher: PitcherStat, offense: BatterStat[], teamLabel: string) {
  const topBats = offense.slice(0, 3);
  const threat = topBats.length ? average(topBats.map((batter) => batter.xwoba)) : null;
  const score = rankPitcherForNrfi(pitcher, topBats);
  const pick = score >= 58 ? "NRFI" : "YRFI";

  return [
    `**${statDisplayName(pitcher["last_name, first_name"])} NRFI/YRFI read vs ${teamLabel}**`,
    `${sampleTag(pitcher.pa)} K% **${formatNumber(pitcher.k_percent)}**, BB% **${formatNumber(pitcher.bb_percent)}**, xwOBA allowed **${formatNumber(pitcher.xwoba, 3)}**, barrel allowed **${formatNumber(pitcher.barrel_batted_rate)}%**, hard-hit allowed **${formatNumber(pitcher.hard_hit_percent)}%**.`,
    `${pitcher.xwoba <= 0.27 || pitcher.barrel_batted_rate <= 6 ? "Expected-stat support is strong here: he is limiting the quality of contact that usually fuels YRFI damage." : "Expected-stat support is shakier here, so clean-contact risk stays on the board."}`,
    threat !== null
      ? `Matched top-of-order xwOBA is **${formatNumber(threat, 3)}**${threat >= 0.4 ? ", so there is real YRFI punishment risk if he misses early." : ", which keeps the first-inning damage profile fairly tame."}`
      : "No top-of-order match was found, so this is based mostly on the pitcher quality profile.",
    `${pitcher.bb_percent <= 5 ? "The low walk rate is a real NRFI asset." : "Walks are the biggest threat to a clean first inning."} ${pitcher.k_percent >= 24 ? "He has enough bat-missing to erase mistakes." : "He is more sequencing-dependent than overpowering."}`,
    `${recommendation(score, 62, 52)} Recommendation: **${pick}**. ${pick === "NRFI" ? "The prevention profile is good enough to back a scoreless first." : "The early-traffic risk is high enough that a first-inning run is the better pick."}`
  ].join("\n\n");
}

async function analyzeFullInningNrfi(game: MatchedGameContext) {
  const nrfi = await combinedNrfiScore(game);
  const pick = nrfi.combined >= 58 ? "NRFI" : "YRFI";

  return [
    `**${game.away} @ ${game.home} NRFI/YRFI outlook**`,
    `${game.away} first-inning scoring threat vs ${game.homePitcher ? statDisplayName(game.homePitcher["last_name, first_name"]) : game.home + " starter"}: **${formatNumber(nrfi.awayHalf)}**.`,
    `${game.home} first-inning scoring threat vs ${game.awayPitcher ? statDisplayName(game.awayPitcher["last_name, first_name"]) : game.away + " starter"}: **${formatNumber(nrfi.homeHalf)}**.`,
    "NRFI requires both the top half and the bottom half to stay scoreless, so this recommendation is combining both sides of the inning instead of grading only one pitcher.",
    `${nrfi.awayHalf >= 58 && nrfi.homeHalf >= 58 ? "Both halves clear the bar for a cleaner first inning." : "One side of the inning is introducing enough run risk to weaken the full NRFI case."}`,
    `${recommendation(nrfi.combined, 62, 54)} Recommendation: **${pick}**. ${pick === "NRFI" ? "Both halves are strong enough to back a scoreless full first inning." : "The full first inning is too vulnerable, so YRFI is the better side."}`
  ].join("\n\n");
}

async function analyzeWinner(game: MatchedGameContext) {
  const breakdown = await buildWinnerBreakdown(game);
  const edge = breakdown.edge;
  const lean = breakdown.lean;
  const tag = recommendation(Math.abs(edge) * 6, 24, 12);
  const oddsLine = breakdown.odds
    ? `${breakdown.odds.bookmaker} odds: away **${breakdown.odds.awayMoneyline ?? "n/a"}**, home **${breakdown.odds.homeMoneyline ?? "n/a"}**${breakdown.odds.total !== null ? `, total **${formatNumber(breakdown.odds.total, 1)}**` : ""}.`
    : "No live odds snapshot was available, so this is purely model-driven.";

    return [
      `**${game.away} @ ${game.home} winner outlook**`,
      `${game.away} weighted rating: **${formatNumber(breakdown.awayScore)}**. Offense **${formatNumber(breakdown.awayOffense)}** (39%), pitching **${formatNumber(breakdown.awayPitching)}** (29%), trend **${formatNumber(breakdown.awayTrendRating)}** (15%, last 5 **${formatNumber(breakdown.awayTrend.last5)}**), win-prob **${formatNumber(breakdown.awayWinProbRating)}** (10%), defense **${formatNumber(breakdown.awayDefenseRating)}** (5%), park **${formatNumber(breakdown.awayParkRating)}** (2%).`,
      `${game.home} weighted rating: **${formatNumber(breakdown.homeScore)}**. Offense **${formatNumber(breakdown.homeOffense)}** (39%), pitching **${formatNumber(breakdown.homePitching)}** (29%), trend **${formatNumber(breakdown.homeTrendRating)}** (15%, last 5 **${formatNumber(breakdown.homeTrend.last5)}**), win-prob **${formatNumber(breakdown.homeWinProbRating)}** (10%), defense **${formatNumber(breakdown.homeDefenseRating)}** (5%), park **${formatNumber(breakdown.homeParkRating)}** (2%).`,
      `Park context: **${breakdown.parkFactor?.venueName || game.home}** wOBA index **${formatNumber(breakdown.parkFactor?.indexWoba || 100, 0)}**, runs index **${formatNumber(breakdown.parkFactor?.indexRuns || 100, 0)}**. Hitter-friendlier parks slightly help the better offense; suppressive parks slightly help the better run-prevention profile.`,
      `${game.away} defense details: **${formatNumber(breakdown.awayDefense?.score || 0)}**${breakdown.awayDefense ? ` (Fld% **${formatNumber(breakdown.awayDefense.fieldingPct, 3)}**, errors **${formatNumber(breakdown.awayDefense.errors, 0)}**)` : ""}. ${game.home} defense details: **${formatNumber(breakdown.homeDefense?.score || 0)}**${breakdown.homeDefense ? ` (Fld% **${formatNumber(breakdown.homeDefense.fieldingPct, 3)}**, errors **${formatNumber(breakdown.homeDefense.errors, 0)}**)` : ""}.`,
      `${game.away} win-prob details: batting **${formatNumber(breakdown.awayBattingImpact?.score || 0)}** / pitching **${formatNumber(breakdown.awayPitchingImpact?.score || 0)}**. ${game.home} win-prob details: batting **${formatNumber(breakdown.homeBattingImpact?.score || 0)}** / pitching **${formatNumber(breakdown.homePitchingImpact?.score || 0)}**.`,
      oddsLine,
      "This winner model now uses the explicit mix you set, with park factor folded in lightly: offense 39%, pitching 29%, trend 15%, win-probability layer 10%, defense 5%, park 2%. Odds stay as context rather than part of the weighted core.",
    `${game.awayBatters.length && game.homeBatters.length ? "This read is using matched lineup bats from the selected game context." : "Lineup coverage is partial, so treat this as a softer lean."}`,
    `${tag} Recommendation: **${lean}** moneyline. It is the ${winnerVerb(edge)} side based on run-prevention and contact-quality setup${breakdown.marketLean ? `, while the market ${breakdown.marketLean === lean ? "is broadly aligned" : "leans the other way"}` : ""}.`
  ].join("\n\n");
}

function analyzeBatter(batter: BatterStat, betType: BetType) {
  const power = batter.xwoba * 100 + batter.barrel_batted_rate + batter.hard_hit_percent * 0.25;
  const contact = 100 - batter.k_percent - batter.whiff_percent * 0.35;
  const tag = recommendation(power + contact * 0.2, 52, 44);
  const angle = betType === "nrfi"
    ? "For NRFI/YRFI, he matters most if he is near the top of the order because he can turn one early mistake into traffic or extra bases."
    : betType === "winner"
      ? "For winner markets, he helps more as a lineup-quality input than as a single-player edge."
      : "He profiles as a usable supporting piece in matchup analysis.";

  return [
    `**${statDisplayName(batter["last_name, first_name"])} outlook**`,
    `${sampleTag(batter.pa)} xwOBA **${formatNumber(batter.xwoba, 3)}**, xSLG **${formatNumber(batter.xslg, 3)}**, hard-hit **${formatNumber(batter.hard_hit_percent)}%**, barrel **${formatNumber(batter.barrel_batted_rate)}%**, EV **${formatNumber(batter.exit_velocity_avg)} mph**, bat speed **${formatNumber(batter.avg_swing_speed)} mph**, K% **${formatNumber(batter.k_percent)}**.`,
    `${batter.xwoba >= 0.38 || batter.barrel_batted_rate >= 15 ? "The quality-of-contact profile is carrying real upside." : "The quality-of-contact profile is more ordinary than explosive."} ${batter.k_percent >= 30 ? "The swing-and-miss risk is elevated." : "The strikeout risk is manageable."}`,
    angle,
    `${tag} Recommendation: **${power + contact * 0.2 >= 52 ? "Back the player" : "Fade the player"}** in prop-style decisions. ${power + contact * 0.2 >= 52 ? "The expected-stat and top-performer signals are good enough to trust the upside." : "The underlying contact mix is not strong enough to support a bullish bet."}`
  ].join("\n\n");
}

function topPitcherList(mode: "strikeouts" | "nrfi") {
  const stats = getCurrentStats();
  const ranked = stats.pitchers
    .map((pitcher) => ({
      pitcher,
      score: mode === "strikeouts" ? rankPitcherForKs(pitcher, []) : rankPitcherForNrfi(pitcher, [])
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return [
    `**Best local ${mode === "strikeouts" ? "strikeout" : "NRFI"} profiles in the dataset**`,
    ...ranked.map(({ pitcher, score }, index) =>
      `${index + 1}. **${statDisplayName(pitcher["last_name, first_name"])}**: K% ${formatNumber(pitcher.k_percent)}, whiff ${formatNumber(pitcher.whiff_percent)}%, BB% ${formatNumber(pitcher.bb_percent)}, xwOBA allowed ${formatNumber(pitcher.xwoba, 3)}. Score ${formatNumber(score)}.`
    ),
    `${recommendation(ranked[0]?.score || 0)} Recommendation: **${statDisplayName(ranked[0].pitcher["last_name, first_name"])}** is the strongest dataset-backed arm to build around first.`
  ].join("\n\n");
}

async function topNrfiGamesFromSlate() {
  try {
    const payload = await loadDailyLineups();
    const ranked = (await Promise.all(payload.games.map(async (game) => {
        const matched = matchGameCard(game);
        const nrfi = await combinedNrfiScore(matched);
        return {
          game,
          matched,
          nrfi
        };
      })))
      .filter(({ matched }) => matched.awayPitcher || matched.homePitcher || matched.awayBatters.length || matched.homeBatters.length)
      .sort((a, b) => b.nrfi.combined - a.nrfi.combined)
      .slice(0, 5);

    if (!ranked.length) {
      return [
        "**Best NRFI/YRFI games today**",
        "Live lineup matching is too thin right now to rank today's games confidently from the current slate.",
        "\uD83D\uDFE1 Recommendation: **Select a game first** so I can grade the full first inning from both sides."
      ].join("\n\n");
    }

    return [
      "**Best NRFI/YRFI games today**",
      ...ranked.map(({ matched, nrfi }, index) => {
        const pick = nrfi.combined >= 58 ? "NRFI" : "YRFI";
        return `${index + 1}. **${matched.away} @ ${matched.home}**: top half **${formatNumber(nrfi.awayHalf)}**, bottom half **${formatNumber(nrfi.homeHalf)}**, combined **${formatNumber(nrfi.combined)}**. Recommendation: **${pick}**.`;
      }),
      `${recommendation(ranked[0].nrfi.combined, 62, 54)} Recommendation: **${ranked[0].nrfi.combined >= 58 ? "NRFI" : "YRFI"} on ${ranked[0].matched.away} @ ${ranked[0].matched.home}** is the strongest full first-inning angle from the live slate.`
    ].join("\n\n");
  } catch (error) {
    return [
      "**Best NRFI/YRFI games today**",
      `I could not load the live slate just now: ${getErrorMessage(error)}.`,
      "\uD83D\uDFE1 Recommendation: **Select a game first** and I will grade the full first inning from both halves."
    ].join("\n\n");
  }
}

async function topWinnerGamesFromSlate() {
  try {
    const payload = await loadDailyLineups();
    const ranked = (await Promise.all(payload.games.map(async (game) => {
        const matched = matchGameCard(game);
        const breakdown = await buildWinnerBreakdown(matched);

        return {
          matched,
          pick: breakdown.lean,
          confidence: Math.abs(breakdown.edge)
        };
      })))
      .filter(({ matched }) => matched.awayPitcher || matched.homePitcher || matched.awayBatters.length || matched.homeBatters.length)
      .sort((a, b) => b.confidence - a.confidence);

    if (!ranked.length) {
      return [
        "**Projected winners today**",
        "Live lineup matching is too thin right now to rank today's winners from the current slate.",
        "\uD83D\uDFE1 Recommendation: **Load or select a game** so I can project a winner from the matchup data."
      ].join("\n\n");
    }

    return [
      "**Projected winners today**",
      ...ranked.map(({ matched, pick, confidence }, index) =>
        `${index + 1}. **${matched.away} @ ${matched.home}** -> **${pick}** moneyline. Confidence score **${formatNumber(confidence)}**.`
      ),
      `${recommendation(ranked[0].confidence * 6, 24, 12)} Strongest winner lean on the current slate: **${ranked[0].pick}** in **${ranked[0].matched.away} @ ${ranked[0].matched.home}**.`
    ].join("\n\n");
  } catch (error) {
    return [
      "**Projected winners today**",
      `I could not load the live slate just now: ${getErrorMessage(error)}.`,
      "\uD83D\uDFE1 Recommendation: **Select a game first** and I will project the winner from the local matchup data."
    ].join("\n\n");
  }
}

async function topBestBetsFromSlate() {
  try {
    const payload = await loadDailyLineups();
    const ranked = (await Promise.all(payload.games.map(async (game) => {
        const matched = matchGameCard(game);
        const bestBet = await chooseBestGeneralBet(matched);
        const winnerBreakdown = await buildWinnerBreakdown(matched);

        return {
          matched,
          bestBet,
          winnerPick: winnerBreakdown.lean
        };
      })))
      .filter(({ matched }) => matched.awayPitcher || matched.homePitcher || matched.awayBatters.length || matched.homeBatters.length)
      .sort((a, b) => b.bestBet.confidence - a.bestBet.confidence);

    if (!ranked.length) {
      return [
        "**Best bets today**",
        "Live lineup matching is too thin right now to rank today's strongest plays from the slate.",
        "\uD83D\uDFE1 Recommendation: **Load or select a game** so I can force the best available angle."
      ].join("\n\n");
    }

    let selected = ranked.filter(({ bestBet }) => bestBet.confidence >= 66).slice(0, 8);
    if (!selected.length) {
      selected = ranked.filter(({ bestBet }) => bestBet.confidence >= 60).slice(0, 5);
    }
    if (!selected.length) {
      selected = ranked.slice(0, 1);
    }

    return [
      "**Best bets today**",
      `Returning **${selected.length}** slate play${selected.length === 1 ? "" : "s"} based on the model's strongest confidence tiers.`,
      ...selected.map(({ matched, bestBet, winnerPick }, index) => {
        const market = bestBet.type === "Winner" ? `${winnerPick} moneyline` : bestBet.type;
        return `${index + 1}. **${matched.away} @ ${matched.home}** -> **${market}**. Confidence **${formatNumber(bestBet.confidence)}** (${confidenceTier(bestBet.confidence)}). ${bestBet.reason}`;
      }),
      `${selected[0].bestBet.tag} Strongest overall slate angle: **${selected[0].bestBet.type === "Winner" ? selected[0].winnerPick + " moneyline" : selected[0].bestBet.type}** in **${selected[0].matched.away} @ ${selected[0].matched.home}**.`
    ].join("\n\n");
  } catch (error) {
    return [
      "**Best bets today**",
      `I could not load the live slate just now: ${getErrorMessage(error)}.`,
      "\uD83D\uDFE1 Recommendation: **Select a game first** and I will force the strongest angle from the available data."
    ].join("\n\n");
  }
}

async function analyzeLocally({
  message,
  betType,
  gameContext
}: {
  message: string;
  betType: BetType;
  gameContext?: string;
}) {
  const normalized = normalizedMessage(message);
  const matchedGame = gameContext ? matchGameContext(gameContext) : null;
  const inferredName = inferPlayerNameFromMessage(message);
  const pitcher = inferredName ? findPitcherStat(inferredName) : null;
  const batter = inferredName && !pitcher ? findBatterStat(inferredName) : null;

  const wantsWinner = /winner|winners|moneyline|who wins|who win|win today|wins today|projected winner|projected winners/.test(normalized);
  const wantsNrfi = /nrfi|yrfi|first inning|no run first inning|run first inning/.test(normalized);
  const wantsStrikeouts = /strikeout|strikeouts|ks|k prop|pitcher k/.test(normalized);
  const wantsBestBets = /best bet|best bets|top bet|top bets|best play|best plays|favorite bets|strongest bets|todays bets|today s bets/.test(normalized);
  const wantsSlate = isSlateWideRequest(message);

  if (pitcher && betType === "strikeouts") {
    const opponentLineup = matchedGame
      ? matchedGame.awayPitcher?.player_id === pitcher.player_id
        ? matchedGame.homeBatters
        : matchedGame.homePitcher?.player_id === pitcher.player_id
          ? matchedGame.awayBatters
          : []
      : [];
    return analyzePitcherStrikeouts(pitcher, opponentLineup);
  }

  if (pitcher && betType === "nrfi") {
    if (matchedGame && (
      matchedGame.awayPitcher?.player_id === pitcher.player_id
      || matchedGame.homePitcher?.player_id === pitcher.player_id
    )) {
      return await analyzeFullInningNrfi(matchedGame);
    }
    return await topNrfiGamesFromSlate();
  }

  if (wantsBestBets && wantsSlate && !matchedGame && !pitcher && !batter) {
    return await topBestBetsFromSlate();
  }

  if (wantsWinner && wantsSlate && !matchedGame && !pitcher && !batter) {
    return await topWinnerGamesFromSlate();
  }

  if (wantsNrfi && wantsSlate && !matchedGame && !pitcher && !batter) {
    return await topNrfiGamesFromSlate();
  }

  if (wantsStrikeouts && wantsSlate && !pitcher && !batter) {
    return topPitcherList("strikeouts");
  }

  if (betType === "winner" && matchedGame) {
    return await analyzeWinner(matchedGame);
  }

  if (pitcher) {
    return pitcher.k_percent >= 26
      ? analyzePitcherStrikeouts(pitcher, [])
      : analyzePitcherNrfi(pitcher, [], "the opposing lineup");
  }

  if (batter) {
    return analyzeBatter(batter, betType);
  }

  if (/best .*k|best pitchers|strikeout upside|k pitchers/i.test(message) || (wantsStrikeouts && wantsSlate)) {
    return topPitcherList("strikeouts");
  }

  if (wantsNrfi) {
    if (matchedGame) {
      return await analyzeFullInningNrfi(matchedGame);
    }
    return await topNrfiGamesFromSlate();
  }

  if (matchedGame && (wantsWinner || /win\/loss/.test(normalized))) {
    return await analyzeWinner(matchedGame);
  }

  if (wantsWinner) {
    return await topWinnerGamesFromSlate();
  }

  if (wantsBestBets) {
    if (matchedGame) {
      const bestBet = await chooseBestGeneralBet(matchedGame);
      return [
        `**Best bet for ${matchedGame.away} @ ${matchedGame.home}**`,
        `${bestBet.reason}`,
        `${matchedGame.awayPitcher || matchedGame.homePitcher ? "This is using the selected game's local Statcast matchup context." : "This is using lineup-quality context even though pitcher coverage is incomplete."}`,
        `${bestBet.tag} Recommendation: **${bestBet.type}**. It is the strongest forced angle from the available data.`
      ].join("\n\n");
    }
    return await topBestBetsFromSlate();
  }

  if (matchedGame) {
    const bestBet = await chooseBestGeneralBet(matchedGame);
    return [
      `**Best bet for ${matchedGame.away} @ ${matchedGame.home}**`,
      `${bestBet.reason}`,
      `${matchedGame.awayPitcher || matchedGame.homePitcher ? "This is using the selected game's local Statcast matchup context." : "This is using lineup-quality context even though pitcher coverage is incomplete."}`,
      `${bestBet.tag} Recommendation: **${bestBet.type}**. It is the strongest forced angle from the available data.`
    ].join("\n\n");
  }

  return [
    "**Local analysis mode**",
    "This app is now answering from the built-in Statcast-style dataset plus any selected matchup context, not from a paid model API.",
    "I can analyze individual pitchers, hitters, NRFI/YRFI spots, strikeout props, and winner leans. Select a game to improve matchup-specific answers.",
    "Good prompts: `Analyze Hunter Brown strikeout prop`, `NRFI on Sandy Alcantara`, `Who has the best K upside today?`, or `Who wins this game?`",
    "\uD83D\uDFE1 Recommendation: **Ask for the best K pitcher today** to start from the strongest current dataset-backed angle."
  ].join("\n\n");
}

app.get("/api/health", (_req, res) => {
  const stats = getCurrentStats();
  const regressionReport = readRegressionReport();
  const productionModel = readProductionRegressionModel();
  const candidateModel = readCandidateRegressionModel();
  const storage = getStorageStatus();
  res.json({
    ok: true,
    anthropicConfigured: true,
    analysisMode: "local",
    analysisVersion: ANALYSIS_VERSION,
    publicSourceCount: 10,
    oddsSourceConfigured: Boolean(cleanText(process.env.ODDS_API_KEY || "")),
    oddsBookmaker: ODDS_BOOKMAKER,
    statCounts: {
      batters: stats.batters.length,
      pitchers: stats.pitchers.length
    },
    statCoverage: stats.coverage,
    csvSources: stats.sourceFiles,
    regression: {
      productionModel: Boolean(productionModel),
      candidateModel: Boolean(candidateModel),
      lastReportAt: regressionReport?.generatedAt || null,
      trainingRows: regressionReport?.trainingRows || 0,
      promotedCandidate: regressionReport?.promotedCandidate || false,
      parkFactorCoverage: regressionReport?.parkFactorCoverage || null
    },
    storage,
    refresh: {
      morningRefreshHourLocal: `${String(MORNING_REFRESH_HOUR).padStart(2, "0")}:${String(MORNING_REFRESH_MINUTE).padStart(2, "0")}`,
      nextMorningRefreshAt,
      lastMorningRefreshAt,
      lastMorningRefreshStatus,
      lastMorningRefreshError
    },
    checkedAt: new Date().toISOString()
  });
});

app.get("/api/sources", async (_req, res) => {
  try {
    const sources = await scrapePublicSources();
    res.json({ ok: true, sources });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.get("/api/odds", async (_req, res) => {
  try {
    const odds = await loadGameOdds();
    res.json({
      ok: true,
      bookmaker: ODDS_BOOKMAKER,
      configured: Boolean(cleanText(process.env.ODDS_API_KEY || "")),
      games: odds
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.get("/api/lineups", async (_req, res) => {
  try {
    const payload = await loadDailyLineups();
    const snapshotDate = new Date().toISOString().slice(0, 10);
    const matchedGames = payload.games.map((game) => matchGameCard(game));
    try {
      await snapshotWinnerFeaturesForGames(matchedGames, snapshotDate);
    } catch (error) {
      console.warn("Winner feature snapshot skipped:", getErrorMessage(error));
    }
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.get("/api/schedule", async (_req, res) => {
  try {
    const payload = await loadSchedule();
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.post("/api/regression/refresh", async (_req, res) => {
  try {
    const report = await refreshRegressionArtifacts();
    res.json({ ok: true, report });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.get("/api/regression/report", (_req, res) => {
  const report = readRegressionReport();
  const productionModel = readProductionRegressionModel();
  const candidateModel = readCandidateRegressionModel();
  const storage = getStorageStatus();
  res.json({
    ok: true,
    report,
    productionModel,
    candidateModel,
    featureRows: readWinnerFeatureSnapshots().length,
    resultRows: readWinnerResults().length,
    storage,
    refresh: {
      morningRefreshHourLocal: `${String(MORNING_REFRESH_HOUR).padStart(2, "0")}:${String(MORNING_REFRESH_MINUTE).padStart(2, "0")}`,
      nextMorningRefreshAt,
      lastMorningRefreshAt,
      lastMorningRefreshStatus,
      lastMorningRefreshError
    }
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, betType = "general", gameContext = "" } = req.body as {
      message?: string;
      betType?: string;
      gameContext?: string;
    };

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    const reply = await analyzeLocally({
      message,
      betType: (["general", "nrfi", "strikeouts", "winner"].includes(betType) ? betType : "general") as BetType,
      gameContext
    });

    res.json({ ok: true, reply, mode: "local" });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/stats", (_req, res) => {
  const stats = getCurrentStats();
  res.json({ ok: true, ...stats });
});

app.get("/", (_req, res) => {
  res.type("html").send(renderPage(getCurrentStats()));
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  runMorningRefresh("startup").catch((error) => {
    lastMorningRefreshStatus = "error";
    lastMorningRefreshError = getErrorMessage(error);
    console.warn("Startup refresh failed:", lastMorningRefreshError);
  });
  scheduleMorningRefresh();
});
