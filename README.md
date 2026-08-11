# Baseball Gambling Agent

A baseball betting analysis app that combines current MLB data, Statcast expected statistics, recency-aware features, and a self-evaluating logistic regression layer. It produces game-winner, NRFI/YRFI, and pitcher strikeout recommendations without a paid language-model API.

## Model Inputs

The August winner heuristic uses this 100% core weighting:

- Offense: 37%
- Confirmed starting pitcher: 20%
- Bullpen: 10%
- Recent team form: 16%
- Baseball Reference win-probability impact: 10%
- Defense: 5%
- Park factor: 2%

Total pitching stays at 30%. The bullpen share is 7% in April-May, 9% in June-July, 10% in August, and 12% in September-October; starter weight moves inversely.

Player form blends current-season expected statistics with measured MLB performance from the last 30 days. Recent samples are shrunk toward the season baseline when plate appearances or batters faced are small. Team form uses exponentially decayed results from the last ten games instead of overlapping last-1, last-3, and last-5 totals.

Bullpen ratings use official MLB season statistics, 14-day performance, and three-day pitch workload. The bullpen rating is also stored as its own regression feature so future game results can determine whether it improves out-of-sample accuracy.

## Prerequisites

- Node.js 22 or later (the project uses `node:sqlite`)
- npm

## Setup

```bash
git clone <your-repo-url>
cd baseball-gambling-agent
npm install
cp .env.example .env
```

## Running

```bash
# Development with hot reload
npm run dev

# Production build and start
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `ODDS_API_KEY` | No | None | The-Odds-API key for live lines |
| `ODDS_BOOKMAKER` | No | `fanduel` | Preferred bookmaker |
| `EXPECTED_BATTERS_CSV_PATH` | No | `data/expected_stats_batters.csv` | Optional custom expected-stat CSV path |
| `EXPECTED_PITCHERS_CSV_PATH` | No | `data/expected_stats_pitchers.csv` | Optional custom expected-stat CSV path |

The analysis engine runs without API keys. Live odds are omitted when `ODDS_API_KEY` is not configured.

## Refresh Behavior

- A full refresh runs at startup and daily at 06:05 in the server's local timezone.
- `/api/chat` triggers a guarded refresh when model data is older than eight hours or expected-stat CSVs are stale.
- Failed refreshes are throttled and retain the last known-good files.
- Expected-stat files are validated for minimum coverage and replaced atomically; empty scraper output cannot overwrite good data.
- Source attempts, successes, row counts, errors, ages, and stale flags are exposed through `/api/health`.

On Oracle, confirm the VM timezone if 06:05 must correspond to a specific local time.

## Persistent Data

The ignored `data/` directory contains the SQLite database and regenerated source files. `data/app.db` is the source of truth for historical feature snapshots, results, and model artifacts. Keep this directory on persistent Oracle storage and back it up before server migrations.

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Model weights, coverage, source freshness, storage, and refresh status |
| `GET /api/lineups` | Today's lineups and probable pitchers |
| `GET /api/schedule` | MLB schedule |
| `GET /api/odds` | Betting odds when configured |
| `GET /api/sources` | Public-source scrape summaries |
| `GET /api/stats` | Current merged player dataset and coverage |
| `POST /api/chat` | Local analysis endpoint |
| `POST /api/data/refresh` | Manually run the full data refresh |
| `POST /api/regression/refresh` | Refresh results and train/evaluate a candidate model |
| `GET /api/regression/report` | Regression metrics and feature coverage |

## Primary Sources

- MLB Stats API: schedules, results, recent player form, defense, and bullpens
- Baseball Savant: expected statistics, first-inning splits, and park factors
- RotoWire: daily lineups
- TeamRankings: season and venue run differential
- Baseball Reference: batting and pitching win-probability impact
- The-Odds-API: optional sportsbook lines
