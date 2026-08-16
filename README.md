# Baseball Gambling Agent

A baseball betting analysis app that combines current MLB data, Statcast expected statistics, recency-aware features, and a rolling-forward-evaluated logistic regression layer. It produces game-winner, NRFI/YRFI, and pitcher strikeout recommendations without a paid language-model API.

Winner projections use the regression only after its training procedure beats the stored-pick baseline on chronologically later games. Approval must pass the full forward window, the latest five eligible slates, and a qualified-tier gate requiring at least 60% accuracy among at least 15 recent predictions rated 55% or higher. A recent accuracy drop automatically pauses production regression use and falls back to an 85% weighted-statistical probability plus a bounded 15% no-vig market sanity check. Missing odds return the fallback to 100% statistical. Probabilities are shrunk toward 50% to reduce overconfidence.

The current MLB date is excluded from recent-slate approval until the slate is complete. Individual finals can enter model training immediately, but one early result cannot evict an entire older slate or toggle production approval intraday.

Player-level expected-stat ratings use a 120-PA/BF reliability prior and bounded component ratings. This prevents a debut-sized Statcast sample from overpowering eight established lineup players or a full team pitching profile while preserving most of the signal for regulars with substantial samples.

Missing lineup slots are scored at a neutral 50 rather than allowing a partial lineup to represent the whole offense. Each winner snapshot also records an evidence-quality score based on lineup coverage, starter Statcast coverage, bullpen availability, market availability, and lineup confirmation. Low-quality games still receive a forced full-slate lean, but their probability edge is shrunk toward 50% and they are not presented as validated high-confidence bets.

Complete-slate winner requests use the primary regression. Winner recommendations can enter `best bets` only when an independently trained no-total selective regression is also approved, rates the same side at 55% or higher, and agrees with a 55%+ primary prediction. This keeps forced projections visible without treating them as equally bettable.

NRFI/YRFI uses both halves of inning one: the away offense against the home starter and the home offense against the away starter. Its displayed number is a model ranking score, not a probability. Pregame first-inning snapshots and official MLB inning-one results are stored separately from winner history. First-inning accuracy is not approved until at least 30 prospective games reach 55% overall accuracy, at least 15 high-quality/clear-edge games reach 60%, and the latest five slates remain at or above 55%. Before approval, the app still returns NRFI/YRFI watchlist leans. Even after the accuracy gate passes, an actual first-inning market price is required before a play can enter `best bets`, because hit rate alone does not establish positive expected value.

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

The analysis engine runs without API keys. When primary two-sided odds are unavailable, winner analysis uses RotoWire's listed pregame moneyline and an empirically fitted hold correction to estimate a complementary no-vig market probability. The market remains one bounded model input; it does not replace the statistical engine.

## Refresh Behavior

- A full refresh runs at startup and daily at 09:05 America/New_York by default. Set `MORNING_REFRESH_TIME_ZONE` and `MORNING_REFRESH_HOUR` to override it.
- `/api/chat` triggers a guarded refresh when model data is older than eight hours or expected-stat CSVs are stale.
- Failed refreshes are throttled and retain the last known-good files.
- Expected-stat files are validated for minimum coverage and replaced atomically; empty scraper output cannot overwrite good data.
- Source attempts, successes, row counts, errors, ages, and stale flags are exposed through `/api/health`.
- The first pregame feature snapshot for a matchup/date is immutable. Page loads and later refreshes cannot rewrite history with in-game or postgame data.
- First-time snapshots are created only while MLB reports a game as scheduled. Once play begins, winner analysis keeps the immutable pregame pick and market input rather than consuming moving in-game lines.

The scheduler is timezone-explicit, so the Oracle VM's operating-system timezone no longer changes the capture time.

## Model Diagnostics

Run `npm run validate:model -- data/app.db` to evaluate the primary and selective regressions with rolling daily holdouts, recent-slate approval metrics, dual-model agreement, and the 55%+ qualified tier separately from forced low-confidence picks. Run `npm run analyze:history -- data/app.db` for recent performance, market agreement, side bias, and feature-variance diagnostics. Run `npm run analyze:market-blend -- data/app.db` to compare bounded market weights and category directionality without changing production weights. Run `npm run calibrate:rotowire -- data/app.db` to refit/check the one-sided-line hold correction against stored two-sided markets. These are forward-looking checks; in-sample accuracy is not used as evidence for promotion.

## Persistent Data

The ignored `data/` directory contains the SQLite database and regenerated source files. `data/app.db` is the source of truth for winner and first-inning feature snapshots, official results, and model artifacts. Each new snapshot stores the raw statistical lean separately from the final prediction, confidence, engine, and market weight so later evaluation does not conflate those concepts. Keep this directory on persistent Oracle storage and back it up before server migrations.

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
| `GET /api/recommendations/history` | Winner picks, evidence quality, results, and accuracy |
| `GET /api/first-inning/history` | NRFI/YRFI snapshots, official first-inning results, accuracy, and approval status |

## Primary Sources

- MLB Stats API: schedules, results, recent player form, defense, and bullpens
- Baseball Savant: expected statistics, first-inning splits, and park factors
- RotoWire: daily lineups
- TeamRankings: season and venue run differential
- Baseball Reference: batting and pitching win-probability impact
- The-Odds-API: optional sportsbook lines
