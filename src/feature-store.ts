import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LogisticRegressionModel, RegressionReport, WinnerFeatureSnapshot, WinnerResultRow } from "./regression-types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const FEATURE_FILE = path.join(DATA_DIR, "game-features.jsonl");
const RESULT_FILE = path.join(DATA_DIR, "game-results.jsonl");
const PRODUCTION_MODEL_FILE = path.join(DATA_DIR, "regression-production.json");
const CANDIDATE_MODEL_FILE = path.join(DATA_DIR, "regression-candidate.json");
const REPORT_FILE = path.join(DATA_DIR, "model-report.json");

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function initDatabase() {
  ensureDataDir();
  const database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS winner_feature_snapshots (
      game_id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      away TEXT NOT NULL,
      home TEXT NOT NULL,
      away_offense REAL NOT NULL,
      home_offense REAL NOT NULL,
      away_pitching REAL NOT NULL,
      home_pitching REAL NOT NULL,
      away_bullpen REAL NOT NULL DEFAULT 50,
      home_bullpen REAL NOT NULL DEFAULT 50,
      away_trend REAL NOT NULL,
      home_trend REAL NOT NULL,
      away_win_prob REAL NOT NULL,
      home_win_prob REAL NOT NULL,
      away_defense REAL NOT NULL,
      home_defense REAL NOT NULL,
      park_index REAL,
      venue_name TEXT,
      away_park REAL NOT NULL DEFAULT 50,
      home_park REAL NOT NULL DEFAULT 50,
      away_moneyline REAL,
      home_moneyline REAL,
      total REAL,
      lineup_coverage_away REAL NOT NULL,
      lineup_coverage_home REAL NOT NULL,
      heuristic_pick TEXT NOT NULL,
      heuristic_edge REAL NOT NULL,
      heuristic_confidence REAL NOT NULL,
      market_lean TEXT
    );

    CREATE TABLE IF NOT EXISTS winner_results (
      game_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      away TEXT NOT NULL,
      home TEXT NOT NULL,
      away_score INTEGER NOT NULL,
      home_score INTEGER NOT NULL,
      home_win INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      kind TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureWinnerFeatureSnapshotColumns(database);

  migrateLegacyFiles(database);
  return database;
}

function ensureWinnerFeatureSnapshotColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(winner_feature_snapshots)").all() as Array<{ name: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (!names.has("park_index")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN park_index REAL");
  }
  if (!names.has("venue_name")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN venue_name TEXT");
  }
  if (!names.has("away_park")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN away_park REAL NOT NULL DEFAULT 50");
  }
  if (!names.has("home_park")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN home_park REAL NOT NULL DEFAULT 50");
  }
  if (!names.has("away_bullpen")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN away_bullpen REAL NOT NULL DEFAULT 50");
  }
  if (!names.has("home_bullpen")) {
    database.exec("ALTER TABLE winner_feature_snapshots ADD COLUMN home_bullpen REAL NOT NULL DEFAULT 50");
  }
}

