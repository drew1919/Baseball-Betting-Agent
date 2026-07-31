# Baseball Gambling Agent

A baseball betting analysis web app that combines real-time MLB data scraping, Statcast statistics, and a logistic regression model to generate betting insights for game winners, NRFI/YRFI, and pitcher strikeout props.

## Features

- **Live data scraping** — lineups, probable pitchers, and betting odds pulled from public sources
- **Statcast analytics** — xwOBA, barrel rate, whiff%, K%, and more for batters and pitchers
- **ML predictions** — logistic regression model trained on historical game features (auto-updates daily)
- **Bet type analysis** — General, NRFI/YRFI, Pitcher K Props, Game Winner
- **Web UI** — dark-themed interface, game selector, and instant analysis

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (included with Node.js)

## Setup

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd baseball-gambling-agent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env if you want live odds (ODDS_API_KEY) — everything else works without it
```

## Running

```bash
# Development (hot reload)
npm run dev

# Production (compiles TypeScript, then runs)
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Port the server listens on |
| `ODDS_API_KEY` | No | — | [The-Odds-API](https://the-odds-api.com) key for live lines |
| `ODDS_BOOKMAKER` | No | `fanduel` | Bookmaker to pull odds from |
| `EXPECTED_BATTERS_CSV_PATH` | No | — | Path to a Baseball Savant batter CSV export |
| `EXPECTED_PITCHERS_CSV_PATH` | No | — | Path to a Baseball Savant pitcher CSV export |

The app runs fully without any API keys — live odds are disabled but all analysis still works.

## Data

A `data/` directory is created automatically on first run. It stores:
- `app.db` — SQLite database with game features and results
- `game-features.jsonl` / `game-results.jsonl` — historical snapshots used to train the model

This directory is excluded from git. The ML model improves over time as it collects more game results.

## Project Structure

```
src/
  index.ts            # Express server and API routes
  page.ts             # HTML/CSS frontend template
  stats.ts            # Built-in Statcast dataset
  augmented-stats.ts  # Feature engineering
  feature-store.ts    # SQLite read/write helpers
  regression-trainer.ts  # Logistic regression training
  model-evaluator.ts  # Accuracy, log loss, Brier score
  regression-types.ts # TypeScript types
  results-fetcher.ts  # MLB results from statsapi.mlb.com
public/
  app.js              # Frontend JavaScript
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | App status and model info |
| `GET /api/lineups` | Today's lineups and probable pitchers |
| `GET /api/schedule` | MLB schedule |
| `GET /api/odds` | Betting odds (requires ODDS_API_KEY) |
| `GET /api/sources` | Raw scraped data from all sources |
| `POST /api/chat` | Analysis endpoint (body: `{ message, betType, gameCtx }`) |
| `POST /api/regression/refresh` | Re-train the prediction model |
| `GET /api/regression/report` | Model performance metrics |

## Data Sources

All public, no authentication required:
- MLB Schedule API
- Baseball Savant (Statcast leaderboards, park factors)
- RotoWire (daily lineups)
- TeamRankings (run differential)
- Baseball Reference (win probability)

Live odds require a free [The-Odds-API](https://the-odds-api.com) key.
