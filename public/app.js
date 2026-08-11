var D = window.APP_DATA || { batters: [], pitchers: [] };
var BATTERS = D.batters;
var PITCHERS = D.pitchers;
var activeBet = "general";
var activeTab = "bat";
var GAMES = [];
var gameCtx = "";
var manualCtx = "";
var selectedGameIndex = -1;
var betLabels = {
  general: "General",
  nrfi: "NRFI / YRFI",
  strikeouts: "Pitcher Ks",
  winner: "Winner"
};
var TEAM_ALIASES = {
  ARI: ["ari", "arizona", "diamondbacks", "dbacks"],
  ATL: ["atl", "atlanta", "braves"],
  BAL: ["bal", "baltimore", "orioles"],
  BOS: ["bos", "boston", "red sox", "redsox"],
  CHC: ["chc", "cubs", "chicago cubs"],
  CWS: ["cws", "white sox", "whitesox", "chicago white sox"],
  CIN: ["cin", "cincinnati", "reds"],
  CLE: ["cle", "cleveland", "guardians"],
  COL: ["col", "colorado", "rockies"],
  DET: ["det", "detroit", "tigers"],
  HOU: ["hou", "houston", "astros"],
  KC: ["kc", "kansas city", "royals"],
  LAA: ["laa", "angels", "los angeles angels"],
  LAD: ["lad", "dodgers", "los angeles dodgers"],
  MIA: ["mia", "miami", "marlins"],
  MIL: ["mil", "milwaukee", "brewers"],
  MIN: ["min", "minnesota", "twins"],
  NYM: ["nym", "mets", "new york mets"],
  NYY: ["nyy", "yankees", "new york yankees"],
  ATH: ["ath", "athletics", "a's", "as", "oakland", "sacramento"],
  PHI: ["phi", "philadelphia", "phillies"],
  PIT: ["pit", "pittsburgh", "pirates"],
  SD: ["sd", "sdp", "padres", "san diego"],
  SF: ["sf", "sfg", "giants", "san francisco"],
  SEA: ["sea", "seattle", "mariners"],
  STL: ["stl", "st louis", "st. louis", "cardinals"],
  TB: ["tb", "tampa bay", "rays"],
  TEX: ["tex", "texas", "rangers"],
  TOR: ["tor", "toronto", "blue jays", "bluejays", "jays"],
  WSH: ["wsh", "was", "washington", "nationals", "nats"]
};

(function () {
  var opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  var hdate = document.getElementById("hdate");
  if (hdate) {
    hdate.textContent = new Date().toLocaleDateString("en-US", opts);
  }
})();

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function addMsg(role, html) {
  var c = document.getElementById("msgs");
  var d = document.createElement("div");
  d.className = "msg " + role;
  d.innerHTML =
    '<div class="mlbl">' + (role === "u" ? "You" : "Agent") + '</div><div class="bub">' + html + "</div>";
  c.appendChild(d);
  c.scrollTop = 99999;
  return d;
}

function fmt(t) {
  return t
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^#{1,3} (.+)$/gm, '<div style="color:#2a9d8f;font-weight:700;margin:6px 0 2px">$1</div>')
    .replace(/\uD83D\uDFE2[^\n]*/g, function (m) { return '<div class="vy">' + m + "</div>"; })
    .replace(/\u2705[^\n]*/g, function (m) { return '<div class="vy">' + m + "</div>"; })
    .replace(/\uD83C\uDFAF[^\n]*/g, function (m) { return '<div class="vy">' + m + "</div>"; })
    .replace(/\uD83D\uDD34[^\n]*/g, function (m) { return '<div class="vn">' + m + "</div>"; })
    .replace(/\uD83D\uDFE1[^\n]*/g, function (m) { return '<div class="vm">' + m + "</div>"; })
    .replace(/\u26A0\uFE0F[^\n]*/g, function (m) { return '<div class="vm">' + m + "</div>"; })
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function setPill(id, text, cls) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = "status-pill " + cls;
  el.textContent = text;
}

