import type { BatterStat, PitcherStat } from "./stats.js";

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderPage(data: { batters: BatterStat[]; pitchers: PitcherStat[] }) {
  const batterCount = data.batters.length;
  const pitcherCount = data.pitchers.length;
  const measuredBatterCount = data.batters.filter((player) => player.statcast_measured).length;
  const measuredPitcherCount = data.pitchers.filter((player) => player.statcast_measured).length;
  const latestPlayerUpdate = [...data.batters, ...data.pitchers]
    .map((player) => player.data_updated_at || "")
    .filter(Boolean)
    .sort()
    .at(-1);
  const playerUpdateLabel = latestPlayerUpdate
    ? new Date(latestPlayerUpdate).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    : "refresh pending";
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
.market-panel{flex-shrink:0;background:linear-gradient(135deg,#101a2d,#0d1728);border-bottom:1px solid #1e3a5f;padding:9px 14px}
.market-panel.hidden{display:none}
.market-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.market-title{font-size:.74rem;font-weight:800;color:#2a9d8f;text-transform:uppercase;letter-spacing:.06em}
.market-sub{font-size:.64rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.market-close{margin-left:auto;border:1px solid #1e3a5f;background:#1a2540;color:#94a3b8;border-radius:5px;padding:3px 8px;cursor:pointer}
.market-rows{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(235px,1fr);gap:7px;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}
.market-card{border:1px solid #1e3a5f;background:#17233a;border-radius:8px;padding:8px 10px;text-align:left;color:#e2e8f0;font-family:inherit;cursor:pointer;min-height:76px}
.market-card:hover{border-color:#2a9d8f;background:#1b3049}
.market-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.7rem;font-weight:800}
.market-pick{color:#2a9d8f}
.market-detail{margin-top:5px;color:#94a3b8;font-size:.64rem;line-height:1.45}
.market-edge{color:#f59e0b;font-weight:700}
.market-empty{font-size:.7rem;color:#64748b;padding:8px}
.main-stage{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:radial-gradient(circle at 85% 0%,rgba(42,157,143,.08),transparent 34%),#0a0f1e}
.main-switch{display:flex;gap:4px;padding:7px 12px;background:#0d1424;border-bottom:1px solid #1e3a5f;flex-shrink:0}
.stage-tab{border:1px solid transparent;background:transparent;color:#64748b;border-radius:6px;padding:6px 12px;font:700 .68rem inherit;text-transform:uppercase;letter-spacing:.05em;cursor:pointer}
.stage-tab.on{background:#1a2540;border-color:#2a9d8f;color:#2a9d8f}
.today-panel{flex:1;min-height:0;overflow:hidden}
.workspace-hidden{display:none!important}
.today-scroll{height:100%;overflow-y:auto;padding:18px 20px 28px}
.today-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:18px 20px;border:1px solid #24415b;border-radius:12px;background:linear-gradient(135deg,rgba(42,157,143,.16),rgba(23,35,58,.92) 48%,rgba(13,23,40,.96));box-shadow:0 14px 36px rgba(0,0,0,.16)}
.today-eyebrow{font-size:.65rem;font-weight:800;color:#2a9d8f;text-transform:uppercase;letter-spacing:.12em}
.today-hero h2{font-size:1.45rem;line-height:1.15;margin-top:5px;color:#f1f5f9}
.today-hero p{font-size:.75rem;color:#94a3b8;margin-top:7px;line-height:1.5;max-width:680px}
.today-refresh{border:0;border-radius:7px;background:#2a9d8f;color:#fff;padding:9px 13px;font:800 .7rem inherit;cursor:pointer;white-space:nowrap}
.today-refresh:disabled{background:#1e3a5f;color:#64748b;cursor:wait}
.today-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:12px 0 18px}
.summary-tile{padding:11px 13px;border:1px solid #1e3a5f;border-radius:9px;background:rgba(17,24,39,.88)}
.summary-label{font-size:.59rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;font-weight:800}
.summary-value{font-size:1.05rem;color:#e2e8f0;font-weight:800;margin-top:4px}
.summary-note{font-size:.61rem;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-section{margin-top:18px}
.dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:8px}
.dash-title{font-size:.79rem;color:#e2e8f0;font-weight:850;letter-spacing:.01em}
.dash-sub{font-size:.62rem;color:#64748b;margin-top:2px}
.dash-link{border:0;background:transparent;color:#2a9d8f;font:750 .64rem inherit;cursor:pointer;padding:4px}
.dash-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.dash-grid.compact{grid-template-columns:repeat(2,minmax(0,1fr))}
.dash-two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dash-card{position:relative;border:1px solid #1e3a5f;background:linear-gradient(145deg,#17233a,#131e31);border-radius:10px;padding:12px 13px;text-align:left;color:#e2e8f0;font-family:inherit;min-width:0;cursor:pointer;transition:transform .15s,border-color .15s,background .15s}
.dash-card:hover{transform:translateY(-1px);border-color:#2a9d8f;background:linear-gradient(145deg,#1a3048,#15243a)}
.dash-card.result-card{cursor:default}
.dash-card.result-card:hover{transform:none;border-color:#1e3a5f}
.dash-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.dash-matchup{font-size:.67rem;color:#94a3b8;font-weight:750}
.dash-status{font-size:.56rem;text-transform:uppercase;letter-spacing:.06em;font-weight:850;padding:3px 6px;border-radius:999px;background:rgba(245,158,11,.12);color:#f59e0b;white-space:nowrap}
.dash-status.qualified{background:rgba(42,157,143,.18);color:#2a9d8f}
.dash-status.result-win{background:rgba(42,157,143,.18);color:#2a9d8f}
.dash-status.result-loss{background:rgba(239,68,68,.15);color:#ef4444}
.dash-pick{font-size:1rem;font-weight:850;color:#f1f5f9;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-metrics{display:flex;gap:8px;align-items:baseline;margin-top:5px;flex-wrap:wrap}
.dash-metric{font-size:.66rem;color:#2a9d8f;font-weight:800}
.dash-metric.muted{color:#94a3b8}
.dash-meta{font-size:.61rem;line-height:1.45;color:#64748b;margin-top:7px}
.dash-empty{grid-column:1/-1;padding:18px;border:1px dashed #24415b;border-radius:10px;background:rgba(15,23,42,.72);color:#94a3b8;font-size:.7rem;line-height:1.55}
.dash-empty strong{color:#e2e8f0}
.dash-loading{animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
.mobile-nav{display:none}
.body{display:flex;flex:1;overflow:hidden}
.left{width:272px;min-width:272px;display:flex;flex-direction:column;background:#111827;border-right:1px solid #1e3a5f;overflow:hidden}
.games-panel,.players-panel{display:contents}
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
.ctx-head{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.ctx-head::-webkit-details-marker{display:none}
.ctx-head::after{content:'+';margin-left:auto;color:#64748b;font-size:1rem;line-height:1}
.ctx-box[open] .ctx-head::after{content:'-'}
.ctx-title{font-size:0.66rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.ctx-optional{font-size:.61rem;color:#475569}
.ctx-content{padding-top:7px}
.ctx-note{font-size:0.66rem;color:#64748b;line-height:1.5;margin-bottom:7px}
.ctx-input{width:100%;min-height:92px;padding:8px 9px;background:#1a2540;border:1px solid #1e3a5f;border-radius:6px;color:#e2e8f0;font-size:0.72rem;resize:vertical;outline:none;font-family:inherit}
.ctx-input:focus{border-color:#2a9d8f}
.ctx-actions{display:flex;gap:6px;margin-top:7px}
.ctx-btn{flex:1;padding:6px 8px;border:none;border-radius:6px;font-size:0.68rem;font-weight:700;cursor:pointer}
.ctx-btn.primary{background:#2a9d8f;color:#fff}
.ctx-btn.secondary{background:#1a2540;color:#94a3b8;border:1px solid #1e3a5f}
.ctx-preview{margin-top:7px;padding:7px 8px;background:#111827;border:1px solid #1e3a5f;border-radius:6px;font-size:0.67rem;line-height:1.5;color:#94a3b8;white-space:pre-wrap}
.src-box{padding:9px;border-bottom:1px solid #1e3a5f;background:#101826}
.src-head{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;list-style:none}
.src-head::-webkit-details-marker{display:none}
.src-head::after{content:'+';color:#64748b;font-size:1rem;line-height:1}
.src-box[open] .src-head::after{content:'-'}
.src-title{font-size:0.66rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.src-summary{margin-left:auto;font-size:0.62rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-content{padding-top:7px}
.src-refresh{padding:4px 8px;border:1px solid #1e3a5f;background:#1a2540;color:#94a3b8;border-radius:5px;font-size:0.64rem;cursor:pointer}
.src-refresh:hover{border-color:#2a9d8f;color:#2a9d8f}
.src-actions{display:flex;justify-content:flex-end;margin-bottom:7px}
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
.player-source{padding:7px 9px;background:#101826;border-bottom:1px solid #1e3a5f;color:#64748b;font-size:.62rem;line-height:1.45}
.player-source strong{color:#2a9d8f}
.stab{flex:1;padding:7px 4px;border:0;background:transparent;text-align:center;font-family:inherit;font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;cursor:pointer}
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
@media (max-width: 900px){
  body{height:100vh;height:100dvh;min-height:0;overflow:hidden}
  header{padding:9px 12px}
  header h1{font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hdate{display:none}
  .bet-bar{padding:7px 10px;gap:7px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
  .bet-bar::-webkit-scrollbar{display:none}
  .bet-bar label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .bet-btn{min-height:36px;padding:6px 12px;white-space:nowrap;flex:0 0 auto}
  .status-bar{padding:5px 10px;gap:6px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
  .status-bar::-webkit-scrollbar{display:none}
  .status-pill{padding:4px 8px;white-space:nowrap;flex:0 0 auto;max-width:78vw;overflow:hidden;text-overflow:ellipsis}
  #dataStatus,#betStatus,#ctxStatus{display:none}
  .market-panel{padding:8px 10px;max-height:38vh;overflow:hidden}
  .market-head{margin-bottom:6px}
  .market-rows{grid-auto-columns:minmax(265px,85vw)}
  .market-card{min-height:84px;padding:10px 11px}
  .mobile-nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:6px 8px;background:#0d1424;border-bottom:1px solid #1e3a5f;flex-shrink:0}
  .mobile-tab{min-height:42px;border:1px solid transparent;border-radius:7px;background:transparent;color:#64748b;font:700 .7rem inherit;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}
  .mobile-tab.on{background:#1a2540;border-color:#2a9d8f;color:#2a9d8f}
  .body{display:block;flex:1;min-height:0;overflow:hidden}
  .left{display:contents}
  .main-stage{display:contents}
  .main-switch{display:none}
  .games-panel,.players-panel,.today-panel,.chat{display:none}
  .games-panel.mobile-active,.players-panel.mobile-active,.today-panel.mobile-active,.chat.mobile-active{display:flex;height:100%;min-height:0}
  .games-panel{flex-direction:column;overflow-y:auto;overscroll-behavior:contain;background:#111827;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
  .players-panel{flex-direction:column;background:#111827}
  .today-panel{flex-direction:column;background:#0a0f1e}
  .chat{flex-direction:column;background:#0a0f1e}
  .today-scroll{padding:12px 10px 22px;overscroll-behavior:contain}
  .today-hero{align-items:flex-start;padding:14px;gap:12px}
  .today-hero h2{font-size:1.18rem}
  .today-hero p{font-size:.7rem}
  .today-refresh{min-height:40px;padding:8px 10px}
  .today-summary{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:9px 0 15px}
  .summary-tile{padding:10px 11px}
  .dash-two-col{grid-template-columns:1fr;gap:4px}
  .dash-grid,.dash-grid.compact{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:4px}
  .dash-card{flex:0 0 82vw;scroll-snap-align:start;padding:12px}
  .dash-empty{flex:0 0 100%}
  .dash-section{margin-top:16px}
  .lup-hdr{position:sticky;top:0;z-index:2;padding:10px 12px}
  .lup-body{max-height:none;overflow:visible;padding:8px 10px}
  .load-btn,.src-refresh,.ctx-btn{min-height:40px}
  .src-box{padding:10px 12px}
  .src-summary{max-width:48vw}
  .src-card{padding:9px}
  .src-meta,.src-rows{overflow-wrap:anywhere}
  .ctx-box{padding:11px 12px}
  .ctx-input{min-height:76px}
  .stabs{min-height:46px}
  .stab{display:flex;align-items:center;justify-content:center;min-height:46px}
  .slist{min-height:0;padding:10px 12px 18px;overscroll-behavior:contain}
  .srch{min-height:44px;padding:9px 11px;font-size:16px}
  .pc{padding:11px 12px;margin-bottom:8px;min-height:58px}
  .pn{font-size:.86rem}.ps{font-size:.69rem;margin-top:5px}
  .msgs{min-height:0;padding:12px 10px 18px;gap:13px;overscroll-behavior:contain}
  .msg{max-width:94%}
  .bub{padding:10px 12px;font-size:.84rem}
  .irow{padding:8px 9px calc(8px + env(safe-area-inset-bottom));position:sticky;bottom:0}
  .tin{min-height:44px;padding:10px 11px;font-size:16px}
  .snd{min-width:64px;min-height:44px;padding:9px 12px}
}
@media (max-width: 380px){
  header h1{font-size:.91rem}
  .bet-btn{padding:6px 10px}
  .mobile-tab{font-size:.64rem}
  .status-pill{font-size:.61rem}
}
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
  <button class="bet-btn on" data-bet="general" onclick="setBet(this,'general')">General</button>
  <button class="bet-btn" data-bet="nrfi" onclick="setBet(this,'nrfi')">NRFI / YRFI</button>
  <button class="bet-btn" data-bet="strikeouts" onclick="setBet(this,'strikeouts')">Pitcher Ks</button>
  <button class="bet-btn" data-bet="winner" onclick="setBet(this,'winner')">Winner</button>
</div>
<div class="status-bar">
  <div class="status-pill status-muted" id="apiStatus">Checking backend...</div>
  <div class="status-pill status-muted" id="dataStatus">Local Savant data ${batterCount} batters / ${pitcherCount} pitchers</div>
  <div class="status-pill status-muted" id="betStatus">Bet mode: General</div>
  <div class="status-pill status-muted" id="ctxStatus">No matchup context selected</div>
</div>
<section class="market-panel hidden" id="marketPanel" aria-live="polite">
  <div class="market-head">
    <div class="market-title" id="marketTitle">Daily market board</div>
    <div class="market-sub" id="marketSub">Loading matchup projections...</div>
    <button class="market-close" type="button" onclick="hideMarketBoard()" aria-label="Close market board">Close</button>
  </div>
  <div class="market-rows" id="marketRows"><div class="market-empty">Loading...</div></div>
</section>
<nav class="mobile-nav" role="tablist" aria-label="Mobile workspace">
  <button class="mobile-tab on" id="mobile-today" role="tab" aria-selected="true" aria-controls="todayPanel" onclick="setWorkspaceView('today')">Today</button>
  <button class="mobile-tab" id="mobile-games" role="tab" aria-selected="false" aria-controls="gamesPanel" onclick="setWorkspaceView('games')">Games</button>
  <button class="mobile-tab" id="mobile-chat" role="tab" aria-selected="false" aria-controls="chatPanel" onclick="setWorkspaceView('chat')">Chat</button>
  <button class="mobile-tab" id="mobile-players" role="tab" aria-selected="false" aria-controls="playersPanel" onclick="setWorkspaceView('players')">Players</button>
</nav>
<div class="body">
  <div class="left">
    <section class="games-panel mobile-view mobile-active" id="gamesPanel" role="tabpanel" aria-labelledby="mobile-games">
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
    <details class="src-box" id="sourceBox">
      <summary class="src-head">
        <span class="src-title">Data Sources</span>
        <span class="src-summary" id="sourceSummary">Updating...</span>
      </summary>
      <div class="src-content">
        <div class="src-actions"><button class="src-refresh" onclick="event.preventDefault();loadSources()">Refresh sources</button></div>
        <div class="src-list" id="sourceList">
          <div class="lup-ph" style="padding:8px 4px">Scraping source summaries...</div>
        </div>
      </div>
    </details>
    <details class="ctx-box" id="ctxBox" open>
      <summary class="ctx-head">
        <span class="ctx-title">Manual Matchup Context</span>
        <span class="ctx-optional">Optional</span>
      </summary>
      <div class="ctx-content">
        <div class="ctx-note">Paste a game note, batting order, prop line, or sportsbook context here when live lineups are missing or you want tighter prompting.</div>
        <textarea class="ctx-input" id="ctxInput" placeholder="Example: TEX @ SEA&#10;Logan Gilbert vs Max Fried&#10;O/U 7.5&#10;Top 4 hitters: ..."></textarea>
        <div class="ctx-actions">
          <button class="ctx-btn primary" onclick="applyManualContext()">Use Context</button>
          <button class="ctx-btn secondary" onclick="clearManualContext()">Clear</button>
        </div>
        <div class="ctx-preview" id="ctxPreview">Using automatic context from selected games when available.</div>
      </div>
    </details>
    </section>
    <section class="players-panel mobile-view" id="playersPanel" role="tabpanel" aria-labelledby="mobile-players">
    <div class="player-source"><strong>Measured Savant season stats</strong><br>${measuredBatterCount}/${batterCount} batters and ${measuredPitcherCount}/${pitcherCount} pitchers · updated ${playerUpdateLabel} ET</div>
    <div class="stabs">
      <button type="button" class="stab on" id="st-bat" onclick="switchTab('bat')">Batters</button>
      <button type="button" class="stab" id="st-pit" onclick="switchTab('pit')">Pitchers</button>
    </div>
    <div class="slist" id="slist"></div>
    </section>
  </div>
  <div class="main-stage">
    <nav class="main-switch" aria-label="Main workspace">
      <button class="stage-tab on" id="stage-today" onclick="setWorkspaceView('today')">Today</button>
      <button class="stage-tab" id="stage-chat" onclick="setWorkspaceView('chat')">Chat</button>
    </nav>
    <main class="today-panel mobile-view mobile-active" id="todayPanel" role="tabpanel" aria-labelledby="mobile-today">
      <div class="today-scroll" id="todayScroll">
        <section class="today-hero">
          <div>
            <div class="today-eyebrow">Daily decision room</div>
            <h2>Today's betting dashboard</h2>
            <p id="todayLead">Loading confirmed lineups, model projections, validation gates, and recent results.</p>
          </div>
          <button class="today-refresh" id="todayRefresh" onclick="loadTodayDashboard(true)">Refresh</button>
        </section>
        <div class="today-summary">
          <div class="summary-tile"><div class="summary-label">Games</div><div class="summary-value" id="sumGames">--</div><div class="summary-note" id="sumGamesNote">Loading slate</div></div>
          <div class="summary-tile"><div class="summary-label">Qualified bets</div><div class="summary-value" id="sumBets">--</div><div class="summary-note" id="sumBetsNote">Validation gates active</div></div>
          <div class="summary-tile"><div class="summary-label">Lineups</div><div class="summary-value" id="sumLineups">--</div><div class="summary-note" id="sumLineupsNote">Checking confirmations</div></div>
          <div class="summary-tile"><div class="summary-label">Recent model</div><div class="summary-value" id="sumAccuracy">--</div><div class="summary-note" id="sumAccuracyNote">Prospective winner history</div></div>
        </div>
        <section class="dash-section" id="dash-best">
          <div class="dash-head"><div><div class="dash-title">Best Bets</div><div class="dash-sub">Only recommendations that clear validation and pricing gates</div></div></div>
          <div class="dash-grid" id="bestBetsGrid"><div class="dash-empty dash-loading">Evaluating today's slate...</div></div>
        </section>
        <section class="dash-section" id="dash-winner">
          <div class="dash-head"><div><div class="dash-title">Projected Winners</div><div class="dash-sub">Full-slate statistical leans, ranked by model probability</div></div><button class="dash-link" onclick="openDashboardAnalysis('winner')">Analyze slate</button></div>
          <div class="dash-grid" id="winnerGrid"><div class="dash-empty dash-loading">Loading winner snapshots...</div></div>
        </section>
        <div class="dash-two-col">
          <section class="dash-section" id="dash-nrfi">
            <div class="dash-head"><div><div class="dash-title">NRFI / YRFI</div><div class="dash-sub">Both halves modeled independently</div></div><button class="dash-link" onclick="focusDashboardSection('nrfi')">View slate</button></div>
            <div class="dash-grid compact" id="nrfiGrid"><div class="dash-empty dash-loading">Loading inning-one projections...</div></div>
          </section>
          <section class="dash-section" id="dash-strikeouts">
            <div class="dash-head"><div><div class="dash-title">Pitcher Ks</div><div class="dash-sub">Workload, matchup, Statcast, umpire, and available prices</div></div><button class="dash-link" onclick="focusDashboardSection('strikeouts')">View slate</button></div>
            <div class="dash-grid compact" id="strikeoutGrid"><div class="dash-empty dash-loading">Loading starter projections...</div></div>
          </section>
        </div>
        <section class="dash-section" id="dash-results">
          <div class="dash-head"><div><div class="dash-title">Recent Results</div><div class="dash-sub">Graded winner predictions from immutable pregame snapshots</div></div><button class="dash-link" onclick="focusDashboardSection('results')">View history</button></div>
          <div class="dash-grid" id="resultsGrid"><div class="dash-empty dash-loading">Reconciling final scores...</div></div>
        </section>
      </div>
    </main>
    <main class="chat mobile-view" id="chatPanel" role="tabpanel" aria-labelledby="mobile-chat">
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
    </main>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>`;
}