function countRows(database: DatabaseSync, tableName: string) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function migrateLegacyFiles(database: DatabaseSync) {
  const featureCount = countRows(database, "winner_feature_snapshots");
  const resultCount = countRows(database, "winner_results");
  const artifactCount = countRows(database, "artifacts");

  const legacyFeatures = featureCount === 0 ? readJsonlFile<WinnerFeatureSnapshot>(FEATURE_FILE) : [];
  const legacyResults = resultCount === 0 ? readJsonlFile<WinnerResultRow>(RESULT_FILE) : [];
  const legacyProduction = artifactCount === 0 ? readJsonFile<LogisticRegressionModel>(PRODUCTION_MODEL_FILE) : null;
  const legacyCandidate = artifactCount === 0 ? readJsonFile<LogisticRegressionModel>(CANDIDATE_MODEL_FILE) : null;
  const legacyReport = artifactCount === 0 ? readJsonFile<RegressionReport>(REPORT_FILE) : null;

  if (!legacyFeatures.length && !legacyResults.length && !legacyProduction && !legacyCandidate && !legacyReport) {
    return;
  }

  database.exec("BEGIN");
  try {
    if (legacyFeatures.length) {
      const statement = database.prepare(`
        INSERT OR REPLACE INTO winner_feature_snapshots (
          game_id, snapshot_date, away, home, away_offense, home_offense, away_pitching, home_pitching, away_bullpen, home_bullpen,
          away_trend, home_trend, away_win_prob, home_win_prob, away_defense, home_defense, park_index, venue_name, away_park, home_park,
          away_moneyline, home_moneyline, total, lineup_coverage_away, lineup_coverage_home,
          heuristic_pick, heuristic_edge, heuristic_confidence, market_lean
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyFeatures) {
        statement.run(
          row.gameId, row.snapshotDate, row.away, row.home, row.awayOffense, row.homeOffense, row.awayPitching, row.homePitching,
          row.awayBullpen ?? 50, row.homeBullpen ?? 50,
          row.awayTrend, row.homeTrend, row.awayWinProb, row.homeWinProb, row.awayDefense, row.homeDefense,
          row.parkIndex ?? null, row.venueName ?? null, row.awayPark ?? 50, row.homePark ?? 50,
          row.awayMoneyline, row.homeMoneyline, row.total, row.lineupCoverageAway, row.lineupCoverageHome,
          row.heuristicPick, row.heuristicEdge, row.heuristicConfidence, row.marketLean
        );
      }
    }

    if (legacyResults.length) {
      const statement = database.prepare(`
        INSERT OR REPLACE INTO winner_results (
          game_id, date, away, home, away_score, home_score, home_win
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyResults) {
        statement.run(row.gameId, row.date, row.away, row.home, row.awayScore, row.homeScore, row.homeWin);
      }
    }

    if (legacyProduction) writeArtifactToDatabase(database, "regression-production", legacyProduction);
    if (legacyCandidate) writeArtifactToDatabase(database, "regression-candidate", legacyCandidate);
    if (legacyReport) writeArtifactToDatabase(database, "model-report", legacyReport);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeArtifactToDatabase(database: DatabaseSync, kind: string, value: unknown) {
  database.prepare(`
    INSERT INTO artifacts (kind, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(kind, JSON.stringify(value), new Date().toISOString());
}

const database = initDatabase();

function mapFeatureRow(row: Record<string, unknown>): WinnerFeatureSnapshot {
  return {
    snapshotDate: String(row.snapshot_date),
    gameId: String(row.game_id),
    away: String(row.away),
    home: String(row.home),
    awayOffense: Number(row.away_offense),
    homeOffense: Number(row.home_offense),
    awayPitching: Number(row.away_pitching),
    homePitching: Number(row.home_pitching),
    awayBullpen: row.away_bullpen === null || row.away_bullpen === undefined ? 50 : Number(row.away_bullpen),
    homeBullpen: row.home_bullpen === null || row.home_bullpen === undefined ? 50 : Number(row.home_bullpen),
    awayTrend: Number(row.away_trend),
    homeTrend: Number(row.home_trend),
    awayWinProb: Number(row.away_win_prob),
    homeWinProb: Number(row.home_win_prob),
    awayDefense: Number(row.away_defense),
    homeDefense: Number(row.home_defense),
    parkIndex: row.park_index === null || row.park_index === undefined ? null : Number(row.park_index),
    venueName: row.venue_name === null || row.venue_name === undefined ? null : String(row.venue_name),
    awayPark: row.away_park === null || row.away_park === undefined ? 50 : Number(row.away_park),
    homePark: row.home_park === null || row.home_park === undefined ? 50 : Number(row.home_park),
    awayMoneyline: row.away_moneyline === null ? null : Number(row.away_moneyline),
    homeMoneyline: row.home_moneyline === null ? null : Number(row.home_moneyline),
    total: row.total === null ? null : Number(row.total),
    lineupCoverageAway: Number(row.lineup_coverage_away),
    lineupCoverageHome: Number(row.lineup_coverage_home),
    heuristicPick: String(row.heuristic_pick),
    heuristicEdge: Number(row.heuristic_edge),
    heuristicConfidence: Number(row.heuristic_confidence),
    marketLean: row.market_lean === null ? null : String(row.market_lean)
  };
}

function mapResultRow(row: Record<string, unknown>): WinnerResultRow {
  return {
    date: String(row.date),
    gameId: String(row.game_id),
    away: String(row.away),
    home: String(row.home),
    awayScore: Number(row.away_score),
    homeScore: Number(row.home_score),
    homeWin: Number(row.home_win) as 0 | 1
  };
}

function readArtifact<T>(kind: string): T | null {
  const row = database.prepare("SELECT payload FROM artifacts WHERE kind = ?").get(kind) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as T : null;
}

export function readWinnerFeatureSnapshots() {
  const rows = database.prepare("SELECT * FROM winner_feature_snapshots ORDER BY snapshot_date ASC, game_id ASC").all() as Record<string, unknown>[];
  return rows.map(mapFeatureRow);
}

export function readWinnerResults() {
  const rows = database.prepare("SELECT * FROM winner_results ORDER BY date ASC, game_id ASC").all() as Record<string, unknown>[];
  return rows.map(mapResultRow);
}

export function upsertWinnerFeatureSnapshots(rows: WinnerFeatureSnapshot[]) {
  const statement = database.prepare(`
    INSERT INTO winner_feature_snapshots (
      game_id, snapshot_date, away, home, away_offense, home_offense, away_pitching, home_pitching, away_bullpen, home_bullpen,
      away_trend, home_trend, away_win_prob, home_win_prob, away_defense, home_defense, park_index, venue_name, away_park, home_park,
      away_moneyline, home_moneyline, total, lineup_coverage_away, lineup_coverage_home,
      heuristic_pick, heuristic_edge, heuristic_confidence, market_lean
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      snapshot_date = excluded.snapshot_date,
      away = excluded.away,
      home = excluded.home,
      away_offense = excluded.away_offense,
      home_offense = excluded.home_offense,
      away_pitching = excluded.away_pitching,
      home_pitching = excluded.home_pitching,
      away_bullpen = excluded.away_bullpen,
      home_bullpen = excluded.home_bullpen,
      away_trend = excluded.away_trend,
      home_trend = excluded.home_trend,
      away_win_prob = excluded.away_win_prob,
      home_win_prob = excluded.home_win_prob,
      away_defense = excluded.away_defense,
      home_defense = excluded.home_defense,
      park_index = excluded.park_index,
      venue_name = excluded.venue_name,
      away_park = excluded.away_park,
      home_park = excluded.home_park,
      away_moneyline = excluded.away_moneyline,
      home_moneyline = excluded.home_moneyline,
      total = excluded.total,
      lineup_coverage_away = excluded.lineup_coverage_away,
      lineup_coverage_home = excluded.lineup_coverage_home,
      heuristic_pick = excluded.heuristic_pick,
      heuristic_edge = excluded.heuristic_edge,
      heuristic_confidence = excluded.heuristic_confidence,
      market_lean = excluded.market_lean
  `);

  database.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(
        row.gameId, row.snapshotDate, row.away, row.home, row.awayOffense, row.homeOffense, row.awayPitching, row.homePitching,
        row.awayBullpen, row.homeBullpen,
        row.awayTrend, row.homeTrend, row.awayWinProb, row.homeWinProb, row.awayDefense, row.homeDefense,
        row.parkIndex, row.venueName, row.awayPark, row.homePark,
        row.awayMoneyline, row.homeMoneyline, row.total, row.lineupCoverageAway, row.lineupCoverageHome,
        row.heuristicPick, row.heuristicEdge, row.heuristicConfidence, row.marketLean
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return readWinnerFeatureSnapshots();
}

export function upsertWinnerResults(rows: WinnerResultRow[]) {
  const statement = database.prepare(`
    INSERT INTO winner_results (
      game_id, date, away, home, away_score, home_score, home_win
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      date = excluded.date,
      away = excluded.away,
      home = excluded.home,
      away_score = excluded.away_score,
      home_score = excluded.home_score,
      home_win = excluded.home_win
  `);

  database.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(row.gameId, row.date, row.away, row.home, row.awayScore, row.homeScore, row.homeWin);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return readWinnerResults();
}

export function readProductionRegressionModel() {
  return readArtifact<LogisticRegressionModel>("regression-production");
}

export function writeProductionRegressionModel(model: LogisticRegressionModel) {
  writeArtifactToDatabase(database, "regression-production", model);
}

export function readCandidateRegressionModel() {
  return readArtifact<LogisticRegressionModel>("regression-candidate");
}

export function writeCandidateRegressionModel(model: LogisticRegressionModel) {
  writeArtifactToDatabase(database, "regression-candidate", model);
}

export function readRegressionReport() {
  return readArtifact<RegressionReport>("model-report");
}

export function writeRegressionReport(report: RegressionReport) {
  writeArtifactToDatabase(database, "model-report", report);
}

export function getStorageStatus() {
  return {
    backend: "sqlite",
    dbPath: DB_FILE,
    featureRows: countRows(database, "winner_feature_snapshots"),
    resultRows: countRows(database, "winner_results"),
    artifactRows: countRows(database, "artifacts")
  };
}
