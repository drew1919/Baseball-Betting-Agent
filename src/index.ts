import express from "express";
import dotenv from "dotenv";
import * as cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs/promises";
import { renderPage } from "./page.js";
import { STATS, type BatterStat, type PitcherStat } from "./stats.js";
import { getAugmentedStats, getExpectedStatsCsvPaths, getExpectedStatsCsvWritePaths } from "./augmented-stats.js";
import { upsertWinnerFeatureSnapshots, upsertWinnerResults, readWinnerFeatureSnapshots, readWinnerResults, readProductionRegressionModel, readCandidateRegressionModel, writeCandidateRegressionModel, writeProductionRegressionModel, readProductionSelectiveRegressionModel, writeCandidateSelectiveRegressionModel, writeProductionSelectiveRegressionModel, readRegressionReport, writeRegressionReport, getStorageStatus, upsertFirstInningFeatureSnapshots, upsertFirstInningResults, readFirstInningFeatureSnapshots, readFirstInningResults } from "./feature-store.js";
import { buildWinnerGameId, fetchWinnerScoreboard, type WinnerScoreboard } from "./results-fetcher.js";
import { buildRegressionTrainingRows, FALLBACK_MARKET_WEIGHT, fallbackHomeWinProbability, MIN_REGRESSION_SAMPLE, predictHomeWinProbability, REGRESSION_FEATURE_NAMES, REGRESSION_FEATURE_VERSION, trainLogisticRegression } from "./regression-trainer.js";
import { evaluateHeuristicBaseline, evaluateRegressionModel, evaluateWalkForwardRegression, QUALIFIED_CONFIDENCE_THRESHOLD, RECENT_VALIDATION_DATES } from "./model-evaluator.js";
import type { RegressionReport, WinnerFeatureSnapshot } from "./regression-types.js";
import { clampPlayerRating, lineupAdjustedTeamRating, sampleAdjustedPlayerRating } from "./rating-utils.js";
import { shrinkProbabilityToEven, winnerEvidenceQuality } from "./prediction-quality.js";
import type { FirstInningFeatureSnapshot, FirstInningPerformance, FirstInningPick } from "./first-inning-types.js";
import { evaluateFirstInningPerformance } from "./first-inning-evaluator.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 3000;
const ANALYSIS_VERSION = "models-v8.5-first-inning-accountability";
const CURRENT_SEASON = new Date().getFullYear();
const PREVIOUS_SEASON = CURRENT_SEASON - 1;

const SCHEDULE_URL = "https://www.mlb.com/schedule";
const ROTOWIRE_LINEUPS_URL = "https://www.rotowire.com/baseball/daily-lineups.php";
const SAVANT_TOP_URL = "https://baseballsavant.mlb.com/leaderboard/top";
const SAVANT_EXPECTED_URL = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";
const SAVANT_EXPECTED_BATTER_URL = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${CURRENT_SEASON}&position=&team=&filterType=bip&min=1&sort=9&sortDir=desc`;
const SAVANT_EXPECTED_PITCHER_URL = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${CURRENT_SEASON}&position=&team=&filterType=bip&min=1&sort=9&sortDir=desc`;
const SAVANT_PARK_FACTORS_URL = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=${CURRENT_SEASON}&batSide=&stat=index_wOBA&condition=All&rolling=3&parks=mlb`;
const TEAMRANKINGS_RUN_DIFF_URL = "https://www.teamrankings.com/mlb/stat/run-differential";
const BR_WIN_PROB_BATTING_URL = `https://www.baseball-reference.com/leagues/majors/${CURRENT_SEASON}-win_probability-batting.shtml`;
const BR_WIN_PROB_PITCHING_URL = `https://www.baseball-reference.com/leagues/majors/${CURRENT_SEASON}-win_probability-pitching.shtml`;
const SAVANT_FIRST_INNING_PITCHERS_URL = `https://baseballsavant.mlb.com/statcast_search?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=${CURRENT_SEASON}%7C${PREVIOUS_SEASON}%7C&hfSit=&player_type=pitcher&hfOuts=&home_road=&pitcher_throws=&batter_stands=&hfSA=&hfEventOuts=&hfEventRuns=&game_date_gt=&game_date_lt=&hfMo=&hfTeam=&hfOpponent=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=1%7C&hfBBT=&hfFlag=is%5C.%5C.bunt%5C.%5C.not%7C&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&chk_stats_abs=on&chk_stats_hits=on&chk_stats_singles=on&chk_stats_hrs=on&chk_stats_k_percent=on&chk_stats_hbp=on&chk_stats_whiffs=on&chk_stats_ba=on&chk_stats_xba=on&chk_stats_barrels_total=on&chk_stats_swing_miss_percent=on&chk_stats_unadj_run_exp=on&chk_stats_unadj_pitcher_run_exp=on&chk_stats_unadj_pitcher_run_value_per_100=on&chk_stats_launch_speed=on&chk_stats_barrels_per_pa_percent=on#results`;
const SAVANT_FIRST_INNING_BATTERS_URL = `https://baseballsavant.mlb.com/statcast_search?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=${CURRENT_SEASON}%7C${PREVIOUS_SEASON}%7C&hfSit=&player_type=batter&hfOuts=&home_road=&pitcher_throws=&batter_stands=&hfSA=&hfEventOuts=&hfEventRuns=&game_date_gt=&game_date_lt=&hfMo=&hfTeam=&hfOpponent=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=1%7C&hfBBT=&hfFlag=is%5C.%5C.bunt%5C.%5C.not%7Cis%5C.%5C.competitive%7C&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&chk_stats_abs=on&chk_stats_hits=on&chk_stats_singles=on&chk_stats_hrs=on&chk_stats_k_percent=on&chk_stats_hbp=on&chk_stats_whiffs=on&chk_stats_ba=on&chk_stats_xba=on&chk_stats_barrels_total=on&chk_stats_swing_miss_percent=on&chk_stats_unadj_run_exp=on&chk_stats_launch_speed=on&chk_stats_hardhit_percent=on&chk_stats_barrels_per_pa_percent=on&chk_stats_sweetspot_speed_mph=on#results`;
const SEARCH_CACHE_MS = 1000 * 60 * 20;
const MODEL_DATA_CACHE_MS = 1000 * 60 * 60 * 6;
const MODEL_DATA_MAX_AGE_MS = 1000 * 60 * 60 * 8;
const SOURCE_STALE_MS = 1000 * 60 * 60 * 26;
const WINNER_SCOREBOARD_CACHE_MS = 1000 * 60 * 2;
const ROTOWIRE_MARKET_SHRINK = 0.915;
const MODEL_APPROVAL_MIN_LIFT = 0.02;
const RECENT_APPROVAL_MIN_GAMES = 30;
const RECENT_APPROVAL_MIN_ACCURACY = 0.50;
const QUALIFIED_APPROVAL_MIN_GAMES = 15;
const QUALIFIED_APPROVAL_MIN_ACCURACY = 0.60;
const SELECTIVE_FEATURE_NAMES = REGRESSION_FEATURE_NAMES.filter((name) => name !== "totalValue");
const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";
const ODDS_BOOKMAKER = process.env.ODDS_BOOKMAKER || "fanduel";
const MORNING_REFRESH_TIME_ZONE = process.env.MORNING_REFRESH_TIME_ZONE || "America/New_York";
const MORNING_REFRESH_HOUR = Number.parseInt(process.env.MORNING_REFRESH_HOUR || "9", 10);
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
  awayStarter: GamePitcher | null;
  homeStarter: GamePitcher | null;
  awayBatters: BatterStat[];
  homeBatters: BatterStat[];
  rotowireLine: string | null;
  rotowireTotal: number | null;
  lineupsConfirmed: boolean;
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

type TeamRecentForm = {
  teamKey: string;
  games: number;
  seasonGames: number;
  last5RunDiff: number;
  last10RunDiff: number;
  weightedRunDiff: number;
  winsLast5: number;
  winsLast10: number;
};

type RecentBatterStat = {
  name: string;
  pa: number;
  battingAvg: number;
  obp: number;
  slg: number;
  ops: number;
  kPercent: number;
  bbPercent: number;
  homeRuns: number;
};

type RecentPitcherStat = {
  name: string;
  battersFaced: number;
  innings: number;
  era: number;
  whip: number;
  kPercent: number;
  bbPercent: number;
  hrPer9: number;
};

type TeamBullpenStat = {
  teamKey: string;
  teamName: string;
  relieverCount: number;
  seasonInnings: number;
  seasonEra: number;
  seasonWhip: number;
  seasonKPercent: number;
  seasonBbPercent: number;
  seasonHrPer9: number;
  saves: number;
  holds: number;
  blownSaves: number;
  recent14Innings: number;
  recent14Era: number;
  recent14Whip: number;
  recent14KPercent: number;
  recent14BbPercent: number;
  pitchesLast3: number;
  fatiguePenalty: number;
  rating: number;
};

