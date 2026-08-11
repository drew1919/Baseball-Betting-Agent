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
const ANALYSIS_VERSION = "models-v7-bullpen-recency";
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

type TeamRecentForm = {
  teamKey: string;
  games: number;
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
  return whole * 3 + partialÛŞµæÚ$z{-®éÜj×’vÖW2FöF’¢¢"À¢’6÷VÆBæ÷BÆöBF†RÆ—fR6ÆFR§W7Bæ÷s¢G¶vWDW'&÷$ÖW76vR†W'&÷"—ÒæÀ¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¥6VÆV7BvÖRf—'7B¢¢æB’v–ÆÂw&FRF†RgVÆÂf—'7B–ææ–ærg&öÒ&÷F‚†ÇfW2â ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ§Ğ ¦7–æ2gVæ7F–öâF÷v–ææW$vÖW4g&öÕ6ÆFR‚’°¢G'’°¢6öç7B–ÆöBÒv—BÆöDF–Ç”Æ–æWW2‚“°¢6öç7B&æ¶VBÒ†v—B&öÖ—6RæÆÂ‡–ÆöBævÖW2æÖ†7–æ2†vÖR’Óâ°¢6öç7BÖF6†VBÒÖF6„vÖT6&B†vÖR“°¢6öç7B'&V¶F÷vâÒv—B'V–ÆEv–ææW$'&V¶F÷vâ†ÖF6†VB“° ¢&WGW&â°¢ÖF6†VBÀ¢–6³¢'&V¶F÷vâæÆVâÀ¢6öæf–FVæ6S¢ÖF‚æ'2†'&V¶F÷vâæVFvR¢Ó°¢Ò’’¢æf–ÇFW"‚‡²ÖF6†VBÒ’ÓâÖF6†VBæv•—F6†W"ÇÂÖF6†VBæ†öÖU—F6†W"ÇÂÖF6†VBæv”&GFW'2æÆVæwF‚ÇÂÖF6†VBæ†öÖT&GFW'2æÆVæwF‚¢ç6÷'B‚†Â"’Óâ"æ6öæf–FVæ6RÒæ6öæf–FVæ6R“° ¢–b‚&æ¶VBæÆVæwF‚’°¢&WGW&â°¢"¢¥&ö¦V7FVBv–ææW'2FöF’¢¢"À¢$Æ—fRÆ–æWWÖF6†–ær—2FöòF†–â&–v‡Bæ÷rFò&æ²FöF’w2v–ææW'2g&öÒF†R7W'&VçB6ÆFRâ"À¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¤ÆöB÷"6VÆV7BvÖR¢¢6ò’6â&ö¦V7Bv–ææW"g&öÒF†RÖF6‡WFFâ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ ¢&WGW&â°¢"¢¥&ö¦V7FVBv–ææW'2FöF’¢¢"À¢ââç&æ¶VBæÖ‚‡²ÖF6†VBÂ–6²Â6öæf–FVæ6RÒÂ–æFW‚’Óà¢G¶–æFW‚²Òâ¢¢G¶ÖF6†VBæv—ÒG¶ÖF6†VBæ†öÖWÒ¢¢Óâ¢¢G·–6·Ò¢¢ÖöæW–Æ–æRâ6öæf–FVæ6R66÷&R¢¢G¶f÷&ÖDçVÖ&W"†6öæf–FVæ6R—Ò¢¢æ ¢’À¢G·&V6öÖÖVæFF–öâ‡&æ¶VE³Òæ6öæf–FVæ6R¢bÂ#BÂ"—Ò7G&öævW7Bv–ææW"ÆVâöâF†R7W'&VçB6ÆFS¢¢¢G·&æ¶VE³Òç–6·Ò¢¢–â¢¢G·&æ¶VE³ÒæÖF6†VBæv—ÒG·&æ¶VE³ÒæÖF6†VBæ†öÖWÒ¢¢æ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ò6F6‚†W'&÷"’°¢&WGW&â°¢"¢¥&ö¦V7FVBv–ææW'2FöF’¢¢"À¢’6÷VÆBæ÷BÆöBF†RÆ—fR6ÆFR§W7Bæ÷s¢G¶vWDW'&÷$ÖW76vR†W'&÷"—ÒæÀ¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¥6VÆV7BvÖRf—'7B¢¢æB’v–ÆÂ&ö¦V7BF†Rv–ææW"g&öÒF†RÆö6ÂÖF6‡WFFâ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ§Ğ ¦7–æ2gVæ7F–öâF÷&W7D&WG4g&öÕ6ÆFR‚’°¢G'’°¢6öç7B–ÆöBÒv—BÆöDF–Ç”Æ–æWW2‚“°¢6öç7B&æ¶VBÒ†v—B&öÖ—6RæÆÂ‡–ÆöBævÖW2æÖ†7–æ2†vÖR’Óâ°¢6öç7BÖF6†VBÒÖF6„vÖT6&B†vÖR“°¢6öç7B&W7D&WBÒv—B6†ö÷6T&W7DvVæW&Ä&WB†ÖF6†VB“°¢6öç7Bv–ææW$'&V¶F÷vâÒv—B'V–ÆEv–ææW$'&V¶F÷vâ†ÖF6†VB“° ¢&WGW&â°¢ÖF6†VBÀ¢&W7D&WBÀ¢v–ææW%–6³¢v–ææW$'&V¶F÷vâæÆVà¢Ó°¢Ò’’¢æf–ÇFW"‚‡²ÖF6†VBÒ’ÓâÖF6†VBæv•—F6†W"ÇÂÖF6†VBæ†öÖU—F6†W"ÇÂÖF6†VBæv”&GFW'2æÆVæwF‚ÇÂÖF6†VBæ†öÖT&GFW'2æÆVæwF‚¢ç6÷'B‚†Â"’Óâ"æ&W7D&WBæ6öæf–FVæ6RÒæ&W7D&WBæ6öæf–FVæ6R“° ¢–b‚&æ¶VBæÆVæwF‚’°¢&WGW&â°¢"¢¤&W7B&WG2FöF’¢¢"À¢$Æ—fRÆ–æWWÖF6†–ær—2FöòF†–â&–v‡Bæ÷rFò&æ²FöF’w27G&öævW7BÆ—2g&öÒF†R6ÆFRâ"À¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¤ÆöB÷"6VÆV7BvÖR¢¢6ò’6âf÷&6RF†R&W7Bf–Æ&ÆRævÆRâ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ ¢ÆWB6VÆV7FVBÒ&æ¶VBæf–ÇFW"‚‡²&W7D&WBÒ’Óâ&W7D&WBæ6öæf–FVæ6RãÒcb’ç6Æ–6RƒÂ‚“°¢–b‚6VÆV7FVBæÆVæwF‚’°¢6VÆV7FVBÒ&æ¶VBæf–ÇFW"‚‡²&W7D&WBÒ’Óâ&W7D&WBæ6öæf–FVæ6RãÒc’ç6Æ–6RƒÂR“°¢Ğ¢–b‚6VÆV7FVBæÆVæwF‚’°¢6VÆV7FVBÒ&æ¶VBç6Æ–6RƒÂ“°¢Ğ ¢&WGW&â°¢"¢¤&W7B&WG2FöF’¢¢"À¢&WGW&æ–ær¢¢G·6VÆV7FVBæÆVæwF‡Ò¢¢6ÆFRÆ’G·6VÆV7FVBæÆVæwF‚ÓÓÒò""¢'2'Ò&6VBöâF†RÖöFVÂw27G&öævW7B6öæf–FVæ6RF–W'2æÀ¢ââç6VÆV7FVBæÖ‚‡²ÖF6†VBÂ&W7D&WBÂv–ææW%–6²ÒÂ–æFW‚’Óâ°¢6öç7BÖ&¶WBÒ&W7D&WBçG—RÓÓÒ%v–ææW""òG·v–ææW%–6·ÒÖöæW–Æ–æV¢&W7D&WBçG—S°¢&WGW&âG¶–æFW‚²Òâ¢¢G¶ÖF6†VBæv—ÒG¶ÖF6†VBæ†öÖWÒ¢¢Óâ¢¢G¶Ö&¶WGÒ¢¢â6öæf–FVæ6R¢¢G¶f÷&ÖDçVÖ&W"†&W7D&WBæ6öæf–FVæ6R—Ò¢¢‚G¶6öæf–FVæ6UF–W"†&W7D&WBæ6öæf–FVæ6R—Ò’âG¶&W7D&WBç&V6öçÖ°¢Ò’À¢G·6VÆV7FVE³Òæ&W7D&WBçFwÒ7G&öævW7B÷fW&ÆÂ6ÆFRævÆS¢¢¢G·6VÆV7FVE³Òæ&W7D&WBçG—RÓÓÒ%v–ææW""ò6VÆV7FVE³Òçv–ææW%–6²²"ÖöæW–Æ–æR"¢6VÆV7FVE³Òæ&W7D&WBçG—WÒ¢¢–â¢¢G·6VÆV7FVE³ÒæÖF6†VBæv—ÒG·6VÆV7FVE³ÒæÖF6†VBæ†öÖWÒ¢¢æ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ò6F6‚†W'&÷"’°¢&WGW&â°¢"¢¤&W7B&WG2FöF’¢¢"À¢’6÷VÆBæ÷BÆöBF†RÆ—fR6ÆFR§W7Bæ÷s¢G¶vWDW'&÷$ÖW76vR†W'&÷"—ÒæÀ¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¥6VÆV7BvÖRf—'7B¢¢æB’v–ÆÂf÷&6RF†R7G&öævW7BævÆRg&öÒF†Rf–Æ&ÆRFFâ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ§Ğ ¦7–æ2gVæ7F–öâæÇ—¦TÆö6ÆÇ’‡°¢ÖW76vRÀ¢&WEG—RÀ¢vÖT6öçFW‡@§Ó¢°¢ÖW76vS¢7G&–æs°¢&WEG—S¢&WEG—S°¢vÖT6öçFW‡Có¢7G&–æs°§Ò’°¢6öç7Bæ÷&ÖÆ—¦VBÒæ÷&ÖÆ—¦VDÖW76vR†ÖW76vR“°¢6öç7BÖF6†VDvÖRÒvÖT6öçFW‡BòÖF6„vÖT6öçFW‡B†vÖT6öçFW‡B’¢çVÆÃ°¢6öç7B–æfW'&VDæÖRÒ–æfW%Æ–W$æÖTg&öÔÖW76vR†ÖW76vR“°¢6öç7B—F6†W"Ò–æfW'&VDæÖRòf–æE—F6†W%7FB†–æfW'&VDæÖR’¢çVÆÃ°¢6öç7B&GFW"Ò–æfW'&VDæÖRbb—F6†W"òf–æD&GFW%7FB†–æfW'&VDæÖR’¢çVÆÃ° ¢6öç7BvçG5v–ææW"Ò÷v–ææW'Çv–ææW'7ÆÖöæW–Æ–æWÇv†òv–ç7Çv†òv–çÇv–âFöF—Çv–ç2FöF—Ç&ö¦V7FVBv–ææW'Ç&ö¦V7FVBv–ææW'2òçFW7B†æ÷&ÖÆ—¦VB“°¢6öç7BvçG4ç&f’Òöç&f—Ç—&f—Æf—'7B–ææ–æwÆæò'Vâf—'7B–ææ–æwÇ'Vâf—'7B–ææ–æròçFW7B†æ÷&ÖÆ—¦VB“°¢6öç7BvçG57G&–¶V÷WG2Ò÷7G&–¶V÷WGÇ7G&–¶V÷WG7Æ·7Æ²&÷Ç—F6†W"²òçFW7B†æ÷&ÖÆ—¦VB“°¢6öç7BvçG4&W7D&WG2Òö&W7B&WGÆ&W7B&WG7ÇF÷&WGÇF÷&WG7Æ&W7BÆ—Æ&W7BÆ—7Æff÷&—FR&WG7Ç7G&öævW7B&WG7ÇFöF—2&WG7ÇFöF’2&WG2òçFW7B†æ÷&ÖÆ—¦VB“°¢6öç7BvçG56ÆFRÒ—56ÆFUv–FU&WVW7B†ÖW76vR“° ¢–b‡—F6†W"bb&WEG—RÓÓÒ'7G&–¶V÷WG2"’°¢6öç7B÷öæVçDÆ–æWWÒÖF6†VDvÖP¢òÖF6†VDvÖRæv•—F6†W#òçÆ–W%ö–BÓÓÒ—F6†W"çÆ–W%ö–@¢òÖF6†VDvÖRæ†öÖT&GFW'0¢¢ÖF6†VDvÖRæ†öÖU—F6†W#òçÆ–W%ö–BÓÓÒ—F6†W"çÆ–W%ö–@¢òÖF6†VDvÖRæv”&GFW'0¢¢µĞ¢¢µÓ°¢&WGW&âæÇ—¦U—F6†W%7G&–¶V÷WG2‡—F6†W"Â÷öæVçDÆ–æWW“°¢Ğ ¢–b‡—F6†W"bb&WEG—RÓÓÒ&ç&f’"’°¢–b†ÖF6†VDvÖRbb€¢ÖF6†VDvÖRæv•—F6†W#òçÆ–W%ö–BÓÓÒ—F6†W"çÆ–W%ö–@¢ÇÂÖF6†VDvÖRæ†öÖU—F6†W#òçÆ–W%ö–BÓÓÒ—F6†W"çÆ–W%ö–@¢’’°¢&WGW&âv—BæÇ—¦TgVÆÄ–ææ–ætç&f’†ÖF6†VDvÖR“°¢Ğ¢&WGW&âv—BF÷ç&f”vÖW4g&öÕ6ÆFR‚“°¢Ğ ¢–b‡vçG4&W7D&WG2bbvçG56ÆFRbbÖF6†VDvÖRbb—F6†W"bb&GFW"’°¢&WGW&âv—BF÷&W7D&WG4g&öÕ6ÆFR‚“°¢Ğ ¢–b‡vçG5v–ææW"bbvçG56ÆFRbbÖF6†VDvÖRbb—F6†W"bb&GFW"’°¢&WGW&âv—BF÷v–ææW$vÖW4g&öÕ6ÆFR‚“°¢Ğ ¢–b‡vçG4ç&f’bbvçG56ÆFRbbÖF6†VDvÖRbb—F6†W"bb&GFW"’°¢&WGW&âv—BF÷ç&f”vÖW4g&öÕ6ÆFR‚“°¢Ğ ¢–b‡vçG57G&–¶V÷WG2bbvçG56ÆFRbb—F6†W"bb&GFW"’°¢&WGW&âF÷—F6†W$Æ—7B‚'7G&–¶V÷WG2"“°¢Ğ ¢–b†&WEG—RÓÓÒ'v–ææW""bbÖF6†VDvÖR’°¢&WGW&âv—BæÇ—¦Uv–ææW"†ÖF6†VDvÖR“°¢Ğ ¢–b‡—F6†W"’°¢&WGW&â—F6†W"æµ÷W&6VçBãÒ#`¢òæÇ—¦U—F6†W%7G&–¶V÷WG2‡—F6†W"ÂµÒ¢¢æÇ—¦U—F6†W$ç&f’‡—F6†W"ÂµÒÂ'F†R÷÷6–ærÆ–æWW"“°¢Ğ ¢–b†&GFW"’°¢&WGW&âæÇ—¦T&GFW"†&GFW"Â&WEG—R“°¢Ğ ¢–b‚ö&W7Bâ¦·Æ&W7B—F6†W'7Ç7G&–¶V÷WBW6–FWÆ²—F6†W'2ö’çFW7B†ÖW76vR’ÇÂ‡vçG57G&–¶V÷WG2bbvçG56ÆFR’’°¢&WGW&âF÷—F6†W$Æ—7B‚'7G&–¶V÷WG2"“°¢Ğ ¢–b‡vçG4ç&f’’°¢–b†ÖF6†VDvÖR’°¢&WGW&âv—BæÇ—¦TgVÆÄ–ææ–ætç&f’†ÖF6†VDvÖR“°¢Ğ¢&WGW&âv—BF÷ç&f”vÖW4g&öÕ6ÆFR‚“°¢Ğ ¢–b†ÖF6†VDvÖRbb‡vçG5v–ææW"ÇÂ÷v–åÂöÆ÷72òçFW7B†æ÷&ÖÆ—¦VB’’’°¢&WGW&âv—BæÇ—¦Uv–ææW"†ÖF6†VDvÖR“°¢Ğ ¢–b‡vçG5v–ææW"’°¢&WGW&âv—BF÷v–ææW$vÖW4g&öÕ6ÆFR‚“°¢Ğ ¢–b‡vçG4&W7D&WG2’°¢–b†ÖF6†VDvÖR’°¢6öç7B&W7D&WBÒv—B6†ö÷6T&W7DvVæW&Ä&WB†ÖF6†VDvÖR“°¢&WGW&â°¢¢¤&W7B&WBf÷"G¶ÖF6†VDvÖRæv—ÒG¶ÖF6†VDvÖRæ†öÖWÒ¢¦À¢G¶&W7D&WBç&V6öçÖÀ¢G¶ÖF6†VDvÖRæv•—F6†W"ÇÂÖF6†VDvÖRæ†öÖU—F6†W"ò%F†—2—2W6–ærF†R6VÆV7FVBvÖRw2Æö6Â7FF67BÖF6‡W6öçFW‡Bâ"¢%F†—2—2W6–ærÆ–æWW×VÆ—G’6öçFW‡BWfVâF†÷Vv‚—F6†W"6÷fW&vR—2–æ6ö×ÆWFRâ'ÖÀ¢G¶&W7D&WBçFwÒ&V6öÖÖVæFF–öã¢¢¢G¶&W7D&WBçG—WÒ¢¢â—B—2F†R7G&öævW7Bf÷&6VBævÆRg&öÒF†Rf–Æ&ÆRFFæ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ¢&WGW&âv—BF÷&W7D&WG4g&öÕ6ÆFR‚“°¢Ğ ¢–b†ÖF6†VDvÖR’°¢6öç7B&W7D&WBÒv—B6†ö÷6T&W7DvVæW&Ä&WB†ÖF6†VDvÖR“°¢&WGW&â°¢¢¤&W7B&WBf÷"G¶ÖF6†VDvÖRæv—ÒG¶ÖF6†VDvÖRæ†öÖWÒ¢¦À¢G¶&W7D&WBç&V6öçÖÀ¢G¶ÖF6†VDvÖRæv•—F6†W"ÇÂÖF6†VDvÖRæ†öÖU—F6†W"ò%F†—2—2W6–ærF†R6VÆV7FVBvÖRw2Æö6Â7FF67BÖF6‡W6öçFW‡Bâ"¢%F†—2—2W6–ærÆ–æWW×VÆ—G’6öçFW‡BWfVâF†÷Vv‚—F6†W"6÷fW&vR—2–æ6ö×ÆWFRâ'ÖÀ¢G¶&W7D&WBçFwÒ&V6öÖÖVæFF–öã¢¢¢G¶&W7D&WBçG—WÒ¢¢â—B—2F†R7G&öævW7Bf÷&6VBævÆRg&öÒF†Rf–Æ&ÆRFFæ ¢Òæ¦ö–â‚%ÆåÆâ"“°¢Ğ ¢&WGW&â°¢"¢¤Æö6ÂæÇ—6—2ÖöFR¢¢"À¢%F†—2—2æ÷rç7vW&–ærg&öÒF†R'V–ÇBÖ–â7FF67B×7G–ÆRFF6WBÇW2ç’6VÆV7FVBÖF6‡W6öçFW‡BÂæ÷Bg&öÒ–BÖöFVÂ’â"À¢$’6âæÇ—¦R–æF—f–GVÂ—F6†W'2Â†—GFW'2Âå$d’õ•$d’7÷G2Â7G&–¶V÷WB&÷2ÂæBv–ææW"ÆVç2â6VÆV7BvÖRFò–×&÷fRÖF6‡W×7V6–f–2ç7vW'2â"À¢$vööB&ö×G3¢æÇ—¦R‡VçFW"'&÷vâ7G&–¶V÷WB&÷Âå$d’öâ6æG’Æ6çF&Âv†ò†2F†R&W7B²W6–FRFöF“öÂ÷"v†òv–ç2F†—2vÖSö"À¢%ÇTCƒ4EÇTDdS&V6öÖÖVæFF–öã¢¢¤6²f÷"F†R&W7B²—F6†W"FöF’¢¢Fò7F'Bg&öÒF†R7G&öævW7B7W'&VçBFF6WBÖ&6¶VBævÆRâ ¢Òæ¦ö–â‚%ÆåÆâ"“°§Ğ ¦ævWB‚"ö’ö†VÇF‚"Â…÷&WÂ&W2’Óâ°¢6öç7B7FG2ÒvWD7W'&VçE7FG2‚“°¢6öç7B&Vw&W76–öå&W÷'BÒ&VE&Vw&W76–öå&W÷'B‚“°¢6öç7B&öGV7F–öäÖöFVÂÒ&VE&öGV7F–öå&Vw&W76–öäÖöFVÂ‚“°¢6öç7B6æF–FFTÖöFVÂÒ&VD6æF–FFU&Vw&W76–öäÖöFVÂ‚“°¢6öç7B7F÷&vRÒvWE7F÷&vU7FGW2‚“°¢6öç7BvV–v‡G2Òv–ææW%vV–v‡G2‚“°¢6öç7Bæ÷rÒFFRææ÷r‚“°¢6öç7B77dg&W6†æW72Ò°¢&GFW$vT†÷W'3¢7FG2ç6÷W&6Tf–ÆW2æ&GFW$77eWFFVDBò†æ÷rÒFFRç'6R‡7FG2ç6÷W&6Tf–ÆW2æ&GFW$77eWFFVDB’’ò5ócó¢çVÆÂÀ¢—F6†W$vT†÷W'3¢7FG2ç6÷W&6Tf–ÆW2ç—F6†W$77eWFFVDBò†æ÷rÒFFRç'6R‡7FG2ç6÷W&6Tf–ÆW2ç—F6†W$77eWFFVDB’’ò5ócó¢çVÆÂÀ¢7FÆTgFW$†÷W'3¢4õU$4Uõ5DÄUôÕ2ò5ócó ¢Ó°¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢çF‡&÷–46öæf–wW&VC¢G'VRÀ¢æÇ—6—4ÖöFS¢&Æö6Â"À¢æÇ—6—5fW'6–öã¢äÅ•4•5õdU%4”ôâÀ¢V&Æ–56÷W&6T6÷VçC¢À¢öFG56÷W&6T6öæf–wW&VC¢&ööÆVâ†6ÆVåFW‡B‡&ö6W72æVçbäôDE5ô•ô´U’ÇÂ""’’À¢öFG4&öö¶Ö¶W#¢ôDE5ô$ôô´Ô´U"À¢7FD6÷VçG3¢°¢&GFW'3¢7FG2æ&GFW'2æÆVæwF‚À¢—F6†W'3¢7FG2ç—F6†W'2æÆVæwF€¢ÒÀ¢7FD6÷fW&vS¢7FG2æ6÷fW&vRÀ¢77e6÷W&6W3¢7FG2ç6÷W&6Tf–ÆW2À¢77dg&W6†æW72À¢v–ææW%vV–v‡G3¢vV–v‡G2À¢6÷W&6T†VÇFƒ¢6÷W&6T†VÇF‚‚’À¢&Vw&W76–öã¢°¢&öGV7F–öäÖöFVÃ¢&ööÆVâ‡&öGV7F–öäÖöFVÂ’À¢6æF–FFTÖöFVÃ¢&ööÆVâ†6æF–FFTÖöFVÂ’À¢Æ7E&W÷'DC¢&Vw&W76–öå&W÷'CòævVæW&FVDBÇÂçVÆÂÀ¢G&–æ–æu&÷w3¢&Vw&W76–öå&W÷'CòçG&–æ–æu&÷w2ÇÂÀ¢&öÖ÷FVD6æF–FFS¢&Vw&W76–öå&W÷'Còç&öÖ÷FVD6æF–FFRÇÂfÇ6RÀ¢&´f7F÷$6÷fW&vS¢&Vw&W76–öå&W÷'Còç&´f7F÷$6÷fW&vRÇÂçVÆÂÀ¢'VÆÇVä6÷fW&vS¢&Vw&W76–öå&W÷'Còæ'VÆÇVä6÷fW&vRÇÂçVÆÀ¢ÒÀ¢7F÷&vRÀ¢&Vg&W6ƒ¢°¢Ö÷&æ–æu&Vg&W6„†÷W$Æö6Ã¢Gµ7G&–ær„Ôõ$ä”äuõ$Te$U4…ô„õU"’çE7F'Bƒ"Â#"—Ó¢Gµ7G&–ær„Ôõ$ä”äuõ$Te$U4…ôÔ”åUDR’çE7F'Bƒ"Â#"—ÖÀ¢æW‡DÖ÷&æ–æu&Vg&W6„BÀ¢Æ7DÖ÷&æ–æu&Vg&W6„BÀ¢Æ7DÖ÷&æ–æu&Vg&W6…7FGW2À¢Æ7DÖ÷&æ–æu&Vg&W6„W'&÷ ¢ÒÀ¢6†V6¶VDC¢æWrFFR‚’çFô•4õ7G&–ær‚¢Ò“°§Ò“° ¦ævWB‚"ö’÷6÷W&6W2"Â7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7B6÷W&6W2Òv—B67&UV&Æ–56÷W&6W2‚“°¢&W2æ§6öâ‡²ö³¢G'VRÂ6÷W&6W2Ò“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ævWB‚"ö’ööFG2"Â7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7BöFG2Òv—BÆöDvÖTöFG2‚“°¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&öö¶Ö¶W#¢ôDE5ô$ôô´Ô´U"À¢6öæf–wW&VC¢&ööÆVâ†6ÆVåFW‡B‡&ö6W72æVçbäôDE5ô•ô´U’ÇÂ""’’À¢vÖW3¢öFG0¢Ò“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ævWB‚"ö’öÆ–æWW2"Â7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7B–ÆöBÒv—BÆöDF–Ç”Æ–æWW2‚“°¢6öç7B6æ6†÷DFFRÒæWrFFR‚’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°¢6öç7BÖF6†VDvÖW2Ò–ÆöBævÖW2æÖ‚†vÖR’ÓâÖF6„vÖT6&B†vÖR’“°¢G'’°¢v—B6æ6†÷Ev–ææW$fVGW&W4f÷$vÖW2†ÖF6†VDvÖW2Â6æ6†÷DFFR“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â‚%v–ææW"fVGW&R6æ6†÷B6¶—VC¢"ÂvWDW'&÷$ÖW76vR†W'&÷"’“°¢Ğ¢&W2æ§6öâ‡²ö³¢G'VRÂââç–ÆöBÒ“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ævWB‚"ö’÷66†VGVÆR"Â7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7B–ÆöBÒv—BÆöE66†VGVÆR‚“°¢&W2æ§6öâ‡²ö³¢G'VRÂââç–ÆöBÒ“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ç÷7B‚"ö’÷&Vw&W76–öâ÷&Vg&W6‚"Â7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7B&W÷'BÒv—B&Vg&W6…&Vw&W76–öä'F–f7G2‚“°¢&W2æ§6öâ‡²ö³¢G'VRÂ&W÷'BÒ“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ç÷7B‚"ö’öFF÷&Vg&W6‚"Â7–æ2…÷&WÂ&W2’Óâ°¢v—B'VäÖ÷&æ–æu&Vg&W6‚‚&ÖçVÂ"“°¢&W2æ§6öâ‡°¢ö³¢Æ7DÖ÷&æ–æu&Vg&W6…7FGW2ÓÒ&W'&÷""À¢7FGW3¢Æ7DÖ÷&æ–æu&Vg&W6…7FGW2À¢&Vg&W6†VDC¢Æ7DÖ÷&æ–æu&Vg&W6„BÀ¢W'&÷#¢Æ7DÖ÷&æ–æu&Vg&W6„W'&÷"À¢6÷W&6W3¢6÷W&6T†VÇF‚‚¢Ò“°§Ò“° ¦ævWB‚"ö’÷&Vw&W76–öâ÷&W÷'B"Â…÷&WÂ&W2’Óâ°¢6öç7B&W÷'BÒ&VE&Vw&W76–öå&W÷'B‚“°¢6öç7B&öGV7F–öäÖöFVÂÒ&VE&öGV7F–öå&Vw&W76–öäÖöFVÂ‚“°¢6öç7B6æF–FFTÖöFVÂÒ&VD6æF–FFU&Vw&W76–öäÖöFVÂ‚“°¢6öç7B7F÷&vRÒvWE7F÷&vU7FGW2‚“°¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&W÷'BÀ¢&öGV7F–öäÖöFVÂÀ¢6æF–FFTÖöFVÂÀ¢fVGW&U&÷w3¢&VEv–ææW$fVGW&U6æ6†÷G2‚’æÆVæwF‚À¢&W7VÇE&÷w3¢&VEv–ææW%&W7VÇG2‚’æÆVæwF‚À¢7F÷&vRÀ¢&Vg&W6ƒ¢°¢Ö÷&æ–æu&Vg&W6„†÷W$Æö6Ã¢Gµ7G&–ær„Ôõ$ä”äuõ$Te$U4…ô„õU"’çE7F'Bƒ"Â#"—Ó¢Gµ7G&–ær„Ôõ$ä”äuõ$Te$U4…ôÔ”åUDR’çE7F'Bƒ"Â#"—ÖÀ¢æW‡DÖ÷&æ–æu&Vg&W6„BÀ¢Æ7DÖ÷&æ–æu&Vg&W6„BÀ¢Æ7DÖ÷&æ–æu&Vg&W6…7FGW2À¢Æ7DÖ÷&æ–æu&Vg&W6„W'&÷ ¢Ğ¢Ò“°§Ò“° ¦ç÷7B‚"ö’ö6†B"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢v—BVç7W&Tg&W6„ÖöFVÄFF‚“°¢6öç7B²ÖW76vRÂ&WEG—RÒ&vVæW&Â"ÂvÖT6öçFW‡BÒ""ÒÒ&Wæ&öG’2°¢ÖW76vSó¢7G&–æs°¢&WEG—Só¢7G&–æs°¢vÖT6öçFW‡Có¢7G&–æs°¢Ó° ¢–b‚ÖW76vR’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢$Ö—76–ærÖW76vR"Ò“°¢Ğ ¢6öç7B&WÇ’Òv—BæÇ—¦TÆö6ÆÇ’‡°¢ÖW76vRÀ¢&WEG—S¢…²&vVæW&Â"Â&ç&f’"Â'7G&–¶V÷WG2"Â'v–ææW"%Òæ–æ6ÇVFW2†&WEG—R’ò&WEG—R¢&vVæW&Â"’2&WEG—RÀ¢vÖT6öçFW‡@¢Ò“° ¢&W2æ§6öâ‡²ö³¢G'VRÂ&WÇ’ÂÖöFS¢&Æö6Â"Ò“°¢Ò6F6‚†W'&÷"’°¢&W2ç7FGW2ƒS’æ§6öâ‡²W'&÷#¢vWDW'&÷$ÖW76vR†W'&÷"’Ò“°¢Ğ§Ò“° ¦ævWB‚"ö’÷7FG2"Â…÷&WÂ&W2’Óâ°¢6öç7B7FG2ÒvWD7W'&VçE7FG2‚“°¢&W2æ§6öâ‡²ö³¢G'VRÂââç7FG2Ò“°§Ò“° ¦ævWB‚"ò"Â…÷&WÂ&W2’Óâ°¢&W2çG—R‚&‡FÖÂ"’ç6VæB‡&VæFW%vR†vWD7W'&VçE7FG2‚’’“°§Ò“° ¦æÆ—7FVâ…õ%BÂ‚’Óâ°¢6öç6öÆRæÆör†'Vææ–æröâ‡GG¢òöÆö6Æ†÷7C¢Gµõ%GÖ“°¢'VäÖ÷&æ–æu&Vg&W6‚‚'7F'GW"’æ6F6‚‚†W'&÷"’Óâ°¢Æ7DÖ÷&æ–æu&Vg&W6…7FGW2Ò&W'&÷"#°¢Æ7DÖ÷&æ–æu&Vg&W6„W'&÷"ÒvWDW'&÷$ÖW76vR†W'&÷"“°¢6öç6öÆRçv&â‚%7F'GW&Vg&W6‚f–ÆVC¢"ÂÆ7DÖ÷&æ–æu&Vg&W6„W'&÷"“°¢Ò“°¢66†VGVÆTÖ÷&æ–æu&Vg&W6‚‚“°§Ò“°