function updateContextState() {
  var active = manualCtx || gameCtx;
  setPill(
    "ctxStatus",
    active ? (manualCtx ? "Manual context active" : "Selected game context active") : "No matchup context selected",
    active ? "status-ok" : "status-muted"
  );
  var preview = document.getElementById("ctxPreview");
  if (preview) {
    preview.textContent = manualCtx || gameCtx || "Using automatic context from selected games when available.";
  }
}

function updateBetState() {
  setPill("betStatus", "Bet mode: " + (betLabels[activeBet] || activeBet), "status-ok");
  var input = document.getElementById("inp");
  if (input) {
    input.placeholder = "Ask about " + (betLabels[activeBet] || "today's games") + "...";
  }
}

async function loadHealth() {
  try {
    var res = await fetch("/api/health");
    var data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    setPill("apiStatus", data.analysisMode === "local" ? "Local analysis ready (" + (data.analysisVersion || "unknown") + ")" : "Chat ready", "status-ok");
    var csvStatus = data.csvSources && data.csvSources.batterCsvLoaded && data.csvSources.pitcherCsvLoaded
      ? " / daily expected CSV sync active"
      : " / static-only fallback";
    var oddsStatus = data.oddsSourceConfigured ? " / odds: " + (data.oddsBookmaker || "configured") : " / odds layer ready (awaiting key)";
    setPill(
      "dataStatus",
      "Local Savant data " + data.statCounts.batters + " batters / " + data.statCounts.pitchers + " pitchers / MLB schedule + RotoWire + Savant leaderboards + 1st inning searches" + csvStatus + oddsStatus,
      "status-muted"
    );
  } catch (e) {
    setPill("apiStatus", "Backend check failed", "status-warn");
  }
}

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasesForTeam(team) {
  var clean = String(team || "").trim();
  var upper = clean.toUpperCase();
  var aliases = TEAM_ALIASES[upper] ? TEAM_ALIASES[upper].slice() : [];
  aliases.push(clean.toLowerCase());
  return aliases.map(function (alias) { return normalizeText(alias); }).filter(Boolean);
}

function messageTargetsGame(message, game) {
  var normalized = normalizeText(message);
  if (!normalized) return false;
  var awayAliases = aliasesForTeam(game.away);
  var homeAliases = aliasesForTeam(game.home);
  return awayAliases.some(function (alias) { return normalized.indexOf(alias) !== -1; })
    || homeAliases.some(function (alias) { return normalized.indexOf(alias) !== -1; });
}

function resolveContextForMessage(message) {
  if (manualCtx) return manualCtx;
  for (var i = 0; i < GAMES.length; i++) {
    if (messageTargetsGame(message, GAMES[i])) {
      return buildCtx(GAMES[i]);
    }
  }
  return gameCtx;
}

async function loadSources() {
  var list = document.getElementById("sourceList");
  if (!list) return;
  list.innerHTML = '<div class="lup-ph" style="padding:8px 4px">Scraping public baseball sources...</div>';
  try {
    var res = await fetch("/api/sources");
    var data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    var sources = data.sources || [];
    if (!sources.length) {
      list.innerHTML = '<div class="lup-ph" style="padding:8px 4px">No source data found.</div>';
      return;
    }
    list.innerHTML = sources.map(function (source) {
      var cls = source.ok ? "chip-g" : "chip-r";
      var label = source.ok ? "Scraped" : "Error";
      var headingLine = (source.headings || []).slice(0, 3).join(" | ");
      var rowLine = (source.sampleRows || []).slice(0, 2).map(function (row) { return row.join(" | "); }).join("\n");
      return '<div class="src-card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div class="src-name">'
        + esc(source.label)
        + '</div><span class="chip ' + cls + '">' + label + '</span></div><div class="src-meta">URL: '
        + esc(source.url)
        + (headingLine ? "<br>Headings: " + esc(headingLine) : "")
        + "<br>"
        + esc(source.preview || "No preview")
        + "</div>"
        + (rowLine ? '<div class="src-rows">' + esc(rowLine) + "</div>" : "")
        + "</div>";
    }).join("");
  } catch (e) {
    list.innerHTML = '<div class="lup-err">Could not scrape public sources.<br><small style="color:#64748b">' + esc(e.message) + "</small></div>";
  }
}

