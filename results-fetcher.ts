import type { WinnerResultRow } from "./regression-types.js";

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
  ATH: ["ATH", "Sacramento", "Sacramento Athletics", "Athletics", "A's", "Oakland"],
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

function resolveTeamKey(value: string) {
  const normalized = normalizeName(value);
  const entry = Object.entries(TEAM_ALIASES).find(([, aliases]) =>
    aliases.some((alias) => normalizeName(alias) === normalized)
  );
  return entry?.[0] || null;
}

export function buildWinnerGameId(date: string, away: string, home: string) {
  return `${date}_${away}_${home}`;
}

export async function fetchWinnerResults(startDate: string, endDate: string) {
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for winner results`);
  }

  const data = (await res.json()) as {
    dates?: Array<{
      date?: string;
      games?: Array<{
        status?: { abstractGameState?: string };
        teams?: {
          away?: { team?: { name?: string }; score?: number };
          home?: { team?: { name?: string }; score?: number };
        };
      }>;
    }>;
  };

  const rows: WinnerResultRow[] = [];
  (data.dates || []).forEach((dateEntry) => {
    const gameDate = cleanText(dateEntry.date || "");
    (dateEntry.games || []).forEach((game) => {
      if (game.status?.abstractGameState !== "Final") return;
      const away = resolveTeamKey(cleanText(game.teams?.away?.team?.name || ""));
      const home = resolveTeamKey(cleanText(game.teams?.home?.team?.name || ""));
      if (!away || !home || !gameDate) return;
      const awayScore = Number(game.teams?.away?.score || 0);
      const homeScore = Number(game.teams?.home?.score || 0);
      rows.push({
        date: gameDate,
        gameId: buildWinnerGameId(gameDate, away, home),
        away,
        home,
        awayScore,
        homeScore,
        homeWin: homeScore > awayScore ? 1 : 0
      });
    });
  });

  return rows;
}