type SourceRefreshState = {
  key: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  rowCount: number;
  error: string | null;
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
  estimated: boolean;
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
let teamLastFiveCache: CacheEntry<Map<string, TeamRecentForm>> | null = null;
let oddsCache: CacheEntry<GameOdds[]> | null = null;
let oddsLastError: string | null = null;
let teamDefenseCache: CacheEntry<Map<string, TeamDefenseStat>> | null = null;
let teamBattingWinProbCache: CacheEntry<Map<string, TeamWinProbStat>> | null = null;
let teamPitchingWinProbCache: CacheEntry<Map<string, TeamWinProbStat>> | null = null;
let teamParkFactorCache: CacheEntry<Map<string, TeamParkFactorStat>> | null = null;
let recentBatterCache: CacheEntry<Map<string, RecentBatterStat>> | null = null;
let recentPitcherCache: CacheEntry<Map<string, RecentPitcherStat>> | null = null;
let teamBullpenCache: CacheEntry<Map<string, TeamBullpenStat>> | null = null;
let teamDefensePromise: Promise<Map<string, TeamDefenseStat>> | null = null;
let teamBattingWinProbPromise: Promise<Map<string, TeamWinProbStat>> | null = null;
let teamPitchingWinProbPromise: Promise<Map<string, TeamWinProbStat>> | null = null;
let teamParkFactorPromise: Promise<Map<string, TeamParkFactorStat>> | null = null;
let recentPlayerPromise: Promise<void> | null = null;
let teamBullpenPromise: Promise<Map<string, TeamBullpenStat>> | null = null;
let refreshPromise: Promise<void> | null = null;
let winnerScoreboardCache: CacheEntry<WinnerScoreboard> | null = null;
let winnerScoreboardPromise: Promise<WinnerScoreboard> | null = null;
let nextMorningRefreshAt: string | null = null;
let lastMorningRefreshAt: string | null = null;
let lastMorningRefreshStatus: "idle" | "ok" | "degraded" | "error" = "idle";
let lastMorningRefreshError: string | null = null;
const sourceRefreshStates = new Map<string, SourceRefreshState>();

function getCurrentStats() {
  return getAugmentedStats(STATS);
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function mlbCalendarDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftIsoDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

async function refreshRecentWinnerScoreboard(force = false) {
  if (!force && winnerScoreboardCache && Date.now() - winnerScoreboardCache.fetchedAt < WINNER_SCOREBOARD_CACHE_MS) {
    return winnerScoreboardCache.value;
  }
  if (winnerScoreboardPromise) return await winnerScoreboardPromise;

  winnerScoreboardPromise = (async () => {
    const today = mlbCalendarDate();
    const scoreboard = await fetchWinnerScoreboard(shiftIsoDate(today, -2), today);
    upsertWinnerResults(scoreboard.results);
    upsertFirstInningResults(scoreboard.firstInningResults);
    winnerScoreboardCache = { fetchedAt: Date.now(), value: scoreboard };
    return scoreboard;
  })();

  try {
    return await winnerScoreboardPromise;
  } finally {
    winnerScoreboardPromise = null;
  }
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let estimate = new Date(desiredAsUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = zonedParts(estimate, timeZone);
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    estimate = new Date(estimate.getTime() + desiredAsUtc - shownAsUtc);
  }
  return estimate;
}

function nextMorningRefresh(now = new Date()) {
  const current = zonedParts(now, MORNING_REFRESH_TIME_ZONE);
  let next = zonedTimeToUtc(
    current.year,
    current.month,
    current.day,
    MORNING_REFRESH_HOUR,
    MORNING_REFRESH_MINUTE,
    MORNING_REFRESH_TIME_ZONE
  );
  if (next.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    next = zonedTimeToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      MORNING_REFRESH_HOUR,
      MORNING_REFRESH_MINUTE,
      MORNING_REFRESH_TIME_ZONE
    );
  }
  return next;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function recordSourceAttempt(key: string) {
  const previous = sourceRefreshStates.get(key);
  sourceRefreshStates.set(key, {
    key,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: previous?.lastSuccessAt || null,
    rowCount: previous?.rowCount || 0,
    error: previous?.error || null
  });
}

function recordSourceSuccess(key: string, rowCount: number) {
  const now = new Date().toISOString();
  sourceRefreshStates.set(key, {
    key,
    lastAttemptAt: now,
    lastSuccessAt: now,
    rowCount,
    error: null
  });
}

function recordSourceFailure(key: string, error: unknown) {
  const previous = sourceRefreshStates.get(key);
  sourceRefreshStates.set(key, {
    key,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: previous?.lastSuccessAt || null,
    rowCount: previous?.rowCount || 0,
    error: getErrorMessage(error)
  });
}

function sourceHealth() {
  const now = Date.now();
  return [...sourceRefreshStates.values()].map((source) => ({
    ...source,
    ageHours: source.lastSuccessAt ? (now - Date.parse(source.lastSuccessAt)) / 3_600_000 : null,
    stale: !source.lastSuccessAt || now - Date.parse(source.lastSuccessAt) > SOURCE_STALE_MS
  }));
}

function inningsToOuts(value: string | number | null | undefined) {
  const [wholeText, partialText = "0"] = String(value || "0").split(".");
  const whole = Number(wholeText) || 0;
  const partial = Math.max(0, Math.min(2, Number(partialText) || 0));
  return whole * 3 + partial;
}

function outsToInnings(outs: number) {
  return Math.max(0, outs) / 3;
}

function safeRate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
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
  const sourceKey = "savant-expected-stats";
  recordSourceAttempt(sourceKey);
  try {
    const [batterHtml, pitcherHtml] = await Promise.all([
      fetchHtml(SAVANT_EXPECTED_BATTER_URL),
      fetchHtml(SAVANT_EXPECTED_PITCHER_URL)
    ]);
    const batterRows = extractSavantLeaderboardData(batterHtml);
    const pitcherRows = extractSavantLeaderboardData(pitcherHtml);
    if (batterRows.length < 100 || pitcherRows.length < 100) {
      throw new Error(`Savant expected-stat response was incomplete (${batterRows.length} batters, ${pitcherRows.length} pitchers)`);
    }

    const { batterPath, pitcherPath } = getExpectedStatsCsvWritePaths();
    const batterTempPath = `${batterPath}.tmp`;
    const pitcherTempPath = `${pitcherPath}.tmp`;
    await fs.mkdir(path.dirname(batterPath), { recursive: true });
    await fs.mkdir(path.dirname(pitcherPath), { recursive: true });
    await fs.writeFile(batterTempPath, formatExpectedStatsCsv("batter", batterRows), "utf8");
    await fs.writeFile(pitcherTempPath, formatExpectedStatsCsv("pitcher", pitcherRows), "utf8");
    await fs.rename(batterTempPath, batterPath);
    await fs.rename(pitcherTempPath, pitcherPath);
    recordSourceSuccess(sourceKey, batterRows.length + pitcherRows.length);

    return {
      batterPath,
      pitcherPath,
      batterCount: batterRows.length,
      pitcherCount: pitcherRows.length
    };
  } catch (error) {
    recordSourceFailure(sourceKey, error);
    throw error;
  }
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
      season: parseNumber(row[String(CURRENT_SEASON)]),
      last3: parseNumber(row["Last 3"]),
      last1: parseNumber(row["Last 1"]),
      home: parseNumber(row["Home"]),
      away: parseNumber(row["Away"]),
      previousSeason: parseNumber(row[String(PREVIOUS_SEASON)])
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

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
  };
  const [res, standingsRes] = await Promise.all([
    fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${today}`, { headers }),
    fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${CURRENT_SEASON}&standingsTypes=regularSeason`, { headers })
  ]);

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
  const seasonGames = new Map<string, number>();
  if (standingsRes.ok) {
    const standings = (await standingsRes.json()) as {
      records?: Array<{ teamRecords?: Array<{ team?: { id?: number }; gamesPlayed?: number }> }>;
    };
    (standings.records || []).flatMap((record) => record.teamRecords || []).forEach((record) => {
      const teamKey = MLB_TEAM_ID_TO_KEY.get(String(record.team?.id || ""));
      if (teamKey) seasonGames.set(teamKey, Number(record.gamesPlayed || 0));
    });
  }

  const perTeam = new Map<string, Array<{ date: string; diff: number; win: boolean }>>();

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
      perTeam.get(awayKey)!.push({ date: gameDate, diff: awayScore - homeScore, win: awayScore > homeScore });
      perTeam.get(homeKey)!.push({ date: gameDate, diff: homeScore - awayScore, win: homeScore > awayScore });
    });
  });

  const map = new Map<string, TeamRecentForm>();
  perTeam.forEach((games, teamKey) => {
    const recent = games.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
    const last5 = recent.slice(0, 5);
    let weightedTotal = 0;
    let weightTotal = 0;
    recent.forEach((game, index) => {
      const weight = Math.pow(0.78, index);
      weightedTotal += game.diff * weight;
      weightTotal += weight;
    });
    map.set(teamKey, {
      teamKey,
      games: recent.length,
      seasonGames: seasonGames.get(teamKey) || 0,
      last5RunDiff: last5.reduce((sum, game) => sum + game.diff, 0),
      last10RunDiff: recent.reduce((sum, game) => sum + game.diff, 0),
      weightedRunDiff: weightTotal ? weightedTotal / weightTotal : 0,
      winsLast5: last5.filter((game) => game.win).length,
      winsLast10: recent.filter((game) => game.win).length
    });
  });

  teamLastFiveCache = { fetchedAt: Date.now(), value: map };
  return map;
}

type MlbPlayerStatSplit = {
  player?: { id?: number; fullName?: string };
  team?: { id?: number; name?: string };
  stat?: Record<string, string | number | null | undefined>;
};

async function fetchMlbPlayerStats(
  group: "hitting" | "pitching",
  stats: "season" | "byDateRange",
  startDate?: string,
  endDate?: string
) {
  const params = new URLSearchParams({
    stats,
    group,
    sportIds: "1",
    playerPool: "ALL",
    season: String(CURRENT_SEASON),
    limit: "3000"
  });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const url = `https://statsapi.mlb.com/api/v1/stats?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for MLB ${group} ${stats}`);
  }
  const data = (await res.json()) as { stats?: Array<{ splits?: MlbPlayerStatSplit[] }> };
  return data.stats?.flatMap((entry) => entry.splits || []) || [];
}

function modelCacheFresh<T>(entry: CacheEntry<T> | null) {
  return Boolean(entry && Date.now() - entry.fetchedAt < MODEL_DATA_CACHE_MS);
}

async function loadRecentPlayerStats() {
  if (modelCacheFresh(recentBatterCache) && modelCacheFresh(recentPitcherCache)) return;
  if (recentPlayerPromise) return await recentPlayerPromise;

  recentPlayerPromise = (async () => {
    const sourceKey = "mlb-player-30-day-form";
    recordSourceAttempt(sourceKey);
    try {
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - 30);
      const startDate = start.toISOString().slice(0, 10);
      const endDate = end.toISOString().slice(0, 10);
      const [hittingRows, pitchingRows] = await Promise.all([
        fetchMlbPlayerStats("hitting", "byDateRange", startDate, endDate),
        fetchMlbPlayerStats("pitching", "byDateRange", startDate, endDate)
      ]);
      const batters = new Map<string, RecentBatterStat>();
      const pitchers = new Map<string, RecentPitcherStat>();

      hittingRows.forEach((row) => {
        const name = cleanText(row.player?.fullName || "");
        const stat = row.stat || {};
        const pa = parseNumber(String(stat.plateAppearances || stat.atBats || 0));
        if (!name || pa < 1) return;
        batters.set(normalizeName(name), {
          name,
          pa,
          battingAvg: parseDecimal(String(stat.avg || 0)),
          obp: parseDecimal(String(stat.obp || 0)),
          slg: parseDecimal(String(stat.slg || 0)),
          ops: parseDecimal(String(stat.ops || 0)),
          kPercent: safeRate(parseNumber(String(stat.strikeOuts || 0)), pa) * 100,
          bbPercent: safeRate(parseNumber(String(stat.baseOnBalls || 0)), pa) * 100,
          homeRuns: parseNumber(String(stat.homeRuns || 0))
        });
      });

      pitchingRows.forEach((row) => {
        const name = cleanText(row.player?.fullName || "");
        const stat = row.stat || {};
        const battersFaced = parseNumber(String(stat.battersFaced || 0));
        if (!name || battersFaced < 1) return;
        pitchers.set(normalizeName(name), {
          name,
          battersFaced,
          innings: outsToInnings(inningsToOuts(stat.inningsPitched)),
          era: parseDecimal(String(stat.era || 0)),
          whip: parseDecimal(String(stat.whip || 0)),
          kPercent: safeRate(parseNumber(String(stat.strikeOuts || 0)), battersFaced) * 100,
          bbPercent: safeRate(parseNumber(String(stat.baseOnBalls || 0)), battersFaced) * 100,
          hrPer9: parseDecimal(String(stat.homeRunsPer9 || 0))
        });
      });

      if (batters.size < 100 || pitchers.size < 100) {
        throw new Error(`MLB recent player feed was incomplete (${batters.size} batters, ${pitchers.size} pitchers)`);
      }
      recentBatterCache = { fetchedAt: Date.now(), value: batters };
      recentPitcherCache = { fetchedAt: Date.now(), value: pitchers };
      recordSourceSuccess(sourceKey, batters.size + pitchers.size);
    } catch (error) {
      recordSourceFailure(sourceKey, error);
      recentBatterCache ||= { fetchedAt: Date.now(), value: new Map<string, RecentBatterStat>() };
      recentPitcherCache ||= { fetchedAt: Date.now(), value: new Map<string, RecentPitcherStat>() };
    }
  })();

  try {
    await recentPlayerPromise;
  } finally {
    recentPlayerPromise = null;
  }
}

async function loadRecentBatterStats() {
  await loadRecentPlayerStats();
  return recentBatterCache?.value || new Map<string, RecentBatterStat>();
}

async function loadRecentPitcherStats() {
  await loadRecentPlayerStats();
  return recentPitcherCache?.value || new Map<string, RecentPitcherStat>();
}

function aggregatePitchingSplits(rows: MlbPlayerStatSplit[]) {
  let outs = 0;
  let earnedRuns = 0;
  let hits = 0;
  let walks = 0;
  let strikeouts = 0;
  let homeRuns = 0;
  let battersFaced = 0;
  let pitches = 0;
  let saves = 0;
  let holds = 0;
  let blownSaves = 0;
  rows.forEach((row) => {
    const stat = row.stat || {};
    outs += inningsToOuts(stat.inningsPitched);
    earnedRuns += parseNumber(String(stat.earnedRuns || 0));
    hits += parseNumber(String(stat.hits || 0));
    walks += parseNumber(String(stat.baseOnBalls || 0));
    strikeouts += parseNumber(String(stat.strikeOuts || 0));
    homeRuns += parseNumber(String(stat.homeRuns || 0));
    battersFaced += parseNumber(String(stat.battersFaced || 0));
    pitches += parseNumber(String(stat.numberOfPitches || 0));
    saves += parseNumber(String(stat.saves || 0));
    holds += parseNumber(String(stat.holds || 0));
    blownSaves += parseNumber(String(stat.blownSaves || 0));
  });
  const innings = outsToInnings(outs);
  return {
    innings,
    era: outs ? earnedRuns * 27 / outs : 4.2,
    whip: innings ? (hits + walks) / innings : 1.32,
    kPercent: safeRate(strikeouts, battersFaced) * 100,
    bbPercent: safeRate(walks, battersFaced) * 100,
    hrPer9: outs ? homeRuns * 27 / outs : 1.2,
    pitches,
    saves,
    holds,
    blownSaves
  };
}

function bullpenSkillRating(stats: ReturnType<typeof aggregatePitchingSplits>) {
  const kBb = stats.kPercent - stats.bbPercent;
  return 50
    + (4.05 - stats.era) * 3.2
    + (1.30 - stats.whip) * 13
    + (kBb - 14) * 0.38
    + (1.10 - stats.hrPer9) * 2.4;
}