function applyManualContext() {
  var input = document.getElementById("ctxInput");
  var value = input ? input.value.trim() : "";
  manualCtx = value;
  updateContextState();
  addMsg("a", value ? "Manual context loaded for the next analysis request." : "Manual context is empty, so only selected game context will be used.");
}

function clearManualContext() {
  manualCtx = "";
  var input = document.getElementById("ctxInput");
  if (input) input.value = "";
  updateContextState();
  addMsg("a", "Manual context cleared.");
}

function setBet(btn, type) {
  activeBet = type;
  document.querySelectorAll(".bet-btn").forEach(function (b) { b.classList.remove("on"); });
  btn.classList.add("on");
  updateBetState();
  addMsg("a", "Bet mode switched to <strong>" + esc(betLabels[type] || type) + "</strong>.");
}

function switchTab(t) {
  activeTab = t;
  document.getElementById("st-bat").className = "stab" + (t === "bat" ? " on" : "");
  document.getElementById("st-pit").className = "stab" + (t === "pit" ? " on" : "");
  renderSidebar();
}

function ask(t) {
  document.getElementById("inp").value = t;
  send();
}

function askPlayer(n) {
  var ctx = activeBet === "nrfi" ? "NRFI/YRFI" : activeBet === "strikeouts" ? "strikeout prop" : activeBet === "winner" ? "team winner" : "betting";
  ask("Analyze " + n + " for " + ctx);
}

function renderSidebar() {
  var el = document.getElementById("slist");
  var existing = el.querySelector(".srch");
  var q = existing ? existing.value : "";
  var html = "";
  if (activeTab === "bat") {
    html += '<input class="srch" placeholder="Search batters..." oninput="renderSidebar()" value="' + esc(q) + '">';
    BATTERS.filter(function (b) { return !q || b["last_name, first_name"].toLowerCase().includes(q.toLowerCase()); }).forEach(function (b) {
      var kc = b.k_percent > 30 ? "r" : b.k_percent < 15 ? "g" : "y";
      var wc = b.xwoba > 0.38 ? "g" : b.xwoba < 0.28 ? "r" : "y";
      html += '<div class="pc" onclick="askPlayer(' + JSON.stringify(b["last_name, first_name"]) + ')"><div class="pn">'
        + esc(b["last_name, first_name"])
        + '</div><div class="ps"><span class="b ' + kc + '">K% ' + b.k_percent + '</span><span class="b '
        + wc + '">xwOBA ' + b.xwoba + '</span><span class="b y">Hard ' + b.hard_hit_percent + "%</span></div></div>";
    });
  } else {
    PITCHERS.forEach(function (p) {
      var kc = p.k_percent > 30 ? "g" : p.k_percent < 20 ? "r" : "y";
      html += '<div class="pc" onclick="askPlayer(' + JSON.stringify(p["last_name, first_name"]) + ')"><div class="pn">'
        + esc(p["last_name, first_name"])
        + '</div><div class="ps"><span class="b ' + kc + '">K% ' + p.k_percent + '</span><span class="b y">Whiff '
        + p.whiff_percent + '%</span><span class="b y">PA ' + p.pa + "</span></div></div>";
    });
  }
  el.innerHTML = html;
  var s = el.querySelector(".srch");
  if (s && q) {
    s.value = q;
    s.focus();
    var l = s.value.length;
    s.setSelectionRange(l, l);
  }
}

function findBatter(name) {
  if (!name) return null;
  var nl = name.toLowerCase();
  var lastName = nl.split(" ").pop();
  for (var i = 0; i < BATTERS.length; i++) {
    var b = BATTERS[i];
    var bn = b["last_name, first_name"].toLowerCase();
    var bLast = bn.split(",")[0].trim();
    if (lastName && lastName.length > 3 && bLast === lastName) return b;
    if (lastName && (nl.includes(bLast) || bLast.includes(lastName))) return b;
  }
  return null;
}

function countMatched(g) {
  var count = 0;
  var seen = {};
  function check(lineup) {
    (lineup || []).forEach(function (p) {
      var b = findBatter(p.name);
      if (b && !seen[b.player_id]) {
        seen[b.player_id] = 1;
        count++;
      }
    });
  }
  check(g.awayLineup);
  check(g.homeLineup);
  return count;
}

