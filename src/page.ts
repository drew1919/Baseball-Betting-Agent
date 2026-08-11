import type { BatterStat, PitcherStat } from "./stats.js";

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderPage(data: { batters: BatterStat[]; pitchers: PitcherStat[] }) {
  const batterCount = data.batters.length;
  const pitcherCount = data.pitchers.length;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Baseball Gambling Agent</title>
<script>window.APP_DATA = ${safeJson(data)};</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0f1e;color:#e2e8f0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{background:linear-gradient(135deg,#1a2540,#0d1b35);border-bottom:2px solid #2a9d8f;padding:10px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0}
header h1{font-size:1.12rem;color:#2a9d8f}
.hdate{margin-left:auto;font-size:0.68rem;color:#64748b}
.bet-bar{display:flex;gap:6px;padding:8px 14px;background:#111827;border-bottom:1px solid #1e3a5f;flex-shrink:0;align-items:center;flex-wrap:wrap}
.bet-bar label{font-size:0.67rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
.bet-btn{padding:4px 11px;border-radius:20px;font-size:0.7rem;font-weight:600;cursor:pointer;border:1.5px solid #1e3a5f;background:transparent;color:#94a3b8;transition:all .15s}
.bet-btn.on,.bet-btn:hover{border-color:#2a9d8f;color:#2a9d8f;background:rgba(42,157,143,.1)}
.status-bar{display:flex;gap:8px;padding:7px 14px;background:#0f172a;border-bottom:1px solid #1e3a5f;flex-wrap:wrap;align-items:center}
.status-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font-size:0.66rem;font-weight:700;letter-spacing:.02em}
.status-ok{background:rgba(42,157,143,.15);color:#2a9d8f}
.status-warn{background:rgba(245,158,11,.15);color:#f59e0b}
.status-muted{background:rgba(30,58,95,.35);color:#94a3b8}
.body{display:flex;flex:1;overflow:hidden}
.left{width:272px;min-width:272px;display:flex;flex-direction:column;background:#111827;border-right:1px solid #1e3a5f;overflow:hidden}
.lup-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;background:#0d1b35;border-bottom:1px solid #1e3a5f;flex-shrink:0}
.lup-title{font-size:0.71rem;font-weight:700;color:#2a9d8f;text-transform:uppercase;letter-spacing:.05em}
.lup-sub{font-size:0.6rem;color:#475569;margin-top:1px}
.load-btn{padding:4px 10px;background:#2a9d8f;color:#fff;border:none;border-radius:4px;font-size:0.69rem;font-weight:600;cursor:pointer}
.load-btn:hover{background:#21867a}
.load-btn:disabled{background:#1e3a5f;color:#64748b;cursor:not-allowed}
.lup-body{max-height:250px;overflow-y:auto;padding:7px;flex-shrink:0;border-bottom:1px solid #1e3a5f}
.lup-ph{font-size:0.71rem;color:#475569;text-align:center;padding:12px 8px;line-height:1.6}
.lup-err{font-size:0.71rem;color:#ef4444;text-align:center;padding:10px 8px;line-height:1.5}
.ctx-box{padding:9px;border-bottom:1px solid #1e3a5f;background:#0f172a}
.ctx-title{font-size:0.66rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.ctx-note{font-size:0.66rem;color:#64748b;line-height:1.5;margin-bottom:7px}
.ctx-input{width:100%;min-height:92px;padding:8px 9px;background:#1a2540;border:1px solid #1e3a5f;border-radius:6px;color:#e2e8f0;font-size:0.72rem;resize:vertical;outline:none;font-family:inherit}
.ctx-input:focus{border-color:#2a9d8f}
.ctx-actions{display:flex;gap:6px;margin-top:7px}
.ctx-btn{flex:1;padding:6px 8px;border:none;border-radius:6px;font-size:0.68rem;font-weight:700;cursor:pointer}
.ctx-btn.primary{background:#2a9d8f;color:#fff}
.ctx-btn.secondary{background:#1a2540;color:#94a3b8;border:1px solid #1e3a5f}
.ctx-preview{margin-top:7px;padding:7px 8px;background:#111827;border:1px solid #1e3a5f;border-radius:6px;font-size:0.67rem;line-height:1.5;color:#94a3b8;white-space:pre-wrap}
.src-box{padding:9px;border-bottom:1px solid #1e3a5f;background:#101826}
.src-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
.src-title{font-size:0.66rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.src-refresh{padding:4px 8px;border:1px solid #1e3a5f;background:#1a2540;color:#94a3b8;border-radius:5px;font-size:0.64rem;cursor:pointer}
.src-refresh:hover{border-color:#2a9d8f;color:#2a9d8f}
.src-list{display:flex;flex-direction:column;gap:6px}
.src-card{padding:7px 8px;background:#111827;border:1px solid #1e3a5f;border-radius:6px}
.src-name{font-size:0.7rem;font-weight:700;color:#e2e8f0}
.src-meta{margin-top:4px;font-size:0.64rem;color:#94a3b8;line-height:1.45}
.src-rows{margin-top:4px;font-size:0.62rem;color:#64748b;line-height:1.45;white-space:pre-wrap}
.gc{background:#1a2540;border:1px solid #1e3a5f;border-radius:6px;padding:8px 9px;margin-bottom:5px;cursor:pointer;transition:border-color .15s}
.gc:hover,.gc.sel{border-color:#2a9d8f;background:#1e2f49}
.gc-hdr{display:flex;align-items:center;justify-content:space-between}
.gc-teams{font-size:0.79rem;font-weight:700}
.gc-row{margin-top:3px;font-size:0.65rem;color:#64748b;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{display:inline-block;padding:1px 5px;border-radius:3px;font-size:0.62rem;font-weight:600}
.chip-g{background:rgba(42,157,143,.15);color:#2a9d8f}
.chip-b{background:rgba(99,102,241,.15);color:#818cf8}
.chip-y{background:rgba(245,158,11,.12);color:#f59e0b}
.chip-r{background:rgba(239,68,68,.12);color:#ef4444}
.gc-lu{display:none;margin-top:7px;padding-top:6px;border-top:1px solid #1e3a5f}
.gc-lu.open{display:block}
.lu-team{font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin:4px 0 2px}
.lu-p{font-size:0.69rem;color:#94a3b8;display:flex;gap:3px;padding:1px 0;align-items:baseline;flex-wrap:wrap}
.lu-n{color:#475569;width:14px;font-size:0.62rem;flex-shrink:0}
.lu-pos{color:#64748b;width:20px;font-size:0.62rem;flex-shrink:0}
.lu-hand{font-size:0.6rem;color:#475569}
.lu-stat{font-size:0.64rem;color:#64748b}
.lu-stat b{color:#94a3b8}
.gc-meta{margin-top:6px;padding-top:5px;border-top:1px dashed #1e3a5f;display:flex;gap:6px;flex-wrap:wrap;font-size:0.63rem;color:#64748b}
.gc-meta span{color:#94a3b8;font-weight:600}
.stabs{display:flex;border-bottom:1px solid #1e3a5f;flex-shrink:0}
.stab{flex:1;padding:7px 4px;text-align:center;font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;cursor:pointer}
.stab.on{color:#2a9d8f;border-bottom:2px solid #2a9d8f;background:#0d1b35}
.slist{flex:1;overflow-y:auto;padding:9px}
.srch{width:100%;padding:5px 9px;background:#1a2540;border:1px solid #1e3a5f;border-radius:5px;color:#e2e8f0;font-size:0.76rem;margin-bottom:6px;outline:none}
.srch:focus{border-color:#2a9d8f}
.pc{background:#1a2540;border:1px solid #1e3a5f;border-radius:6px;padding:7px 8px;margin-bottom:5px;cursor:pointer;transition:border-color .15s,background .15s}
.pc:hover{border-color:#2a9d8f;background:#1e2f49}
.pn{font-size:0.79rem;font-weight:600}
.ps{font-size:0.65rem;color:#64748b;margin-top:3px;display:flex;gap:3px;flex-wrap:wrap}
.b{display:inline-block;padding:1px 5px;border-radius:3px;font-size:0.61rem;font-weight:700}
.g{background:rgba(42,157,143,.2);color:#2a9d8f}
.r{background:rgba(239,68,68,.2);color:#ef4444}
.y{background:rgba(245,158,11,.2);color:#f59e0b}
.chat{flex:1;display:flex;flex-direction:column;overflow:hidden}
.msgs{flex:1;overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:11px}
.msg{max-width:87%}
.msg.u{align-self:flex-end}
.msg.a{align-self:flex-start}
.mlbl{font-size:0.64rem;color:#64748b;margin-bottom:3px;padding:0 2px}
.bub{padding:10px 13px;border-radius:10px;font-size:0.81rem;line-height:1.55}
.msg.u .bub{background:#1e40af;border-radius:10px 10px 2px 10px}
.msg.a .bub{background:#1a2540;border:1px solid #1e3a5f;border-radius:10px 10px 10px 2px}
.bub strong{color:#cbd5e1}.bub ul{margin:5px 0 0 17px;line-height:1.8}
.vy{margin-top:8px;padding:6px 10px;border-radius:5px;font-size:0.78rem;font-weight:600;background:rgba(42,157,143,.15);border-left:3px solid #2a9d8f;color:#2a9d8f}
.vn{margin-top:8px;padding:6px 10px;border-radius:5px;font-size:0.78rem;font-weight:600;background:rgba(239,68,68,.15);border-left:3px solid #ef4444;color:#ef4444}
.vm{margin-top:8px;padding:6px 10px;border-radius:5px;font-size:0.78rem;font-weight:600;background:rgba(245,158,11,.15);border-left:3px solid #f59e0b;color:#f59e0b}
.dots span{animation:blink 1.2s infinite;display:inline-block}.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:0}40%{opacity:1}}
.qs{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.qb{padding:3px 8px;background:#1a2540;border:1px solid #1e3a5f;border-radius:12px;font-size:0.68rem;color:#94a3b8;cursor:pointer;transition:all .15s}
.qb:hover{border-color:#2a9d8f;color:#2a9d8f}
.irow{padding:9px 12px;background:#111827;border-top:1px solid #1e3a5f;display:flex;gap:6px;flex-shrink:0}
.tin{flex:1;padding:8px 11px;background:#1a2540;border:1px solid #1e3a5f;border-radius:7px;color:#e2e8f0;font-size:0.81rem;resize:none;font-family:inherit;min-height:37px;max-height:100px;outline:none}
.tin:focus{border-color:#2a9d8f}.snd{padding:8px 14px;background:#2a9d8f;color:#fff;border:none;border-radius:7px;font-size:0.81rem;font-weight:600;cursor:pointer}
.snd:hover{background:#21867a}.snd:disabled{background:#1e3a5f;color:#64748b;cursor:not-allowed}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0a0f1e}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:3px}
@media (max-width: 980px){body{height:auto;overflow:auto}.body{flex-direction:column;overflow:visible}.left{width:100%;min-width:0;border-right:none;border-bottom:1px solid #1e3a5f}.lup-body{max-height:220px}.chat{min-height:60vh}}
</style>
</head>
<body>
<header>
  <span style="font-size:1.3rem">⚾</span>
  <h1>Baseball Gambling Agent</h1>
  <div class="hdate" id="hdate"></div>
</header>
<div class="bet-bar">
  <label>Bet:</label>
  <button class="bet-btn on" onclick="setBet(this,'general')">General</button>
  <button class="bet-btn" onclick="setBet(this,'nrfi')">NRFI / YRFI</button>
  <button class="bet-btn" onclick="setBet(this,'strikeouts')">Pitcher Ks</button>
  <button class="bet-btn" onclick="setBet(this,'winner')">Winner</button>
</div>
<div class="status-bar">
  <div class="status-pill status-muted" id="apiStatus">Checking backend...</div>
  <div class="status-pill status-muted" id="dataStatus">Local Savant data ${batterCount} batters / ${pitcherCount} pitchers</div>
  <div class="status-pill status-muted" id="betStatus">Bet mode: General</div>
  <div class="status-pill status-muted" id="ctxStatus">No matchup context selected</div>
</div>
<div class="body">
  <div class="left">
    <div class="lup-hdr">
      <div>
        <div class="lup-title">Today's Lineups</div>
        <div class="lup-sub">RotoWire lineups + MLB schedule context</div>
      </div>
      <button class="load-btn" id="lbtn" onclick="loadLineups()">Load Today</button>
    </div>
    <div class="lup-body" id="lbody">
      <div class="lup-ph">Click <strong>Load Today</strong> to fetch today's MLB lineups, starters, totals, moneyline, umpire K rate, and weather through the server.</div>
    </div>
    <div class="src-box">
      <div class="src-head">
        <div class="src-title">Public Source Feed</div>
        <button class="src-refresh" onclick="loadSources()">Scrape</button>
      </div>
      <div class="src-list" id="sourceList">
        <div class="lup-ph" style="padding:8px 4px">Scraping source summaries...</div>
      </div>
    </div>
    <div class="ctx-box">
      <div class="ctx-title">Manual Matchup Context</div>
      <div class="ctx-note">Paste a game note, batting order, prop line, or sportsbook context here when live lineups are missing or you want tighter prompting.</div>
      <textarea class="ctx-input" id="ctxInput" placeholder="Example: TEX @ SEA&#10;Logan Gilbert vs Max Fried&#10;O/U 7.5&#10;Top 4 hitters: ..."></textarea>
      <div class="ctx-actions">
        <button class="ctx-btn primary" onclick="applyManualContext()">Use Context</button>
        <button class="ctx-btn secondary" onclick="clearManualContext()">Clear</button>
      </div>
      <div class="ctx-preview" id="ctxPreview">Using automatic context from selected games when available.</div>
    </div>
    <div class="stabs">
      <div class="stab on" id="st-bat" onclick="switchTab('bat')">Batters</div>
      <div class="stab" id="st-pit" onclick="switchTab('pit')">Pitchers</div>
    </div>
    <div class="slist" id="slist"></div>
  </div>
  <div class="chat">
    <div class="msgs" id="msgs">
      <div class="msg a">
        <div class="mlbl">Agent</div>
        <div class="bub">
          Ready with <strong>2026 Statcast data</strong> for ${batterCount} batters and ${pitcherCount} pitchers.<br><br>
          Load today's lineups, pick a game, and I'll cross-reference the matchup against the local Statcast dataset before sending your question to the backend analyst.
          <div class="qs">
            <div class="qb" onclick="ask('Which pitchers in our data have the best strikeout upside today?')">Best K pitchers?</div>
            <div class="qb" onclick="ask('Analyze Sandy Alcantara for a NRFI bet')">NRFI: Alcantara</div>
            <div class="qb" onclick="ask('Analyze Hunter Brown strikeout prop')">K prop: Brown</div>
            <div class="qb" onclick="ask('Compare Max Fried vs Logan Gilbert for team winner')">Fried vs Gilbert</div>
          </div>
        </div>
      </div>
    </div>
    <div class="irow">
      <textarea class="tin" id="inp" placeholder="Ask about any player, matchup, or today's games..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
      <button class="snd" id="sbtn" onclick="send()">Send</button>
    </div>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>`;
}