async function loadTeamBullpenStats() {
  if (modelCacheFresh(teamBullpenCache)) return teamBullpenCache!.value;
  if (teamBullpenPromise) return await teamBullpenPromise;

  teamBullpenPromise = (async () => {
    const sourceKey = "mlb-bullpen";
    recordSourceAttempt(sourceKey);
    try {
      const end = new Date();
      const start14 = new Date(end);
      const start3 = new Date(end);
      start14.setDate(start14.getDate() - 14);
      start3.setDate(start3.getDate() - 3);
      const [seasonRows, recent14Rows, recent3Rows] = await Promise.all([
        fetchMlbPlayerStats("pitching", "season"),
        fetchMlbPlayerStats("pitching", "byDateRange", start14.toISOString().slice(0, 10), end.toISOString().slice(0, 10)),
        fetchMlbPlayerStats("pitching", "byDateRange", start3.toISOString().slice(0, 10), end.toISOString().slice(0, 10))
      ]);

      const relieverIds = new Set<number>();
      seasonRows.forEach((row) => {
        const stat = row.stat || {};
        const playerId = Number(row.player?.id || 0);
        const games = parseNumber(String(stat.gamesPlayed || stat.gamesPitched || 0));
        const starts = parseNumber(String(stat.gamesStarted || 0));
        const innings = outsToInnings(inningsToOuts(stat.inningsPitched));
        const leverageAppearances = parseNumber(String(stat.saves || 0))
          + parseNumber(String(stat.holds || 0))
          + parseNumber(String(stat.gamesFinished || 0));
        const primarilyRelief = starts === 0 || starts / Math.max(games, 1) <= 0.25 || leverageAppearances > 0;
        if (playerId && games >= 4 && innings >= 3 && primarilyRelief) relieverIds.add(playerId);
      });

      const seasonByTeam = new Map<string, MlbPlayerStatSplit[]>();
      const recent14ByTeam = new Map<string, MlbPlayerStatSplit[]>();
      const recent3ByTeam = new Map<string, MlbPlayerStatSplit[]>();
      const append = (target: Map<string, MlbPlayerStatSplit[]>, row: MlbPlayerStatSplit) => {
        const playerId = Number(row.player?.id || 0);
        const teamKey = MLB_TEAM_ID_TO_KEY.get(String(row.team?.id || ""));
        if (!teamKey || !relieverIds.has(playerId)) return;
        if (!target.has(teamKey)) target.set(teamKey, []);
        target.get(teamKey)!.push(row);
      };
      seasonRows.forEach((row) => append(seasonByTeam, row));
      recent14Rows.forEach((row) => append(recent14ByTeam, row));
      recent3Rows.forEach((row) => append(recent3ByTeam, row));

      const map = new Map<string, TeamBullpenStat>();
      Object.keys(MLB_TEAM_IDS).forEach((teamKey) => {
        const seasonTeamRows = seasonByTeam.get(teamKey) || [];
        if (!seasonTeamRows.length) return;
        const season = aggregatePitchingSplits(seasonTeamRows);
        const recent14 = aggregatePitchingSplits(recent14ByTeam.get(teamKey) || []);
        const recent3 = aggregatePitchingSplits(recent3ByTeam.get(teamKey) || []);
        const recentWeight = Math.min(0.32, recent14.innings / 110);
        const seasonRating = bullpenSkillRating(season);
        const recentRating = bullpenSkillRating(recent14);
        const averagePitchesLast3 = recent3.pitches / Math.max(seasonTeamRows.length, 1);
        const fatiguePenalty = Math.max(0, Math.min(6, (averagePitchesLast3 - 28) / 4));
        const saveChances = season.saves + season.blownSaves;
        const saveBonus = saveChances ? (season.saves / saveChances - 0.70) * 4 : 0;
        const rating = Math.max(30, Math.min(75,
          seasonRating * (1 - recentWeight) + recentRating * recentWeight + saveBonus - fatiguePenalty
        ));
        map.set(teamKey, {
          teamKey,
          teamName: cleanText(seasonTeamRows[0]?.team?.name || teamKey),
          relieverCount: seasonTeamRows.length,
          seasonInnings: season.innings,
          seasonEra: season.era,
          seasonWhip: season.whip,
          seasonKPercent: season.kPercent,
          seasonBbPercent: season.bbPercent,
          seasonHrPer9: season.hrPer9,
          saves: season.saves,
          holds: season.holds,
          blownSaves: season.blownSaves,
          recent14Innings: recent14.innings,
          recent14Era: recent14.era,
          recent14Whip: recent14.whip,
          recent14KPercent: recent14.kPercent,
          recent14BbPercent: recent14.bbPercent,
          pitchesLast3: recent3.pitches,
          fatiguePenalty,
          rating
        });
      });

      if (map.size < 28) throw new Error(`MLB bullpen feed only covered ${map.size} teams`);
      teamBullpenCache = { fetchedAt: Date.now(), value: map };
      recordSourceSuccess(sourceKey, map.size);
      return map;
    } catch (error) {
      recordSourceFailure(sourceKey, error);
      if (teamBullpenCache?.value.size) return teamBullpenCache.value;
      const fallback = new Map<string, TeamBullpenStat>();
      teamBullpenCache = { fetchedAt: Date.now(), value: fallback };
      return fallback;
    }
  })();

  try {
    return await teamBullpenPromise;
  } finally {
    teamBullpenPromise = null;
  }
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
          const passedBalls = parseNumber(String(stat.passedBall || stat.passedBalls || 0));
          const gamesPlayed = Math.max(1, parseNumber(String(stat.gamesPlayed || stat.games || 0)));
          const rangeFactorPerGame = parseDecimal(String(stat.rangeFactorPerGame || 0));
          const rangeFactorPer9 = parseDecimal(String(stat.rangeFactorPer9Inn || 0));
          const errorRate = chances ? errors / chances : 0;
          // Team totals must be normalized; raw season counts previously pushed every club into the same clamp.
          const rawScore = (fieldingPct - 0.985) * 500
            + (rangeFactorPerGame - 35.5) * 0.15
            + ((doublePlays / gamesPlayed) - 0.75) * 1.5
            + (0.55 - (errors / gamesPlayed)) * 3
            + (0.26 - (throwingErrors / gamesPlayed)) * 2
            + (0.04 - (passedBalls / gamesPlayed)) * 1.5
            + (0.015 - errorRate) * 100;
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

function americanOddsFromProbability(probability: number) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  return Math.round(probability >= 0.5
    ? (-100 * probability) / (1 - probability)
    : (100 * (1 - probability)) / probability);
}

function rotowireOddsForGame(game: MatchedGameContext): GameOdds | null {
  const match = cleanText(game.rotowireLine || "").replace(/\u2212/g, "-").match(/\b([A-Z]{2,4})\s*([+-]\d{2,4})\b/);
  if (!match) return null;
  const listedTeam = resolveTeamKey(match[1]);
  const listedPrice = Number(match[2]);
  const listedImplied = impliedProbability(listedPrice);
  if (!listedTeam || listedImplied === null || (listedTeam !== game.away && listedTeam !== game.home)) return null;

  // Fitted on 183 stored two-sided markets: the listed-side implied edge is
  // about 91.5% of its corresponding no-vig edge after removing the hold.
  const listedFair = Math.max(0.05, Math.min(0.95,
    0.5 + (listedImplied - 0.5) * ROTOWIRE_MARKET_SHRINK
  ));
  const awayProbability = listedTeam === game.away ? listedFair : 1 - listedFair;
  const homeProbability = 1 - awayProbability;

  return {
    away: game.away,
    home: game.home,
    bookmaker: "RotoWire listed line (estimated no-vig)",
    commenceTime: null,
    lastUpdate: null,
    awayMoneyline: americanOddsFromProbability(awayProbability),
    homeMoneyline: americanOddsFromProbability(homeProbability),
    total: game.rotowireTotal,
    overPrice: null,
    underPrice: null,
    runLine: null,
    awayRunLinePrice: null,
    homeRunLinePrice: null,
    estimated: true
  };
}

function snapshotOddsForGame(snapshot: WinnerFeatureSnapshot | null): GameOdds | null {
  if (!snapshot || snapshot.awayMoneyline === null || snapshot.homeMoneyline === null) return null;
  return {
    away: snapshot.away,
    home: snapshot.home,
    bookmaker: "Immutable pregame market snapshot",
    commenceTime: null,
    lastUpdate: null,
    awayMoneyline: snapshot.awayMoneyline,
    homeMoneyline: snapshot.homeMoneyline,
    total: snapshot.total,
    overPrice: null,
    underPrice: null,
    runLine: null,
    awayRunLinePrice: null,
    homeRunLinePrice: null,
    estimated: snapshot.analysisVersion === ANALYSIS_VERSION
  };
}

async function loadGameOdds() {
  if (isFresh(oddsCache)) {
    return oddsCache!.value;
  }

  const apiKey = cleanText(process.env.ODDS_API_KEY || "");
  if (!apiKey) {
    oddsLastError = null;
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
    oddsLastError = `Fetch failed ${res.status} for odds API`;
    console.warn(`${oddsLastError}; continuing without market odds.`);
    oddsCache = { fetchedAt: Date.now(), value: [] };
    return [];
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

  const odds = data.map((event): GameOdds | null => {
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
      homeRunLinePrice: homeSpread?.price ?? null,
      estimated: false
    };
  }).filter((value): value is GameOdds => value !== null);

  oddsCache = { fetchedAt: Date.now(), value: odds };
  oddsLastError = null;
  return odds;
}

async function findOddsForGame(
  game: MatchedGameContext,
  pregameSnapshot: WinnerFeatureSnapshot | null,
  gameState: string | null
) {
  const frozenOdds = snapshotOddsForGame(pregameSnapshot);
  if (frozenOdds) return frozenOdds;
  if (gameState === null) return null;
  if (gameState === "live" || gameState === "final" || gameState === "postponed") return null;

  const odds = await loadGameOdds();
  const awayKey = resolveTeamKey(game.away);
  const homeKey = resolveTeamKey(game.home);
  if (!awayKey || !homeKey) return null;
  return odds.find((entry) => entry.away === awayKey && entry.home === homeKey) || rotowireOddsForGame(game);
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
  const [html, schedule] = await Promise.all([fetchHtml(ROTOWIRE_LINEUPS_URL), loadSchedule()]);
  const scheduleKeys = new Set(schedule.games.map((game) => {
    const away = resolveTeamKey(game.away);
    const home = resolveTeamKey(game.home);
    return away && home ? `${away}_${home}` : "";
  }).filter(Boolean));
  const parsedGames = parseRotoWireGames(html);
  const games = parsedGames.filter((game) => scheduleKeys.has(`${game.away}_${game.home}`));
  return {
    source: ROTOWIRE_LINEUPS_URL,
    scrapedAt: new Date().toISOString(),
    slateDate: mlbCalendarDate(),
    discardedStaleGames: parsedGames.length - games.length,
    games
  };
}