function buildCtx(g) {
  var lines = [];
  lines.push("GAME: " + g.away + " @ " + g.home + " (" + (g.confirmed ? "Confirmed" : "Projected") + " lineups)");
  if (g.awayP) lines.push("Away starter: " + g.awayP.name + " | " + (g.awayP.hand || "") + " | " + (g.awayP.era || "?") + " ERA");
  if (g.homeP) lines.push("Home starter: " + g.homeP.name + " | " + (g.homeP.hand || "") + " | " + (g.homeP.era || "?") + " ERA");
  if (g.ou) lines.push("Over/Under: " + g.ou + " runs");
  if (g.line) lines.push("Moneyline: " + g.line);
  if (g.umpireKpg) lines.push("Umpire K/G: " + g.umpireKpg);
  if (g.weather) lines.push("Weather: " + g.weather);
  function lineupStr(lineup, label) {
    if (!lineup || !lineup.length) return "";
    var players = lineup.slice(0, 9).map(function (p, i) {
      var stat = findBatter(p.name);
      var s = (i + 1) + ". " + p.name + " (" + (p.pos || "?") + "/" + (p.hand || "?") + ")";
      if (stat) s += " [K%:" + stat.k_percent + ", xwOBA:" + stat.xwoba + ", hard_hit%:" + stat.hard_hit_percent + ", barrel%:" + stat.barrel_batted_rate + "]";
      return s;
    });
    return label + ": " + players.join(", ");
  }
  if (g.awayLineup && g.awayLineup.length) lines.push(lineupStr(g.awayLineup, g.away + " lineup"));
  if (g.homeLineup && g.homeLineup.length) lines.push(lineupStr(g.homeLineup, g.home + " lineup"));
  return lines.join("\n");
}

async function loadLineups() {
  var btn = document.getElementById("lbtn");
  var body = document.getElementById("lbody");
  btn.disabled = true;
  btn.textContent = "...";
  body.innerHTML = '<div class="lup-ph">Fetching RotoWire lineups via backend...</div>';
  try {
    var res = await fetch("/api/lineups");
    var data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    GAMES = data.games || [];
    if (!GAMES.length) {
      var schedRes = await fetch("/api/schedule");
      var schedData = await schedRes.json();
      if (!schedRes.ok) throw new Error((schedData && schedData.error) || ("HTTP " + schedRes.status));
      GAMES = (schedData.games || []).map(function (game) {
        return {
          away: game.away,
          home: game.home,
          awayP: null,
          homeP: null,
          awayLineup: [],
          homeLineup: [],
          confirmed: false,
          ou: null,
          line: null,
          umpireKpg: null,
          weather: game.gameTime ? "First pitch " + game.gameTime : null
        };
      });
      if (GAMES.length) {
        renderCards();
        addMsg("a", "RotoWire lineups are not posted yet, so I loaded <strong>today's MLB schedule</strong> instead.");
      } else {
        body.innerHTML = "<div class=\"lup-ph\">No games found yet.<br><br>RotoWire may not have posted today's confirmed lineups yet.</div>";
      }
    } else {
      renderCards();
      addMsg("a", "Loaded daily games from <strong>RotoWire</strong>.");
    }
  } catch (e) {
    body.innerHTML = '<div class="lup-err">Could not fetch lineups.<br><small style="color:#64748b">' + esc(e.message) + "</small></div>";
  }
  btn.disabled = false;
  btn.textContent = "Refresh";
}

function renderCards() {
  var body = document.getElementById("lbody");
  var html = "";
  GAMES.forEach(function (g, i) {
    var awayPtxt = g.awayP ? g.awayP.name + " (" + (g.awayP.era || "?") + " ERA)" : "TBD";
    var homePtxt = g.homeP ? g.homeP.name + " (" + (g.homeP.era || "?") + " ERA)" : "TBD";
    html += '<div class="gc" id="gc-' + i + '" onclick="selectGame(' + i + ')"><div class="gc-hdr"><div class="gc-teams">'
      + esc(g.away) + " @ " + esc(g.home) + '</div><span class="chip ' + (g.confirmed ? "chip-g" : "chip-y") + '">'
      + (g.confirmed ? "Confirmed" : "Projected")
      + '</span></div><div class="gc-row"><span class="chip chip-b">' + esc(awayPtxt)
      + '</span><span class="chip chip-g">' + esc(homePtxt) + "</span>"
      + (g.ou ? '<span class="chip chip-y">O/U ' + esc(g.ou) + "</span>" : "")
      + (g.line ? '<span class="chip chip-r">LINE: ' + esc(g.line) + "</span>" : "")
      + '</div><div class="gc-lu" id="lu-' + i + '"></div></div>';
  });
  body.innerHTML = html;
}