async function loadSchedule() {
  const today = mlbCalendarDate();
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
  const rotowireLine = gameContext.match(/Moneyline:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const totalText = gameContext.match(/Over\/Under:\s*([\d.]+)/i)?.[1] || "";
  const rotowireTotal = Number.parseFloat(totalText);

  return {
    away: teams.away,
    home: teams.home,
    awayPitcher: awayPitcherName ? findPitcherStat(awayPitcherName) : null,
    homePitcher: homePitcherName ? findPitcherStat(homePitcherName) : null,
    awayStarter: awayPitcherName ? { name: awayPitcherName, era: gameContext.match(/Away starter:[^\n]*?([\d.]+)\s*ERA/i)?.[1] || "", hand: "", record: "" } : null,
    homeStarter: homePitcherName ? { name: homePitcherName, era: gameContext.match(/Home starter:[^\n]*?([\d.]+)\s*ERA/i)?.[1] || "", hand: "", record: "" } : null,
    awayBatters: compactBatters(collectNamedPlayersFromContext(gameContext, teams.away)
      .map((name) => findBatterStat(name))),
    homeBatters: compactBatters(collectNamedPlayersFromContext(gameContext, teams.home)
      .map((name) => findBatterStat(name))),
    rotowireLine,
    rotowireTotal: Number.isFinite(rotowireTotal) ? rotowireTotal : null,
    lineupsConfirmed: /confirmed lineups?/i.test(gameContext)
  };
}

function matchGameCard(card: GameCard): MatchedGameContext {
  const parsedTotal = Number.parseFloat(card.ou || "");
  return {
    away: card.away,
    home: card.home,
    awayPitcher: card.awayP?.name ? findPitcherStat(card.awayP.name) : null,
    homePitcher: card.homeP?.name ? findPitcherStat(card.homeP.name) : null,
    awayStarter: card.awayP,
    homeStarter: card.homeP,
    awayBatters: compactBatters((card.awayLineup || []).map((batter) => findBatterStat(batter.name))),
    homeBatters: compactBatters((card.homeLineup || []).map((batter) => findBatterStat(batter.name))),
    rotowireLine: card.line,
    rotowireTotal: Number.isFinite(parsedTotal) ? parsedTotal : null,
    lineupsConfirmed: card.confirmed
  };
}

function rankPitcherForKs(
  pitcher: PitcherStat,
  lineup: BatterStat[],
  recentPitcher: RecentPitcherStat | null = null,
  recentBatters = new Map<string, RecentBatterStat>()
) {
  const recentWeight = recentPitcher ? Math.min(0.35, (recentPitcher.battersFaced / 120) * 0.35) : 0;
  const kPercent = pitcher.k_percent * (1 - recentWeight) + (recentPitcher?.kPercent || pitcher.k_percent) * recentWeight;
  const bbPercent = pitcher.bb_percent * (1 - recentWeight) + (recentPitcher?.bbPercent || pitcher.bb_percent) * recentWeight;
  const lineupK = lineup.length
    ? average(lineup.map((batter) => {
        const recent = recentBatters.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
        const weight = recent ? Math.min(0.35, (recent.pa / 120) * 0.35) : 0;
        return batter.k_percent * (1 - weight) + (recent?.kPercent || batter.k_percent) * weight;
      }))
    : 22;
  return 50
    + (kPercent - 22) * 1.2
    + (pitcher.whiff_percent - 24) * 0.65
    + (pitcher.out_zone_swing_miss - 10) * 0.35
    + pitcher.swords * 0.8
    + (lineupK - 22) * 0.6
    - (bbPercent - 8) * 0.7;
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
    + (batter.xwoba - 0.320) * 45
    + (batter.xslg - 0.420) * 15
    + (batter.xba - 0.250) * 10;
}

function firstInningPitcherScore(split: FirstInningPitcherSplit | null, pitcher: PitcherStat | null, recent: RecentPitcherStat | null) {
  const recentAdjustment = recent
    ? Math.max(-5, Math.min(5,
        (4.00 - recent.era) * 0.7
        + ((recent.kPercent - recent.bbPercent) - 15) * 0.14
        + (1.10 - recent.hrPer9) * 0.8
      ))
    : 0;
  if (split) {
    return 55
      + (split.kPercent - 20) * 0.55
      + (split.whiffPercent - 24) * 0.25
      + (0.240 - split.xba) * 95
      + (0.240 - split.ba) * 80
      + (8 - split.barrelsPerPaPercent) * 0.65
      + (-split.pitcherRunValuePer100) * 2.2
      - split.hr * 2.1
      + recentAdjustment;
  }

  if (!pitcher) return 45;

  const kPercent = recent?.kPercent ?? pitcher.k_percent;
  const bbPercent = recent?.bbPercent ?? pitcher.bb_percent;
  return 52
    + (kPercent - 20) * 0.45
    + (0.280 - pitcher.xwoba) * 85
    + (0.400 - pitcher.xslg) * 18
    - bbPercent * 0.3
    + recentAdjustment;
}

function firstInningBatterThreat(split: FirstInningBatterSplit | null, batter: BatterStat | null, recent: RecentBatterStat | null) {
  const recentAdjustment = recent
    ? Math.max(-4, Math.min(4, (recent.ops - 0.720) * 16 + (recent.obp - 0.320) * 8))
    : 0;
  if (split) {
    return 42
      + split.xba * 70
      + split.ba * 45
      + split.hardHitPercent * 0.22
      + split.barrelsPerPaPercent * 0.6
      + split.ev * 0.08
      - split.kPercent * 0.16
      - split.whiffPercent * 0.08
      + split.hr * 1.4
      + recentAdjustment;
  }

  if (!batter) return 45;
  return fallbackBatterThreat(batter) + recentAdjustment;
}

async function combinedNrfiScore(game: MatchedGameContext) {
  const [pitcherSplits, batterSplits, recentPitchers, recentBatters] = await Promise.all([
    loadFirstInningPitcherSplits().catch(() => new Map<string, FirstInningPitcherSplit>()),
    loadFirstInningBatterSplits().catch(() => new Map<string, FirstInningBatterSplit>()),
    loadRecentPitcherStats(),
    loadRecentBatterStats()
  ]);

  function halfScore(pitcher: PitcherStat | null, offense: BatterStat[]) {
    const pitcherSplit = pitcher ? pitcherSplits.get(normalizeName(statDisplayName(pitcher["last_name, first_name"]))) || null : null;
    const recentPitcher = pitcher ? recentPitchers.get(normalizeName(statDisplayName(pitcher["last_name, first_name"]))) || null : null;
    const topThree = offense.slice(0, 3);
    const offenseThreat = topThree.length
      ? average(topThree.map((batter) => {
          const split = batterSplits.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
          const recent = recentBatters.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
          return firstInningBatterThreat(split, batter, recent);
        }))
      : 45;

    return firstInningPitcherScore(pitcherSplit, pitcher, recentPitcher) - (offenseThreat - 45) * 0.78;
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

function rankOffense(lineup: BatterStat[], recentStats = new Map<string, RecentBatterStat>()) {
  if (!lineup.length) return 50;
  return lineupAdjustedTeamRating(
    lineup.map((batter) => {
      const rawSeasonRating = 50
        + (batter.xwoba - 0.320) * 90
        + (batter.xslg - 0.420) * 30
        + (batter.xba - 0.250) * 20;
      const seasonRating = sampleAdjustedPlayerRating(rawSeasonRating, batter.pa);
      const recent = recentStats.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
      if (!recent) return seasonRating;
      const recentRating = clampPlayerRating(50
        + (recent.ops - 0.720) * 35
        + (recent.obp - 0.320) * 15
        + (recent.slg - 0.400) * 10
        + ((recent.bbPercent - recent.kPercent) + 15) * 0.20);
      const recentWeight = Math.min(0.38, (recent.pa / 120) * 0.38);
      return seasonRating * (1 - recentWeight) + recentRating * recentWeight;
    }),
    9,
    50
  );
}

async function firstInningProjection(game: MatchedGameContext) {
  const halves = await combinedNrfiScore(game);
  const total = game.rotowireTotal;
  const totalAdjustment = total !== null ? (total <= 7.5 ? 3 : total >= 9 ? -3 : 0) : 0;
  const nrfiScore = halves.combined + totalAdjustment;
  const pick: FirstInningPick = nrfiScore >= 58 ? "NRFI" : "YRFI";
  return {
    ...halves,
    rawCombinedScore: halves.combined,
    total,
    totalAdjustment,
    nrfiScore,
    pick,
    pickScore: pick === "NRFI" ? nrfiScore : 70 - nrfiScore,
    dataQuality: firstInningDataQuality(game, total)
  };
}

function messageMentionsTeam(message: string, team: string) {
  const normalized = ` ${normalizeName(message)} `;
  const teamKey = resolveTeamKey(team);
  if (!teamKey) return false;
  return (TEAM_ALIASES[teamKey] || [teamKey]).some((alias) => {
    const normalizedAlias = normalizeName(alias);
    return normalizedAlias && normalized.includes(` ${normalizedAlias} `);
  });
}

async function inferMatchedGameFromMessage(message: string) {
  const payload = await loadDailyLineups();
  const candidates = payload.games
    .map((game) => ({
      game,
      mentions: Number(messageMentionsTeam(message, game.away)) + Number(messageMentionsTeam(message, game.home))
    }))
    .filter(({ mentions }) => mentions > 0);
  const exactMatch = candidates.find(({ mentions }) => mentions === 2);
  if (exactMatch) return matchGameCard(exactMatch.game);
  return candidates.length === 1 ? matchGameCard(candidates[0].game) : null;
}

function rankPitchingForWin(
  pitcher: PitcherStat | null,
  recentStats = new Map<string, RecentPitcherStat>(),
  starter: GamePitcher | null = null
) {
  const starterName = pitcher ? statDisplayName(pitcher["last_name, first_name"]) : starter?.name || "";
  const recent = recentStats.get(normalizeName(starterName)) || null;
  const fallbackEra = Number.parseFloat(starter?.era || "");
  if (!pitcher && !recent && !Number.isFinite(fallbackEra)) return 50;
  const rawSeasonRating = pitcher
    ? 50
      + (0.320 - pitcher.xwoba) * 90
      + (0.420 - pitcher.xslg) * 25
      + (0.250 - pitcher.xba) * 20
    : 50 + (4.20 - (Number.isFinite(fallbackEra) ? fallbackEra : 4.20)) * 3;
  const seasonRating = pitcher
    ? sampleAdjustedPlayerRating(rawSeasonRating, pitcher.pa, 50, 120, 35, 80)
    : Math.max(35, Math.min(80, rawSeasonRating));
  if (!recent) return Math.max(35, Math.min(80, seasonRating));
  const recentRating = clampPlayerRating(50
    + (4.00 - recent.era) * 3
    + (1.28 - recent.whip) * 10
    + ((recent.kPercent - recent.bbPercent) - 15) * 0.30
    + (1.10 - recent.hrPer9) * 2, 35, 80);
  const recentWeight = Math.min(0.32, (recent.battersFaced / 120) * 0.32);
  return Math.max(35, Math.min(80, seasonRating * (1 - recentWeight) + recentRating * recentWeight));
}

function winnerWeights(date = new Date()) {
  const month = date.getMonth() + 1;
  const bullpen = month <= 5 ? 0.07 : month <= 7 ? 0.09 : month === 8 ? 0.10 : 0.12;
  return {
    offense: 0.37,
    starter: 0.30 - bullpen,
    bullpen,
    trend: 0.16,
    winProb: 0.10,
    defense: 0.05,
    park: 0.02
  };
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
    return { score: 0, rawScore: 0, season: 0, last3: 0, last1: 0, last5: 0, last10: 0, weightedRecent: 0, winsLast10: 0, split: 0, previousSeason: 0 };
  }

  const runDiffs = await loadTeamRunDifferentials();
  const recentForms = await loadLastFiveRunDifferentials();
  const row = runDiffs.get(teamKey);
  const recent = recentForms.get(teamKey) || null;

  if (!row) {
    return { score: 0, rawScore: 0, season: 0, last3: 0, last1: 0, last5: recent?.last5RunDiff || 0, last10: recent?.last10RunDiff || 0, weightedRecent: recent?.weightedRunDiff || 0, winsLast10: recent?.winsLast10 || 0, split: 0, previousSeason: 0 };
  }

  const split = isHome ? row.home : row.away;
  const games = recent?.games || 0;
  const winRateAdjustment = games ? ((recent?.winsLast10 || 0) / games - 0.5) * 6 : 0;
  const priorSeasonWeight = new Date().getMonth() <= 4 ? 0.08 : 0;
  const seasonGames = Math.max(recent?.seasonGames || 0, 1);
  const estimatedSplitGames = Math.max(seasonGames / 2, 1);
  const seasonPerGame = row.season / seasonGames;
  const splitPerGame = split / estimatedSplitGames;
  const previousSeasonPerGame = row.previousSeason / 162;
  const rawScore = (recent?.weightedRunDiff || 0) * 1.40
    + winRateAdjustment
    + seasonPerGame * 1.20
    + splitPerGame * 0.35
    + previousSeasonPerGame * priorSeasonWeight;
  const score = Math.max(-12, Math.min(12, rawScore));

  return {
    score,
    rawScore,
    season: row.season,
    last3: row.last3,
    last1: row.last1,
    last5: recent?.last5RunDiff || 0,
    last10: recent?.last10RunDiff || 0,
    weightedRecent: recent?.weightedRunDiff || 0,
    winsLast10: recent?.winsLast10 || 0,
    split,
    previousSeason: row.previousSeason
  };
}

async function buildWinnerBreakdown(game: MatchedGameContext) {
  const gameId = buildWinnerGameId(mlbCalendarDate(), game.away, game.home);
  const pregameSnapshot = readWinnerFeatureSnapshots().find((snapshot) => snapshot.gameId === gameId) || null;
  let gameState: string | null = null;
  try {
    const scoreboard = await refreshRecentWinnerScoreboard();
    gameState = scoreboard.statuses.find((status) => status.gameId === gameId)?.state || null;
  } catch {
    // A missing scoreboard must not block local analysis; without a known state,
    // only an existing immutable snapshot can safely supply market data.
  }
  const awayTrend = await winnerTrendScore(game.away, false);
  const homeTrend = await winnerTrendScore(game.home, true);
  const [recentBatters, recentPitchers, bullpens] = await Promise.all([
    loadRecentBatterStats(),
    loadRecentPitcherStats(),
    loadTeamBullpenStats()
  ]);
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
  const odds = await findOddsForGame(game, pregameSnapshot, gameState);
  const awayImplied = impliedProbability(odds?.awayMoneyline ?? null);
  const homeImplied = impliedProbability(odds?.homeMoneyline ?? null);
  const marketLean = awayImplied === null || homeImplied === null ? null : (homeImplied >= awayImplied ? game.home : game.away);
  const awayOffense = rankOffense(game.awayBatters, recentBatters);
  const homeOffense = rankOffense(game.homeBatters, recentBatters);
  const awayPitching = rankPitchingForWin(game.awayPitcher, recentPitchers, game.awayStarter);
  const homePitching = rankPitchingForWin(game.homePitcher, recentPitchers, game.homeStarter);
  const awayBullpen = bullpens.get(resolveTeamKey(game.away) || "") || null;
  const homeBullpen = bullpens.get(resolveTeamKey(game.home) || "") || null;
  const awayBullpenRating = awayBullpen?.rating || 50;
  const homeBullpenRating = homeBullpen?.rating || 50;
  const awayTrendRating = trendRating(awayTrend.score);
  const homeTrendRating = trendRating(homeTrend.score);
  const awayWinProbRating = winProbRating(awayBattingImpact, awayPitchingImpact);
  const homeWinProbRating = winProbRating(homeBattingImpact, homePitchingImpact);
  const awayDefenseRating = defenseRating(awayDefense);
  const homeDefenseRating = defenseRating(homeDefense);
  const awayParkRating = parkRating(parkFactor, awayOffense, awayPitching);
  const homeParkRating = parkRating(parkFactor, homeOffense, homePitching);
  const awayLineupCoverage = lineupCoverageRatio(game.away, game.awayBatters);
  const homeLineupCoverage = lineupCoverageRatio(game.home, game.homeBatters);
  const dataQuality = winnerEvidenceQuality({
    awayLineupCoverage,
    homeLineupCoverage,
    awayStarterQuality: game.awayPitcher ? 1 : game.awayStarter?.era ? 0.65 : 0,
    homeStarterQuality: game.homePitcher ? 1 : game.homeStarter?.era ? 0.65 : 0,
    awayBullpenAvailable: awayBullpen !== null,
    homeBullpenAvailable: homeBullpen !== null,
    marketAvailable: awayImplied !== null && homeImplied !== null,
    lineupsConfirmed: game.lineupsConfirmed
  });

  const weights = winnerWeights();
  const awayScore = awayOffense * weights.offense
    + awayPitching * weights.starter
    + awayBullpenRating * weights.bullpen
    + awayTrendRating * weights.trend
    + awayWinProbRating * weights.winProb
    + awayDefenseRating * weights.defense
    + awayParkRating * weights.park;
  const homeScore = homeOffense * weights.offense
    + homePitching * weights.starter
    + homeBullpenRating * weights.bullpen
    + homeTrendRating * weights.trend
    + homeWinProbRating * weights.winProb
    + homeDefenseRating * weights.defense
    + homeParkRating * weights.park;
  const edge = homeScore - awayScore;

  return {
    awayOffense,
    homeOffense,
    awayPitching,
    homePitching,
    awayBullpen,
    homeBullpen,
    awayBullpenRating,
    homeBullpenRating,
    weights,
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
    pregameSnapshot,
    gameState,
    odds,
    marketLean,
    awayImplied,
    homeImplied,
    awayLineupCoverage,
    homeLineupCoverage,
    dataQuality
  };
}

function winnerPrediction(game: MatchedGameContext, breakdown: Awaited<ReturnType<typeof buildWinnerBreakdown>>) {
  const heuristicHomeProbability = 1 / (1 + Math.exp(-breakdown.edge * 0.14));
  const statisticalHomeProbability = 0.5 + (heuristicHomeProbability - 0.5) * 0.35;
  const impliedTotal = (breakdown.awayImplied || 0) + (breakdown.homeImplied || 0);
  const marketHomeProbability = breakdown.awayImplied !== null && breakdown.homeImplied !== null && impliedTotal
    ? breakdown.homeImplied / impliedTotal
    : null;
  const isStarted = breakdown.gameState === "live" || breakdown.gameState === "final";
  if (isStarted && breakdown.pregameSnapshot) {
    const snapshot = breakdown.pregameSnapshot;
    const snapshotPick = snapshot.predictionPick || snapshot.heuristicPick;
    const snapshotConfidence = Math.max(50, Math.min(100, snapshot.predictionConfidence ?? snapshot.heuristicConfidence));
    const snapshotHomeProbability = snapshotPick === game.home
      ? snapshotConfidence / 100
      : 1 - snapshotConfidence / 100;
    return {
      pick: snapshotPick,
      homeProbability: snapshotHomeProbability,
      pickProbability: snapshotConfidence / 100,
      confidence: snapshotConfidence,
      probabilityEdge: (snapshotConfidence - 50) * 2,
      method: `immutable pregame prediction (${snapshot.predictionMethod || "legacy snapshot"})`,
      validatedStrong: false,
      selectiveConfirmation: false,
      selectiveConfidence: null,
      heuristicPick: snapshot.heuristicPick,
      marketHomeProbability,
      dataQuality: snapshot.dataQuality ?? breakdown.dataQuality.score,
      dataQualityNotes: snapshot.dataQualityNotes ?? breakdown.dataQuality.notes
    };
  }
  const production = readProductionRegressionModel();
  const selectiveProduction = readProductionSelectiveRegressionModel();
  const regressionReport = readRegressionReport();
  const usableModel = production?.featureVersion === REGRESSION_FEATURE_VERSION
    && production.trainingSampleSize >= MIN_REGRESSION_SAMPLE
    && regressionReport?.productionApproved !== false
    ? production
    : null;
  const usableSelectiveModel = selectiveProduction?.featureVersion === REGRESSION_FEATURE_VERSION
    && selectiveProduction.trainingSampleSize >= MIN_REGRESSION_SAMPLE
    && regressionReport?.selectiveProductionApproved === true
    ? selectiveProduction
    : null;
  const snapshot: WinnerFeatureSnapshot = {
    analysisVersion: ANALYSIS_VERSION,
    snapshotDate: mlbCalendarDate(),
    gameId: buildWinnerGameId(mlbCalendarDate(), game.away, game.home),
    away: game.away,
    home: game.home,
    awayOffense: breakdown.awayOffense,
    homeOffense: breakdown.homeOffense,
    awayPitching: breakdown.awayPitching,
    homePitching: breakdown.homePitching,
    awayBullpen: breakdown.awayBullpenRating,
    homeBullpen: breakdown.homeBullpenRating,
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
    lineupCoverageAway: breakdown.awayLineupCoverage,
    lineupCoverageHome: breakdown.homeLineupCoverage,
    dataQuality: breakdown.dataQuality.score,
    dataQualityNotes: breakdown.dataQuality.notes,
    heuristicPick: breakdown.lean,
    heuristicEdge: Math.abs(breakdown.edge),
    heuristicConfidence: Math.max(statisticalHomeProbability, 1 - statisticalHomeProbability) * 100,
    marketLean: breakdown.marketLean
  };

  let homeProbability = fallbackHomeWinProbability(snapshot);
  let method = marketHomeProbability === null
    ? "conservative weighted-statistical model"
    : "85% statistical model + 15% market sanity check";
  if (usableModel) {
    const regressionProbability = predictHomeWinProbability(usableModel, snapshot);
    if (Number.isFinite(regressionProbability)) {
      homeProbability = regressionProbability;
      method = "rolling-validated regression";
    }
  }
  homeProbability = shrinkProbabilityToEven(homeProbability, breakdown.dataQuality.reliability);

  const pick = homeProbability >= 0.5 ? game.home : game.away;
  const confidence = Math.max(homeProbability, 1 - homeProbability) * 100;
  const selectiveHomeProbability = usableSelectiveModel
    ? predictHomeWinProbability(usableSelectiveModel, snapshot)
    : null;
  const selectivePick = selectiveHomeProbability === null
    ? null
    : selectiveHomeProbability >= 0.5 ? game.home : game.away;
  const selectiveConfidence = selectiveHomeProbability === null
    ? null
    : Math.max(selectiveHomeProbability, 1 - selectiveHomeProbability) * 100;
  const selectiveConfirmation = method === "rolling-validated regression"
    && selectivePick === pick
    && selectiveConfidence !== null
    && selectiveConfidence >= QUALIFIED_CONFIDENCE_THRESHOLD * 100;
  return {
    pick,
    homeProbability,
    pickProbability: Math.max(homeProbability, 1 - homeProbability),
    confidence,
    probabilityEdge: Math.abs(homeProbability - 0.5) * 200,
    method,
    validatedStrong: method === "rolling-validated regression"
      && marketHomeProbability !== null
      && confidence >= QUALIFIED_CONFIDENCE_THRESHOLD * 100
      && breakdown.dataQuality.score >= 0.85
      && selectiveConfirmation,
    selectiveConfirmation,
    selectiveConfidence,
    heuristicPick: breakdown.lean,
    marketHomeProbability,
    dataQuality: breakdown.dataQuality.score,
    dataQualityNotes: breakdown.dataQuality.notes
  };
}

function lineupCoverageRatio(teamAbbreviation: string, matchedBatters: BatterStat[]) {
  const expectedCount = 9;
  if (!teamAbbreviation) return matchedBatters.length / expectedCount;
  return Math.max(0, Math.min(1, matchedBatters.length / expectedCount));
}

async function buildWinnerFeatureSnapshot(game: MatchedGameContext, snapshotDate: string): Promise<WinnerFeatureSnapshot> {
  const breakdown = await buildWinnerBreakdown(game);
  const prediction = winnerPrediction(game, breakdown);
  const awayCoverage = breakdown.awayLineupCoverage;
  const homeCoverage = breakdown.homeLineupCoverage;
  const heuristicEdge = Math.abs(breakdown.edge);
  const rawHomeProbability = 1 / (1 + Math.exp(-breakdown.edge * 0.14));
  const statisticalHomeProbability = 0.5 + (rawHomeProbability - 0.5) * 0.35;
  const heuristicConfidence = Math.max(statisticalHomeProbability, 1 - statisticalHomeProbability) * 100;

  return {
    analysisVersion: ANALYSIS_VERSION,
    snapshotDate,
    gameId: buildWinnerGameId(snapshotDate, game.away, game.home),
    away: game.away,
    home: game.home,
    awayOffense: breakdown.awayOffense,
    homeOffense: breakdown.homeOffense,
    awayPitching: breakdown.awayPitching,
    homePitching: breakdown.homePitching,
    awayBullpen: breakdown.awayBullpenRating,
    homeBullpen: breakdown.homeBullpenRating,
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
    dataQuality: breakdown.dataQuality.score,
    dataQualityNotes: breakdown.dataQuality.notes,
    heuristicPick: breakdown.lean,
    heuristicEdge,
    heuristicConfidence,
    predictionPick: prediction.pick,
    predictionConfidence: prediction.confidence,
    predictionMethod: prediction.method,
    marketWeight: prediction.method === "85% statistical model + 15% market sanity check"
      ? FALLBACK_MARKET_WEIGHT
      : null,
    marketLean: breakdown.marketLean
  };
}

async function snapshotWinnerFeaturesForGames(games: MatchedGameContext[], snapshotDate: string) {
  const scoreboard = await refreshRecentWinnerScoreboard();
  const statuses = new Map(scoreboard.statuses.map((status) => [status.gameId, status.state]));
  const eligibleGames = games.filter((game) => {
    const gameId = buildWinnerGameId(snapshotDate, game.away, game.home);
    return statuses.get(gameId) === "scheduled";
  });
  const snapshots = await Promise.all(eligibleGames.map((game) => buildWinnerFeatureSnapshot(game, snapshotDate)));
  return upsertWinnerFeatureSnapshots(snapshots);
}

function firstInningDataQuality(game: MatchedGameContext, total: number | null) {
  const lineupCoverage = (
    Math.min(3, game.awayBatters.length) / 3
    + Math.min(3, game.homeBatters.length) / 3
  ) / 2;
  const awayStarterQuality = game.awayPitcher ? 1 : game.awayStarter?.era ? 0.65 : 0;
  const homeStarterQuality = game.homePitcher ? 1 : game.homeStarter?.era ? 0.65 : 0;
  const starterCoverage = (awayStarterQuality + homeStarterQuality) / 2;
  return lineupCoverage * 0.45
    + starterCoverage * 0.40
    + Number(game.lineupsConfirmed) * 0.10
    + Number(total !== null) * 0.05;
}

async function buildFirstInningFeatureSnapshot(
  game: MatchedGameContext,
  snapshotDate: string
): Promise<FirstInningFeatureSnapshot> {
  const projection = await firstInningProjection(game);
  return {
    gameId: buildWinnerGameId(snapshotDate, game.away, game.home),
    snapshotDate,
    away: game.away,
    home: game.home,
    awayHalfScore: projection.awayHalf,
    homeHalfScore: projection.homeHalf,
    nrfiScore: projection.nrfiScore,
    pick: projection.pick,
    pickScore: projection.pickScore,
    total: projection.total,
    dataQuality: projection.dataQuality,
    analysisVersion: ANALYSIS_VERSION
  };
}

async function snapshotFirstInningFeaturesForGames(games: MatchedGameContext[], snapshotDate: string) {
  const scoreboard = await refreshRecentWinnerScoreboard();
  const statuses = new Map(scoreboard.statuses.map((status) => [status.gameId, status.state]));
  const eligibleGames = games.filter((game) =>
    statuses.get(buildWinnerGameId(snapshotDate, game.away, game.home)) === "scheduled"
  );
  const snapshots = await Promise.all(eligibleGames.map((game) => buildFirstInningFeatureSnapshot(game, snapshotDate)));
  return upsertFirstInningFeatureSnapshots(snapshots);
}

function firstInningPerformance(): FirstInningPerformance {
  return evaluateFirstInningPerformance(readFirstInningFeatureSnapshots(), readFirstInningResults());
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
  const scoreboard = await fetchWinnerScoreboard(startDate.toISOString().slice(0, 10), endDate);
  const storedResultRows = upsertWinnerResults(scoreboard.results);
  upsertFirstInningResults(scoreboard.firstInningResults);

  const featuresByGameId = new Map(featureRows.map((row) => [row.gameId, row]));
  const joined = storedResultRows
    .map((result) => {
      const feature = featuresByGameId.get(result.gameId);
      return feature ? { ...feature, ...result } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const trainingRows = buildRegressionTrainingRows(joined);
  const candidate = trainLogisticRegression(trainingRows);
  const selectiveCandidate = trainLogisticRegression(trainingRows, SELECTIVE_FEATURE_NAMES);
  const storedProduction = readProductionRegressionModel();
  const production = storedProduction?.featureVersion === REGRESSION_FEATURE_VERSION ? storedProduction : null;
  const walkForward = evaluateWalkForwardRegression(
    trainingRows,
    MIN_REGRESSION_SAMPLE,
    undefined,
    endDate
  );
  const selectiveWalkForward = evaluateWalkForwardRegression(
    trainingRows,
    MIN_REGRESSION_SAMPLE,
    SELECTIVE_FEATURE_NAMES,
    endDate
  );
  const walkForwardRows = walkForward.firstTestDate
    ? trainingRows.filter((row) => row.snapshotDate >= walkForward.firstTestDate!)
    : [];
  const heuristicMetrics = evaluateHeuristicBaseline(walkForwardRows);
  const recentWalkForwardRows = walkForward.recentStartDate
    ? trainingRows.filter((row) =>
        row.snapshotDate >= walkForward.recentStartDate! && row.snapshotDate !== endDate
      )
    : [];
  const recentHeuristicMetrics = evaluateHeuristicBaseline(recentWalkForwardRows);
  const productionMetrics = production && walkForwardRows.length
    ? evaluateRegressionModel(production, walkForwardRows)
    : null;
  const candidateMetrics = walkForward.metrics;
  const parkRows = featureRows.filter((row) => row.parkIndex !== null);
  const parkCoverage = {
    populatedRows: parkRows.length,
    coverageRate: featureRows.length ? parkRows.length / featureRows.length : 0,
    averageParkIndex: averageOrNull(parkRows.map((row) => row.parkIndex as number)),
    averageAwayParkRating: averageOrNull(featureRows.map((row) => row.awayPark)),
    averageHomeParkRating: averageOrNull(featureRows.map((row) => row.homePark))
  };
  const bullpenRows = featureRows.filter((row) => row.awayBullpen !== 50 || row.homeBullpen !== 50);
  const bullpenCoverage = {
    populatedRows: bullpenRows.length,
    coverageRate: featureRows.length ? bullpenRows.length / featureRows.length : 0,
    averageAwayBullpenRating: averageOrNull(bullpenRows.map((row) => row.awayBullpen)),
    averageHomeBullpenRating: averageOrNull(bullpenRows.map((row) => row.homeBullpen))
  };
  let promotedCandidate = false;
  let productionApproved = false;
  let selectiveProductionApproved = false;
  const notes: string[] = [];

  if (candidate) {
    writeCandidateRegressionModel(candidate);
    const beatsHeuristic = !heuristicMetrics || !candidateMetrics
      ? false
      : candidateMetrics.logLoss < heuristicMetrics.logLoss
        && candidateMetrics.brierScore <= heuristicMetrics.brierScore
        && candidateMetrics.accuracy >= heuristicMetrics.accuracy + MODEL_APPROVAL_MIN_LIFT;
    const passesRecentForm = !walkForward.recentMetrics || !recentHeuristicMetrics
      ? false
      : walkForward.recentMetrics.sampleSize >= RECENT_APPROVAL_MIN_GAMES
        && walkForward.recentMetrics.accuracy >= RECENT_APPROVAL_MIN_ACCURACY
        && walkForward.recentMetrics.accuracy >= recentHeuristicMetrics.accuracy + MODEL_APPROVAL_MIN_LIFT
        && walkForward.recentMetrics.logLoss < recentHeuristicMetrics.logLoss
        && walkForward.recentMetrics.brierScore <= recentHeuristicMetrics.brierScore;
    const passesQualifiedTier = Boolean(walkForward.recentQualifiedMetrics
      && walkForward.recentQualifiedMetrics.sampleSize >= QUALIFIED_APPROVAL_MIN_GAMES
      && walkForward.recentQualifiedMetrics.accuracy >= QUALIFIED_APPROVAL_MIN_ACCURACY);
    productionApproved = Boolean(
      beatsHeuristic
      && passesRecentForm
      && passesQualifiedTier
      && candidateMetrics
      && candidateMetrics.sampleSize >= 45
    );

    if (productionApproved) {
      writeProductionRegressionModel(candidate);
      promotedCandidate = true;
      notes.push("Candidate regression promoted after passing overall, recent, and qualified-tier rolling-forward validation.");
    } else {
      notes.push("Candidate regression stored but production use is paused until overall, recent, and qualified-tier gates all pass.");
    }
  } else {
    notes.push(`Regression needs at least ${MIN_REGRESSION_SAMPLE} completed games with matching pregame feature snapshots before training can begin.`);
  }

  if (selectiveCandidate) {
    writeCandidateSelectiveRegressionModel(selectiveCandidate);
    selectiveProductionApproved = Boolean(
      productionApproved
      && selectiveWalkForward.qualifiedMetrics
      && selectiveWalkForward.qualifiedMetrics.sampleSize >= 30
      && selectiveWalkForward.qualifiedMetrics.accuracy >= QUALIFIED_APPROVAL_MIN_ACCURACY
      && selectiveWalkForward.recentQualifiedMetrics
      && selectiveWalkForward.recentQualifiedMetrics.sampleSize >= QUALIFIED_APPROVAL_MIN_GAMES
      && selectiveWalkForward.recentQualifiedMetrics.accuracy >= QUALIFIED_APPROVAL_MIN_ACCURACY
    );
    if (selectiveProductionApproved) {
      writeProductionSelectiveRegressionModel(selectiveCandidate);
      notes.push("Selective no-total confirmation model approved for dual-model best-bet gating.");
    } else {
      notes.push("Selective confirmation model is paused until overall and recent qualified tiers pass.");
    }
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
    bullpenCoverage,
    heuristicMetrics,
    productionMetrics,
    candidateMetrics,
    walkForwardMetrics: walkForward.metrics,
    walkForwardStartDate: walkForward.firstTestDate,
    recentWalkForwardMetrics: walkForward.recentMetrics,
    recentQualifiedMetrics: walkForward.recentQualifiedMetrics,
    recentForcedMetrics: walkForward.recentForcedMetrics,
    recentHeuristicMetrics,
    recentValidationStartDate: walkForward.recentStartDate,
    recentValidationExcludedDate: endDate,
    productionApproved,
    selectiveProductionApproved,
    selectiveWalkForwardMetrics: selectiveWalkForward.metrics,
    selectiveQualifiedMetrics: selectiveWalkForward.qualifiedMetrics,
    selectiveRecentQualifiedMetrics: selectiveWalkForward.recentQualifiedMetrics,
    promotedCandidate,
    notes
  };

  writeRegressionReport(report);
  return report;
}

function clearModelCaches() {
  firstInningPitcherCache = null;
  firstInningBatterCache = null;
  teamRunDiffCache = null;
  teamLastFiveCache = null;
  teamDefenseCache = null;
  teamBattingWinProbCache = null;
  teamPitchingWinProbCache = null;
  teamParkFactorCache = null;
  recentBatterCache = null;
  recentPitcherCache = null;
  teamBullpenCache = null;
}

async function runMorningRefresh(reason: "startup" | "scheduled" | "stale" | "manual") {
  if (refreshPromise) return await refreshPromise;
  refreshPromise = (async () => {
    const failures: string[] = [];
    clearModelCaches();
    const tasks = [
      ["expected stats", refreshExpectedStatsCsvs()],
      ["schedule", loadSchedule()],
      ["run differential", loadTeamRunDifferentials()],
      ["recent team form", loadLastFiveRunDifferentials()],
      ["recent player form", loadRecentPlayerStats()],
      ["bullpen", loadTeamBullpenStats()],
      ["defense", loadTeamDefenseStats()],
      ["batting win probability", loadTeamWinProbabilityStats("batting")],
      ["pitching win probability", loadTeamWinProbabilityStats("pitching")],
      ["park factors", loadTeamParkFactors()],
      ["odds", loadGameOdds()]
    ] as Array<[string, Promise<unknown>]>;
    const results = await Promise.allSettled(tasks.map(([, task]) => task));
    results.forEach((result, index) => {
      if (result.status === "rejected") failures.push(`${tasks[index][0]}: ${getErrorMessage(result.reason)}`);
    });

    try {
      const payload = await loadDailyLineups();
      const snapshotDate = mlbCalendarDate();
      const matchedGames = payload.games.map((game) => matchGameCard(game));
      await Promise.all([
        snapshotWinnerFeaturesForGames(matchedGames, snapshotDate),
        snapshotFirstInningFeaturesForGames(matchedGames, snapshotDate)
      ]);
    } catch (error) {
      failures.push(`lineup snapshot: ${getErrorMessage(error)}`);
    }

    try {
      await refreshRegressionArtifacts();
    } catch (error) {
      failures.push(`regression: ${getErrorMessage(error)}`);
    }

    lastMorningRefreshAt = new Date().toISOString();
    lastMorningRefreshStatus = failures.length ? "degraded" : "ok";
    lastMorningRefreshError = failures.length ? failures.join(" | ") : null;
    if (failures.length) console.warn(`Refresh completed with gaps (${reason}):`, lastMorningRefreshError);
  })();

  try {
    await refreshPromise;
  } catch (error) {
    lastMorningRefreshAt = new Date().toISOString();
    lastMorningRefreshStatus = "error";
    lastMorningRefreshError = getErrorMessage(error);
    console.warn(`Refresh failed (${reason}):`, lastMorningRefreshError);
  } finally {
    refreshPromise = null;
  }
}

async function ensureFreshModelData() {
  const lastRefreshTime = lastMorningRefreshAt ? Date.parse(lastMorningRefreshAt) : 0;
  const stats = getCurrentStats();
  const csvTimes = [stats.sourceFiles.batterCsvUpdatedAt, stats.sourceFiles.pitcherCsvUpdatedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value));
  const oldestCsv = csvTimes.length ? Math.min(...csvTimes) : 0;
  const refreshAge = lastRefreshTime ? Date.now() - lastRefreshTime : Number.POSITIVE_INFINITY;
  const csvIsStale = !oldestCsv || Date.now() - oldestCsv > SOURCE_STALE_MS;
  if (!lastRefreshTime || refreshAge > MODEL_DATA_MAX_AGE_MS || (csvIsStale && refreshAge > SEARCH_CACHE_MS)) {
    await runMorningRefresh("stale");
  }
}

function scheduleMorningRefresh() {
  const now = new Date();
  const next = nextMorningRefresh(now);

  nextMorningRefreshAt = next.toISOString();
  const delay = Math.max(1000, next.getTime() - now.getTime());
  setTimeout(async () => {
    await runMorningRefresh("scheduled");
    scheduleMorningRefresh();
  }, delay);
}

async function chooseBestGeneralBet(game: MatchedGameContext) {
  const firstInning = await firstInningProjection(game);
  const winnerBreakdown = await buildWinnerBreakdown(game);
  const winner = winnerPrediction(game, winnerBreakdown);
  const firstInningReport = firstInningPerformance();
  const winnerEdge = winner.probabilityEdge;
  const total = firstInning.total;
  const nrfiModelScore = firstInning.nrfiScore;
  const firstInningPick = firstInning.pick;
  const firstInningModelScore = firstInning.pickScore;
  const firstInningQuality = firstInning.dataQuality;
  const firstInningPriceAvailable = false;
  const firstInningQualified = firstInningPriceAvailable
    && firstInningReport.approved
    && firstInningQuality >= 0.85
    && Math.abs(nrfiModelScore - 58) >= 3;
  const winnerConfidence = winner.confidence;

  if (firstInningQualified) {
    return {
      type: firstInningPick,
      tag: recommendation(firstInningModelScore, 62, 54),
      score: firstInningModelScore,
      confidence: firstInningModelScore,
      metricLabel: "model score",
      dataQuality: firstInningQuality,
      validated: true,
      reason: `The first-inning system has passed its prospective accuracy gate, this matchup clears its evidence and score thresholds, and an actionable first-inning market price is available${total !== null ? `; the game total is **${formatNumber(total, 1)}**` : ""}.`
    };
  }

  return {
    type: "Winner",
    tag: recommendation(winnerConfidence, 62, 56),
    score: winnerEdge,
    confidence: winnerConfidence,
    metricLabel: "calibrated win probability",
    dataQuality: winner.dataQuality,
    validated: winner.validatedStrong,
    reason: winner.validatedStrong
      ? `The independently approved winner models agree on **${winner.pick}** at **${formatNumber(winner.confidence)}%**.`
      : `The strongest available watchlist lean is **${winner.pick}** at **${formatNumber(winner.confidence)}%**. ${firstInningReport.approved ? "First-inning accuracy is approved, but no actionable NRFI/YRFI price is available" : `First-inning accuracy remains unapproved (${firstInningReport.gradedCount}/${firstInningReport.minimumGraded} minimum graded)`}, so that market is not being promoted as a best bet.`
  };
}

async function analyzePitcherStrikeouts(pitcher: PitcherStat, lineup: BatterStat[]) {
  const [recentPitchers, recentBatters] = await Promise.all([loadRecentPitcherStats(), loadRecentBatterStats()]);
  const recentPitcher = recentPitchers.get(normalizeName(statDisplayName(pitcher["last_name, first_name"]))) || null;
  const lineupK = lineup.length ? average(lineup.map((batter) => {
    const recent = recentBatters.get(normalizeName(statDisplayName(batter["last_name, first_name"]))) || null;
    return recent?.kPercent ?? batter.k_percent;
  })) : null;
  const score = rankPitcherForKs(pitcher, lineup, recentPitcher, recentBatters);
  const pick = score >= 60 ? "Over" : "Under";

  return [
    `**${statDisplayName(pitcher["last_name, first_name"])} strikeout outlook**`,
    `${sampleTag(pitcher.pa)} season K% **${formatNumber(pitcher.k_percent)}**, 30-day K% **${formatNumber(recentPitcher?.kPercent ?? pitcher.k_percent)}**, whiff **${formatNumber(pitcher.whiff_percent)}%**, chase-miss **${formatNumber(pitcher.out_zone_swing_miss, 0)}**, swords **${formatNumber(pitcher.swords, 0)}**.`,
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
  const projection = await firstInningProjection(game);
  const pick = projection.pick;
  const report = firstInningPerformance();

  return [
    `**${game.away} @ ${game.home} NRFI/YRFI outlook**`,
    `${game.away} first-inning scoring threat vs ${game.homePitcher ? statDisplayName(game.homePitcher["last_name, first_name"]) : game.home + " starter"}: **${formatNumber(projection.awayHalf)}**.`,
    `${game.home} first-inning scoring threat vs ${game.awayPitcher ? statDisplayName(game.awayPitcher["last_name, first_name"]) : game.away + " starter"}: **${formatNumber(projection.homeHalf)}**.`,
    `Combined first-inning model score: **${formatNumber(projection.nrfiScore)}**${projection.totalAdjustment ? ` (raw **${formatNumber(projection.rawCombinedScore)}**, adjusted **${projection.totalAdjustment > 0 ? "+" : ""}${formatNumber(projection.totalAdjustment)}** for the **${formatNumber(projection.total || 0, 1)}** game total)` : ""}. This is a ranking score, not a win probability.`,
    "NRFI requires both the top half and the bottom half to stay scoreless, so this recommendation is combining both sides of the inning instead of grading only one pitcher.",
    `Prospective validation: **${report.gradedCount}** graded, **${report.accuracy === null ? "n/a" : formatNumber(report.accuracy * 100) + "%"}** accuracy; accuracy approval is **${report.approved ? "active" : "not active"}**. An offered price is still required to determine betting value.`,
    `${projection.awayHalf >= 58 && projection.homeHalf >= 58 ? "Both halves clear the bar for a cleaner first inning." : "One side of the inning is introducing enough run risk to weaken the full NRFI case."}`,
    `${recommendation(projection.nrfiScore, 62, 54)} Recommendation: **${pick}**. ${pick === "NRFI" ? "Both halves are strong enough to back a scoreless full first inning." : "The full first inning is too vulnerable, so YRFI is the better side."}`
  ].join("\n\n");
}

async function analyzeWinner(game: MatchedGameContext) {
  const breakdown = await buildWinnerBreakdown(game);
  const prediction = winnerPrediction(game, breakdown);
  const edge = prediction.probabilityEdge;
  const lean = prediction.pick;
  const tag = recommendation(prediction.confidence, 62, 56);
  const oddsLine = breakdown.odds
    ? `${breakdown.odds.bookmaker} odds: away **${breakdown.odds.awayMoneyline ?? "n/a"}**, home **${breakdown.odds.homeMoneyline ?? "n/a"}**${breakdown.odds.total !== null ? `, total **${formatNumber(breakdown.odds.total, 1)}**` : ""}.`
    : "No live odds snapshot was available, so this is purely model-driven.";

    return [
      `**${game.away} @ ${game.home} winner outlook**`,
      `${game.away} weighted rating: **${formatNumber(breakdown.awayScore)}**. Offense **${formatNumber(breakdown.awayOffense)}** (${formatNumber(breakdown.weights.offense * 100, 0)}%), starter **${formatNumber(breakdown.awayPitching)}** (${formatNumber(breakdown.weights.starter * 100, 0)}%), bullpen **${formatNumber(breakdown.awayBullpenRating)}** (${formatNumber(breakdown.weights.bullpen * 100, 0)}%), trend **${formatNumber(breakdown.awayTrendRating)}** (${formatNumber(breakdown.weights.trend * 100, 0)}%, decay-weighted RD **${formatNumber(breakdown.awayTrend.weightedRecent)}**), win-prob **${formatNumber(breakdown.awayWinProbRating)}** (10%), defense **${formatNumber(breakdown.awayDefenseRating)}** (5%), park **${formatNumber(breakdown.awayParkRating)}** (2%).`,
      `${game.home} weighted rating: **${formatNumber(breakdown.homeScore)}**. Offense **${formatNumber(breakdown.homeOffense)}** (${formatNumber(breakdown.weights.offense * 100, 0)}%), starter **${formatNumber(breakdown.homePitching)}** (${formatNumber(breakdown.weights.starter * 100, 0)}%), bullpen **${formatNumber(breakdown.homeBullpenRating)}** (${formatNumber(breakdown.weights.bullpen * 100, 0)}%), trend **${formatNumber(breakdown.homeTrendRating)}** (${formatNumber(breakdown.weights.trend * 100, 0)}%, decay-weighted RD **${formatNumber(breakdown.homeTrend.weightedRecent)}**), win-prob **${formatNumber(breakdown.homeWinProbRating)}** (10%), defense **${formatNumber(breakdown.homeDefenseRating)}** (5%), park **${formatNumber(breakdown.homeParkRating)}** (2%).`,
      `${game.away} bullpen: season ERA **${formatNumber(breakdown.awayBullpen?.seasonEra || 0, 2)}**, WHIP **${formatNumber(breakdown.awayBullpen?.seasonWhip || 0, 2)}**, 14-day ERA **${formatNumber(breakdown.awayBullpen?.recent14Era || 0, 2)}**, three-day pitches **${formatNumber(breakdown.awayBullpen?.pitchesLast3 || 0, 0)}**, fatigue penalty **${formatNumber(breakdown.awayBullpen?.fatiguePenalty || 0)}**. ${game.home} bullpen: season ERA **${formatNumber(breakdown.homeBullpen?.seasonEra || 0, 2)}**, WHIP **${formatNumber(breakdown.homeBullpen?.seasonWhip || 0, 2)}**, 14-day ERA **${formatNumber(breakdown.homeBullpen?.recent14Era || 0, 2)}**, three-day pitches **${formatNumber(breakdown.homeBullpen?.pitchesLast3 || 0, 0)}**, fatigue penalty **${formatNumber(breakdown.homeBullpen?.fatiguePenalty || 0)}**.`,
      `Park context: **${breakdown.parkFactor?.venueName || game.home}** wOBA index **${formatNumber(breakdown.parkFactor?.indexWoba || 100, 0)}**, runs index **${formatNumber(breakdown.parkFactor?.indexRuns || 100, 0)}**. Hitter-friendlier parks slightly help the better offense; suppressive parks slightly help the better run-prevention profile.`,
      `${game.away} defense details: **${formatNumber(breakdown.awayDefense?.score || 0)}**${breakdown.awayDefense ? ` (Fld% **${formatNumber(breakdown.awayDefense.fieldingPct, 3)}**, errors **${formatNumber(breakdown.awayDefense.errors, 0)}**)` : ""}. ${game.home} defense details: **${formatNumber(breakdown.homeDefense?.score || 0)}**${breakdown.homeDefense ? ` (Fld% **${formatNumber(breakdown.homeDefense.fieldingPct, 3)}**, errors **${formatNumber(breakdown.homeDefense.errors, 0)}**)` : ""}.`,
      `${game.away} win-prob details: batting **${formatNumber(breakdown.awayBattingImpact?.score || 0)}** / pitching **${formatNumber(breakdown.awayPitchingImpact?.score || 0)}**. ${game.home} win-prob details: batting **${formatNumber(breakdown.homeBattingImpact?.score || 0)}** / pitching **${formatNumber(breakdown.homePitchingImpact?.score || 0)}**.`,
      oddsLine,
      `Prediction engine: **${prediction.method}**. Conservative win-probability estimate: **${formatNumber(prediction.confidence)}%** for ${lean}. The statistical core preferred **${prediction.heuristicPick}**${breakdown.marketLean ? ` and the no-vig market side is **${breakdown.marketLean}**` : ""}.`,
      `Evidence quality: **${formatNumber(prediction.dataQuality * 100, 0)}%**${prediction.dataQualityNotes.length ? ` (${prediction.dataQualityNotes.join(", ")})` : " (complete)"}. Missing evidence shrinks certainty toward 50% but does not replace the model's preferred side.`,
      `The statistical core is offense ${formatNumber(breakdown.weights.offense * 100, 0)}%, total pitching 30% (starter ${formatNumber(breakdown.weights.starter * 100, 0)}% + bullpen ${formatNumber(breakdown.weights.bullpen * 100, 0)}%), recency/trend ${formatNumber(breakdown.weights.trend * 100, 0)}%, win-probability 10%, defense 5%, and park 2%. When regression is paused and odds exist, that core supplies 85% of the final probability and the no-vig market supplies a bounded 15% sanity check.`,
    `${game.awayBatters.length && game.homeBatters.length ? "This read is using matched lineup bats from the selected game context." : "Lineup coverage is partial, so treat this as a softer lean."}`,
    `${tag} Recommendation: **${lean}** moneyline at **${formatNumber(prediction.confidence)}%** model confidence. ${prediction.validatedStrong ? "This clears the dual-model rolling-forward best-bet tier." : "This is a full-slate projection, not a validated high-confidence best bet."}`
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

async function topPitcherList(mode: "strikeouts" | "nrfi") {
  const stats = getCurrentStats();
  const recentPitchers = mode === "strikeouts" ? await loadRecentPitcherStats() : new Map<string, RecentPitcherStat>();
  const ranked = stats.pitchers
    .map((pitcher) => ({
      pitcher,
      score: mode === "strikeouts"
        ? rankPitcherForKs(pitcher, [], recentPitchers.get(normalizeName(statDisplayName(pitcher["last_name, first_name"]))) || null)
        : rankPitcherForNrfi(pitcher, [])
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
        const projection = await firstInningProjection(matched);
        return {
          game,
          matched,
          projection
        };
      })))
      .filter(({ matched }) => matched.awayPitcher || matched.homePitcher || matched.awayBatters.length || matched.homeBatters.length)
      .sort((a, b) => b.projection.nrfiScore - a.projection.nrfiScore)
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
      `First-inning recommendations are currently **${firstInningPerformance().approved ? "prospectively approved" : "watchlist-only while results accumulate"}**. Scores below are ranking scores, not probabilities.`,
      ...ranked.map(({ matched, projection }, index) => {
        return `${index + 1}. **${matched.away} @ ${matched.home}**: top half **${formatNumber(projection.awayHalf)}**, bottom half **${formatNumber(projection.homeHalf)}**, combined model score **${formatNumber(projection.nrfiScore)}**. Lean: **${projection.pick}**.`;
      }),
      `${recommendation(ranked[0].projection.nrfiScore, 62, 54)} Recommendation: **${ranked[0].projection.pick} on ${ranked[0].matched.away} @ ${ranked[0].matched.home}** is the strongest full first-inning angle from the live slate.`
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
        const prediction = winnerPrediction(matched, breakdown);

        return {
          matched,
          pick: prediction.pick,
          confidence: prediction.confidence,
          method: prediction.method,
          dataQuality: prediction.dataQuality
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
      ...ranked.map(({ matched, pick, confidence, method, dataQuality }, index) =>
        `${index + 1}. **${matched.away} @ ${matched.home}** -> **${pick}** moneyline. Calibrated win probability **${formatNumber(confidence)}%** via ${method}; evidence quality **${formatNumber(dataQuality * 100, 0)}%**.`
      ),
      `${recommendation(ranked[0].confidence, 62, 56)} Strongest winner lean on the current slate: **${ranked[0].pick}** in **${ranked[0].matched.away} @ ${ranked[0].matched.home}** at **${formatNumber(ranked[0].confidence)}%**.`
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
        const winner = winnerPrediction(matched, winnerBreakdown);

        return {
          matched,
          bestBet,
          winnerPick: winner.pick
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

    const qualifiesStrongly = ({ bestBet }: typeof ranked[number]) =>
      bestBet.validated
      && bestBet.dataQuality >= 0.85
      && (bestBet.type === "Winner" ? bestBet.confidence >= 58 : bestBet.confidence >= 66);
    const qualifies = ({ bestBet }: typeof ranked[number]) =>
      bestBet.validated
      && bestBet.dataQuality >= 0.72
      && (bestBet.type === "Winner" ? bestBet.confidence >= 55 : bestBet.confidence >= 60);
    let selected = ranked.filter(qualifiesStrongly).slice(0, 8);
    if (!selected.length) {
      selected = ranked.filter(qualifies).slice(0, 5);
    }
    if (!selected.length) {
      selected = ranked.slice(0, 1);
    }
    const hasValidatedSelection = selected.some(({ bestBet }) => bestBet.validated);

    return [
      "**Best bets today**",
      hasValidatedSelection
        ? `Returning **${selected.length}** prospectively validated slate play${selected.length === 1 ? "" : "s"}.`
        : "No play clears a prospectively validated betting tier today. Showing one watchlist lean so the model still answers, but it is not labeled a recommended wager.",
      ...selected.map(({ matched, bestBet, winnerPick }, index) => {
        const market = bestBet.type === "Winner" ? `${winnerPick} moneyline` : bestBet.type;
        return `${index + 1}. **${matched.away} @ ${matched.home}** -> **${market}**. ${bestBet.metricLabel} **${formatNumber(bestBet.confidence)}${bestBet.type === "Winner" ? "%" : ""}**; evidence quality **${formatNumber(bestBet.dataQuality * 100, 0)}%**. ${bestBet.reason}`;
      }),
      `${selected[0].bestBet.tag} ${hasValidatedSelection ? "Strongest approved slate angle" : "Strongest watchlist lean"}: **${selected[0].bestBet.type === "Winner" ? selected[0].winnerPick + " moneyline" : selected[0].bestBet.type}** in **${selected[0].matched.away} @ ${selected[0].matched.home}**.`
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
  const messageGame = await inferMatchedGameFromMessage(message);
  const matchedGame = messageGame || (gameContext ? matchGameContext(gameContext) : null);
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
        `${bestBet.tag} ${bestBet.validated ? "Validated recommendation" : "Watchlist lean"}: **${bestBet.type}**.`
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
      `${bestBet.tag} ${bestBet.validated ? "Validated recommendation" : "Watchlist lean"}: **${bestBet.type}**.`
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
  const selectiveProductionModel = readProductionSelectiveRegressionModel();
  const candidateModel = readCandidateRegressionModel();
  const storage = getStorageStatus();
  const weights = winnerWeights();
  const now = Date.now();
  const csvFreshness = {
    batterAgeHours: stats.sourceFiles.batterCsvUpdatedAt ? (now - Date.parse(stats.sourceFiles.batterCsvUpdatedAt)) / 3_600_000 : null,
    pitcherAgeHours: stats.sourceFiles.pitcherCsvUpdatedAt ? (now - Date.parse(stats.sourceFiles.pitcherCsvUpdatedAt)) / 3_600_000 : null,
    staleAfterHours: SOURCE_STALE_MS / 3_600_000
  };
  res.json({
    ok: true,
    anthropicConfigured: true,
    analysisMode: "local",
    analysisVersion: ANALYSIS_VERSION,
    publicSourceCount: 10,
    oddsSourceConfigured: Boolean(cleanText(process.env.ODDS_API_KEY || "")),
    oddsSourceError: oddsLastError,
    oddsBookmaker: ODDS_BOOKMAKER,
    oddsFallback: "RotoWire listed moneyline (estimated no-vig)",
    rotowireMarketShrink: ROTOWIRE_MARKET_SHRINK,
    fallbackMarketWeight: FALLBACK_MARKET_WEIGHT,
    statCounts: {
      batters: stats.batters.length,
      pitchers: stats.pitchers.length
    },
    statCoverage: stats.coverage,
    csvSources: stats.sourceFiles,
    csvFreshness,
    winnerWeights: weights,
    sourceHealth: sourceHealth(),
    firstInning: firstInningPerformance(),
    regression: {
      productionModel: Boolean(productionModel),
      selectiveProductionModel: Boolean(selectiveProductionModel),
      candidateModel: Boolean(candidateModel),
      lastReportAt: regressionReport?.generatedAt || null,
      trainingRows: regressionReport?.trainingRows || 0,
      promotedCandidate: regressionReport?.promotedCandidate || false,
      productionApproved: regressionReport?.productionApproved ?? null,
      selectiveProductionApproved: regressionReport?.selectiveProductionApproved ?? null,
      selectiveWalkForwardMetrics: regressionReport?.selectiveWalkForwardMetrics || null,
      selectiveQualifiedMetrics: regressionReport?.selectiveQualifiedMetrics || null,
      selectiveRecentQualifiedMetrics: regressionReport?.selectiveRecentQualifiedMetrics || null,
      recentWalkForwardMetrics: regressionReport?.recentWalkForwardMetrics || null,
      recentQualifiedMetrics: regressionReport?.recentQualifiedMetrics || null,
      recentForcedMetrics: regressionReport?.recentForcedMetrics || null,
      recentHeuristicMetrics: regressionReport?.recentHeuristicMetrics || null,
      recentValidationStartDate: regressionReport?.recentValidationStartDate || null,
      recentValidationExcludedDate: regressionReport?.recentValidationExcludedDate || null,
      approvalGate: {
        recentSlates: RECENT_VALIDATION_DATES,
        minimumRecentGames: RECENT_APPROVAL_MIN_GAMES,
        minimumRecentAccuracy: RECENT_APPROVAL_MIN_ACCURACY,
        minimumHeuristicLift: MODEL_APPROVAL_MIN_LIFT,
        qualifiedConfidenceThreshold: QUALIFIED_CONFIDENCE_THRESHOLD,
        minimumQualifiedGames: QUALIFIED_APPROVAL_MIN_GAMES,
        minimumQualifiedAccuracy: QUALIFIED_APPROVAL_MIN_ACCURACY,
        requiresBetterLogLoss: true,
        requiresNoWorseBrierScore: true
      },
      parkFactorCoverage: regressionReport?.parkFactorCoverage || null,
      bullpenCoverage: regressionReport?.bullpenCoverage || null
    },
    storage,
    refresh: {
      morningRefreshHourLocal: `${String(MORNING_REFRESH_HOUR).padStart(2, "0")}:${String(MORNING_REFRESH_MINUTE).padStart(2, "0")}`,
      morningRefreshTimeZone: MORNING_REFRESH_TIME_ZONE,
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
      sourceError: oddsLastError,
      fallback: "RotoWire listed moneylines are used in winner analysis when primary odds are unavailable.",
      games: odds
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: getErrorMessage(error) });
  }
});

app.get("/api/lineups", async (_req, res) => {
  try {
    const payload = await loadDailyLineups();
    const snapshotDate = mlbCalendarDate();
    const matchedGames = payload.games.map((game) => matchGameCard(game));
    try {
      await snapshotWinnerFeaturesForGames(matchedGames, snapshotDate);
      await snapshotFirstInningFeaturesForGames(matchedGames, snapshotDate);
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

app.post("/api/data/refresh", async (_req, res) => {
  await runMorningRefresh("manual");
  res.json({
    ok: lastMorningRefreshStatus !== "error",
    status: lastMorningRefreshStatus,
    refreshedAt: lastMorningRefreshAt,
    error: lastMorningRefreshError,
    sources: sourceHealth()
  });
});

app.get("/api/regression/report", (_req, res) => {
  const report = readRegressionReport();
  const productionModel = readProductionRegressionModel();
  const selectiveProductionModel = readProductionSelectiveRegressionModel();
  const candidateModel = readCandidateRegressionModel();
  const storage = getStorageStatus();
  res.json({
    ok: true,
    report,
    productionModel,
    selectiveProductionModel,
    candidateModel,
    featureRows: readWinnerFeatureSnapshots().length,
    resultRows: readWinnerResults().length,
    storage,
    refresh: {
      morningRefreshHourLocal: `${String(MORNING_REFRESH_HOUR).padStart(2, "0")}:${String(MORNING_REFRESH_MINUTE).padStart(2, "0")}`,
      morningRefreshTimeZone: MORNING_REFRESH_TIME_ZONE,
      nextMorningRefreshAt,
      lastMorningRefreshAt,
      lastMorningRefreshStatus,
      lastMorningRefreshError
    }
  });
});

app.get("/api/first-inning/history", async (req, res) => {
  const requestedDays = Number.parseInt(String(req.query.days || "30"), 10);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(365, requestedDays)) : 30;
  const today = mlbCalendarDate();
  const cutoff = shiftIsoDate(today, -(days - 1));
  try {
    await refreshRecentWinnerScoreboard();
  } catch (error) {
    console.warn("First-inning result reconciliation failed; serving stored results:", getErrorMessage(error));
  }
  const results = new Map(readFirstInningResults().map((result) => [result.gameId, result]));
  const games = readFirstInningFeatureSnapshots()
    .filter((snapshot) => snapshot.snapshotDate >= cutoff)
    .map((snapshot) => {
      const result = results.get(snapshot.gameId) || null;
      const actualPick = result ? (result.nrfiHit ? "NRFI" : "YRFI") : null;
      return {
        ...snapshot,
        status: result ? "graded" : snapshot.snapshotDate < today ? "stale" : "pending",
        awayFirstRuns: result?.awayFirstRuns ?? null,
        homeFirstRuns: result?.homeFirstRuns ?? null,
        actualPick,
        correct: actualPick ? snapshot.pick === actualPick : null
      };
    })
    .sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate) || a.gameId.localeCompare(b.gameId));
  res.json({ ok: true, days, performance: firstInningPerformance(), games });
});

app.get("/api/recommendations/history", async (req, res) => {
  const requestedDays = Number.parseInt(String(req.query.days || "14"), 10);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(365, requestedDays)) : 14;
  const todayDate = mlbCalendarDate();
  const todayTime = Date.parse(`${todayDate}T00:00:00Z`);
  const cutoff = new Date(todayTime);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));

  let recentScoreboard: WinnerScoreboard | null = null;
  try {
    recentScoreboard = await refreshRecentWinnerScoreboard();
  } catch (error) {
    console.warn("Winner result reconciliation failed; serving stored results:", getErrorMessage(error));
  }

  const results = readWinnerResults();
  const resultsByGameId = new Map(results.map((result) => [result.gameId, result]));
  const resultsByMatchup = results.reduce<Map<string, typeof results>>((groups, result) => {
    const key = `${result.away}_${result.home}`;
    const matchupResults = groups.get(key) || [];
    matchupResults.push(result);
    groups.set(key, matchupResults);
    return groups;
  }, new Map());
  const statusesByGameId = new Map((recentScoreboard?.statuses || []).map((status) => [status.gameId, status]));

  const games = readWinnerFeatureSnapshots()
    .filter((snapshot) => {
      const snapshotTime = Date.parse(`${snapshot.snapshotDate}T00:00:00Z`);
      return Number.isFinite(snapshotTime) && snapshotTime >= cutoff.getTime();
    })
    .map((snapshot) => {
      const exactResult = resultsByGameId.get(snapshot.gameId) || null;
      const snapshotTime = Date.parse(`${snapshot.snapshotDate}T00:00:00Z`);
      const currentStatus = statusesByGameId.get(snapshot.gameId) || null;
      const isPast = snapshotTime < todayTime;
      const nearbyResult = !exactResult && isPast
        ? (resultsByMatchup.get(`${snapshot.away}_${snapshot.home}`) || [])
          .map((result) => ({
            result,
            distanceDays: Math.abs(Date.parse(`${result.date}T00:00:00Z`) - snapshotTime) / 86_400_000
          }))
          .filter((candidate) => candidate.distanceDays <= 7)
          .sort((a, b) => a.distanceDays - b.distanceDays || b.result.date.localeCompare(a.result.date))[0]?.result || null
        : null;
      const displayedResult = exactResult || nearbyResult;
      const status = exactResult
        ? "graded"
        : currentStatus?.state === "live"
          ? "live"
          : currentStatus?.state === "postponed"
            ? "postponed"
            : isPast
              ? "stale"
              : "pending";
      const actualWinner = displayedResult ? (displayedResult.homeWin ? displayedResult.home : displayedResult.away) : null;
      const displayedScore = displayedResult
        ? `${displayedResult.awayScore}-${displayedResult.homeScore}`
        : currentStatus?.state === "live"
          && currentStatus.awayScore !== null && currentStatus.awayScore !== undefined
          && currentStatus?.homeScore !== null && currentStatus?.homeScore !== undefined
          ? `${currentStatus.awayScore}-${currentStatus.homeScore}`
          : null;
      const analysisVersion = snapshot.analysisVersion || "legacy";
      const legacySnapshot = analysisVersion === "legacy" || snapshot.predictionMethod === "legacy snapshot";
      return {
        date: snapshot.snapshotDate,
        gameId: snapshot.gameId,
        away: snapshot.away,
        home: snapshot.home,
        predictedWinner: snapshot.predictionPick || snapshot.heuristicPick,
        status,
        correct: exactResult ? (snapshot.predictionPick || snapshot.heuristicPick) === actualWinner : null,
        actualWinner,
        resultDate: displayedResult?.date || null,
        finalScore: displayedScore,
        gameStateDetail: currentStatus?.detailedState || null,
        edge: snapshot.heuristicEdge,
        confidence: legacySnapshot ? null : snapshot.predictionConfidence ?? snapshot.heuristicConfidence,
        legacyStrengthScore: legacySnapshot ? snapshot.heuristicConfidence : null,
        confidenceKind: legacySnapshot ? "legacy-strength-score" : "pick-probability",
        predictionMethod: snapshot.predictionMethod || "legacy snapshot",
        marketWeight: snapshot.marketWeight ?? null,
        marketLean: snapshot.marketLean,
        dataQuality: snapshot.dataQuality ?? null,
        dataQualityNotes: snapshot.dataQualityNotes ?? [],
        analysisVersion
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.gameId.localeCompare(b.gameId));

  const graded = games.filter((game) => game.status === "graded");
  const stale = games.filter((game) => game.status === "stale");
  const correctCount = graded.filter((game) => game.correct).length;
  const marketGraded = graded.filter((game) => game.marketLean);
  const marketCorrectCount = marketGraded.filter((game) => game.marketLean === game.actualWinner).length;
  const byAnalysisVersion = Object.values(graded.reduce<Record<string, { version: string; gradedCount: number; correctCount: number }>>((groups, game) => {
    const version = game.analysisVersion || "legacy";
    if (!groups[version]) groups[version] = { version, gradedCount: 0, correctCount: 0 };
    groups[version].gradedCount += 1;
    if (game.correct) groups[version].correctCount += 1;
    return groups;
  }, {})).map((group) => ({
    ...group,
    accuracy: group.gradedCount ? group.correctCount / group.gradedCount : null
  }));
  const cohortSummary = (cohortGames: typeof graded) => {
    const cohortCorrect = cohortGames.filter((game) => game.correct).length;
    const cohortMarket = cohortGames.filter((game) => game.marketLean);
    const cohortMarketCorrect = cohortMarket.filter((game) => game.marketLean === game.actualWinner).length;
    return {
      gradedCount: cohortGames.length,
      correctCount: cohortCorrect,
      accuracy: cohortGames.length ? cohortCorrect / cohortGames.length : null,
      marketGradedCount: cohortMarket.length,
      marketCorrectCount: cohortMarketCorrect,
      marketAccuracy: cohortMarket.length ? cohortMarketCorrect / cohortMarket.length : null
    };
  };
  const prospectiveGraded = graded.filter((game) => game.analysisVersion !== "legacy");
  const legacyGraded = graded.filter((game) => game.analysisVersion === "legacy");

  res.json({
    ok: true,
    days,
    summary: {
      totalCount: games.length,
      gradedCount: graded.length,
      correctCount,
      staleCount: stale.length,
      pendingCount: games.filter((game) => game.status === "pending").length,
      liveCount: games.filter((game) => game.status === "live").length,
      postponedCount: games.filter((game) => game.status === "postponed").length,
      accuracy: graded.length ? correctCount / graded.length : null,
      marketGradedCount: marketGraded.length,
      marketCorrectCount,
      marketAccuracy: marketGraded.length ? marketCorrectCount / marketGraded.length : null,
      prospective: cohortSummary(prospectiveGraded),
      legacy: cohortSummary(legacyGraded),
      byAnalysisVersion
    },
    games
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    await ensureFreshModelData();
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
  setInterval(() => {
    refreshRecentWinnerScoreboard(true).catch((error) => {
      console.warn("Scheduled winner result reconciliation failed:", getErrorMessage(error));
    });
  }, WINNER_SCOREBOARD_CACHE_MS);
});