function selectGame(idx) {
  document.querySelectorAll(".gc").forEach(function (c) { c.classList.remove("sel"); });
  document.querySelectorAll(".gc-lu").forEach(function (l) { l.classList.remove("open"); l.innerHTML = ""; });
  var card = document.getElementById("gc-" + idx);
  var luEl = document.getElementById("lu-" + idx);
  if (!card) return;
  card.classList.add("sel");
  selectedGameIndex = idx;
  var g = GAMES[idx];
  gameCtx = buildCtx(g);
  updateContextState();
  function renderSide(label, lineup) {
    if (!lineup || !lineup.length) return "";
    var h = '<div class="lu-team">' + label + "</div>";
    lineup.slice(0, 9).forEach(function (p, i) {
      var stat = findBatter(p.name);
      h += '<div class="lu-p"><span class="lu-n">' + (i + 1) + '.</span><span class="lu-pos">' + (p.pos || "") + "</span>"
        + esc(p.name) + '<span class="lu-hand"> ' + (p.hand || "") + "</span>"
        + (stat ? ' <span class="lu-stat">K%<b>' + stat.k_percent + "</b> xwOBA<b>" + stat.xwoba + "</b></span>" : "")
        + "</div>";
    });
    return h;
  }
  var html = "";
  html += renderSide(g.away + " (Away)", g.awayLineup);
  html += renderSide(g.home + " (Home)", g.homeLineup);
  var meta = "";
  if (g.ou) meta += "<span>O/U <b>" + esc(g.ou) + "</b></span>";
  if (g.line) meta += "<span>LINE <b>" + esc(g.line) + "</b></span>";
  if (g.umpireKpg) meta += "<span>Ump K/G <b>" + esc(g.umpireKpg) + "</b></span>";
  if (g.weather) meta += "<span>Weather <b>" + esc(g.weather) + "</b></span>";
  if (meta) html += '<div class="gc-meta">' + meta + "</div>";
  luEl.innerHTML = html || '<div style="font-size:0.69rem;color:#475569;padding:4px 0">Lineup detail not available yet.</div>';
  luEl.classList.add("open");
  var matched = countMatched(g);
  addMsg("a", "<strong>" + esc(g.away + " @ " + g.home) + "</strong> loaded."
    + (matched ? "<br>Matched <strong>" + matched + "</strong> lineup players to local Statcast data." : "")
    + '<br><em style="font-size:0.76rem;color:#64748b">Now ask me to analyze this matchup.</em>');
}

async function send() {
  var inp = document.getElementById("inp");
  var btn = document.getElementById("sbtn");
  var text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  inp.style.height = "auto";
  btn.disabled = true;
  addMsg("u", esc(text));
  var ld = addMsg("a", '<div class="dots">Analyzing<span>.</span><span>.</span><span>.</span></div>');
  try {
    var activeContext = resolveContextForMessage(text);
    var res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, betType: activeBet, gameContext: activeContext })
    });
    var data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    ld.querySelector(".bub").innerHTML = fmt(data.reply || "No response");
  } catch (e) {
    ld.querySelector(".bub").innerHTML = '<span style="color:#ef4444">Error: ' + esc(String(e.message || e)) + "</span>";
  }
  btn.disabled = false;
  document.getElementById("msgs").scrollTop = 99999;
}

window.setBet = setBet;
window.switchTab = switchTab;
window.ask = ask;
window.askPlayer = askPlayer;
window.loadLineups = loadLineups;
window.selectGame = selectGame;
window.send = send;
window.applyManualContext = applyManualContext;
window.clearManualContext = clearManualContext;
window.renderSidebar = renderSidebar;
window.loadSources = loadSources;

renderSidebar();
loadHealth();
loadSources();
updateContextState();
updateBetState();

