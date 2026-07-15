import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { fetchQuotes, fetchOpenPositionChains, findOptionForContract, fetchPositions, schwabGet, buildOCCSymbol, fetchOptionQuotes } from "./schwab.js";
import { BarChart, Bar, ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── camelCase <-> snake_case converters ──────────────────────────────────────
function toApp(row) {
  if (!row) return null;
  return {
    id:               row.id,
    parentId:         row.parent_id,
    closedById:       row.closed_by_id,
    stock:            row.stock,
    type:             row.type,
    optType:          row.opt_type,
    strike:           row.strike != null ? +row.strike : null,
    qty:              row.qty,
    expires:          row.expires,
    premium:          row.premium != null ? +row.premium : null,
    priceAtExecution: row.price_at_execution != null ? +row.price_at_execution : null,
    dateExec:         row.date_exec,
    account:          row.account,
    status:           row.status,
    costToClose:      row.cost_to_close != null ? +row.cost_to_close : null,
    closeDate:        row.close_date,
    stockPriceAtClose: row.stock_price_at_close != null ? +row.stock_price_at_close : null,
    profit:           row.profit != null ? +row.profit : null,
    profitPct:        row.profit_pct != null ? +row.profit_pct : null,
    daysHeld:         row.days_held,
    exercised:        row.exercised,
    rolledOver:       row.rolled_over,
    notes:            row.notes,
    createdVia:       row.created_via,
    createdBy:        row.created_by,
    currentPrice:     row.current_price != null ? +row.current_price : null,
    strategy:         row.strategy || null,
    strategyGroupId:  row.strategy_group_id != null ? +row.strategy_group_id : null,
    strategyType:     row.strategy_type || null,
    openMethod:          row.open_method || null,
    closeMethod:         row.close_method || null,
    stopLossMultiplier:  row.stop_loss_multiplier != null ? +row.stop_loss_multiplier : 2.0,
    timeStopDte:         row.time_stop_dte != null ? +row.time_stop_dte : null,
    deltaStop:           row.delta_stop != null ? +row.delta_stop : null,
    lastExitAlertAt:     row.last_exit_alert_at || null,
  };
}
function toDB(c) {
  return {
    id:                 c.id,
    parent_id:          c.parentId || null,
    closed_by_id:       c.closedById || null,
    stock:              c.stock || null,
    type:               c.type,
    opt_type:           c.optType,
    strike:             c.strike != null ? +c.strike : null,
    qty:                c.qty != null ? +c.qty : null,
    expires:            c.expires || null,
    premium:            c.premium != null ? +c.premium : null,
    price_at_execution: c.priceAtExecution != null ? +c.priceAtExecution : null,
    date_exec:          c.dateExec || null,
    account:            c.account || null,
    status:             c.status || "Open",
    cost_to_close:      c.costToClose != null ? +c.costToClose : null,
    close_date:         c.closeDate || null,
    stock_price_at_close: c.stockPriceAtClose != null ? +c.stockPriceAtClose : null,
    profit:             c.profit != null ? +c.profit : null,
    profit_pct:         c.profitPct != null ? +c.profitPct : null,
    days_held:          c.daysHeld != null ? +c.daysHeld : null,
    exercised:          c.exercised || null,
    rolled_over:        c.rolledOver || null,
    notes:              c.notes || null,
    created_via:        c.createdVia || "Manual",
    created_by:         c.createdBy || null,
    current_price:      c.currentPrice != null ? +c.currentPrice : null,
    strategy:           c.strategy || null,
    strategy_group_id:  c.strategyGroupId != null ? +c.strategyGroupId : null,
    strategy_type:      c.strategyType || null,
    open_method:           c.openMethod || null,
    close_method:          c.closeMethod || null,
    stop_loss_multiplier:  c.stopLossMultiplier != null ? +c.stopLossMultiplier : 2.0,
    time_stop_dte:         c.timeStopDte != null ? +c.timeStopDte : null,
    delta_stop:            c.deltaStop != null ? +c.deltaStop : null,
  };
}
function planToApp(row) {
  return {
    id:           row.id,
    ticker:       row.ticker,
    action:       row.action,
    type:         row.type || "Call",
    account:      row.account || null,
    qty:          row.qty,
    strike:       row.strike,
    expiration:   row.expiration,
    premium:      row.premium,
    stockPrice:   row.stock_price,
    bid:          row.bid,
    ask:          row.ask,
    last:         row.last,
    targetPremium:row.target_premium,
    notes:        row.notes,
    status:       row.status,
    createdAt:    row.created_at,
    doneAt:       row.done_at,
  };
}
function planToDB(p) {
  return {
    id:            p.id,
    ticker:        p.ticker,
    action:        p.action,
    type:          p.type || "Call",
    account:       p.account || null,
    qty:           p.qty ? +p.qty : null,
    strike:        p.strike ? +p.strike : null,
    expiration:    p.expiration || null,
    premium:       p.premium ? +p.premium : null,
    stock_price:   p.stockPrice ? +p.stockPrice : null,
    bid:           p.bid ? +p.bid : null,
    ask:           p.ask ? +p.ask : null,
    last:          p.last ? +p.last : null,
    target_premium:p.targetPremium ? +p.targetPremium : null,
    notes:         p.notes || null,
    status:        p.status || "open",
  };
}

// ── Users ─────────────────────────────────────────────────────────────────────
const USERS_DEFAULT = [
  { id:"frank",     name:"Frank M DiMarzio",           initials:"FD", color:"#00ff88", pin:"0116" },
  { id:"priscilla", name:"Priscilla Perutti DiMarzio", initials:"PP", color:"#58a6ff", pin:"4223" },
];

// ── Seed: open contracts only ─────────────────────────────────────────────────
const SEED = [
  {id:369,stock:null,type:"Call",optType:"BTO",strike:50.0,qty:50,expires:"2026-04-10",premium:-583.1,priceAtExecution:45.32,dateExec:"2026-04-01",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:374,stock:null,type:"Call",optType:"BTO",strike:257.5,qty:1,expires:"2026-04-06",premium:-84.66,priceAtExecution:null,dateExec:"2026-04-02",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"mistakenly BTO",createdVia:"Excel",currentPrice:null},
  {id:375,stock:null,type:"Call",optType:"STO",strike:177.5,qty:3,expires:"2026-04-06",premium:412.44,priceAtExecution:176.12,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:376,stock:null,type:"Call",optType:"STO",strike:210.0,qty:3,expires:"2026-04-06",premium:595.43,priceAtExecution:209.36,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:377,stock:null,type:"Call",optType:"STO",strike:372.5,qty:2,expires:"2026-04-06",premium:408.95,priceAtExecution:369.87,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:378,stock:null,type:"Call",optType:"STO",strike:255.0,qty:2,expires:"2026-04-06",premium:362.95,priceAtExecution:254.37,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:379,stock:null,type:"Call",optType:"STO",strike:297.5,qty:2,expires:"2026-04-10",premium:668.94,priceAtExecution:295.26,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:380,stock:null,type:"Call",optType:"STO",strike:50.0,qty:5,expires:"2026-04-10",premium:792.39,priceAtExecution:47.8,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:381,stock:null,type:"Call",optType:"STO",strike:217.5,qty:1,expires:"2026-04-10",premium:464.48,priceAtExecution:213.3,dateExec:"2026-04-02",account:"Etrade",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:382,stock:null,type:"Call",optType:"STO",strike:97.0,qty:2,expires:"2026-04-10",premium:486.67,priceAtExecution:97.82,dateExec:"2026-04-02",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:383,stock:null,type:"Call",optType:"STO",strike:300.0,qty:1,expires:"2026-04-10",premium:1268.34,priceAtExecution:296.41,dateExec:"2026-04-02",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:384,stock:null,type:"Call",optType:"STO",strike:297.5,qty:2,expires:"2026-04-10",premium:620.67,priceAtExecution:294.87,dateExec:"2026-04-02",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
  {id:385,stock:null,type:"Call",optType:"STO",strike:212.5,qty:7,expires:"2026-04-06",premium:506.35,priceAtExecution:209.07,dateExec:"2026-04-02",account:"Schwab",status:"Open",costToClose:null,closeDate:null,profit:null,profitPct:null,daysHeld:null,exercised:null,rolledOver:null,notes:"",createdVia:"Excel",currentPrice:null},
];

// ── Formatters ────────────────────────────────────────────────────────────────
const f$    = v=>v==null?"—":"$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const f$0   = v=>v==null?"—":"$"+Math.round(Math.abs(v)).toLocaleString("en-US"); // no cents
const fSign = v=>v==null?"—":(v>=0?"+":"-")+"$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fSign0= v=>v==null?"—":(v>=0?"+":"-")+"$"+Math.round(Math.abs(v)).toLocaleString("en-US"); // no cents
const fMoney = v=>v==null?"—":(v<0?"-":"")+"$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fPct  = v=>v==null?"—":(v*100).toFixed(1)+"%";
const TODAY = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);

// ── Contract title formatter (Schwab/Etrade style) ────────────────────────────
function fTitle(c) {
  if (!c) return "—";
  const ticker = c.stock || "?";
  const exp = c.expires ? (() => {
    const d = new Date(c.expires + "T12:00:00");
    return (d.getMonth()+1).toString().padStart(2,"0") + "/" + d.getDate().toString().padStart(2,"0") + "/" + d.getFullYear();
  })() : "—";
  const strike = c.strike != null ? c.strike.toFixed(2) : "—";
  const typeChar = c.type === "Put" ? "P" : "C";
  return `${ticker} ${exp} ${strike} ${typeChar}`;
}

// ── Expiry schedules ──────────────────────────────────────────────────────────
const EXPIRY_SCHEDULES = {
  AMZN:["Mon","Wed","Fri"],TSLA:["Mon","Wed","Fri"],AAPL:["Mon","Wed","Fri"],
  NVDA:["Mon","Wed","Fri"],SPY:["Mon","Wed","Fri"],QQQ:["Mon","Wed","Fri"],
  META:["Mon","Wed","Fri"],MSFT:["Mon","Wed","Fri"],GOOG:["Fri"],GOOGL:["Fri"],
  NFLX:["Fri"],RBLX:["Fri"],OKLO:["Fri"],JPM:["Fri"],SMCI:["Fri"],MSTR:["Fri"],NVTS:["Fri"],AMD:["Fri"],
};
function nextExpiry(ticker) {
  const days = EXPIRY_SCHEDULES[ticker?.toUpperCase()]; if (!days) return "";
  const dm = {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}; const targets = days.map(d=>dm[d]);
  // Use ET date so after-hours entry on Friday night doesn't skip to the following week
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  for (let i=1;i<=14;i++) {
    const d = new Date(nowET);
    d.setDate(nowET.getDate()+i);
    if (targets.includes(d.getDay())) return d.toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0,10);
  }
  return "";
}

// ── ITM/OTM helper ────────────────────────────────────────────────────────────
function getITMStatus(contract) {
  const price = contract.currentPrice;
  if (price == null) return null;
  const strike = contract.strike;
  if (contract.type === "Call") return price > strike ? "ITM" : "OTM";
  if (contract.type === "Put")  return price < strike ? "ITM" : "OTM";
  return null;
}

// ── Sound engine (Web Audio API) ─────────────────────────────────────────────
function playCashRegister() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const play = (freq, start, dur, vol=0.3) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = freq; o.type = "sine";
      g.gain.setValueAtTime(0, ctx.currentTime + start);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
    };
    // Cash register: ding sequence
    play(1047, 0,    0.15, 0.4);
    play(1319, 0.1,  0.12, 0.35);
    play(1568, 0.2,  0.12, 0.35);
    play(2093, 0.3,  0.25, 0.5);
    // Coin jingles
    [0.55, 0.65, 0.72, 0.80, 0.88].forEach((t,i) => {
      play(2637 + i*100, t, 0.08, 0.25);
    });
  } catch(e) {}
}

function playLoss() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sawtooth"; o.frequency.setValueAtTime(220, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.4);
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

// ── Default form states ───────────────────────────────────────────────────────
const EMPTY_NEW = {stock:"",type:"Call",optType:"STO",strike:"",qty:"",expires:"",premium:"",priceAtExecution:"",dateExec:TODAY,account:"",notes:"",strategy:"OTM Covered Call Strategy",tradeRule:"",createdVia:"Manual",currentPrice:null};
const EMPTY_CLOSE = {costToClose:"",closeDate:TODAY,exercised:"No",rolledOver:"No",notes:"",stockPriceAtClose:""};

// ── Default column config ─────────────────────────────────────────────────────
const DEFAULT_COLS = [
  {key:"ticker",      label:"Ticker",       show:true,  sortKey:"stock"},
  {key:"contract",    label:"Contract",     show:false, sortKey:null},
  {key:"optType",     label:"Opt",          show:true,  sortKey:"optType"},
  {key:"strike",      label:"Strike",       show:true,  sortKey:"strike",      right:true},
  {key:"qty",         label:"Qty",          show:true,  sortKey:"qty",         right:true},
  {key:"expires",     label:"Expires",      show:true,  sortKey:"expires"},
  {key:"dateExec",    label:"Executed",     show:false, sortKey:"dateExec"},
  {key:"premium",     label:"Premium",      show:true,  sortKey:"premium",     right:true},
  {key:"costToClose", label:"Cost/Close",   show:true,  sortKey:"costToClose", right:true},
  {key:"closeDate",   label:"Close Date",   show:true,  sortKey:"closeDate"},
  {key:"profit",      label:"Profit",       show:true,  sortKey:"profit",      right:true},
  {key:"profitPct",   label:"Profit %",     show:true,  sortKey:"profitPct",   right:true},
  {key:"daysHeld",    label:"Days Held",    show:true,  sortKey:"daysHeld",    right:true},
  {key:"account",     label:"Acct",         show:true,  sortKey:"account"},
  {key:"status",      label:"Status",       show:true,  sortKey:"status"},
  {key:"itmotm",      label:"ITM/OTM",      show:true,  sortKey:null},
  {key:"otmPct",      label:"OTM %",        show:false, sortKey:null,          right:true},
  {key:"band",        label:"Band",         show:false, sortKey:null},
  {key:"tgtPerShare", label:"$/share",      show:false, sortKey:null,          right:true},
  {key:"tgtClose",    label:"Tgt Close $",  show:false, sortKey:null,          right:true},
  {key:"liveStockPrice", label:"Stock $",     show:true,  sortKey:null,          right:true},
  {key:"liveChange",     label:"Chg",         show:true,  sortKey:null,          right:true},
  {key:"liveBid",        label:"Opt Bid",     show:true,  sortKey:null,          right:true},
  {key:"liveAsk",        label:"Opt Ask",     show:true,  sortKey:null,          right:true},
  {key:"liveLast",       label:"Opt Last",    show:true,  sortKey:null,          right:true},
  {key:"mktValue",       label:"Mkt Value",   show:true,  sortKey:null,          right:true},
  {key:"liveGain",       label:"Gain $",      show:true,  sortKey:null,          right:true},
  {key:"liveGainPct",    label:"Gain %",      show:true,  sortKey:null,          right:true},
  {key:"signal",         label:"Signal",      show:true,  sortKey:null,          right:false},
];

// ── Theme helper — module-level so all components can access it ───────────────
// _lightMode is synced from App state on every render (see App component body)
let _lightMode = false;
const th = (d, l) => _lightMode ? l : d;

// ── UI Primitives ─────────────────────────────────────────────────────────────
const Tag = ({children, color="green"}) => {
  const pal = {green:"#00ff88",red:"#ff4560",blue:"#58a6ff",amber:"#ffd166",gray:"#555",purple:"#c084fc"};
  const c = pal[color]||pal.gray;
  return <span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",background:`${c}18`,color:c,border:`1px solid ${c}30`,borderRadius:3,padding:"1px 6px",whiteSpace:"nowrap"}}>{children}</span>;
};
const KPI = ({label,value,sub,color="#00ff88"}) => (
  <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"10px 12px",flex:1,minWidth:88}}>
    <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:2,textTransform:"uppercase"}}>{label}</div>
    <div style={{fontSize:15,fontWeight:700,color,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.2}}>{value}</div>
    {sub && <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),marginTop:1,fontFamily:"monospace"}}>{sub}</div>}
  </div>
);
const FL = ({children,req}) => (
  <div style={{fontSize:9,color:"#4a5568",fontFamily:"monospace",marginBottom:3,textTransform:"uppercase",letterSpacing:"0.06em"}}>
    {children}{req && <span style={{color:"#ff4560",marginLeft:2}}>*</span>}
  </div>
);
const ChartTip = ({active,payload,label}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:5,padding:"8px 11px"}}>
      <div style={{color:"#555",fontSize:10,marginBottom:4,fontFamily:"monospace"}}>{label}</div>
      {payload.map((p,i) => <div key={i} style={{color:p.color,fontSize:11,fontFamily:"monospace"}}>{p.name}: {p.name==="Contracts"?p.value:f$(p.value)}</div>)}
    </div>
  );
};

// ── Coin / Loss animation overlay ─────────────────────────────────────────────
// ── Contract Decay Chart ──────────────────────────────────────────────────────
// Single chart: stock price (left axis, grey line) + option value (right axis, red curve)
// Strike price = dotted horizontal line. Blue dot = today.
function ContractDecayChart({ contract, stocksData }) {
  const { dateExec, expires, premium, priceAtExecution, currentPrice, type, strike, optType, qty, stock } = contract;
  if (!expires || !dateExec || !premium) return null;

  const nd = x => { const a=Math.abs(x),t=1/(1+0.2316419*a),d=0.3989423*Math.exp(-0.5*a*a);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))));return x>=0?1-p:p; };
  const bsP = (S,K,T,r,sig,call) => { if(T<=0||sig<=0)return call?Math.max(0,S-K):Math.max(0,K-S); const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T); return call?S*nd(d1)-K*Math.exp(-r*T)*nd(d2):K*Math.exp(-r*T)*nd(-d2)-S*nd(-d1); };

  const today = new Date(); today.setHours(0,0,0,0);
  const execDate  = new Date(dateExec + 'T00:00:00');
  const expDate   = new Date(expires  + 'T00:00:00');
  const totalDays  = Math.max(1, Math.round((expDate - execDate) / 86400000));
  const daysElapsed = Math.max(0, Math.min(totalDays, Math.round((today - execDate) / 86400000)));
  const daysLeft    = Math.max(0, Math.round((expDate - today) / 86400000));

  const isSTO  = optType === 'STO';
  const isCall = type === 'Call';
  const K      = +strike;
  const r      = 0.05;
  const S0     = priceAtExecution || K;
  const liveStock = stocksData?.[stock]?.currentPrice ?? null;
  const premPerShare = Math.abs(premium) / Math.max(1, qty) / 100;

  // Back-solve IV from entry premium
  let sigma = 0.40;
  for (let i = 0; i < 60; i++) {
    const T0 = totalDays / 365;
    const p  = bsP(S0, K, T0, r, sigma, isCall);
    const vega = S0 * Math.sqrt(T0) * 0.3989423 * Math.exp(-0.5 * ((Math.log(S0/K)+(r+0.5*sigma*sigma)*T0)/(sigma*Math.sqrt(T0)))**2);
    if (Math.abs(p - premPerShare) < 0.0005) break;
    sigma = Math.max(0.01, Math.min(5, sigma - (p - premPerShare) / (vega || 0.01)));
  }

  // Option value at each day
  const optPts = Array.from({length: totalDays + 1}, (_, d) => ({
    d, val: Math.max(0, bsP(S0, K, Math.max(0,(totalDays-d)/365), r, sigma, isCall))
  }));

  // Current option value
  const curOptVal  = currentPrice != null ? Math.abs(currentPrice) : optPts[daysElapsed]?.val ?? 0;
  const pnlPct     = isSTO && premPerShare > 0 ? ((premPerShare - curOptVal) / premPerShare) * 100 : null;
  const pnlDollar  = isSTO ? (premPerShare - curOptVal) * qty * 100 : null;
  const pnlColor   = (pnlDollar ?? 0) >= 0 ? '#00ff88' : '#ff4560';
  const liveS      = liveStock ?? S0;
  const isITM      = isCall ? liveS > K : liveS < K;
  const itmColor   = isITM ? '#ff4560' : '#00ff88';

  // Chart dimensions — single panel
  const W   = 432;
  const H   = 150;
  const PAD = { top: 16, right: 46, bottom: 26, left: 52 };
  const cW  = W - PAD.left - PAD.right;
  const cH  = H - PAD.top  - PAD.bottom;

  const sX = d => PAD.left + (d / totalDays) * cW;

  // ── Left axis: stock price ──
  // Range centers on strike ±12%, but must include both S0 and liveStock
  const pad12 = K * 0.12;
  const sMin = Math.min(K - pad12, S0 * 0.97, liveS * 0.97);
  const sMax = Math.max(K + pad12, S0 * 1.03, liveS * 1.03);
  const scaleS = v => PAD.top + cH - ((v - sMin) / (sMax - sMin)) * cH;

  const strikeY    = scaleS(K);
  const entryStockY = scaleS(S0);
  const liveStockY  = scaleS(liveS);
  const todayX      = sX(daysElapsed);

  // ── Right axis: option value ──
  const scaleO = v => PAD.top + cH - (Math.min(v, premPerShare) / premPerShare) * cH;

  const optCurvePath = optPts.map((p,i) => `${i===0?'M':'L'}${sX(p.d).toFixed(1)},${scaleO(p.val).toFixed(1)}`).join(' ');
  const optAreaPath  = optCurvePath + ` L${sX(totalDays).toFixed(1)},${(PAD.top+cH).toFixed(1)} L${PAD.left},${(PAD.top+cH).toFixed(1)} Z`;
  const todayOptY    = scaleO(curOptVal);

  // Stock line: entry → today
  const stockLinePath = `M${sX(0)},${entryStockY.toFixed(1)} L${todayX},${liveStockY.toFixed(1)}`;

  // DANI 80% target day
  const target80Day = optPts.findIndex(p => p.val <= premPerShare * 0.20);
  const target80X   = target80Day >= 0 ? sX(target80Day) : null;

  const gradId = `dcg_${contract.id}`;

  // X labels
  const xLabels = [
    { d: 0,          label: 'Entry' },
    { d: Math.round(totalDays/2), label: `${Math.round(totalDays/2)}d` },
    { d: totalDays,  label: 'Exp' },
  ];

  // Right-axis option price ticks
  const optTicks = [0, 0.5, 1].map(f => ({
    f, val: premPerShare * f, y: scaleO(premPerShare * f)
  }));

  // Left-axis stock price ticks: sMin, K, sMax
  const stockTicks = [
    { v: sMin, label: `$${sMin.toFixed(0)}` },
    { v: K,    label: `$${K.toFixed(0)}` },
    { v: sMax, label: `$${sMax.toFixed(0)}` },
  ];

  return (
    <div style={{background:'#080c12',borderRadius:8,padding:'10px 12px',border:'1px solid #1c2128',marginTop:10}}>

      {/* Stats row */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
        <span style={{fontFamily:'monospace',fontSize:8,color:'#3a4050',letterSpacing:'0.07em'}}>THETA DECAY</span>
        <div style={{display:'flex',gap:10}}>
          {liveStock != null && (
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>STOCK</div>
              <div style={{fontSize:10,color:'#c9d1d9',fontFamily:'monospace'}}>${liveStock.toFixed(2)}</div>
            </div>
          )}
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>STATUS</div>
            <div style={{fontSize:10,color:itmColor,fontFamily:'monospace',fontWeight:700}}>{isITM?'ITM':'OTM'}</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>DTE</div>
            <div style={{fontSize:10,color:daysLeft<=3?'#ff4560':daysLeft<=7?'#ffd166':'#c9d1d9',fontFamily:'monospace'}}>{daysLeft}d</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>EST IV</div>
            <div style={{fontSize:10,color:'#c9d1d9',fontFamily:'monospace'}}>{(sigma*100).toFixed(0)}%</div>
          </div>
          {pnlPct != null && (
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>RETAINED</div>
              <div style={{fontSize:10,color:pnlColor,fontFamily:'monospace',fontWeight:700}}>{Math.min(100,Math.max(0,pnlPct)).toFixed(0)}%</div>
            </div>
          )}
          {pnlDollar != null && (
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>P&L</div>
              <div style={{fontSize:10,color:pnlColor,fontFamily:'monospace',fontWeight:700}}>{pnlDollar>=0?'+':''}{f$(pnlDollar)}</div>
            </div>
          )}
        </div>
      </div>

      <svg width={W} height={H} style={{display:'block',maxWidth:'100%',overflow:'visible'}}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#ff4560" stopOpacity="0.22"/>
            <stop offset="100%" stopColor="#ff4560" stopOpacity="0.02"/>
          </linearGradient>
        </defs>

        {/* Chart background */}
        <rect x={PAD.left} y={PAD.top} width={cW} height={cH} fill={th("#0a0e14","#f8f3eb")} rx="2"/>

        {/* ── Left axis: stock price ticks ── */}
        {stockTicks.map(({v,label}) => {
          const y = scaleS(v);
          return (
            <g key={v}>
              <line x1={PAD.left-3} y1={y} x2={PAD.left} y2={y} stroke={th("#3a4050","#8a7e74")} strokeWidth="0.5"/>
              <text x={PAD.left-5} y={y+3} textAnchor="end" fontSize="7" fill={th("#3a4050","#8a7e74")} fontFamily="monospace">{label}</text>
            </g>
          );
        })}
        <text x={PAD.left-30} y={PAD.top+cH/2} textAnchor="middle" fontSize="7" fill={th("#3a4050","#8a7e74")} fontFamily="monospace"
          transform={`rotate(-90,${PAD.left-30},${PAD.top+cH/2})`}>Stock ($)</text>

        {/* ── Right axis: option value ticks ── */}
        {optTicks.map(({val,y}) => (
          <g key={val}>
            <line x1={PAD.left+cW} y1={y} x2={PAD.left+cW+3} y2={y} stroke="#ff456060" strokeWidth="0.5"/>
            <text x={PAD.left+cW+5} y={y+3} fontSize="7" fill="#ff456080" fontFamily="monospace">${val.toFixed(2)}</text>
          </g>
        ))}
        <text x={PAD.left+cW+38} y={PAD.top+cH/2} textAnchor="middle" fontSize="7" fill="#ff456060" fontFamily="monospace"
          transform={`rotate(90,${PAD.left+cW+38},${PAD.top+cH/2})`}>Option ($)</text>

        {/* Horizontal grid lines (align to stock axis) */}
        {stockTicks.map(({v}) => (
          <line key={v} x1={PAD.left} y1={scaleS(v)} x2={PAD.left+cW} y2={scaleS(v)}
            stroke={th("#1c2128","#b8a898")} strokeWidth="0.5"/>
        ))}

        {/* ITM shade: for calls shade above strike, for puts shade below */}
        {isCall
          ? <rect x={PAD.left} y={PAD.top} width={cW} height={Math.max(0,strikeY-PAD.top)} fill="#ff456006"/>
          : <rect x={PAD.left} y={strikeY} width={cW} height={Math.max(0,PAD.top+cH-strikeY)} fill="#ff456006"/>
        }

        {/* ── Strike price dotted horizontal line ── */}
        <line x1={PAD.left} y1={strikeY} x2={PAD.left+cW} y2={strikeY}
          stroke={th("#8b949e","#5a5248")} strokeWidth="1.5" strokeDasharray="6,3" opacity="0.8"/>
        <text x={PAD.left+cW-2} y={strikeY-3} textAnchor="end" fontSize="7" fill={th("#8b949e","#5a5248")} fontFamily="monospace">
          Strike ${K.toFixed(2)}
        </text>

        {/* ── Option value filled area + decay curve (drawn before stock so stock is on top) ── */}
        <path d={optAreaPath}  fill={`url(#${gradId})`}/>
        <path d={optCurvePath} fill="none" stroke="#ff4560" strokeWidth="1.8" strokeLinecap="round"/>

        {/* DANI 80% target vertical */}
        {target80X != null && (
          <g>
            <line x1={target80X} y1={PAD.top} x2={target80X} y2={PAD.top+cH}
              stroke="#00ff88" strokeWidth="1" strokeDasharray="3,3" opacity="0.45"/>
            <text x={target80X+2} y={PAD.top+8} fontSize="7" fill="#00ff88" fontFamily="monospace" opacity="0.7">80%</text>
          </g>
        )}

        {/* ── Stock price line (entry → today) ── */}
        <path d={stockLinePath} fill="none" stroke={th("#c9d1d9","#1a1a18")} strokeWidth="1.6" strokeLinecap="round"/>

        {/* Entry stock dot */}
        <circle cx={sX(0)} cy={entryStockY} r="3" fill="#58a6ff" stroke={th("#0a0e14","#f8f3eb")} strokeWidth="1.5"/>
        <text x={sX(0)+5} y={entryStockY-3} fontSize="7" fill="#58a6ff80" fontFamily="monospace">${S0.toFixed(0)}</text>

        {/* Today vertical */}
        {daysElapsed > 0 && daysElapsed < totalDays && (
          <line x1={todayX} y1={PAD.top} x2={todayX} y2={PAD.top+cH}
            stroke="#58a6ff" strokeWidth="0.8" strokeDasharray="2,2" opacity="0.35"/>
        )}

        {/* Live stock price dot */}
        <circle cx={todayX} cy={liveStockY} r="4" fill={itmColor} stroke={th("#0a0e14","#f8f3eb")} strokeWidth="1.5"/>
        {liveStock != null && (
          <text x={todayX+(liveStockY < strikeY+12 ? 6 : -6)} y={liveStockY-4}
            textAnchor={liveStockY < strikeY+12 ? 'start' : 'end'}
            fontSize="7" fill={itmColor} fontFamily="monospace">${liveStock.toFixed(2)}</text>
        )}

        {/* Today dot on option curve */}
        <circle cx={todayX} cy={todayOptY} r="4" fill="#58a6ff" stroke={th("#0a0e14","#f8f3eb")} strokeWidth="1.5"/>

        {/* ── X-axis ── */}
        <line x1={PAD.left} y1={PAD.top+cH} x2={PAD.left+cW} y2={PAD.top+cH} stroke={th("#21262d","#c8b8a8")} strokeWidth="1"/>
        {xLabels.map(({d,label}) => (
          <text key={d} x={sX(d)} y={PAD.top+cH+11}
            textAnchor={d===0?'start':d===totalDays?'end':'middle'}
            fontSize="7" fill={th("#3a4050","#8a7e74")} fontFamily="monospace">{label}</text>
        ))}
        {daysElapsed > 2 && daysElapsed < totalDays - 2 && (
          <text x={todayX} y={PAD.top+cH+11} textAnchor="middle" fontSize="7" fill="#58a6ff" fontFamily="monospace">Now</text>
        )}

        {/* Legend */}
        <g transform={`translate(${PAD.left},${H-3})`}>
          <line x1="0" y1="-1" x2="10" y2="-1" stroke={th("#c9d1d9","#1a1a18")} strokeWidth="1.5"/>
          <text x="13" y="2" fontSize="7" fill="#555" fontFamily="monospace">stock</text>
          <line x1="42" y1="-1" x2="52" y2="-1" stroke={th("#8b949e","#5a5248")} strokeWidth="1.5" strokeDasharray="5,2"/>
          <text x="55" y="2" fontSize="7" fill="#555" fontFamily="monospace">strike</text>
          <line x1="92" y1="-1" x2="102" y2="-1" stroke="#ff4560" strokeWidth="1.5"/>
          <text x="105" y="2" fontSize="7" fill="#555" fontFamily="monospace">option value</text>
          {target80X != null && <>
            <line x1="172" y1="-1" x2="182" y2="-1" stroke="#00ff88" strokeWidth="1" strokeDasharray="3,2"/>
            <text x="185" y="2" fontSize="7" fill="#555" fontFamily="monospace">80% target</text>
          </>}
        </g>
      </svg>

      {/* Time progress bar */}
      <div style={{marginTop:8}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
          <span style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>TIME ELAPSED</span>
          <span style={{fontSize:7,color:'#3a4050',fontFamily:'monospace'}}>{daysElapsed}d elapsed · {daysLeft}d left · {totalDays}d total</span>
        </div>
        <div style={{height:4,background:'#1c2128',borderRadius:2,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${(daysElapsed/totalDays*100).toFixed(1)}%`,
            background:daysLeft<=3?'#ff4560':daysLeft<=7?'#ffd166':'#58a6ff',borderRadius:2}}/>
        </div>
      </div>
    </div>
  );
}

function CelebrationOverlay({profit, onDone}) {
  useEffect(() => { const t = setTimeout(onDone, 2800); return () => clearTimeout(t); }, []);

  // Listen handled by onTrade callback from OptionsChainComponent
  const isWin = profit > 0;
  return (
    <div style={{position:"fixed",inset:0,zIndex:2000,pointerEvents:"none",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{`
        @keyframes coinPop{0%{opacity:0;transform:scale(0.3) translateY(0)}40%{opacity:1;transform:scale(1.3) translateY(-40px)}70%{transform:scale(1) translateY(-60px)}100%{opacity:0;transform:scale(0.8) translateY(-120px)}}
        @keyframes lossSlide{0%{opacity:0;transform:translateY(-20px)}20%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(20px)}}
        @keyframes sparkle{0%{opacity:1;transform:scale(1) translate(0,0)}100%{opacity:0;transform:scale(0) translate(var(--dx),var(--dy))}}
      `}</style>
      {isWin ? (
        <div style={{textAlign:"center",animation:"coinPop 2.8s ease forwards"}}>
          <div style={{fontSize:72}}>🪙</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:28,color:"#00ff88",textShadow:"0 0 20px #00ff8880",marginTop:8}}>
            {fSign(profit)}
          </div>
          <div style={{fontFamily:"monospace",fontSize:12,color:"#00ff8880",marginTop:4}}>CONTRACT CLOSED</div>
          {/* Sparkles */}
          {[...Array(12)].map((_,i) => (
            <div key={i} style={{position:"absolute",left:"50%",top:"50%",fontSize:16,
              "--dx":`${(Math.random()-0.5)*200}px`,"--dy":`${(Math.random()-0.5)*200}px`,
              animation:`sparkle 1.2s ease ${i*0.08}s forwards`}}>
              {["✨","💰","🌟","💵","⭐"][i%5]}
            </div>
          ))}
        </div>
      ) : (
        <div style={{textAlign:"center",animation:"lossSlide 2.8s ease forwards"}}>
          <div style={{fontSize:64}}>📉</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:24,color:"#ff4560",textShadow:"0 0 20px #ff456080",marginTop:8}}>
            {fSign(profit)}
          </div>
          <div style={{fontFamily:"monospace",fontSize:11,color:"#ff456080",marginTop:4}}>CONTRACT CLOSED</div>
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
// ── Balance History Component ─────────────────────────────────────────────────
function BalanceHistory({ supabase, cashData, onSave }) {
  const [balHistory, setBalHistory] = useState(null);
  const [balEditMode, setBalEditMode] = useState(false);
  const [balEdits, setBalEdits] = useState({});

  useEffect(()=>{
    supabase.from("col_prefs").select("cols").eq("id","balance_history").maybeSingle()
      .then(({data})=>{ if(data?.cols) setBalHistory(data.cols); else setBalHistory({}); });
  },[]);

  const saveBalHistory = async (updated) => {
    await supabase.from("col_prefs").upsert({id:"balance_history",cols:updated,updated_at:new Date().toISOString()},{onConflict:"id"});
    setBalHistory(updated);
    if(onSave) onSave(updated);
  };

  const monthKeys = [];
  const now5 = new Date();
  for (let i=12; i>=0; i--) {
    const d = new Date(now5.getFullYear(), now5.getMonth()-i, 1);
    monthKeys.push(d.toISOString().slice(0,7));
  }
  const thisMonthKey = now5.toISOString().slice(0,7);
  const liveSchwab = cashData.schwab ? +cashData.schwab : null;

  const rows = monthKeys.map(mk => {
    const b = balHistory?.[mk] || {};
    const schwab = b.schwab ?? (mk===thisMonthKey&&liveSchwab ? liveSchwab : null);
    const etrade = b.etrade ?? null;
    const total  = (schwab||0)+(etrade||0);
    return { mk, schwab, etrade, total, isLive: mk===thisMonthKey&&liveSchwab&&!b.schwab };
  });

  const withChanges = rows.map((r,i) => {
    const prev = rows[i-1];
    const mom  = prev?.total>0 && r.total>0 ? ((r.total-prev.total)/prev.total*100) : null;
    // YTD: use first month of the year that has a non-zero balance as the base
    const yearPrefix = r.mk.slice(0,4);
    const yearRows   = rows.filter(x=>x.mk.startsWith(yearPrefix) && x.total>0);
    const baseRow    = yearRows[0] || null;
    const ytd  = baseRow && r.total>0 && baseRow.mk !== r.mk ? ((r.total-baseRow.total)/baseRow.total*100) : null;
    return {...r, mom, ytd};
  });

  if (!balHistory) return <div style={{padding:20,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10}}>Loading balance history…</div>;

  return (
    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"12px",marginTop:9}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em"}}>ACCOUNT BALANCE HISTORY</div>
        <button onClick={()=>{
          if(balEditMode){
            const updated = {...balHistory};
            Object.entries(balEdits).forEach(([mk,vals])=>{ updated[mk]={...(updated[mk]||{}),...vals}; });
            if(liveSchwab) { updated[thisMonthKey]={...(updated[thisMonthKey]||{}),schwab:liveSchwab,schwabAuto:true}; }
            saveBalHistory(updated);
            setBalEdits({});
          }
          setBalEditMode(v=>!v);
        }} style={{background:balEditMode?"#00ff8814":"transparent",border:"1px solid "+(balEditMode?"#00ff8844":th("#21262d","#c8b8a8")),borderRadius:4,color:balEditMode?"#00ff88":th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"3px 10px",cursor:"pointer"}}>
          {balEditMode?"💾 Save":"✎ Edit"}
        </button>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"monospace"}}>
          <thead>
            <tr style={{borderBottom:"1px solid #1c2128"}}>
              <th style={{padding:"4px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontWeight:400}}>Month</th>
              <th style={{padding:"4px 8px",textAlign:"right",color:"#58a6ff",fontWeight:400}}>Schwab</th>
              <th style={{padding:"4px 8px",textAlign:"right",color:"#ffd166",fontWeight:400}}>ETrade</th>
              <th style={{padding:"4px 8px",textAlign:"right",color:"#00ff88",fontWeight:400}}>Total</th>
              <th style={{padding:"4px 8px",textAlign:"right",color:"#c084fc",fontWeight:400}}>MoM%</th>
              <th style={{padding:"4px 8px",textAlign:"right",color:"#ff9f1c",fontWeight:400}}>YTD%</th>
            </tr>
          </thead>
          <tbody>
            {withChanges.map(r=>(
              <tr key={r.mk} style={{borderBottom:"1px solid #0d1117",background:r.mk===thisMonthKey?"#00ff8806":"transparent"}}>
                <td style={{padding:"4px 8px",color:r.mk===thisMonthKey?"#00ff88":th("#8b949e","#5a5248")}}>{r.mk}{r.isLive&&<span style={{fontSize:7,color:"#00ff8870",marginLeft:4}}>live</span>}</td>
                <td style={{padding:"4px 8px",textAlign:"right"}}>
                  {balEditMode && r.mk!==thisMonthKey ? (
                    <input type="number" defaultValue={r.schwab||""} placeholder="—" onBlur={e=>setBalEdits(p=>({...p,[r.mk]:{...(p[r.mk]||{}),schwab:e.target.value?+e.target.value:null}}))}
                      style={{width:80,background:"transparent",border:"1px solid #21262d",borderRadius:3,color:"#58a6ff",fontFamily:"monospace",fontSize:10,padding:"2px 4px",textAlign:"right"}}/>
                  ) : <span style={{color:"#58a6ff"}}>{r.schwab!=null?"$"+(+r.schwab).toLocaleString("en-US",{maximumFractionDigits:0}):"—"}</span>}
                </td>
                <td style={{padding:"4px 8px",textAlign:"right"}}>
                  {balEditMode ? (
                    <input type="number" defaultValue={r.etrade||""} placeholder="—" onBlur={e=>setBalEdits(p=>({...p,[r.mk]:{...(p[r.mk]||{}),etrade:e.target.value?+e.target.value:null}}))}
                      style={{width:80,background:"transparent",border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace",fontSize:10,padding:"2px 4px",textAlign:"right"}}/>
                  ) : <span style={{color:"#ffd166"}}>{r.etrade!=null?"$"+(+r.etrade).toLocaleString("en-US",{maximumFractionDigits:0}):"—"}</span>}
                </td>
                <td style={{padding:"4px 8px",textAlign:"right",color:"#00ff88",fontWeight:700}}>{r.total>0?"$"+(r.total).toLocaleString("en-US",{maximumFractionDigits:0}):"—"}</td>
                <td style={{padding:"4px 8px",textAlign:"right",color:r.mom>0?"#00ff88":r.mom<0?"#ff4560":th("#3a4050","#8a7e74")}}>{r.mom!=null?(r.mom>0?"+":"")+r.mom.toFixed(1)+"%":"—"}</td>
                <td style={{padding:"4px 8px",textAlign:"right",color:r.ytd>0?"#ff9f1c":r.ytd<0?"#ff4560":th("#3a4050","#8a7e74")}}>{r.ytd!=null?(r.ytd>0?"+":"")+r.ytd.toFixed(1)+"%":"—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Import Tab wrapper ────────────────────────────────────────────────────────
// ImportPage.jsx no longer used — import tab is inline below
// ── Signal Rules Modal ────────────────────────────────────────────────────────
// Thin wrapper for tab mode — renders rules content inline without overlay
function SignalRulesTab({ supabase }) {
  return <SignalRulesModal supabase={supabase} onClose={null} inline={true} />;
}

function SignalRulesModal({ supabase, onClose, inline = false }) {
  const [rules,         setRules]         = useState([]);
  const [stats,         setStats]         = useState({});
  const [loading,       setLoading]       = useState(true);
  const [saving,        setSaving]        = useState(null);
  const [edits,         setEdits]         = useState({});
  const [momentumCfg,   setMomentumCfg]   = useState(null);
  const [momentumEdits, setMomentumEdits] = useState({});
  const [savingMom,     setSavingMom]     = useState(false);
  const [analysis,      setAnalysis]      = useState(null);
  const [analyzing,     setAnalyzing]     = useState(false);
  const [skynetCtrl,    setSkynetCtrl]    = useState(null);
  const [tickerRiskCfg, setTickerRiskCfg] = useState([]);
  const [autoStats,     setAutoStats]     = useState(null); // Skynet auto performance

  useEffect(() => {
    supabase.from("skynet_controls").select("*").eq("enabled",true).limit(1).maybeSingle()
      .then(({data}) => { if (data) setSkynetCtrl(data); });
    supabase.from("ticker_risk_config").select("*").order("symbol")
      .then(({data}) => { if (data) setTickerRiskCfg(data); });
    // Load auto-trade performance stats
    supabase.from("contracts").select("id,profit,profit_pct,open_method,close_method,status,stock,opt_type")
      .or("open_method.eq.auto,close_method.eq.auto")
      .then(({data: cx}) => {
        if (!cx) { setAutoStats({ error: true }); return; }
        const autoOpen   = cx.filter(c => c.open_method === "auto");
        const autoClosed = autoOpen.filter(c => c.status === "Closed" && c.profit != null);
        const fullAuto   = cx.filter(c => c.open_method === "auto" && c.close_method === "auto" && c.profit != null);
        const wins = autoClosed.filter(c => (+c.profit) > 0);
        const fullWins = fullAuto.filter(c => (+c.profit) > 0);
        const sum = arr => arr.reduce((s, c) => s + (+c.profit || 0), 0);
        const avg = arr => arr.length ? sum(arr) / arr.length : 0;
        setAutoStats({
          autoOpen:   autoOpen.length,
          autoClosed: autoClosed.length,
          winRate:    autoClosed.length ? Math.round(wins.length / autoClosed.length * 100) : 0,
          totalProfit: Math.round(sum(autoClosed) * 100) / 100,
          avgProfit:   Math.round(avg(autoClosed) * 100) / 100,
          fullAutoCount:  fullAuto.length,
          fullAutoWinRate: fullAuto.length ? Math.round(fullWins.length / fullAuto.length * 100) : 0,
          fullAutoProfit:  Math.round(sum(fullAuto) * 100) / 100,
        });
      }).catch(() => setAutoStats({ error: true }));
    Promise.all([
      supabase.from("signal_rules").select("*").order("priority", { ascending: false }),
      supabase.from("signal_log").select("id,signal_type,profit_pct_at_signal,pushed,created_at,rule_id,contract_id"),
      supabase.from("decision_log").select("signal_id,decision"),
      supabase.from("contracts").select("id,profit,close_method,open_method,stock,strike,expires").or("close_method.eq.auto,open_method.eq.auto"),
      supabase.from("sto_momentum_config").select("*").limit(1),
    ]).then(([{ data: r }, { data: sl }, { data: dl }, { data: cx }, { data: mc }]) => {
      setRules(r || []);
      if (mc?.[0]) setMomentumCfg(mc[0]);

      // Build stats per rule_id (fall back to signal_type for legacy rows)
      const st = {};
      (sl || []).forEach(s => {
        const k = s.rule_id ? `rule_${s.rule_id}` : (s.signal_type || "unknown");
        if (!st[k]) st[k] = { fired: 0, pushed: 0, autoCount: 0, autoProfit: 0 };
        st[k].fired++;
        if (s.pushed) st[k].pushed++;
      });

      // Map auto-closed contracts to rules via signal_log contract_id
      const autoClosedIds = new Set((cx || []).filter(c => c.close_method === "auto").map(c => String(c.id)));
      const autoOpenedIds = new Set((cx || []).filter(c => c.open_method  === "auto").map(c => String(c.id)));
      const allAutoIds    = new Set([...autoClosedIds, ...autoOpenedIds]);
      const contractProfitMap = {};
      (cx || []).forEach(c => { contractProfitMap[String(c.id)] = +c.profit || 0; });

      (sl || []).forEach(s => {
        if (!s.contract_id || !allAutoIds.has(String(s.contract_id))) return;
        const k = s.rule_id ? `rule_${s.rule_id}` : (s.signal_type || "unknown");
        if (!st[k]) st[k] = { fired: 0, pushed: 0, autoCount: 0, autoProfit: 0 };
        st[k].autoCount++;
        st[k].autoProfit += contractProfitMap[String(s.contract_id)] || 0;
      });

      // For STO rules — also count auto-opened contracts directly (since contract_id
      // linkage may be missing for early signals before the fix)
      const stoRule = (r || []).find(rule => rule.rule_type === "sto");
      if (stoRule) {
        const k = `rule_${stoRule.id}`;
        if (!st[k]) st[k] = { fired: 0, pushed: 0, autoCount: 0, autoProfit: 0 };
        const autoOpenedContracts = (cx || []).filter(c => c.open_method === "auto");
        // Only add if not already counted via signal_log linkage
        const alreadyCounted = new Set();
        (sl || []).forEach(s => { if (s.rule_id === stoRule.id && s.contract_id) alreadyCounted.add(String(s.contract_id)); });
        autoOpenedContracts.forEach(c => {
          if (!alreadyCounted.has(String(c.id))) {
            st[k].autoCount++;
            st[k].autoProfit += +c.profit || 0;
          }
        });
      }

      // Totals for summary bar
      const autoProfit = (cx || []).filter(c => c.close_method === "auto").reduce((s, c) => s + (+c.profit || 0), 0);
      st._autoProfit = autoProfit;
      st._autoCount  = autoClosedIds.size;

      setStats(st);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const setEdit = (id, field, val) => setEdits(p => ({ ...p, [id]: { ...(p[id] || {}), [field]: val } }));
  const getEdit = (rule, field) => edits[rule.id]?.[field] !== undefined ? edits[rule.id][field] : rule[field];

  const saveRule = async (rule) => {
    const changes = edits[rule.id] || {};
    if (!Object.keys(changes).length) return;
    setSaving(rule.id);
    const { error } = await supabase.from("signal_rules").update({ ...changes, updated_at: new Date().toISOString() }).eq("id", rule.id);
    if (error) { alert("Save failed: " + error.message); }
    else {
      setRules(p => p.map(r => r.id === rule.id ? { ...r, ...changes } : r));
      setEdits(p => { const n = { ...p }; delete n[rule.id]; return n; });
      // btc_auto: when switching to LIVE, cancel any stale dry_run_approved orders
      // so they don't block the scanner from creating fresh live orders
      if (rule.rule_type === "btc_auto" && changes.dry_run === false) {
        await supabase.from("trade_orders")
          .update({ status: "cancelled" })
          .eq("dry_run", true)
          .in("status", ["dry_run_approved", "pending_approval"]);
      }
    }
    setSaving(null);
  };

  const ruleTypeLabel = t => ({ sto: "STO Scanner", btc_auto: "Auto BTC", close_signal: "Close Signal" })[t] || t;
  const ruleTypeColor = t => ({ sto: "#ffd166", btc_auto: "#00ff88", close_signal: "#58a6ff" })[t] || "#888";
  const f$ = v => v != null ? "$" + (+v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "—";

  const inner = (
    <div style={{background:"transparent", width:"100%", padding: inline?"0 4px":20, ...(inline?{}:{border:"1px solid #21262d", borderRadius:12, maxWidth:780, maxHeight:"90vh", overflowY:"auto"}), animation:"fadeIn .15s"}} onClick={e=>!inline&&e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>🤖 SKYNET — SIGNAL RULES</div>
          {!inline && <button onClick={onClose} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>}
        </div>

        {/* ── Auto-trade performance stats ── */}
        {autoStats && !autoStats.error && (
          <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8820",borderRadius:8,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.08em",marginBottom:10}}>📈 AUTO-TRADE PERFORMANCE</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[
                { label:"AUTO-OPENED",   val: autoStats.autoOpen,    sub: "total contracts",   color:"#ffd166" },
                { label:"AUTO CLOSED",   val: autoStats.autoClosed,  sub: `${autoStats.winRate}% win rate`, color:"#00ff88" },
                { label:"AUTO PROFIT",   val: (autoStats.totalProfit >= 0 ? "+" : "") + "$" + Math.abs(autoStats.totalProfit).toLocaleString(), sub: `avg $${autoStats.avgProfit}/trade`, color: autoStats.totalProfit >= 0 ? "#00ff88" : "#ff4560" },
                { label:"FULL AUTO",     val: autoStats.fullAutoCount, sub: `open+close auto`, color:"#58a6ff" },
                { label:"FULL AUTO WIN", val: autoStats.fullAutoWinRate + "%", sub: `${autoStats.fullAutoCount} trades`, color:"#58a6ff" },
                { label:"FULL AUTO P/L", val: (autoStats.fullAutoProfit >= 0 ? "+" : "") + "$" + Math.abs(autoStats.fullAutoProfit).toLocaleString(), sub: "fully automated P/L", color: autoStats.fullAutoProfit >= 0 ? "#00ff88" : "#ff4560" },
              ].map(s => (
                <div key={s.label} style={{background:th("#080c12","#ede8df"),border:"1px solid #1c2128",borderRadius:5,padding:"8px 10px",minWidth:90,flex:"0 0 auto"}}>
                  <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em",marginBottom:3}}>{s.label}</div>
                  <div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:s.color,lineHeight:1}}>{s.val}</div>
                  <div style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),marginTop:2}}>{s.sub}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Summary stats bar ── */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {[
            { label:"TOTAL FIRED",    val: Object.values(stats).filter(v=>typeof v==="object").reduce((s,v)=>s+(v.fired||0),0) },
            { label:"TOTAL PUSHED",   val: Object.values(stats).filter(v=>typeof v==="object").reduce((s,v)=>s+(v.pushed||0),0) },
            { label:"AUTO OPENED",    val: autoStats?.autoOpen ?? 0, color:"#58a6ff" },
            { label:"AUTO CLOSED",    val: stats._autoCount ?? 0 },
            { label:"AUTO PROFIT",    val: f$(stats._autoProfit), color:"#00ff88" },
          ].map(s => (
            <div key={s.label} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em",marginBottom:4}}>{s.label}</div>
              <div style={{fontFamily:"monospace",fontSize:16,color:s.color||th("#e6edf3","#0d0d0b")}}>{s.val}</div>
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{fontFamily:"monospace",fontSize:11,color:th("#3a4050","#8a7e74"),padding:20,textAlign:"center"}}>Loading...</div>
        ) : rules.length === 0 ? (
          <div style={{fontFamily:"monospace",fontSize:11,color:th("#3a4050","#8a7e74"),padding:20,textAlign:"center"}}>No rules found. Insert via SQL to get started.</div>
        ) : (
          rules.map(rule => {
            const st = stats[`rule_${rule.id}`] || stats[rule.rule_type] || {};
            const hasEdits = Object.keys(edits[rule.id] || {}).length > 0;
            return (
              <div key={rule.id} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid " + (hasEdits ? "#ffd16640" : th("#1c2128","#b8a898")),borderRadius:8,padding:14,marginBottom:10}}>

                {/* Rule header */}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"monospace",fontSize:10,fontWeight:700,color:ruleTypeColor(rule.rule_type)}}>{ruleTypeLabel(rule.rule_type)}</span>
                  <span style={{fontFamily:"monospace",fontSize:10,color:th("#8b949e","#5a5248")}}>{rule.name}</span>
                  <span style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
                    {/* Enabled toggle */}
                    <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",fontFamily:"monospace",fontSize:9,color:th("#8b949e","#5a5248")}}>
                      <div onClick={()=>setEdit(rule.id,"enabled",!getEdit(rule,"enabled"))}
                        style={{width:28,height:15,borderRadius:8,background:getEdit(rule,"enabled")?"#00ff88":th("#21262d","#c8b8a8"),position:"relative",cursor:"pointer",transition:"background .2s"}}>
                        <div style={{position:"absolute",top:2,left:getEdit(rule,"enabled")?13:2,width:11,height:11,borderRadius:"50%",background:th("#010409","#f5f0e8"),transition:"left .2s"}}/>
                      </div>
                      {getEdit(rule,"enabled") ? "ON" : "OFF"}
                    </label>
                    {/* Live/DryRun toggle — green=LIVE, yellow=DRY RUN */}
                    {(rule.rule_type === "btc_auto" || rule.rule_type === "sto") && (
                      <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",fontFamily:"monospace",fontSize:9,color:getEdit(rule,"dry_run") ? "#ffd166" : "#00ff88"}}>
                        <div onClick={()=>{
                            const newDryRun = !getEdit(rule,"dry_run");
                            setEdit(rule.id,"dry_run",newDryRun);
                            // btc_auto: auto_execute mirrors LIVE toggle
                            if (rule.rule_type === "btc_auto") {
                              setEdit(rule.id,"auto_execute",!newDryRun);
                            }
                          }}
                          style={{width:28,height:15,borderRadius:8,background:getEdit(rule,"dry_run") ? "#ffd166" : "#00ff88",position:"relative",cursor:"pointer",transition:"background .2s"}}>
                          <div style={{position:"absolute",top:2,left:getEdit(rule,"dry_run") ? 2 : 13,width:11,height:11,borderRadius:"50%",background:th("#010409","#f5f0e8"),transition:"left .2s"}}/>
                        </div>
                        {getEdit(rule,"dry_run") ? "DRY RUN" : "LIVE"}
                      </label>
                    )}
                  </span>
                </div>

                {/* Stats row */}
                <div style={{display:"flex",gap:16,marginBottom:12,flexWrap:"wrap"}}>
                  {[
                    { label:"FIRED",   val: st.fired  ?? 0 },
                    { label:"PUSHED",  val: st.pushed ?? 0 },
                    { label:"SUPPRESSED", val: (st.fired??0)-(st.pushed??0) },
                    ...(rule.rule_type==="btc_auto" ? [
                      { label:"AUTO CLOSED", val: st.autoCount ?? 0 },
                      { label:"AUTO PROFIT",  val: f$(st.autoProfit), color:"#00ff88" },
                    ] : []),
                    ...(rule.rule_type==="sto" ? [
                      { label:"AUTO PLACED", val: st.autoCount ?? 0 },
                      { label:"EST PREMIUM",  val: f$(st.autoProfit), color:"#ffd166" },
                    ] : []),
                  ].map(s => (
                    <div key={s.label}>
                      <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em"}}>{s.label}</div>
                      <div style={{fontFamily:"monospace",fontSize:13,color:s.color||th("#e6edf3","#0d0d0b")}}>{s.val}</div>
                    </div>
                  ))}
                </div>

                {/* Editable fields */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
                  {rule.rule_type === "btc_auto" && <>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN PROFIT %</div>
                      <input type="number" value={getEdit(rule,"min_profit_pct")??""} onChange={e=>setEdit(rule.id,"min_profit_pct",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>FIRES AFTER (ET)</div>
                      <input type="time" value={getEdit(rule,"min_time_et")||""} onChange={e=>setEdit(rule.id,"min_time_et",e.target.value||null)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color: getEdit(rule,"min_time_et") ? "#ffd166" : "#555",width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>FIRES BEFORE (ET)</div>
                      <input type="time" value={getEdit(rule,"max_time_et")||""} onChange={e=>setEdit(rule.id,"max_time_et",e.target.value||null)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color: getEdit(rule,"max_time_et") ? "#ffd166" : "#555",width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>OPT TYPE</div>
                      <select value={getEdit(rule,"opt_type")||"Call"} onChange={e=>setEdit(rule.id,"opt_type",e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}}>
                        <option>Call</option><option>Put</option><option>Both</option>
                      </select>
                    </div>
                  </>}
                  {rule.rule_type === "sto" && <>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN CHANGE %</div>
                      <input type="number" value={getEdit(rule,"min_change_pct")??""} onChange={e=>setEdit(rule.id,"min_change_pct",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN TIME ET</div>
                      <input type="text" value={getEdit(rule,"min_time_et")||""} onChange={e=>setEdit(rule.id,"min_time_et",e.target.value)} placeholder="09:45" style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN DTE</div>
                      <input type="number" value={getEdit(rule,"min_dte")??""} onChange={e=>setEdit(rule.id,"min_dte",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MAX DTE</div>
                      <input type="number" value={getEdit(rule,"max_dte")??""} onChange={e=>setEdit(rule.id,"max_dte",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN PREMIUM $</div>
                      <input type="number" value={getEdit(rule,"min_premium")??""} onChange={e=>setEdit(rule.id,"min_premium",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN OTM %</div>
                      <input type="number" value={getEdit(rule,"min_otm_pct")??""} onChange={e=>setEdit(rule.id,"min_otm_pct",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MAX OTM %</div>
                      <input type="number" value={getEdit(rule,"max_otm_pct")??""} onChange={e=>setEdit(rule.id,"max_otm_pct",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                    <div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>MIN VIX</div>
                      <input type="number" value={getEdit(rule,"min_vix")??""} onChange={e=>setEdit(rule.id,"min_vix",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                    </div>
                  </>}
                  <div>
                    <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>PRIORITY</div>
                    <input type="number" value={getEdit(rule,"priority")??""} onChange={e=>setEdit(rule.id,"priority",+e.target.value)} style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"4px 7px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                  </div>
                </div>

                {/* ── OTM by DTE Table (STO rules only) ── */}
                {rule.rule_type === "sto" && (() => {
                  const table = getEdit(rule, "otm_dte_table") || [];
                  const rows = Array.isArray(table) ? [...table].sort((a,b) => a.max_dte - b.max_dte) : [];
                  return (
                    <div style={{marginTop:12,padding:10,background:th("#0d1117","#f5f0e8"),border:"1px solid #1c2128",borderRadius:6}}>
                      <div style={{fontFamily:"monospace",fontSize:9,color:"#58a6ff",marginBottom:8,letterSpacing:"0.05em"}}>📊 OTM % BY DTE TABLE</div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:6}}>Shorter DTE → tighter OTM. Each row sets the minimum OTM% for contracts up to that DTE.</div>
                      <div style={{display:"grid",gridTemplateColumns:"80px 100px 30px",gap:4,alignItems:"center"}}>
                        <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74")}}>MAX DTE</div>
                        <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74")}}>MIN OTM %</div>
                        <div/>
                        {rows.map((row, i) => (
                          <div key={i} style={{display:"contents"}}>
                            <input type="number" value={row.max_dte} onChange={e => {
                              const updated = [...rows]; updated[i] = { ...updated[i], max_dte: +e.target.value };
                              setEdit(rule.id, "otm_dte_table", updated);
                            }} style={{background:th("#161b22","#ede8df"),border:"1px solid #21262d",borderRadius:3,padding:"3px 6px",fontSize:10,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                            <input type="number" step="0.25" value={row.min_otm_pct} onChange={e => {
                              const updated = [...rows]; updated[i] = { ...updated[i], min_otm_pct: +e.target.value };
                              setEdit(rule.id, "otm_dte_table", updated);
                            }} style={{background:th("#161b22","#ede8df"),border:"1px solid #21262d",borderRadius:3,padding:"3px 6px",fontSize:10,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"}} />
                            <button onClick={() => { const updated = rows.filter((_,j) => j!==i); setEdit(rule.id, "otm_dte_table", updated); }}
                              style={{background:"transparent",border:"none",color:"#f85149",cursor:"pointer",fontSize:12,padding:0}}>×</button>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => {
                        const updated = [...rows, { max_dte: rows.length ? Math.max(...rows.map(r=>r.max_dte)) + 7 : 3, min_otm_pct: 2.0 }];
                        setEdit(rule.id, "otm_dte_table", updated);
                      }} style={{marginTop:6,background:"transparent",border:"1px dashed #21262d",borderRadius:3,padding:"3px 10px",fontSize:9,fontFamily:"monospace",color:"#58a6ff",cursor:"pointer"}}>+ Add Row</button>
                    </div>
                  );
                })()}

                {/* ── Unified Momentum Filters (STO rules only) ── */}
                {rule.rule_type === "sto" && (() => {
                  const mf = getEdit(rule, "momentum_filters") || {};
                  const setMF = (field, val) => setEdit(rule.id, "momentum_filters", { ...mf, [field]: val });
                  const trendOptions = ["bullish", "neutral", "bearish"];
                  const currentTrends = Array.isArray(mf.require_trend) ? mf.require_trend : [];
                  const toggleStyle = (on) => ({width:28,height:15,borderRadius:8,background:on?"#00ff88":th("#21262d","#c8b8a8"),position:"relative",cursor:"pointer",transition:"background .2s",display:"inline-block"});
                  const thumbStyle = (on) => ({position:"absolute",top:2,left:on?13:2,width:11,height:11,borderRadius:"50%",background:th("#010409","#f5f0e8"),transition:"left .2s"});
                  const sectionLabel = {fontFamily:"monospace",fontSize:9,letterSpacing:"0.05em",marginBottom:6,marginTop:10};
                  const fieldLabel = {fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3};
                  const inputStyle = {background:th("#161b22","#ede8df"),border:"1px solid #21262d",borderRadius:3,padding:"3px 6px",fontSize:10,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),width:"100%"};
                  return (
                    <div style={{marginTop:8,padding:10,background:th("#0d1117","#f5f0e8"),border:"1px solid #1c2128",borderRadius:6}}>
                      <div style={{fontFamily:"monospace",fontSize:9,color:"#ffd166",marginBottom:4,letterSpacing:"0.05em"}}>⚡ MOMENTUM FILTERS</div>
                      <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:8}}>All momentum checks for this STO rule. Toggle each gate individually.</div>

                      {/* ── Intraday momentum gates ── */}
                      <div style={{...sectionLabel,color:"#58a6ff"}}>INTRADAY GATES</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
                        <div style={{padding:8,background:th("#161b22","#ede8df"),borderRadius:4,border:"1px solid #1c2128"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                            <div onClick={()=>setMF("pullback_enabled",!mf.pullback_enabled)} style={toggleStyle(mf.pullback_enabled)}><div style={thumbStyle(mf.pullback_enabled)}/></div>
                            <span style={{fontFamily:"monospace",fontSize:8,color:th("#c9d1d9","#1a1a18")}}>Pullback from high</span>
                          </div>
                          <div style={fieldLabel}>MIN PULLBACK %</div>
                          <input type="number" step="0.1" value={mf.min_pullback_from_high_pct??""} onChange={e=>setMF("min_pullback_from_high_pct",e.target.value===""?null:+e.target.value)} style={inputStyle} placeholder="0.3" />
                        </div>
                        <div style={{padding:8,background:th("#161b22","#ede8df"),borderRadius:4,border:"1px solid #1c2128"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                            <div onClick={()=>setMF("require_decelerating",!mf.require_decelerating)} style={toggleStyle(mf.require_decelerating)}><div style={thumbStyle(mf.require_decelerating)}/></div>
                            <span style={{fontFamily:"monospace",fontSize:8,color:th("#c9d1d9","#1a1a18")}}>Deceleration gate</span>
                          </div>
                          <div style={fieldLabel}>LOOKBACK MINS</div>
                          <input type="number" value={mf.momentum_lookback_mins??""} onChange={e=>setMF("momentum_lookback_mins",e.target.value===""?null:+e.target.value)} style={inputStyle} placeholder="30" />
                        </div>
                        <div style={{padding:8,background:th("#161b22","#ede8df"),borderRadius:4,border:"1px solid #1c2128"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                            <div onClick={()=>setMF("gap_enabled",!mf.gap_enabled)} style={toggleStyle(mf.gap_enabled)}><div style={thumbStyle(mf.gap_enabled)}/></div>
                            <span style={{fontFamily:"monospace",fontSize:8,color:th("#c9d1d9","#1a1a18")}}>Gap-up filter</span>
                          </div>
                          <div style={fieldLabel}>MAX GAP UP %</div>
                          <input type="number" step="0.5" value={mf.max_gap_up_pct??""} onChange={e=>setMF("max_gap_up_pct",e.target.value===""?null:+e.target.value)} style={inputStyle} placeholder="2.0" />
                        </div>
                      </div>

                      {/* ── Technical filters ── */}
                      <div style={{...sectionLabel,color:"#58a6ff"}}>TECHNICAL FILTERS</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
                        <div>
                          <div style={fieldLabel}>MAX RSI</div>
                          <input type="number" value={mf.max_rsi??""} onChange={e=>setMF("max_rsi",e.target.value===""?null:+e.target.value)} placeholder="75" style={inputStyle} />
                        </div>
                        <div>
                          <div style={fieldLabel}>MIN RSI</div>
                          <input type="number" value={mf.min_rsi??""} onChange={e=>setMF("min_rsi",e.target.value===""?null:+e.target.value)} placeholder="30" style={inputStyle} />
                        </div>
                        <div>
                          <div style={fieldLabel}>MIN SMA ALIGN</div>
                          <select value={mf.min_sma_alignment??""} onChange={e=>setMF("min_sma_alignment",e.target.value===""?null:+e.target.value)} style={inputStyle}>
                            <option value="">Any</option>
                            <option value="1">1 (P &gt; SMA20)</option>
                            <option value="2">2 (P &gt; 20 &gt; 50)</option>
                            <option value="3">3 (P &gt; 20 &gt; 50 &gt; 200)</option>
                          </select>
                        </div>
                      </div>
                      <div style={{marginTop:8}}>
                        <div style={fieldLabel}>ALLOWED TREND REGIMES</div>
                        <div style={{display:"flex",gap:8}}>
                          {trendOptions.map(t => {
                            const active = currentTrends.includes(t);
                            return (
                              <label key={t} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",fontFamily:"monospace",fontSize:9,color:active?th("#c9d1d9","#1a1a18"):th("#3a4050","#8a7e74")}}>
                                <div onClick={() => {
                                  const next = active ? currentTrends.filter(x=>x!==t) : [...currentTrends, t];
                                  setMF("require_trend", next.length ? next : null);
                                }} style={{width:14,height:14,borderRadius:3,border:"1px solid "+(active?"#58a6ff":th("#21262d","#c8b8a8")),background:active?"#58a6ff20":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#58a6ff"}}>
                                  {active && "\u2713"}
                                </div>
                                {t}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {hasEdits && (
                  <div style={{display:"flex",gap:8,marginTop:10,alignItems:"center"}}>
                    <button onClick={()=>saveRule(rule)} disabled={saving===rule.id}
                      style={{background:"#00ff8820",border:"1px solid #00ff8840",borderRadius:4,padding:"4px 14px",fontSize:10,fontFamily:"monospace",color:"#00ff88",cursor:"pointer"}}>
                      {saving===rule.id ? "saving..." : "SAVE CHANGES"}
                    </button>
                    <button onClick={()=>setEdits(p=>{const n={...p};delete n[rule.id];return n;})}
                      style={{background:"transparent",border:"1px solid #21262d",borderRadius:4,padding:"4px 10px",fontSize:10,fontFamily:"monospace",color:"#555",cursor:"pointer"}}>
                      discard
                    </button>
                    {rule.rule_type==="btc_auto" && getEdit(rule,"dry_run")===false && (
                      <span style={{fontFamily:"monospace",fontSize:9,color:"#ff4560",marginLeft:4}}>⚠ LIVE MODE — orders will be placed automatically</span>
                    )}
                    {rule.rule_type==="sto" && getEdit(rule,"dry_run")===false && (
                      <span style={{fontFamily:"monospace",fontSize:9,color:"#ff4560",marginLeft:4}}>⚠ LIVE MODE — Skynet will auto-sell covered calls</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* ── STO Momentum Config ── */}
        {momentumCfg && (() => {
          const mc = momentumCfg;
          const me = momentumEdits;
          const getME = (field) => me[field] !== undefined ? me[field] : mc[field];
          const setME = (field, val) => setMomentumEdits(p => ({ ...p, [field]: val }));
          const hasEdits = Object.keys(me).length > 0;
          const Toggle = ({ field, label }) => (
            <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",fontFamily:"monospace",fontSize:9,color:th("#8b949e","#5a5248")}}>
              <div onClick={()=>setME(field,!getME(field))} style={{width:28,height:15,borderRadius:8,background:getME(field)?"#ffd166":th("#21262d","#c8b8a8"),position:"relative",cursor:"pointer",transition:"background .2s"}}>
                <div style={{position:"absolute",top:2,left:getME(field)?13:2,width:11,height:11,borderRadius:"50%",background:th("#010409","#f5f0e8"),transition:"left .2s"}}/>
              </div>
              {label}
            </label>
          );
          return (
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid "+(hasEdits?"#ffd16640":th("#1c2128","#b8a898")),borderRadius:8,padding:14,marginTop:10}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                <span style={{fontFamily:"monospace",fontSize:10,fontWeight:700,color:"#ffd166"}}>📈 STO MOMENTUM FILTERS</span>
                <span style={{fontFamily:"monospace",fontSize:10,color:th("#8b949e","#5a5248")}}>{mc.name}</span>
                <Toggle field="enabled" label="enabled" />
              </div>
              {mc.description && <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),marginBottom:10,fontStyle:"italic"}}>{mc.description}</div>}
              {[
                { field:"pullback_enabled", numField:"min_pullback_from_high_pct", numLabel:"Min pullback %", numSuffix:"% from high", label:"1. Pullback from high", desc:mc.pullback_description },
                { field:"momentum_enabled", numField:"momentum_lookback_mins", numLabel:"Lookback", numSuffix:"mins", label:"2. Deceleration gate", desc:mc.momentum_description, extra:<Toggle field="require_decelerating" label="require decelerating" /> },
                { field:"gap_enabled", numField:"max_gap_up_pct", numLabel:"Max gap up %", numSuffix:"", label:"3. Gap-up filter", desc:mc.gap_description },
                { field:"volume_enabled", numField:null, numLabel:null, label:"4. Volume filter (future)", desc:mc.volume_description },
              ].map(({ field, numField, numLabel, numSuffix, label, desc, extra }) => (
                <div key={field} style={{background:th("#0d1117","#f5f0e8"),borderRadius:6,padding:"10px 12px",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                    <Toggle field={field} label={label} />
                    {extra}
                  </div>
                  {desc && <div style={{fontFamily:"monospace",fontSize:9,color:"#555",marginBottom:6}}>{desc}</div>}
                  {numField && getME(field) && (
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>{numLabel}</span>
                      <input type="number" step="0.1" value={getME(numField)||""} onChange={e=>setME(numField,+e.target.value)}
                        style={{width:70,background:th("#0a0e14","#f8f3eb"),border:"1px solid #21262d",borderRadius:4,padding:"3px 7px",fontSize:11,fontFamily:"monospace",color:"#ffd166"}} />
                      {numSuffix && <span style={{fontFamily:"monospace",fontSize:9,color:"#555"}}>{numSuffix}</span>}
                    </div>
                  )}
                </div>
              ))}
              <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:hasEdits?10:0,flexWrap:"wrap"}}>
                <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>Fire window ET:</span>
                <input type="time" value={getME("min_time_et")||""} onChange={e=>setME("min_time_et",e.target.value)} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #21262d",borderRadius:4,padding:"3px 7px",fontSize:11,fontFamily:"monospace",color:"#ffd166"}} />
                <span style={{fontFamily:"monospace",fontSize:9,color:"#555"}}>→</span>
                <input type="time" value={getME("max_time_et")||""} onChange={e=>setME("max_time_et",e.target.value)} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #21262d",borderRadius:4,padding:"3px 7px",fontSize:11,fontFamily:"monospace",color:"#ffd166"}} />
              </div>
              {hasEdits && (
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <button onClick={async()=>{
                    setSavingMom(true);
                    const { error } = await supabase.from("sto_momentum_config").update({ ...me, updated_at: new Date().toISOString() }).eq("id", mc.id);
                    if (error) alert("Save failed: "+error.message);
                    else { setMomentumCfg(p=>({...p,...me})); setMomentumEdits({}); }
                    setSavingMom(false);
                  }} disabled={savingMom} style={{background:"#ffd16620",border:"1px solid #ffd16640",borderRadius:4,padding:"4px 14px",fontSize:10,fontFamily:"monospace",color:"#ffd166",cursor:"pointer"}}>
                    {savingMom?"saving...":"SAVE CHANGES"}
                  </button>
                  <button onClick={()=>setMomentumEdits({})} style={{background:"transparent",border:"1px solid #21262d",borderRadius:4,padding:"4px 10px",fontSize:10,fontFamily:"monospace",color:"#555",cursor:"pointer"}}>discard</button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Skynet Intelligence — Claude Analysis ── */}
        <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #58a6ff20",borderRadius:8,padding:14,marginTop:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
            <span style={{fontFamily:"monospace",fontSize:10,fontWeight:700,color:"#58a6ff"}}>🧠 SKYNET INTELLIGENCE</span>
            <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>Claude-powered signal analysis</span>
            <button onClick={async () => {
              setAnalyzing(true); setAnalysis(null);
              try {
                const [sfvRes, soRes, swRes, sfRes] = await Promise.all([
                  supabase.from("scoring_factor_values").select("signal_id,factor_name,value").limit(500),
                  supabase.from("signal_outcomes").select("signal_id,signal_quality,outcome_profit_pct,outcome_days_held").limit(200),
                  supabase.from("scoring_weights").select("factor_name,weight,max_points,direction,rationale").eq("enabled",true),
                  supabase.from("scoring_factors").select("name,display_name,description,rationale").eq("enabled",true),
                ]);
                const resp = await fetch("/api/claude", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mode: "skynet_analysis",
                    signals:         sfvRes.data || [],
                    outcomes:        soRes.data  || [],
                    current_weights: swRes.data  || [],
                    factors:         sfRes.data  || [],
                  }),
                });
                const data = await resp.json();
                if (!resp.ok) setAnalysis({ error: data.error || "Analysis failed" });
                else setAnalysis(data.analysis);
              } catch(e) { setAnalysis({ error: e.message }); }
              setAnalyzing(false);
            }} disabled={analyzing} style={{marginLeft:"auto",background:"#58a6ff20",border:"1px solid #58a6ff40",borderRadius:4,padding:"4px 14px",fontSize:10,fontFamily:"monospace",color:"#58a6ff",cursor:"pointer"}}>
              {analyzing ? "analyzing..." : "▶ run analysis"}
            </button>
          </div>
          {!analysis && !analyzing && (
            <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>
              Click "run analysis" to have Claude analyze your signal outcomes and suggest weight adjustments. Needs a few weeks of data to be meaningful.
            </div>
          )}
          {analyzing && <div style={{fontFamily:"monospace",fontSize:9,color:"#58a6ff"}}>Analyzing signal patterns... 10-20 seconds</div>}
          {analysis?.error && <div style={{fontFamily:"monospace",fontSize:9,color:"#ff4560"}}>{analysis.error}</div>}
          {analysis && !analysis.error && (
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{background:th("#0d1117","#f5f0e8"),borderRadius:6,padding:"10px 12px"}}>
                <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:4}}>SUMMARY</div>
                <div style={{fontFamily:"monospace",fontSize:11,color:th("#c9d1d9","#1a1a18"),lineHeight:1.5}}>{analysis.summary}</div>
              </div>
              {analysis.win_rate_analysis && (
                <div style={{background:th("#0d1117","#f5f0e8"),borderRadius:6,padding:"10px 12px"}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:4}}>WIN RATE ANALYSIS</div>
                  <div style={{fontFamily:"monospace",fontSize:11,color:th("#c9d1d9","#1a1a18")}}>{analysis.win_rate_analysis}</div>
                </div>
              )}
              {analysis.patterns?.length > 0 && (
                <div style={{background:th("#0d1117","#f5f0e8"),borderRadius:6,padding:"10px 12px"}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:8}}>PATTERNS FOUND</div>
                  {analysis.patterns.map((p, i) => (
                    <div key={i} style={{marginBottom:8,paddingBottom:8,borderBottom:i<analysis.patterns.length-1?"1px solid #1c2128":"none"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                        <span style={{fontFamily:"monospace",fontSize:9,color:p.confidence==="high"?"#00ff88":p.confidence==="medium"?"#ffd166":"#888",background:p.confidence==="high"?"#00ff8815":p.confidence==="medium"?"#ffd16615":th("#1c2128","#b8a898"),borderRadius:3,padding:"1px 6px"}}>{p.confidence}</span>
                        <span style={{fontFamily:"monospace",fontSize:10,color:th("#e6edf3","#0d0d0b")}}>{p.finding}</span>
                      </div>
                      <div style={{fontFamily:"monospace",fontSize:9,color:"#555",marginLeft:8}}>{p.evidence}</div>
                    </div>
                  ))}
                </div>
              )}
              {analysis.weight_suggestions?.length > 0 && (
                <div style={{background:th("#0d1117","#f5f0e8"),borderRadius:6,padding:"10px 12px"}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:8}}>SUGGESTED WEIGHT CHANGES</div>
                  {analysis.weight_suggestions.map((w, i) => (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                      <span style={{fontFamily:"monospace",fontSize:10,color:th("#c9d1d9","#1a1a18"),minWidth:140}}>{w.factor_name}</span>
                      <span style={{fontFamily:"monospace",fontSize:10,color:"#555"}}>{w.current_weight}</span>
                      <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>→</span>
                      <span style={{fontFamily:"monospace",fontSize:10,color:w.suggested_weight>w.current_weight?"#00ff88":"#ff4560",fontWeight:700}}>{w.suggested_weight}</span>
                      <span style={{fontFamily:"monospace",fontSize:9,color:"#555",flex:1}}>{w.rationale}</span>
                    </div>
                  ))}
                  <div style={{marginTop:8,fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>Apply changes manually in the weight fields above after reviewing.</div>
                </div>
              )}
              {analysis.overall_recommendation && (
                <div style={{background:"#58a6ff10",border:"1px solid #58a6ff20",borderRadius:6,padding:"8px 12px"}}>
                  <div style={{fontFamily:"monospace",fontSize:9,color:"#58a6ff"}}>{analysis.overall_recommendation}</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Skynet Controls ── */}
        {skynetCtrl && (() => {
          const inp = {fontSize:11,padding:"3px 6px",background:th("#0a0e14","#f8f3eb"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace",width:90};
          const sc = skynetCtrl;
          return (
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:"12px 14px",marginTop:16}}>
              <div style={{fontFamily:"monospace",fontSize:9,color:"#ffd166",letterSpacing:"0.08em",marginBottom:10}}>🛡 SKYNET CONTROLS</div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:3}}>MAX ORDER VALUE $</div>
                  <input defaultValue={sc.max_order_value} onBlur={async e=>{const v=parseFloat(e.target.value);if(!isNaN(v)){await supabase.from("skynet_controls").update({max_order_value:v,updated_at:new Date().toISOString()}).eq("id",sc.id);setSkynetCtrl(p=>({...p,max_order_value:v}));}}} style={inp}/>
                </div>
                <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:3}}>MAX BID/ASK DEV %</div>
                  <input defaultValue={sc.max_bid_ask_deviation_pct} onBlur={async e=>{const v=parseFloat(e.target.value);if(!isNaN(v)){await supabase.from("skynet_controls").update({max_bid_ask_deviation_pct:v,updated_at:new Date().toISOString()}).eq("id",sc.id);setSkynetCtrl(p=>({...p,max_bid_ask_deviation_pct:v}));}}} style={inp}/>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <input type="checkbox" checked={!!sc.block_if_loss} onChange={async e=>{const v=e.target.checked;await supabase.from("skynet_controls").update({block_if_loss:v,updated_at:new Date().toISOString()}).eq("id",sc.id);setSkynetCtrl(p=>({...p,block_if_loss:v}));}} id="sc-bil"/>
                  <label htmlFor="sc-bil" style={{fontSize:9,color:th("#c9d1d9","#1a1a18"),fontFamily:"monospace",cursor:"pointer"}}>Block if loss</label>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Ticker Risk Config (task #22) ── */}
        {tickerRiskCfg.length > 0 && (
          <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #58a6ff25",borderRadius:8,padding:"12px 14px",marginTop:16}}>
            <div style={{fontFamily:"monospace",fontSize:9,color:"#58a6ff",letterSpacing:"0.08em",marginBottom:10}}>📊 TICKER RISK CONFIG</div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"monospace"}}>
                <thead><tr style={{borderBottom:"1px solid #1c2128"}}>
                  {["Symbol","Min OTM%","Max DTE","Min IV%","Max IV%","Action","Notes"].map(h=>(
                    <th key={h} style={{padding:"3px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontWeight:600,fontSize:9}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {tickerRiskCfg.map(r => (
                    <tr key={r.symbol} style={{borderBottom:"1px solid #0d1117"}}>
                      <td style={{padding:"4px 8px",color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{r.symbol}</td>
                      <td style={{padding:"4px 8px"}}><input type="number" step="0.5" defaultValue={r.min_otm_pct} onBlur={async e=>{const v=parseFloat(e.target.value);if(!isNaN(v)){await supabase.from("ticker_risk_config").update({min_otm_pct:v,updated_at:new Date().toISOString()}).eq("symbol",r.symbol);setTickerRiskCfg(p=>p.map(x=>x.symbol===r.symbol?{...x,min_otm_pct:v}:x));}}} style={{width:55,fontSize:10,padding:"2px 4px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace"}}/></td>
                      <td style={{padding:"4px 8px"}}><input type="number" step="1"   defaultValue={r.max_dte??""} placeholder="—" onBlur={async e=>{const v=e.target.value===""?null:parseInt(e.target.value);await supabase.from("ticker_risk_config").update({max_dte:v,updated_at:new Date().toISOString()}).eq("symbol",r.symbol);}} style={{width:45,fontSize:10,padding:"2px 4px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace"}}/></td>
                      <td style={{padding:"4px 8px",color:"#888"}}>{r.min_iv_pct??'—'}</td>
                      <td style={{padding:"4px 8px",color:"#888"}}>{r.max_iv_pct??'—'}</td>
                      <td style={{padding:"4px 8px"}}>
                        <select defaultValue={r.action} onChange={async e=>{const v=e.target.value;await supabase.from("ticker_risk_config").update({action:v,updated_at:new Date().toISOString()}).eq("symbol",r.symbol);setTickerRiskCfg(p=>p.map(x=>x.symbol===r.symbol?{...x,action:v}:x));}} style={{fontSize:10,padding:"2px 4px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:r.action==="avoid"?"#ff4560":"#00ff88",fontFamily:"monospace"}}>
                          <option value="scan">scan</option>
                          <option value="avoid">avoid</option>
                        </select>
                      </td>
                      <td style={{padding:"4px 8px",color:"#555",fontSize:9}}>{r.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
  );

  if (inline) return inner;
  return (
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      {inner}
    </div>
  );
}

// ─── SAGE Attention Panel ─────────────────────────────────────────────────────
function SageAttentionPanel({ onOpenChain }) {
  const [results,  setResults]  = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [expanded, setExpanded] = useState({});

  const [manualTicker, setManualTicker] = useState("");

  const runScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const body = { mode: "sage_scan" };
      if (manualTicker.trim()) body.extra_ticker = manualTicker.trim().toUpperCase();
      const res  = await fetch("/api/claude", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "scan failed");
      setResults(data);
      setLastScan(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (ticker) => setExpanded(prev => ({ ...prev, [ticker]: !prev[ticker] }));

  const recColor = (rec, score) => {
    if (rec === "sto_strong")    return "#00ff88";
    if (rec === "sto_favorable") return "#3fb950";
    if (rec === "monitor")       return "#d29922";
    if (rec === "hold")          return "#6e7681";
    if (rec === "no_data")       return "#484f58";
    return "#6e7681";
  };
  const recLabel = (rec, score) => {
    if (rec === "sto_strong")    return "💚 Strong STO Signal";
    if (rec === "sto_favorable") return "🟢 STO Signal";
    if (rec === "monitor")       return score >= 45 ? "🟡 Watch" : "🔴 Not a Candidate";
    if (rec === "hold")          return score >= 45 ? "🟡 Watch" : "🔴 Not a Candidate";
    if (rec === "no_data")       return "No Data";
    return rec;
  };
  // BTO scoring — inverted weights from STO
  // BTO favors: RSI oversold, near support, low IV (cheap options), gap fill setup
  const scoreBTO = (factors) => {
    if (!factors) return { score: 0, signal: "no_data", reasons: [] };
    const f = factors;
    let score = 0, reasons = [];
    // RSI oversold = strong BTO signal
    if (f.rsi_14 != null) {
      const r = Number(f.rsi_14);
      if (r < 30)      { score += 25; reasons.push(`🟢 RSI deeply oversold (${r.toFixed(0)}) — strong bounce potential`); }
      else if (r < 40) { score += 18; reasons.push(`🟢 RSI oversold (${r.toFixed(0)}) — good bounce setup`); }
      else if (r < 50) { score += 8;  reasons.push(`🟡 RSI neutral-low (${r.toFixed(0)})`); }
      else if (r > 70) { score -= 15; reasons.push(`🔴 RSI overbought (${r.toFixed(0)}) — poor BTO timing`); }
    }
    // Near Fib support = strong BTO signal
    if (f.fib_near_support === 1)    { score += 22; reasons.push(`🟢 On Fibonacci support — natural bounce level`); }
    else if (f.fib_broke_below === 1){ score -= 10; reasons.push(`🔴 Broke below Fibonacci level — downward momentum`); }
    else if (f.fib_near_resistance === 1) { score -= 8; reasons.push(`🔴 Near resistance — limited upside for BTO`); }
    // Lower BB = oversold, good entry
    if (f.bb_pct_b != null) {
      const b = Number(f.bb_pct_b);
      if (b < 0.2)      { score += 18; reasons.push(`🟢 Near lower Bollinger Band (%B=${b.toFixed(2)}) — oversold entry`); }
      else if (b < 0.35){ score += 10; reasons.push(`🟡 Lower half of Bollinger Band — decent entry`); }
      else if (b > 0.8) { score -= 12; reasons.push(`🔴 Near upper Bollinger Band — overbought, poor BTO entry`); }
    }
    // Gap down = potential gap fill BTO (gaps fill 80% of the time)
    if (f.gap_flag === 1 && f.gap_direction === -1) { score += 15; reasons.push(`⚡ Gapped down ${Math.abs(Number(f.gap_pct||0)).toFixed(1)}% — gap fill potential (fills 80% of the time)`); }
    // Low IV = cheap options to buy
    if (f.iv_pct != null) {
      const iv = Number(f.iv_pct);
      if (iv < 30)      { score += 12; reasons.push(`💰 Low IV (${iv.toFixed(0)}%) — options are cheap to buy`); }
      else if (iv < 50) { score += 6;  reasons.push(`🟡 Moderate IV (${iv.toFixed(0)}%)`); }
      else              { score -= 5;  reasons.push(`⚠️ High IV (${iv.toFixed(0)}%) — options expensive to buy`); }
    }
    // Stock down today but not too far = mean reversion setup
    if (f.change_pct != null) {
      const cp = Number(f.change_pct);
      if (cp < -2)       { score += 12; reasons.push(`📉 Down ${cp.toFixed(2)}% — mean reversion candidate`); }
      else if (cp < -0.5){ score += 6;  reasons.push(`📉 Down ${cp.toFixed(2)}% — mild pullback`); }
      else if (cp > 1.5) { score -= 10; reasons.push(`📈 Already up ${cp.toFixed(2)}% — momentum may be extended`); }
    }
    const finalScore = Math.min(100, Math.max(0, score));
    const signal = finalScore >= 70 ? "bto_strong" : finalScore >= 50 ? "bto_favorable" : finalScore >= 30 ? "bto_watch" : "bto_weak";
    return { score: finalScore, signal, reasons };
  };
  const scoreColor = (s) => s >= 75 ? "#3fb950" : s >= 65 ? "#d29922" : s >= 45 ? th("#8b949e","#5a5248") : "#484f58";

  const factorMeta = {
    iv_pct:              { label:"IV%",         fmt: v=>`${Number(v).toFixed(1)}%`,                        good: v=>v>80,   bad: v=>v<40  },
    iv_rank:             { label:"IV Rank",      fmt: v=>`${Math.round(v)}`,                               good: v=>v>70,   bad: v=>v<30  },
    iv_percentile:       { label:"IV %ile",      fmt: v=>`${Math.round(v)}%`,                              good: v=>v>70,   bad: v=>v<30  },
    rsi_14:              { label:"RSI-14",       fmt: v=>Number(v).toFixed(1),                              good: v=>v<40,   bad: v=>v>70  },
    change_pct:          { label:"Change%",      fmt: v=>`${v>=0?"+":""}${Number(v).toFixed(2)}%`,          good: v=>v>=0.5, bad: v=>v<0   },
    vix:                 { label:"VIX",          fmt: v=>Number(v).toFixed(1),                              good: v=>v>22,   bad: v=>v<18  },
    bb_pct_b:            { label:"%B",           fmt: v=>Number(v).toFixed(2),                              good: v=>v<0.25, bad: v=>v>0.8 },
    fib_near_resistance: { label:"Fib Resist",   fmt: v=>v==1?"Yes":"No",                                   good: v=>v==1,   bad: ()=>false },
    fib_near_support:    { label:"Fib Support",  fmt: v=>v==1?"Yes":"No",                                   good: ()=>false, bad: v=>v==1  },
    fib_broke_below:     { label:"Fib Break↓",   fmt: v=>v==1?"Yes":"No",                                   good: v=>v==1,   bad: ()=>false },
    dte:                 { label:"DTE",          fmt: v=>`${Math.round(v)}d`,                               good: v=>v>=25&&v<=40, bad: v=>v<21||v>45 },
    gap_flag:            { label:"Gap",          fmt: v=>v==1?"Yes":"No",                                   good: v=>v==1,   bad: ()=>false },
    sr_near_resistance:  { label:"Near S/R Res", fmt: v=>v==1?"Yes":"No",                                   good: v=>v==1,   bad: ()=>false },
    sr_near_support:     { label:"Near S/R Sup", fmt: v=>v==1?"Yes":"No",                                   good: ()=>false, bad: v=>v==1  },
    sr_nearest_dist_pct: { label:"S/R Dist%",    fmt: v=>`${Number(v).toFixed(1)}%`,                       good: v=>v>3,    bad: v=>v<1   },
    sr_nearest_strength: { label:"S/R Strength", fmt: v=>`${Math.round(v)}x`,                              good: v=>v>=3,   bad: ()=>false },
  };

  return (
    <div style={{ background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:8, marginBottom:16, overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderBottom:"1px solid #21262d", background:th("#161b22","#ede8df") }}>
        <span style={{ color:th("#e6edf3","#0d0d0b"), fontWeight:600, fontSize:13, letterSpacing:"0.02em" }}>◈ SAGE Attention Scanner</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <input
            value={manualTicker}
            onChange={e => setManualTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && runScan()}
            placeholder="+ ticker (e.g. NVDA)"
            style={{ background:th("#21262d","#c8b8a8"), border:"1px solid #30363d", borderRadius:5, padding:"4px 10px", fontSize:11, color:th("#e6edf3","#0d0d0b"), width:140, fontFamily:"monospace" }}
          />
          <button
            onClick={runScan}
            disabled={loading}
            style={{ background:loading?th("#21262d","#c8b8a8"):"#1f6feb", color:th("#e6edf3","#0d0d0b"), border:"none", borderRadius:5, padding:"5px 14px", fontSize:12, fontWeight:600, cursor:loading?"not-allowed":"pointer", opacity:loading?0.7:1 }}
          >
            {loading ? "Scanning..." : "▶ Scan My Holdings"}
          </button>
        </div>
      </div>

      {/* Meta bar */}
      {results && (
        <div style={{ padding:"6px 14px", fontSize:11, color:"#6e7681", borderBottom:"1px solid #21262d", display:"flex", gap:16 }}>
          <span>{results.scanned} tickers scanned</span>
          {results.vix   && <span>VIX: {Number(results.vix).toFixed(1)}</span>}
          <span>Threshold: {results.threshold}/100</span>
          {lastScan      && <span>Last scan: {lastScan.toLocaleTimeString()}</span>}
        </div>
      )}

      {error && <div style={{ padding:"10px 14px", color:"#f85149", fontSize:12 }}>Error: {error}</div>}

      {!results && !loading && (
        <div style={{ padding:"24px 14px", textAlign:"center", color:"#6e7681", fontSize:13 }}>
          Click "Scan My Holdings" to see which tickers deserve your attention right now.
        </div>
      )}

      {/* Ticker rows */}
      {results?.results?.map(r => {
        const isOpen  = expanded[r.ticker];
        const factors = r.factors || {};
        return (
          <div key={r.ticker} style={{ borderBottom:"1px solid #21262d" }}>
            {/* Main row */}
            <div onClick={() => toggle(r.ticker)} style={{ display:"flex", alignItems:"center", padding:"8px 14px", cursor:"pointer", gap:10 }}>
              {/* Score circle */}
              <div style={{ width:36, height:36, borderRadius:"50%", border:`2px solid ${scoreColor(r.score)}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:scoreColor(r.score), flexShrink:0 }}>
                {r.score}
              </div>
              <span style={{ fontSize:14, fontWeight:700, color:th("#e6edf3","#0d0d0b"), width:60, flexShrink:0 }}>{r.ticker}</span>
              <span style={{ background:recColor(r.recommendation, r.score)+"22", color:recColor(r.recommendation, r.score), border:`1px solid ${recColor(r.recommendation, r.score)}55`, borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:600, flexShrink:0 }}>
                {recLabel(r.recommendation, r.score)}
              </span>
              {/* Score bar */}
              <div style={{ flex:1, height:4, background:th("#21262d","#c8b8a8"), borderRadius:2, overflow:"hidden" }}>
                <div style={{ width:`${r.score}%`, height:"100%", background:scoreColor(r.score), borderRadius:2, transition:"width 0.4s ease" }} />
              </div>
              <span style={{ fontSize:11, color:"#6e7681", flexShrink:0 }}>{r.shares} sh</span>
              <button
                onClick={e => { e.stopPropagation(); onOpenChain?.(r.ticker); }}
                style={{ background:th("#21262d","#c8b8a8"), border:"1px solid #30363d", borderRadius:4, padding:"2px 8px", fontSize:10, color:"#58a6ff", cursor:"pointer", flexShrink:0 }}
              >⛓ chain</button>
              <span style={{ fontSize:10, color:"#484f58" }}>{isOpen?"▲":"▼"}</span>
            </div>

            {/* Expanded: gate failures */}
            {isOpen && r.gateFailures?.length > 0 && (
              <div style={{ padding:"0 14px 6px 74px", fontSize:11, color:"#f85149" }}>
                ✕ {r.gateFailures.join(" · ")}
              </div>
            )}

            {/* Expanded: factor chips */}
            {isOpen && (
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, padding:"0 14px 6px 74px" }}>
                {Object.entries(factorMeta).map(([key, def]) => {
                  const val = factors[key];
                  if (val === undefined || val === null) return null;
                  const color = def.good(val) ? "#3fb950" : def.bad(val) ? "#f85149" : th("#8b949e","#5a5248");
                  return (
                    <span key={key} style={{ background:color+"18", border:`1px solid ${color}44`, borderRadius:4, padding:"2px 8px", fontSize:11, color }}>
                      {def.label}: {def.fmt(val)}
                    </span>
                  );
                })}
                {Object.keys(factorMeta).every(k => factors[k] == null) && (
                  <span style={{ color:"#484f58", fontSize:11 }}>No factor data yet — populates after signals fire</span>
                )}
              </div>
            )}

            {/* Expanded: plain English SAGE interpretation */}
            {isOpen && factors && Object.keys(factors).some(k => factors[k] != null) && (() => {
              const lines = [];
              const f = factors;
              if (f.change_pct != null) {
                if (f.change_pct >= 1.5)      lines.push(`📈 Up strongly (+${Number(f.change_pct).toFixed(2)}%) — momentum is in your favor for a covered call.`);
                else if (f.change_pct >= 0.5) lines.push(`📈 Up +${Number(f.change_pct).toFixed(2)}% — meets the minimum 0.5% movement threshold.`);
                else if (f.change_pct >= 0)   lines.push(`➡️ Barely up (+${Number(f.change_pct).toFixed(2)}%) — doesn't meet the 0.5% minimum for an STO.`);
                else                          lines.push(`📉 Down ${Number(f.change_pct).toFixed(2)}% today — not a candidate for selling a call.`);
              }
              if (f.iv_pct != null) {
                if (f.iv_pct > 80)      lines.push(`💰 IV elevated at ${Number(f.iv_pct).toFixed(0)}% — excellent premium environment.`);
                else if (f.iv_pct > 50) lines.push(`💰 IV moderate at ${Number(f.iv_pct).toFixed(0)}% — decent premium available.`);
                else if (f.iv_pct > 0)  lines.push(`⚠️ IV low at ${Number(f.iv_pct).toFixed(0)}% — premium will be thin, consider waiting.`);
              }
              if (f.rsi_14 != null) {
                if (f.rsi_14 < 35)      lines.push(`🟢 RSI oversold at ${Number(f.rsi_14).toFixed(0)} — stock pulled back, less likely to blow through your strike.`);
                else if (f.rsi_14 < 50) lines.push(`🟢 RSI neutral-low at ${Number(f.rsi_14).toFixed(0)} — healthy, not overbought.`);
                else if (f.rsi_14 < 65) lines.push(`🟡 RSI neutral at ${Number(f.rsi_14).toFixed(0)} — no strong signal either way.`);
                else if (f.rsi_14 < 75) lines.push(`🟡 RSI elevated at ${Number(f.rsi_14).toFixed(0)} — stock getting stretched, use a wider strike.`);
                else                    lines.push(`🔴 RSI overbought at ${Number(f.rsi_14).toFixed(0)} — extended, high risk of call going ITM.`);
              }
              if (f.bb_pct_b != null) {
                if (f.bb_pct_b > 0.8)      lines.push(`🔴 Near upper Bollinger Band (%B=${Number(f.bb_pct_b).toFixed(2)}) — overbought, caution.`);
                else if (f.bb_pct_b > 0.5) lines.push(`🟡 Upper half of Bollinger Band — mild upward pressure.`);
                else if (f.bb_pct_b > 0.2) lines.push(`🟢 Middle of Bollinger Band — neutral, good room for call to stay OTM.`);
                else                       lines.push(`🟢 Near lower Bollinger Band (%B=${Number(f.bb_pct_b).toFixed(2)}) — oversold, likely to bounce not run.`);
              }
              if (f.fib_near_resistance === 1)      lines.push(`📐 Near Fibonacci resistance (${f.fib_level ? (f.fib_level*100).toFixed(1)+"% level" : "key level"}) — natural ceiling, favors call staying OTM.`);
              else if (f.fib_near_support === 1)    lines.push(`⚠️ Sitting on Fibonacci support — bounce risk, use a wider strike.`);
              else if (f.fib_broke_below === 1)     lines.push(`📐 Just broke below a Fibonacci level — downward momentum, favorable for covered call.`);
              else if (f.fib_proximity_pct != null) lines.push(`📐 Nearest Fibonacci level is ${Number(f.fib_proximity_pct).toFixed(1)}% away — no immediate Fib signal.`);
              if (f.vix != null) {
                if (f.vix >= 25)      lines.push(`🌊 VIX high at ${Number(f.vix).toFixed(1)} — volatile market, premiums are rich.`);
                else if (f.vix >= 18) lines.push(`🌊 VIX at ${Number(f.vix).toFixed(1)} — adequate volatility, meets the minimum threshold.`);
                else                  lines.push(`😴 VIX low at ${Number(f.vix).toFixed(1)} — calm market, premium will be thin.`);
              }
              if (f.gap_flag === 1) lines.push(`⚡ Gapped ${f.gap_direction === 1 ? "up" : "down"} ${Math.abs(Number(f.gap_pct||0)).toFixed(1)}% at open — elevated IV, be mindful of gap fill potential.`);
              if (f.iv_rank != null) {
                if (f.iv_rank > 80)       lines.push(`📊 IV Rank ${Math.round(f.iv_rank)} — IV near its yearly high, excellent time to sell premium.`);
                else if (f.iv_rank > 50)  lines.push(`📊 IV Rank ${Math.round(f.iv_rank)} — IV above average for this ticker.`);
                else if (f.iv_rank > 0)   lines.push(`📊 IV Rank ${Math.round(f.iv_rank)} — IV below average, premium may be thin.`);
              }
              if (f.sr_near_resistance === 1) lines.push(`🧱 Within 2% of S/R resistance (${f.sr_nearest_strength || 1}x tested at $${Number(f.sr_resistance_price||0).toFixed(2)}) — strong ceiling, favors call staying OTM.`);
              else if (f.sr_near_support === 1) lines.push(`🧱 Within 2% of S/R support ($${Number(f.sr_support_price||0).toFixed(2)}) — bounce risk, consider wider strike.`);
              else if (f.sr_nearest_dist_pct != null) lines.push(`🧱 Nearest S/R level is ${Number(f.sr_nearest_dist_pct).toFixed(1)}% away (${f.sr_nearest_type || "level"}, ${f.sr_nearest_strength || 1}x tested).`);
              if (!lines.length) return null;
              return (
                <div style={{ padding:"0 14px 10px 74px" }}>
                  <div style={{ background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:6, padding:"8px 12px" }}>
                    <div style={{ fontFamily:"monospace", fontSize:9, color:th("#3a4050","#8a7e74"), letterSpacing:"0.08em", marginBottom:6 }}>SAGE INTERPRETATION</div>
                    {lines.map((line, i) => (
                      <div key={i} style={{ fontSize:12, color:th("#8b949e","#5a5248"), lineHeight:"1.7", marginBottom: i < lines.length-1 ? 2 : 0 }}>{line}</div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}

// ─── SAGE BTO Panel ───────────────────────────────────────────────────────────
function SageBTOPanel({ onOpenChain }) {
  const [results,     setResults]     = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [lastScan,    setLastScan]    = useState(null);
  const [expanded,    setExpanded]    = useState({});
  const [manualTicker, setManualTicker] = useState("");

  const scoreBTO = (factors) => {
    if (!factors) return { score: 0, signal: "no_data", reasons: [] };
    const f = factors;
    let score = 0, reasons = [];
    if (f.rsi_14 != null) {
      const r = Number(f.rsi_14);
      if (r < 30)      { score += 25; reasons.push(`🟢 RSI deeply oversold (${r.toFixed(0)}) — strong bounce potential`); }
      else if (r < 40) { score += 18; reasons.push(`🟢 RSI oversold (${r.toFixed(0)}) — good bounce setup`); }
      else if (r < 50) { score += 8;  reasons.push(`🟡 RSI neutral-low (${r.toFixed(0)})`); }
      else if (r > 70) { score -= 15; reasons.push(`🔴 RSI overbought (${r.toFixed(0)}) — poor BTO timing`); }
    }
    if (f.fib_near_support === 1)         { score += 22; reasons.push(`🟢 On Fibonacci support — natural bounce level`); }
    else if (f.fib_broke_below === 1)     { score -= 10; reasons.push(`🔴 Broke below Fibonacci level — downward momentum`); }
    else if (f.fib_near_resistance === 1) { score -= 8;  reasons.push(`🔴 Near resistance — limited upside for BTO`); }
    if (f.bb_pct_b != null) {
      const b = Number(f.bb_pct_b);
      if (b < 0.2)       { score += 18; reasons.push(`🟢 Near lower Bollinger Band (%B=${b.toFixed(2)}) — oversold entry`); }
      else if (b < 0.35) { score += 10; reasons.push(`🟡 Lower half of Bollinger Band — decent entry`); }
      else if (b > 0.8)  { score -= 12; reasons.push(`🔴 Near upper Bollinger Band — overbought, poor BTO entry`); }
    }
    if (f.gap_flag === 1 && f.gap_direction === -1) { score += 15; reasons.push(`⚡ Gapped down ${Math.abs(Number(f.gap_pct||0)).toFixed(1)}% — gap fill potential (fills 80% of the time)`); }
    if (f.iv_pct != null) {
      const iv = Number(f.iv_pct);
      if (iv < 30)      { score += 12; reasons.push(`💰 Low IV (${iv.toFixed(0)}%) — options are cheap to buy`); }
      else if (iv < 50) { score += 6;  reasons.push(`🟡 Moderate IV (${iv.toFixed(0)}%)`); }
      else              { score -= 5;  reasons.push(`⚠️ High IV (${iv.toFixed(0)}%) — options expensive to buy`); }
    }
    if (f.change_pct != null) {
      const cp = Number(f.change_pct);
      if (cp < -2)       { score += 12; reasons.push(`📉 Down ${cp.toFixed(2)}% — mean reversion candidate`); }
      else if (cp < -0.5){ score += 6;  reasons.push(`📉 Down ${cp.toFixed(2)}% — mild pullback`); }
      else if (cp > 1.5) { score -= 10; reasons.push(`📈 Already up ${cp.toFixed(2)}% — momentum may be extended`); }
    }
    const finalScore = Math.min(100, Math.max(0, score));
    const signal = finalScore >= 70 ? "bto_strong" : finalScore >= 50 ? "bto_favorable" : finalScore >= 30 ? "bto_watch" : "bto_weak";
    return { score: finalScore, signal, reasons };
  };

  const signalColor = (s) => ({ bto_strong:"#00ff88", bto_favorable:"#3fb950", bto_watch:"#d29922", bto_weak:"#6e7681", no_data:"#484f58" }[s] || "#6e7681");
  const signalLabel = (s) => ({ bto_strong:"💚 Strong BTO Signal", bto_favorable:"🟢 BTO Signal", bto_watch:"🟡 Watch", bto_weak:"🔴 Weak", no_data:"No Data" }[s] || s);
  const scoreColor  = (s) => s >= 70 ? "#00ff88" : s >= 50 ? "#3fb950" : s >= 30 ? "#d29922" : "#6e7681";

  const runScan = async (extraTicker) => {
    setLoading(true); setError(null);
    try {
      const body = { mode: "bto_scan" };
      if (extraTicker) body.extra_ticker = extraTicker.toUpperCase().trim();
      const res  = await fetch("/api/claude", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "scan failed");
      // Apply BTO scoring on top of returned factors
      const scored = (data.results || []).map(r => {
        const bto = scoreBTO(r.factors);
        return { ...r, btoScore: bto.score, btoSignal: bto.signal, btoReasons: bto.reasons };
      }).sort((a, b) => b.btoScore - a.btoScore);
      setResults({ ...data, results: scored });
      setLastScan(new Date());
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const toggle = (ticker) => setExpanded(prev => ({ ...prev, [ticker]: !prev[ticker] }));

  return (
    <div style={{ background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:8, marginBottom:16, overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderBottom:"1px solid #21262d", background:th("#161b22","#ede8df") }}>
        <span style={{ color:th("#e6edf3","#0d0d0b"), fontWeight:600, fontSize:13, letterSpacing:"0.02em" }}>◈ BTO Opportunity Scanner</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <input
            value={manualTicker}
            onChange={e => setManualTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && manualTicker && runScan(manualTicker)}
            placeholder="+ ticker (e.g. TSLA)"
            style={{ background:th("#21262d","#c8b8a8"), border:"1px solid #30363d", borderRadius:5, padding:"4px 10px", fontSize:11, color:th("#e6edf3","#0d0d0b"), width:140, fontFamily:"monospace" }}
          />
          <button onClick={() => runScan(manualTicker || null)} disabled={loading}
            style={{ background:loading?th("#21262d","#c8b8a8"):"#238636", color:th("#e6edf3","#0d0d0b"), border:"none", borderRadius:5, padding:"5px 14px", fontSize:12, fontWeight:600, cursor:loading?"not-allowed":"pointer", opacity:loading?0.7:1 }}>
            {loading ? "Scanning..." : "▶ Scan for BTO"}
          </button>
        </div>
      </div>

      {/* Meta */}
      {results && (
        <div style={{ padding:"6px 14px", fontSize:11, color:"#6e7681", borderBottom:"1px solid #21262d", display:"flex", gap:16 }}>
          <span>{results.scanned} tickers scanned</span>
          {results.vix && <span>VIX: {Number(results.vix).toFixed(1)}</span>}
          {lastScan && <span>Last scan: {lastScan.toLocaleTimeString()}</span>}
          <span style={{ color:"#484f58" }}>BTO = expect stock to rise, buy calls cheap</span>
        </div>
      )}

      {error && <div style={{ padding:"10px 14px", color:"#f85149", fontSize:12 }}>Error: {error}</div>}

      {!results && !loading && (
        <div style={{ padding:"24px 14px", textAlign:"center", color:"#6e7681", fontSize:13 }}>
          Scan your holdings for oversold bounce candidates — or enter any ticker to check it.
        </div>
      )}

      {results?.results?.map(r => {
        const isOpen = expanded[r.ticker];
        const col    = signalColor(r.btoSignal);
        return (
          <div key={r.ticker} style={{ borderBottom:"1px solid #21262d" }}>
            <div onClick={() => toggle(r.ticker)} style={{ display:"flex", alignItems:"center", padding:"8px 14px", cursor:"pointer", gap:10 }}>
              <div style={{ width:36, height:36, borderRadius:"50%", border:`2px solid ${scoreColor(r.btoScore)}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:scoreColor(r.btoScore), flexShrink:0 }}>
                {r.btoScore}
              </div>
              <span style={{ fontSize:14, fontWeight:700, color:th("#e6edf3","#0d0d0b"), width:60, flexShrink:0 }}>{r.ticker}</span>
              <span style={{ background:col+"22", color:col, border:`1px solid ${col}55`, borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:600, flexShrink:0 }}>
                {signalLabel(r.btoSignal)}
              </span>
              <div style={{ flex:1, height:4, background:th("#21262d","#c8b8a8"), borderRadius:2, overflow:"hidden" }}>
                <div style={{ width:`${r.btoScore}%`, height:"100%", background:scoreColor(r.btoScore), borderRadius:2, transition:"width 0.4s ease" }} />
              </div>
              <span style={{ fontSize:11, color:"#6e7681", flexShrink:0 }}>{r.shares ? `${r.shares} sh` : "watchlist"}</span>
              <button
                onClick={e => { e.stopPropagation(); onOpenChain?.(r.ticker); }}
                style={{ background:th("#21262d","#c8b8a8"), border:"1px solid #30363d", borderRadius:4, padding:"2px 8px", fontSize:10, color:"#58a6ff", cursor:"pointer", flexShrink:0 }}
              >⛓ chain</button>
              <span style={{ fontSize:10, color:"#484f58" }}>{isOpen?"▲":"▼"}</span>
            </div>
            {isOpen && r.btoReasons?.length > 0 && (
              <div style={{ padding:"0 14px 10px 74px" }}>
                <div style={{ background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:6, padding:"8px 12px" }}>
                  <div style={{ fontFamily:"monospace", fontSize:9, color:th("#3a4050","#8a7e74"), letterSpacing:"0.08em", marginBottom:6 }}>BTO ANALYSIS</div>
                  {r.btoReasons.map((line, i) => (
                    <div key={i} style={{ fontSize:12, color:th("#8b949e","#5a5248"), lineHeight:"1.7", marginBottom: i < r.btoReasons.length-1 ? 2 : 0 }}>{line}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SAGE Explorer Tab ────────────────────────────────────────────────────────
function SageTab({ supabase, setTab, setSelectedTicker }) {
  const [contracts,    setContracts]    = useState([]);
  const [factorValues, setFactorValues] = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [aiResult,     setAiResult]     = useState(null);
  const chartRefs = useRef({});

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "sage_data" }),
      }).then(r => r.json()),
      supabase.from("scoring_factor_values").select("factor_name,value,signal_id").limit(2000),
    ])
      .then(([d, { data: fv }]) => {
        if (!d.ok) throw new Error(d.error || "API error");
        setContracts(d.contracts || []);
        setFactorValues(fv || []);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const stos = useMemo(() =>
    contracts.filter(c => c.opt_type === "STO" && c.profit_pct != null && c.status === "Closed"),
  [contracts]);

  const metrics = useMemo(() => {
    if (!stos.length) return null;
    const wins = stos.filter(c => c.profit_pct >= 0.5);
    const avgProfit = stos.reduce((s, c) => s + c.profit_pct, 0) / stos.length * 100;
    const avgPrem   = stos.reduce((s, c) => s + (c.premium || 0), 0) / stos.length;
    const tickers   = new Set(stos.map(c => c.stock)).size;
    return { total: stos.length, winRate: wins.length / stos.length * 100, avgProfit, avgPrem, tickers };
  }, [stos]);

  const byTicker = useMemo(() => {
    const map = {};
    stos.forEach(c => {
      if (!map[c.stock]) map[c.stock] = { wins: 0, total: 0, profitSum: 0, premSum: 0 };
      const t = map[c.stock];
      t.total++;
      t.profitSum += c.profit_pct;
      t.premSum   += (c.premium || 0);
      if (c.profit_pct >= 0.5) t.wins++;
    });
    return Object.entries(map)
      .filter(([, v]) => v.total >= 3)
      .map(([stock, v]) => ({ stock, ...v, wr: v.wins / v.total * 100 }))
      .sort((a, b) => b.wr - a.wr);
  }, [stos]);

  const distBuckets = useMemo(() => {
    const labels = ["<0%", "0-25%", "25-50%", "50-75%", "75-100%", ">100%"];
    const counts  = [0, 0, 0, 0, 0, 0];
    stos.forEach(c => {
      const p = c.profit_pct * 100;
      if      (p < 0)   counts[0]++;
      else if (p < 25)  counts[1]++;
      else if (p < 50)  counts[2]++;
      else if (p < 75)  counts[3]++;
      else if (p <= 100) counts[4]++;
      else              counts[5]++;
    });
    return { labels, counts };
  }, [stos]);

  const dayBuckets = useMemo(() => {
    const bkts = { "0d": [], "1d": [], "2-3d": [], "4-7d": [], "8+d": [] };
    stos.forEach(c => {
      const d = c.days_held;
      if      (d === 0)        bkts["0d"].push(c.profit_pct);
      else if (d === 1)        bkts["1d"].push(c.profit_pct);
      else if (d <= 3)         bkts["2-3d"].push(c.profit_pct);
      else if (d <= 7)         bkts["4-7d"].push(c.profit_pct);
      else if (d != null)      bkts["8+d"].push(c.profit_pct);
    });
    return Object.entries(bkts).map(([label, arr]) => ({
      label,
      wr:  arr.length ? arr.filter(p => p >= 0.5).length / arr.length * 100 : 0,
      cnt: arr.length,
    }));
  }, [stos]);

  // Factor coverage stats — aggregate across all captured factor values
  const factorStats = useMemo(() => {
    const byFactor = {};
    factorValues.forEach(({ factor_name, value }) => {
      if (value == null) return;
      if (!byFactor[factor_name]) byFactor[factor_name] = [];
      byFactor[factor_name].push(value);
    });
    return Object.entries(byFactor).map(([name, vals]) => {
      const sorted = [...vals].sort((a, b) => a - b);
      const avg    = vals.reduce((s, v) => s + v, 0) / vals.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const min    = sorted[0];
      const max    = sorted[sorted.length - 1];
      return { name, count: vals.length, avg, median, min, max };
    }).sort((a, b) => b.count - a.count);
  }, [factorValues]);

  // Draw charts after data loads
  useEffect(() => {
    if (loading || !stos.length) return;
    if (typeof Chart === "undefined") return;

    const destroy = id => { if (chartRefs.current[id]) { chartRefs.current[id].destroy(); delete chartRefs.current[id]; } };

    // Chart 1 — win rate by ticker
    destroy("c1");
    const c1 = document.getElementById("sage-c1");
    if (c1) {
      chartRefs.current["c1"] = new Chart(c1, {
        type: "bar",
        data: {
          labels: byTicker.map(e => e.stock),
          datasets: [{ label: "Win %", data: byTicker.map(e => parseFloat(e.wr.toFixed(1))),
            backgroundColor: byTicker.map(e => e.wr >= 60 ? "#27500A" : e.wr >= 50 ? "#185FA5" : "#A32D2D"),
            borderRadius: 3 }],
        },
        options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { min: 0, max: 100, ticks: { callback: v => v + "%" } }, y: { ticks: { font: { size: 10 } } } } },
      });
    }

    // Chart 2 — profit distribution
    destroy("c2");
    const c2 = document.getElementById("sage-c2");
    if (c2) {
      chartRefs.current["c2"] = new Chart(c2, {
        type: "bar",
        data: {
          labels: distBuckets.labels,
          datasets: [{ label: "Trades", data: distBuckets.counts,
            backgroundColor: ["#A32D2D", "#F09595", "#FAC775", "#85B7EB", "#639922", "#27500A"],
            borderRadius: 3 }],
        },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { autoSkip: false, font: { size: 10 } } } } },
      });
    }

    // Chart 3 — win rate by days held
    destroy("c3");
    const c3 = document.getElementById("sage-c3");
    if (c3) {
      chartRefs.current["c3"] = new Chart(c3, {
        type: "bar",
        data: {
          labels: dayBuckets.map(b => b.label),
          datasets: [{ label: "Win %", data: dayBuckets.map(b => parseFloat(b.wr.toFixed(1))),
            backgroundColor: "#185FA5", borderRadius: 3 }],
        },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { autoSkip: false } }, y: { min: 0, max: 100, ticks: { callback: v => v + "%" } } } },
      });
    }

    return () => { ["c1", "c2", "c3"].forEach(destroy); };
  }, [loading, stos, byTicker, distBuckets, dayBuckets]);

  const askSage = async () => {
    setAiLoading(true); setAiResult(null);
    try {
      const summary = metrics ? `STO trades: ${metrics.total}, win rate: ${metrics.winRate.toFixed(1)}%, avg profit: ${metrics.avgProfit.toFixed(1)}%, avg premium: $${Math.round(metrics.avgPrem)}. Top tickers by win rate: ${byTicker.slice(0,5).map(t=>`${t.stock} ${t.wr.toFixed(0)}%`).join(", ")}.` : "No data yet.";
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "chat",
          messages: [{ role: "user", content: `You are SAGE, a trade scoring advisor. Based on this STO trade history: ${summary}\n\nRecommend specific scoring weights (0-10) for each of these factors: change_pct, vix, dte, otm_pct, time_of_day, days_since_last_sto, ticker_win_rate. Also recommend whether a gating+weighted-sum or tiered-bucket architecture fits best for this data. Be concise and specific.` }],
        }),
      });
      const d = await res.json();
      const content = d.content || d.response || d.message || d.error || "No response";
      const text = Array.isArray(content)
        ? content.filter(b => b.type === "text").map(b => b.text).join("\n")
        : String(content);
      setAiResult(text);
    } catch (e) { setAiResult("Error: " + e.message); }
    setAiLoading(false);
  };

  const cardStyle = { background: th("#0d1117","#f5f0e8"), border: "1px solid #1c2128", borderRadius: 6, padding: "10px 14px", marginBottom: 12 };
  const labelStyle = { fontFamily: "monospace", fontSize: 9, color: th("#3a4050","#8a7e74"), letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 6 };
  const metricStyle = { fontFamily: "monospace", fontSize: 20, fontWeight: 600, color: "#00ff88" };
  const subStyle = { fontFamily: "monospace", fontSize: 9, color: "#555", marginTop: 2 };

  if (loading) return <div style={{ padding: 24, fontFamily: "monospace", fontSize: 11, color: "#555" }}>loading sage data...</div>;
  if (error)   return <div style={{ padding: 24, fontFamily: "monospace", fontSize: 11, color: "#ff4444" }}>error: {error}</div>;
  if (!stos.length) return <div style={{ padding: 24, fontFamily: "monospace", fontSize: 11, color: "#555" }}>no closed STO contracts found</div>;

  return (
    <div style={{ padding: "12px 12px 0", maxWidth: 700 }}>
      <div style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.12em", marginBottom: 14 }}>◈ SAGE EXPLORER</div>
      <SageAttentionPanel onOpenChain={(ticker) => { setTab("stocks"); setSelectedTicker(ticker); }} />
      <SageBTOPanel onOpenChain={(ticker) => { setTab("stocks"); setSelectedTicker(ticker); }} />

      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 14 }}>
        {[
          { label: "STO trades",  val: metrics.total },
          { label: "Win rate",    val: metrics.winRate.toFixed(1) + "%" },
          { label: "Avg profit",  val: metrics.avgProfit.toFixed(1) + "%" },
          { label: "Avg premium", val: "$" + Math.round(metrics.avgPrem) },
          { label: "Tickers",     val: metrics.tickers },
        ].map(({ label, val }) => (
          <div key={label} style={{ background: th("#0d1117","#f5f0e8"), border: "1px solid #1c2128", borderRadius: 6, padding: "8px 10px" }}>
            <div style={labelStyle}>{label}</div>
            <div style={metricStyle}>{val}</div>
          </div>
        ))}
      </div>

      {/* Win rate by ticker */}
      <div style={cardStyle}>
        <div style={labelStyle}>Win rate by ticker (STO ≥3 trades)</div>
        <div style={{ position: "relative", width: "100%", height: Math.max(180, byTicker.length * 26 + 40) }}>
          <canvas id="sage-c1" role="img" aria-label="Win rate by ticker" />
        </div>
      </div>

      {/* Profit distribution */}
      <div style={cardStyle}>
        <div style={labelStyle}>Profit % distribution</div>
        <div style={{ position: "relative", width: "100%", height: 180 }}>
          <canvas id="sage-c2" role="img" aria-label="Profit % distribution" />
        </div>
      </div>

      {/* Win rate by days held */}
      <div style={cardStyle}>
        <div style={labelStyle}>Win rate by days held</div>
        <div style={{ position: "relative", width: "100%", height: 180 }}>
          <canvas id="sage-c3" role="img" aria-label="Win rate by days held" />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
          {dayBuckets.map(b => (
            <div key={b.label} style={{ fontFamily: "monospace", fontSize: 9, color: "#555" }}>
              {b.label} <span style={{ color: b.cnt ? "#aaa" : "#333" }}>n={b.cnt}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Ticker table */}
      <div style={cardStyle}>
        <div style={labelStyle}>Ticker detail</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 10 }}>
          <thead>
            <tr>{["Ticker","Trades","Win %","Avg profit","Avg prem"].map(h => (
              <th key={h} style={{ textAlign: "left", color: th("#3a4050","#8a7e74"), fontSize: 9, padding: "3px 6px", borderBottom: "1px solid #1c2128" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {byTicker.map(e => (
              <tr key={e.stock}>
                <td style={{ padding: "4px 6px", color: "#00ff88" }}>{e.stock}</td>
                <td style={{ padding: "4px 6px", color: "#aaa" }}>{e.total}</td>
                <td style={{ padding: "4px 6px", color: e.wr >= 50 ? "#00ff88" : "#ff4444" }}>{e.wr.toFixed(0)}%</td>
                <td style={{ padding: "4px 6px", color: e.profitSum / e.total >= 0.5 ? "#00ff88" : "#ff4444" }}>{(e.profitSum / e.total * 100).toFixed(1)}%</td>
                <td style={{ padding: "4px 6px", color: "#aaa" }}>${Math.round(e.premSum / e.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Factor coverage table */}
      {factorStats.length > 0 && (
        <div style={cardStyle}>
          <div style={labelStyle}>Factor coverage — scoring_factor_values</div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontFamily:"monospace", fontSize:10 }}>
            <thead>
              <tr>{["Factor","Signals","Avg","Median","Min","Max"].map(h => (
                <th key={h} style={{ textAlign:"left", color:th("#3a4050","#8a7e74"), fontSize:9, padding:"3px 8px", borderBottom:"1px solid #1c2128" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {factorStats.map(f => {
                const fmt = v => {
                  if (v == null) return "—";
                  if (Number.isInteger(v) || Math.abs(v) >= 100) return v.toFixed(1);
                  return v.toFixed(3);
                };
                // Coverage bar width — relative to max count
                const maxCount = factorStats[0]?.count || 1;
                const barW = Math.round(f.count / maxCount * 100);
                return (
                  <tr key={f.name} style={{ borderBottom:"1px solid #0d1117" }}>
                    <td style={{ padding:"4px 8px", color:"#00ff88" }}>{f.name}</td>
                    <td style={{ padding:"4px 8px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <div style={{ width:50, height:4, background:th("#1c2128","#b8a898"), borderRadius:2, overflow:"hidden" }}>
                          <div style={{ width:`${barW}%`, height:"100%", background:"#185FA5", borderRadius:2 }} />
                        </div>
                        <span style={{ color:"#aaa" }}>{f.count}</span>
                      </div>
                    </td>
                    <td style={{ padding:"4px 8px", color:"#aaa" }}>{fmt(f.avg)}</td>
                    <td style={{ padding:"4px 8px", color:"#aaa" }}>{fmt(f.median)}</td>
                    <td style={{ padding:"4px 8px", color:"#555" }}>{fmt(f.min)}</td>
                    <td style={{ padding:"4px 8px", color:"#555" }}>{fmt(f.max)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop:6, fontFamily:"monospace", fontSize:9, color:th("#3a4050","#8a7e74") }}>
            {factorValues.length} total rows · {new Set(factorValues.map(f => f.signal_id)).size} unique signals
          </div>
        </div>
      )}

      {/* Ask SAGE button */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={askSage}
          disabled={aiLoading}
          style={{ fontFamily: "monospace", fontSize: 10, background: th("#0d1117","#f5f0e8"), border: "1px solid #00ff88", borderRadius: 4, color: "#00ff88", padding: "6px 14px", cursor: aiLoading ? "default" : "pointer", opacity: aiLoading ? 0.5 : 1 }}
        >
          {aiLoading ? "asking sage..." : "◈ recommend factor weights"}
        </button>
        {aiResult && (
          <div style={{ marginTop: 10, background: th("#0d1117","#f5f0e8"), border: "1px solid #1c2128", borderRadius: 6, padding: "10px 14px", fontFamily: "monospace", fontSize: 10, color: "#aaa", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {aiResult}
          </div>
        )}
      </div>
    </div>
  );
}

function SignalLogTab({ supabase }) {
  const [signals,      setSignals]      = useState([]);
  const [anomalies,    setAnomalies]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [filter,       setFilter]       = useState("all");
  const [pushedFilt,   setPushedFilt]   = useState("all");
  const [expanded,     setExpanded]     = useState(null);
  const [decNotes,     setDecNotes]     = useState("");
  const [decReason,    setDecReason]    = useState("");
  const [saved,        setSaved]        = useState({});
  const [contracts,    setContracts]    = useState([]);
  const [reasons,      setReasons]      = useState([]);
  const [showAddReason,setShowAddReason]= useState(false);
  const [newReason,    setNewReason]    = useState({ reason: "", description: "", action: "" });
  const [factorMap,      setFactorMap]      = useState({}); // { signalId: { factorName: value } }
  const [factorLoading,  setFactorLoading]  = useState({});  // { signalId: true }
  const [feedback,       setFeedback]       = useState({}); // { signalId: 'good'|'bad' }
  const [dismissReason,  setDismissReason]  = useState(""); // quick-pick dismiss reason for current expanded signal

  const loadFactors = async (signalId) => {
    if (!signalId || factorMap[signalId]) return;
    setFactorLoading(p => ({ ...p, [signalId]: true }));
    const { data } = await supabase
      .from("scoring_factor_values")
      .select("factor_name,value")
      .eq("signal_id", signalId);
    const map = {};
    (data || []).forEach(r => { map[r.factor_name] = r.value; });
    setFactorMap(p => ({ ...p, [signalId]: map }));
    setFactorLoading(p => ({ ...p, [signalId]: false }));
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from("signal_log").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("import_anomalies").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("contracts").select("id,stock,opt_type,type,strike,expires,qty,account,status").eq("status","Open"),
      supabase.from("decision_log").select("signal_id,decision").order("created_at", { ascending: false }).then(r => r).catch(() => ({ data: [] })),
      supabase.from("signal_reasons").select("*").order("reason", { ascending: true }).then(r => r).catch(() => ({ data: [] })),
      supabase.from("signal_outcomes").select("signal_id,signal_quality,feedback_at").not("signal_quality","is",null).limit(200).then(r=>r).catch(()=>({data:[]})),
    ]).then(([{ data: sl, error: e1 }, { data: ia, error: e2 }, { data: cx }, { data: dl }, { data: rs }, { data: fb }]) => {
      if (e1) console.warn("[signal_log] fetch error:", e1.message);
      if (e2) console.warn("[import_anomalies] fetch error:", e2.message);
      setSignals(sl || []);
      setAnomalies((ia || []).map(a => ({
        ...a,
        _source: a.opt_type ? "committed" : "anomaly",
        signal_type: a.opt_type ? "committed" : "anomaly",
        symbol: a.stock,
        pushed: !!a.opt_type,
      })));
      setContracts(cx || []);
      // Seed saved state from DB — keyed by source_id so UI shows correct state on load
      const savedMap = {};
      (dl || []).forEach(d => { if (d.signal_id) savedMap[String(d.signal_id)] = d.decision; });
      setSaved(savedMap);
      setReasons(rs || []);
      const fbMap = {};
      (fb || []).forEach(r => { if (r.signal_id) fbMap[String(r.signal_id)] = r.signal_quality; });
      setFeedback(fbMap);
      setLoading(false);
    }).catch(err => {
      console.error("[SignalLogTab] fetch failed:", err);
      setLoading(false);
    });
  }, []);

  // Merge + sort all rows newest first
  const allRows = useMemo(() => {
    const combined = [
      ...signals.map(s => ({ ...s, _source: "signal_log" })),
      ...anomalies,
    ];
    return combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [signals, anomalies]);

  const filtered = useMemo(() => {
    return allRows.filter(s => {
      const typeMatch = filter === "all" ? true
        : filter === "sto"       ? (s.signal_type === "sto_suggestion" || s.signal_type === "sto_auto")
        : filter === "committed" ? s.signal_type === "committed"
        : filter === "anomaly"   ? s.signal_type === "anomaly"
        : true;
      const pushedMatch = pushedFilt === "all" ? true
        : pushedFilt === "pushed"     ? s.pushed === true
        : pushedFilt === "suppressed" ? s.pushed === false
        : true;
      return typeMatch && pushedMatch;
    });
  }, [allRows, filter, pushedFilt]);

  const counts = useMemo(() => ({
    sto:       allRows.filter(s => s.signal_type === "sto_suggestion" || s.signal_type === "sto_auto").length,
    committed: allRows.filter(s => s.signal_type === "committed").length,
    anomaly:   allRows.filter(s => s.signal_type === "anomaly").length,
  }), [allRows]);

  const typeColor = t => ({ sto_suggestion:"#ffd166", sto_auto:"#3fb950", committed:"#00ff88", anomaly:"#ff4560", close_now:"#00ff88", approaching:"#58a6ff", itm_warning:"#ff4560" })[t] || "#888";
  const typeLabel = t => ({ sto_suggestion:"STO", sto_auto:"🤖 AUTO-STO", committed:"COMMITTED", anomaly:"ANOMALY", close_now:"CLOSE NOW", approaching:"APPROACHING", itm_warning:"ITM ⚠" })[t] || t;
  const fmt$  = v => v != null ? "$" + (+v).toLocaleString("en-US", { minimumFractionDigits:0, maximumFractionDigits:0 }) : "—";
  const fmtPct = v => v != null ? (+v).toFixed(1) + "%" : "—";

  const openContracts = useMemo(() =>
    contracts.filter(c => c.status === "Open"),
  [contracts]);

  const contractsForSymbol = sym => openContracts.filter(c => c.stock === sym);

  const saveDecision = async (s, decision) => {
    const notes    = decNotes;
    const reasonId = decReason || null;
    const signalId = s._source === "signal_log" ? s.id : null;
    const row = {
      signal_id:    signalId,
      source_table: s._source,
      source_id:    s.id,
      decision,
      notes,
      reason_id:    reasonId,
      created_at:   new Date().toISOString()
    };
    console.log("[decision_log] attempting insert:", row);
    const { data, error } = await supabase.from("decision_log").insert(row).select();
    console.log("[decision_log] result:", { data, error });
    if (error) { alert("Save failed: " + error.message + "\n\nDetails: " + JSON.stringify(error)); return; }
    setSaved(p => ({ ...p, [String(s.id)]: decision }));
    // Save dismissed_reason to signal_outcomes when passing
    if (decision === "passed" && dismissReason && s._source === "signal_log") {
      await supabase.from("signal_outcomes").upsert(
        { signal_id: s.id, dismissed_reason: dismissReason, signal_quality: "bad", feedback_at: new Date().toISOString() },
        { onConflict: "signal_id" }
      ).catch(e => console.warn("[signal_outcomes] dismissed_reason save failed:", e.message));
    }
    setExpanded(null);
    setDecNotes("");
    setDecReason("");
    setDismissReason("");
  };

  const addReason = async () => {
    if (!newReason.reason.trim()) return;
    const { data, error } = await supabase.from("signal_reasons").insert({
      reason:      newReason.reason.trim(),
      description: newReason.description.trim() || null,
      action:      newReason.action.trim() || null,
      created_at:  new Date().toISOString(),
    }).select();
    if (error) { alert("Failed to add reason: " + error.message); return; }
    setReasons(p => [...p, ...(data || [])].sort((a,b) => a.reason.localeCompare(b.reason)));
    setNewReason({ reason: "", description: "", action: "" });
    setShowAddReason(false);
  };

  const filterBtn = (key, label, count) => (
    <button key={key} onClick={() => setFilter(key)} style={{background: filter===key ? th("#1c2128","#b8a898") : "transparent", border:"1px solid " + (filter===key ? th("#30363d","#c0b0a0") : "transparent"), borderRadius:4, padding:"2px 7px", fontSize:8, fontFamily:"monospace", color: filter===key ? th("#e6edf3","#0d0d0b") : "#555", cursor:"pointer"}}>
      {label}{count != null ? <span style={{marginLeft:4,color:th("#3a4050","#8a7e74")}}>{count}</span> : null}
    </button>
  );

  return (
    <div style={{padding:"0 4px"}}>
      {/* Filter bar */}
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
        <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginRight:2}}>SIGNAL LOG</span>
        {filterBtn("all",   "ALL",       null)}
        {filterBtn("sto",   "STO",       counts.sto)}
        {filterBtn("committed","COMMITTED",counts.committed)}
        {filterBtn("anomaly",  "ANOMALY",  counts.anomaly)}
        <span style={{marginLeft:8,fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74")}}>|</span>
        {["all","pushed","suppressed"].map(p => (
          <button key={p} onClick={() => setPushedFilt(p)} style={{background: pushedFilt===p ? th("#1c2128","#b8a898") : "transparent", border:"1px solid " + (pushedFilt===p ? th("#30363d","#c0b0a0") : "transparent"), borderRadius:4, padding:"2px 7px", fontSize:8, fontFamily:"monospace", color: pushedFilt===p ? th("#e6edf3","#0d0d0b") : "#555", cursor:"pointer"}}>
            {p === "all" ? "ALL PUSH" : p === "pushed" ? "✓ PUSHED" : "✗ SUPPRESSED"}
          </button>
        ))}
        <span style={{marginLeft:"auto",fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74")}}>{filtered.length} rows</span>
        <button onClick={() => setShowAddReason(p => !p)}
          style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",color:th("#3a4050","#8a7e74"),cursor:"pointer"}}>
          {showAddReason ? "cancel" : "+ reason"}
        </button>
      </div>

      {/* ── Add Reason form ── */}
      {showAddReason && (
        <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:6,padding:"12px 14px",marginBottom:10}}>
          <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em",marginBottom:8}}>ADD REASON</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div style={{flex:"1 1 120px"}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>REASON *</div>
              <input value={newReason.reason} onChange={e=>setNewReason(p=>({...p,reason:e.target.value}))}
                placeholder="e.g. Too Early"
                style={{width:"100%",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),boxSizing:"border-box"}} />
            </div>
            <div style={{flex:"2 1 200px"}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>DESCRIPTION</div>
              <input value={newReason.description} onChange={e=>setNewReason(p=>({...p,description:e.target.value}))}
                placeholder="e.g. Signal fired before market settled"
                style={{width:"100%",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),boxSizing:"border-box"}} />
            </div>
            <div style={{flex:"1 1 160px"}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:3}}>ACTION</div>
              <input value={newReason.action} onChange={e=>setNewReason(p=>({...p,action:e.target.value}))}
                placeholder="e.g. Adjust timing"
                style={{width:"100%",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),boxSizing:"border-box"}} />
            </div>
            <button onClick={addReason}
              style={{background:"#00ff8820",border:"1px solid #00ff8840",borderRadius:4,padding:"5px 14px",fontSize:11,fontFamily:"monospace",color:"#00ff88",cursor:"pointer",whiteSpace:"nowrap"}}>
              ADD
            </button>
          </div>
          {reasons.length > 0 && (
            <div style={{marginTop:10,display:"flex",gap:6,flexWrap:"wrap"}}>
              {reasons.map(r => (
                <span key={r.id} style={{fontFamily:"monospace",fontSize:9,background:th("#1c2128","#b8a898"),borderRadius:3,padding:"2px 8px",color:th("#8b949e","#5a5248")}}
                  title={[r.description, r.action ? "Action: "+r.action : ""].filter(Boolean).join(" · ")}>
                  {r.reason}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div style={{color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:11,padding:20}}>Loading...</div>
      ) : (
        <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{borderBottom:"1px solid #1c2128"}}>
              {["Time","Type","Symbol","Account","Price","Chg%","VIX","Strike","Exp","DTE","OTM%","Qty","Est$","Profit%","Pushed",""].map(h => (
                <th key={h} style={{padding:"7px 10px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={16} style={{padding:20,textAlign:"center",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:12}}>No signals yet</td></tr>
              )}
              {filtered.map(s => (
                <Fragment key={s.id}>
                  <tr style={{borderTop:"1px solid #0d1117", background: expanded===s.id ? "#0d1a0d" : "transparent"}}>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#555",whiteSpace:"nowrap"}}>{s.created_at ? new Date(s.created_at).toLocaleString("en-US", { timeZone:"America/New_York", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).replace(",","") : "—"}</td>
                    <td style={{padding:"7px 10px"}}><span style={{fontFamily:"monospace",fontSize:11,fontWeight:700,color:typeColor(s.signal_type)}}>{typeLabel(s.signal_type)}</span></td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:th("#e6edf3","#0d0d0b"),fontSize:13}}>{s.symbol}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#555"}}>{s.account}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:th("#c9d1d9","#1a1a18")}}>{s.stock_price != null ? "$" + (+s.stock_price).toFixed(2) : "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color: s.change_pct >= 0 ? "#00ff88" : "#ff4560"}}>{s.change_pct != null ? (s.change_pct >= 0 ? "+" : "") + (+s.change_pct).toFixed(2) + "%" : "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#888"}}>{s.vix != null ? (+s.vix).toFixed(1) : "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:th("#c9d1d9","#1a1a18")}}>{s.strike ? "$" + s.strike : "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#555",whiteSpace:"nowrap"}}>{s.expires || "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#888"}}>{s.dte ?? "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#888"}}>{fmtPct(s.otm_pct)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#888"}}>{s.suggested_qty ?? s.qty ?? "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color:"#ffd166"}}>{fmt$(s.est_premium ?? s.premium)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color: s.profit_pct_at_signal >= 0.6 ? "#00ff88" : "#888"}}>{s.profit_pct_at_signal != null ? (s.profit_pct_at_signal * 100).toFixed(0) + "%" : "—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"monospace",fontSize:11,color: s.pushed ? "#00ff88" : "#ff4560"}}>{s.pushed ? "✓" : "✗"}</td>
                    <td style={{padding:"7px 10px"}}>
                      <div style={{display:"flex",gap:4,alignItems:"center"}}>
                        {/* Thumbs up/down feedback */}
                        {s._source === "signal_log" && (
                          <>
                            <button title="Good signal" onClick={async()=>{
                              const q = "good";
                              const { error } = await supabase.from("signal_outcomes").upsert({ signal_id: s.id, signal_quality: q, feedback_at: new Date().toISOString() }, { onConflict: "signal_id" });
                              if (!error) setFeedback(p=>({...p,[String(s.id)]:q}));
                            }} style={{background: feedback[String(s.id)]==="good" ? "#00ff8825" : "transparent", border:"1px solid "+(feedback[String(s.id)]==="good"?"#00ff8860":th("#1c2128","#b8a898")), borderRadius:3, padding:"2px 5px", fontSize:12, cursor:"pointer", lineHeight:1}}>👍</button>
                            <button title="Bad signal" onClick={async()=>{
                              const q = "bad";
                              const { error } = await supabase.from("signal_outcomes").upsert({ signal_id: s.id, signal_quality: q, feedback_at: new Date().toISOString() }, { onConflict: "signal_id" });
                              if (!error) setFeedback(p=>({...p,[String(s.id)]:q}));
                            }} style={{background: feedback[String(s.id)]==="bad" ? "#ff456025" : "transparent", border:"1px solid "+(feedback[String(s.id)]==="bad"?"#ff456060":th("#1c2128","#b8a898")), borderRadius:3, padding:"2px 5px", fontSize:12, cursor:"pointer", lineHeight:1}}>👎</button>
                          </>
                        )}
                        {saved[String(s.id)] ? (
                          <span style={{fontFamily:"monospace",fontSize:11,color:th("#3a4050","#8a7e74")}}>✓ {saved[String(s.id)]}</span>
                        ) : (
                          <button onClick={() => {
                            const newExp = expanded === s.id ? null : s.id;
                            setExpanded(newExp);
                            setDecNotes("");
                            if (newExp && s._source === "signal_log") loadFactors(s.id);
                          }}
                            style={{background:"transparent",border:"1px solid #1c2128",borderRadius:3,padding:"3px 10px",fontSize:11,fontFamily:"monospace",color:th("#3a4050","#8a7e74"),cursor:"pointer",whiteSpace:"nowrap"}}>
                            {expanded === s.id ? "cancel" : "log"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === s.id && (
                    <tr style={{borderTop:"none"}}>
                      <td colSpan={16} style={{padding:"0 10px 12px 10px",background:"#0d1a0d"}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",paddingTop:10}}>
                          {["traded","passed","partial"].map(d => (
                            <button key={d} onClick={() => saveDecision(s, d)}
                              style={{background:"transparent",border:"1px solid " + (d==="passed" ? "#ff456040" : "#00ff8830"),borderRadius:4,padding:"5px 14px",fontSize:11,fontFamily:"monospace",color: d==="passed" ? "#ff4560" : "#00ff88",cursor:"pointer",textTransform:"uppercase",letterSpacing:"0.05em"}}>
                              {d}
                            </button>
                          ))}
                          {/* Quick dismiss reason — shown when "passed" is about to be clicked */}
                          <select value={dismissReason} onChange={e => setDismissReason(e.target.value)}
                            style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ff456030",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color:dismissReason?"#ff4560":"#555"}}>
                            <option value="">dismiss reason (optional)</option>
                            {["Too risky","Wrong timing","Already positioned","Low premium","Other"].map(r=>(
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                          {/* Reason dropdown */}
                          <select value={decReason} onChange={e => { setDecReason(e.target.value); if (e.target.value !== "other") setDecNotes(""); }}
                            style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color: decReason ? th("#c9d1d9","#1a1a18") : "#555"}}>
                            <option value="">reason (optional)</option>
                            {reasons.map(r => (
                              <option key={r.id} value={String(r.id)} title={r.action ? "Action: "+r.action : ""}>{r.reason}</option>
                            ))}
                            <option value="other">Other...</option>
                          </select>
                          {/* Notes — always shown for "other", optional otherwise */}
                          <input value={decNotes} onChange={e => setDecNotes(e.target.value)}
                            placeholder={decReason === "other" ? "describe reason..." : "notes (optional)..."}
                            style={{flex:1,minWidth:140,background:th("#0a0e14","#f8f3eb"),border:"1px solid " + (decReason==="other" ? "#ffd16660" : th("#1c2128","#b8a898")),borderRadius:4,padding:"5px 10px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18")}} />
                          {s.signal_type === "sto_suggestion" && contractsForSymbol(s.symbol).length > 0 && (
                            <select style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:4,padding:"5px 8px",fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18")}}>
                              <option value="">link contract (optional)</option>
                              {contractsForSymbol(s.symbol).map(c => (
                                <option key={c.id} value={c.id}>{c.stock} ${c.strike} {c.type} {c.expires} ×{c.qty} ({c.account})</option>
                              ))}
                            </select>
                          )}
                        </div>
                        {/* Factor values panel */}
                        {s._source === "signal_log" && (() => {
                          const factors = factorMap[s.id];
                          const isLoading = factorLoading[s.id];
                          if (isLoading) return <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),paddingTop:8}}>loading factors...</div>;
                          if (!factors || !Object.keys(factors).length) return (
                            <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),paddingTop:8}}>no factor data for this signal</div>
                          );
                          // Factor display config: label, color fn, format fn
                          const FACTOR_DISPLAY = {
                            change_pct:         { label:"Chg%",      fmt: v => (v>=0?"+":"")+v.toFixed(2)+"%", color: v => v>=0?"#00ff88":"#ff4560" },
                            vix:                { label:"VIX",       fmt: v => v.toFixed(1),                   color: v => v>25?"#ff4560":v>20?"#ffd166":"#888" },
                            rsi_14:             { label:"RSI-14",    fmt: v => v.toFixed(1),                   color: v => v>70?"#ff4560":v<30?"#00ff88":"#888" },
                            iv_pct:             { label:"IV%",       fmt: v => v.toFixed(1)+"%",               color: v => v>80?"#00ff88":v>50?"#ffd166":"#888" },
                            dte:                { label:"DTE",       fmt: v => v.toFixed(0)+"d",               color: () => "#888" },
                            otm_pct:            { label:"OTM%",      fmt: v => v.toFixed(1)+"%",               color: () => "#888" },
                            bb_pct_b:           { label:"%B",        fmt: v => v.toFixed(2),                   color: v => v>0.8?"#ff4560":v<0.2?"#00ff88":"#888" },
                            bb_width:           { label:"BB Width",  fmt: v => v.toFixed(1)+"%",               color: () => "#888" },
                            bb_position:        { label:"BB Pos",    fmt: v => v===1?"upper":v===-1?"lower":"mid", color: v => v===1?"#ff4560":v===-1?"#00ff88":"#888" },
                            gap_flag:           { label:"Gap",       fmt: v => v?"YES":"no",                   color: v => v?"#ffd166":"#555" },
                            gap_pct:            { label:"Gap%",      fmt: v => (v>=0?"+":"")+v.toFixed(2)+"%", color: v => Math.abs(v)>1?"#ffd166":"#555" },
                            fib_level:          { label:"Fib Lvl",   fmt: v => (v*100).toFixed(1)+"%",         color: () => "#8338ec" },
                            fib_proximity_pct:  { label:"Fib Prox",  fmt: v => "±"+v.toFixed(1)+"%",          color: v => v<1?"#ffd166":"#888" },
                            fib_near_resistance:{ label:"Fib Res",   fmt: v => v?"✓":"",                      color: () => "#00ff88" },
                            fib_near_support:   { label:"Fib Sup",   fmt: v => v?"✓":"",                      color: () => "#ff4560" },
                            fib_broke_below:    { label:"Broke↓",    fmt: v => v?"✓":"",                      color: () => "#ff4560" },
                            pullback_from_high: { label:"Pullback",  fmt: v => v.toFixed(1)+"%",               color: () => "#888" },
                            time_of_day:        { label:"Time",      fmt: v => { const h=Math.floor(v/60),m=v%60; return `${h}:${String(m).padStart(2,"0")}`; }, color: () => "#555" },
                          };
                          return (
                            <div style={{marginTop:10,padding:"8px 10px",background:"#070b0f",border:"1px solid #1c2128",borderRadius:4}}>
                              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:6}}>SAGE FACTORS</div>
                              <div style={{display:"flex",flexWrap:"wrap",gap:"6px 16px"}}>
                                {Object.entries(factors).map(([key, val]) => {
                                  if (val == null) return null;
                                  const cfg = FACTOR_DISPLAY[key];
                                  if (!cfg) return null;
                                  const display = cfg.fmt(val);
                                  if (!display) return null;
                                  return (
                                    <div key={key} style={{display:"flex",flexDirection:"column",gap:1}}>
                                      <span style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>{cfg.label}</span>
                                      <span style={{fontFamily:"monospace",fontSize:11,color:cfg.color(val)}}>{display}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                        {/* Show selected reason's action as a hint */}
                        {decReason && decReason !== "other" && (() => {
                          const r = reasons.find(r => String(r.id) === decReason);
                          return r?.action ? (
                            <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),paddingTop:6,paddingLeft:2}}>
                              suggested action: <span style={{color:"#ffd166"}}>{r.action}</span>
                            </div>
                          ) : null;
                        })()}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}



// ── Options Chain Component (inlined) ─────────────────────────
// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:       "#080b10",
  surface:  th("#0d1117","#f5f0e8"),
  card:     "#111620",
  border:   "#1a2030",
  border2:  "#242e40",
  green:    "#00e676",
  red:      "#ff4444",
  blue:     "#4fc3f7",
  yellow:   "#ffd54f",
  purple:   "#ce93d8",
  muted:    "#546e7a",
  text:     "#eceff1",
  dim:      "#37474f",
  font:     "'JetBrains Mono', 'Fira Code', monospace",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Syne:wght@400;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${T.bg}; color: ${T.text}; font-family: ${T.font}; }
  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-track { background: ${T.bg}; }
  ::-webkit-scrollbar-thumb { background: ${T.border2}; border-radius: 3px; }
  input { font-family: ${T.font}; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .fade-in { animation: fadeIn 0.2s ease forwards; }
  .expiry-row { transition: background 0.12s; cursor: pointer; }
  .expiry-row:hover { background: #151e2a !important; }
  .strike-row { transition: background 0.08s; }
  .strike-row:hover { background: #0f1620 !important; }
  @media (max-width: 600px) {
    .chain-table th, .chain-table td { padding: 5px 6px !important; font-size: 10px !important; }
    .hide-mobile { display: none !important; }
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (v, d=2) => v != null ? (+v).toFixed(d) : "—";
const fmtK = v => v != null ? (+v >= 1000 ? (v/1000).toFixed(0)+"k" : String(v)) : "—";
const pct  = v => v != null ? (v*100).toFixed(1)+"%" : "—";
const clr  = (v, pos=T.green, neg=T.red) => !v ? T.muted : +v >= 0 ? pos : neg;

function Spinner() {
  return <div style={{width:18,height:18,border:`2px solid ${T.border2}`,borderTopColor:T.blue,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>;
}

// ── Option row ────────────────────────────────────────────────────────────────
function OptionRow({ opt, type, stockPrice, ticker, expiry, onTrade }) {
  if (!opt) return (
    <tr className="strike-row" style={{borderBottom:`1px solid ${T.border}`}}>
      {Array(9).fill(0).map((_,i) => <td key={i} style={{padding:"7px 10px",color:T.dim,fontSize:11,textAlign:"right"}}>—</td>)}
    </tr>
  );

  const itm    = type === "Call" ? stockPrice > opt.strikePrice : stockPrice < opt.strikePrice;
  const mid    = opt.bid != null && opt.ask != null ? ((+opt.bid + +opt.ask)/2).toFixed(2) : null;
  const ivPct  = opt.volatility != null ? (opt.volatility).toFixed(1)+"%" : "—";

  const handleTrade = () => {
    if (onTrade) onTrade({ ticker, expiry, optType: type, strike: opt.strikePrice, bid: opt.bid, ask: opt.ask, mid });
  };

  return (
    <tr className="strike-row" style={{
      borderBottom: `1px solid ${T.border}`,
      background: itm ? (type==="Call" ? "#00e67608" : "#ff444408") : "transparent",
    }}>
      {/* Strike */}
      <td style={{padding:"7px 10px",fontWeight:600,color:itm?(type==="Call"?T.green:T.red):T.text,fontSize:12,textAlign:"right",fontFamily:T.font}}>
        {opt.strikePrice}
        {itm && <span style={{fontSize:8,color:itm?(type==="Call"?T.green:T.red):T.dim,marginLeft:4}}>ITM</span>}
      </td>
      <td style={{padding:"7px 10px",color:T.text,fontSize:11,textAlign:"right"}}>{fmt(opt.bid)}</td>
      <td style={{padding:"7px 10px",color:T.text,fontSize:11,textAlign:"right"}}>{fmt(opt.ask)}</td>
      <td style={{padding:"7px 10px",color:mid?T.blue:T.muted,fontSize:11,textAlign:"right"}}>{mid||"—"}</td>
      <td style={{padding:"7px 10px",color:T.muted,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmt(opt.last)}</td>
      <td style={{padding:"7px 10px",color:T.purple,fontSize:11,textAlign:"right"}} className="hide-mobile">{ivPct}</td>
      <td style={{padding:"7px 10px",color:clr(opt.delta, type==="Call"?T.green:T.red, type==="Call"?T.red:T.green),fontSize:11,textAlign:"right"}} className="hide-mobile">{fmt(opt.delta,3)}</td>
      <td style={{padding:"7px 10px",color:T.muted,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmtK(opt.totalVolume)}</td>
      <td style={{padding:"7px 10px",color:T.dim,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmtK(opt.openInterest)}</td>
      {/* Trade button */}
      <td style={{padding:"4px 8px",textAlign:"right"}}>
        <button onClick={handleTrade}
          style={{background:T.green+"22",color:T.green,border:`1px solid ${T.green}44`,borderRadius:4,padding:"3px 8px",fontSize:9,fontFamily:T.font,cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"}}>
          STO
        </button>
      </td>
    </tr>
  );
}

// ── Chain table ───────────────────────────────────────────────────────────────
function ChainTable({ calls, puts, stockPrice, showType, ticker, expiry, onTrade, strikeCount }) {
  const allStrikes = [...new Set([
    ...calls.map(o => o.strikePrice),
    ...puts.map(o => o.strikePrice),
  ])].sort((a,b) => a-b);

  // Filter to N strikes above and below ATM
  const visibleStrikes = (() => {
    if (!strikeCount || !stockPrice) return allStrikes;
    // Find the ATM index (closest strike to stock price)
    let atmIdx = 0;
    let minDiff = Infinity;
    allStrikes.forEach((s, i) => { const d = Math.abs(s - stockPrice); if (d < minDiff) { minDiff = d; atmIdx = i; } });
    const lo = Math.max(0, atmIdx - strikeCount);
    const hi = Math.min(allStrikes.length - 1, atmIdx + strikeCount);
    return allStrikes.slice(lo, hi + 1);
  })();

  const callMap = Object.fromEntries(calls.map(o => [o.strikePrice, o]));
  const putMap  = Object.fromEntries(puts.map(o  => [o.strikePrice, o]));

  const thStyle = {padding:"6px 10px",textAlign:"right",color:T.muted,fontSize:9,fontFamily:T.font,letterSpacing:"0.08em",borderBottom:`1px solid ${T.border2}`,fontWeight:400};

  const headers = ["STRIKE","BID","ASK","MID","LAST","IV","DELTA","VOL","OI",""];

  return (
    <div style={{overflowX:"auto"}}>
      <table className="chain-table" style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{background:T.surface}}>
            {headers.map((h,i) => (
              <th key={h||"trade"} style={{...thStyle, ...(i>4&&i<9?{display:"none"}:{}), ...({})}}
                className={i>=4&&i<9?"hide-mobile":""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleStrikes.map(strike => (
            <OptionRow
              key={strike}
              opt={showType==="Call" ? callMap[strike] : putMap[strike]}
              type={showType}
              stockPrice={stockPrice}
              ticker={ticker}
              expiry={expiry}
              onTrade={onTrade}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Expiry row ────────────────────────────────────────────────────────────────
function ExpiryRow({ expiry, dte, isOpen, onToggle, calls, puts, stockPrice, showType, onTypeChange, ticker, onTrade, strikeCount }) {
  const totalVol = [...calls,...puts].reduce((s,o) => s+(o.totalVolume||0), 0);
  const totalOI  = [...calls,...puts].reduce((s,o) => s+(o.openInterest||0), 0);

  const dteColor = dte <= 7 ? T.red : dte <= 14 ? T.yellow : dte <= 30 ? T.blue : T.muted;

  return (
    <div style={{borderBottom:`1px solid ${T.border}`,overflow:"hidden"}}>
      {/* Header row */}
      <div className="expiry-row fade-in"
        onClick={onToggle}
        style={{display:"flex",alignItems:"center",padding:"12px 16px",gap:12,background:isOpen?T.card:T.surface}}>
        {/* Arrow */}
        <span style={{color:T.muted,fontSize:10,width:12,transition:"transform 0.15s",transform:isOpen?"rotate(90deg)":"none",display:"inline-block"}}>▶</span>
        {/* Date */}
        <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14,color:T.text,flex:1}}>
          {new Date(expiry+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
        </span>
        {/* DTE badge */}
        <span style={{fontSize:9,fontFamily:T.font,color:dteColor,background:dteColor+"18",border:`1px solid ${dteColor}33`,borderRadius:4,padding:"2px 7px",flexShrink:0}}>
          {dte}d
        </span>
        {/* Stats */}
        <span style={{fontSize:9,color:T.muted,fontFamily:T.font,flexShrink:0}} className="hide-mobile">
          Vol {fmtK(totalVol)} · OI {fmtK(totalOI)}
        </span>
      </div>
      {/* Expanded chain */}
      {isOpen && (
        <div className="fade-in" style={{background:T.bg,borderTop:`1px solid ${T.border}`}}>
          {/* Call/Put toggle */}
          <div style={{display:"flex",gap:0,padding:"8px 16px",borderBottom:`1px solid ${T.border}`}}>
            {["Call","Put"].map(t => (
              <button key={t} onClick={e=>{e.stopPropagation();onTypeChange(t);}}
                style={{background:showType===t?(t==="Call"?T.green+"22":T.red+"22"):"transparent",
                  color:showType===t?(t==="Call"?T.green:T.red):T.muted,
                  border:`1px solid ${showType===t?(t==="Call"?T.green+"44":T.red+"44"):T.border}`,
                  borderRadius:t==="Call"?"4px 0 0 4px":"0 4px 4px 0",
                  padding:"4px 16px",fontSize:10,fontFamily:T.font,cursor:"pointer",fontWeight:600}}>
                {t}s ({t==="Call"?calls.length:puts.length})
              </button>
            ))}
          </div>
          <ChainTable calls={calls} puts={puts} stockPrice={stockPrice} showType={showType} ticker={ticker} expiry={expiry} onTrade={onTrade} strikeCount={strikeCount}/>
        </div>
      )}
    </div>
  );
}

// ── ChainOrderPanel — place new STO/BTO from options chain ──────────────────
// trade: { ticker, expiry, optType ("Call"/"Put"), strike, bid, ask, mid }
function ChainOrderPanel({ trade, onClose, onOrderPlaced }) {
  const SECRET   = "CronSecret2026!";
  const ACCOUNTS = ["Schwab", "ETrade 6917", "ETrade 8222"];

  const [account,    setAccount]    = useState(trade.account || null);
  const [optType,    setOptType]    = useState("STO");
  const [qty,        setQty]        = useState(trade.qty ?? 1);
  const [orderType,  setOrderType]  = useState("LIMIT");
  const [duration,   setDuration]   = useState("DAY");
  const [limitPrice, setLimitPrice] = useState(
    trade.limitPrice ? Math.round(parseFloat(trade.limitPrice)*100)/100
    : trade.mid      ? Math.round(parseFloat(trade.mid)*100)/100
    : null
  );
  const [preview,    setPreview]    = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(null);
  const [showRaw,    setShowRaw]    = useState(false);

  const isETrade      = account?.startsWith("ETrade");
  const previewAction = isETrade ? "etrade-preview-new" : "preview-new";
  const approveAction = isETrade ? "etrade-place-new"   : "approve-new";
  const apiBase       = `/api/schwab-orders`;
  const bid = trade.bid != null ? +trade.bid : null;
  const ask = trade.ask != null ? +trade.ask : null;
  const mid = trade.mid != null ? +trade.mid : null;

  const fetchPreview = async () => {
    if (!account) { setError("Select an account first"); return; }
    setLoading(true); setError(null); setPreview(null); setSuccess(null);
    try {
      const r = await fetch(`${apiBase}?action=${previewAction}&secret=${encodeURIComponent(SECRET)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker:      trade.ticker,
          type:        trade.optType,
          strike:      trade.strike,
          expires:     trade.expiry,
          opt_type:    optType,
          qty:         +qty,
          limit_price: orderType === "LIMIT" ? (limitPrice ?? undefined) : undefined,
          order_type:  orderType,
          duration,
          account,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Preview failed");
      if (data.livePrice?.mid != null && orderType === "LIMIT") {
        setLimitPrice(Math.round(data.livePrice.mid * 100) / 100);
      }
      setPreview(data);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const approveOrder = async (dryRun) => {
    if (!preview?.order?.id) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${apiBase}?action=${approveAction}&secret=${encodeURIComponent(SECRET)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: preview.order.id, dry_run: dryRun, limit_price: orderType === "LIMIT" ? limitPrice : undefined, order_type: orderType, duration }),
      });
      const data = await r.json();
      if (r.status === 429 && data.retryable) {
        let secs = 60;
        setError(`⏱ Rate limit — retrying in ${secs}s`);
        const cd = setInterval(()=>{ secs--; if(secs<=0){clearInterval(cd);setError(null);approveOrder(dryRun);}else{setError(`⏱ Rate limit — retrying in ${secs}s`);} }, 1000);
        setLoading(false); return;
      }
      if (!r.ok) throw new Error(data.error || "Failed");
      setSuccess(dryRun ? "✓ Dry run approved." : `✅ Order submitted to ${account}!`);
      setPreview(null);
      setTimeout(() => onOrderPlaced?.(), 1400);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  // Raw JSON payload — mirrors contracts tab close form
  const rawPayload = (() => {
    if (!trade.ticker || !trade.strike || !trade.expiry) return null;
    const instrSchwab = { STO:"SELL_TO_OPEN", BTO:"BUY_TO_OPEN" };
    const instrETrade = { STO:"SELL_OPEN",    BTO:"BUY_OPEN" };
    const expiresDate = new Date(trade.expiry);
    if (isETrade) {
      return { PreviewOrderRequest: { orderType:"OPTN", clientOrderId:"app_preview",
        Order:[{ priceType:orderType==="MARKET"?"MARKET":"LIMIT",
          ...(orderType!=="MARKET"&&limitPrice?{limitPrice}:{}),
          orderTerm:duration==="GTC"?"GOOD_UNTIL_CANCEL":"GOOD_FOR_DAY", marketSession:"REGULAR",
          Instrument:[{ Product:{ securityType:"OPTN", symbol:trade.ticker, callPut:trade.optType.toUpperCase(),
            expiryYear:expiresDate.getFullYear(), expiryMonth:expiresDate.getMonth()+1, expiryDay:expiresDate.getDate(), strikePrice:+trade.strike },
            orderAction:instrETrade[optType], quantityType:"QUANTITY", quantity:+qty }]
        }]
      }};
    }
    const osi = `${trade.ticker.toUpperCase().padEnd(6)}${trade.expiry.replace(/-/g,"").slice(2)}${trade.optType==="Call"?"C":"P"}${((+trade.strike)*1000).toFixed(0).padStart(8,"0")}`;
    return { orderType, session:"NORMAL", duration, orderStrategyType:"SINGLE",
      ...(orderType==="LIMIT"&&limitPrice?{price:(+limitPrice).toFixed(2)}:{}),
      orderLegCollection:[{ instruction:instrSchwab[optType], quantity:+qty, instrument:{symbol:osi,assetType:"OPTION"} }]
    };
  })();

  const estCost = orderType==="LIMIT" && limitPrice ? (+limitPrice)*(+qty)*100 : null;

  if (success) {
    return (
      <div style={{margin:"10px 0",background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8825",borderRadius:8,padding:13}}>
        <div style={{fontSize:13,color:"#00ff88",fontFamily:"monospace",marginBottom:8}}>{success}</div>
        <button onClick={onClose} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer"}}>Done</button>
      </div>
    );
  }

  return (
    <div style={{margin:"10px 0",background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8825",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
        <div style={{width:5,height:5,borderRadius:"50%",background:"#00ff88"}}/>
        <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em",fontWeight:700}}>
          PLACE ORDER · {trade.ticker} ${trade.strike} {trade.optType} {trade.expiry}
        </span>
        <button onClick={onClose} style={{marginLeft:"auto",background:"transparent",border:"none",color:"#555",cursor:"pointer",fontSize:14,lineHeight:1}}>✕</button>
      </div>

      {/* Controls — side/qty/order type/duration */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
        <div>
          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:4}}>SIDE</div>
          <div style={{display:"flex"}}>
            {[["STO","#00ff88"],["BTO","#c084fc"]].map(([t,col],i)=>(
              <button key={t} onClick={()=>setOptType(t)}
                style={{background:optType===t?col+"22":"transparent",color:optType===t?col:"#555",border:`1px solid ${optType===t?col+"44":th("#21262d","#c8b8a8")}`,borderRadius:i===0?"4px 0 0 4px":"0 4px 4px 0",padding:"4px 12px",fontSize:10,fontFamily:"monospace",cursor:"pointer",fontWeight:600}}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:4}}>QTY</div>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={()=>setQty(q=>Math.max(1,q-1))} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer",fontSize:14,lineHeight:1}}>−</button>
            <span style={{fontFamily:"monospace",fontSize:13,color:th("#e6edf3","#0d0d0b"),minWidth:20,textAlign:"center"}}>{qty}</span>
            <button onClick={()=>setQty(q=>Math.min(20,q+1))} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer",fontSize:14,lineHeight:1}}>+</button>
          </div>
        </div>
        {[["ORDER TYPE",["LIMIT","MARKET"],"orderType","#ffd166",setOrderType],["DURATION",[["DAY","Day"],["GTC","GTC"]],"duration","#58a6ff",setDuration]].map(([label,opts,key,color,setter])=>(
          <div key={key}>
            <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:4}}>{label}</div>
            <div style={{display:"flex"}}>
              {opts.map((o,i)=>{const[val,lbl]=Array.isArray(o)?o:[o,o];const cur=key==="orderType"?orderType:duration;return(
                <button key={val} onClick={()=>setter(val)}
                  style={{background:cur===val?color+"22":"transparent",color:cur===val?color:"#555",border:`1px solid ${cur===val?color+"44":th("#21262d","#c8b8a8")}`,borderRadius:i===0?"4px 0 0 4px":"0 4px 4px 0",padding:"4px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer"}}>{lbl}</button>
              );})}
            </div>
          </div>
        ))}
      </div>

      {/* Account */}
      <div style={{marginBottom:10}}>
        <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:5}}>ACCOUNT</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {ACCOUNTS.map(a=>(
            <button key={a} onClick={()=>{setAccount(a);setPreview(null);setError(null);}}
              style={{background:account===a?"#58a6ff22":th("#080c12","#ede8df"),color:account===a?"#58a6ff":"#555",border:`1px solid ${account===a?"#58a6ff44":th("#21262d","#c8b8a8")}`,borderRadius:5,padding:"5px 12px",fontSize:10,fontFamily:"monospace",cursor:"pointer",fontWeight:account===a?700:400}}>
              {a}
            </button>
          ))}
        </div>
      </div>

      {/* Limit price — bid/mid/ask click buttons + nudger, mirrors close form */}
      {orderType === "LIMIT" && (
        <div style={{background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:6,padding:"8px 10px",marginBottom:10}}>
          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:6}}>LIMIT PRICE</div>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            {[["Bid",bid,"#ff4560"],["Mid",mid,"#00ff88"],["Ask",ask,"#58a6ff"]].map(([lbl,val,color])=>
              val!=null && (
                <button key={lbl} onClick={()=>setLimitPrice(Math.round(val*100)/100)}
                  style={{background:limitPrice!=null&&Math.abs(limitPrice-val)<0.005?color+"22":"transparent",color,border:`1px solid ${color}44`,borderRadius:4,padding:"3px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer",fontWeight:600}}>
                  {lbl} ${val.toFixed(2)}
                </button>
              )
            )}
            <button onClick={()=>setLimitPrice(p=>Math.max(0.01,Math.round(((p||0)-0.01)*100)/100))} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer",fontSize:13,lineHeight:1}}>−</button>
            <span style={{fontFamily:"monospace",fontSize:13,color:"#ffd166",minWidth:40,textAlign:"center"}}>${(limitPrice||0).toFixed(2)}</span>
            <button onClick={()=>setLimitPrice(p=>Math.round(((p||0)+0.01)*100)/100)} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer",fontSize:13,lineHeight:1}}>+</button>
            <input type="number" step="0.01" min="0.01" value={limitPrice??""} onChange={e=>setLimitPrice(e.target.value?+e.target.value:null)}
              style={{width:64,background:th("#161b22","#ede8df"),color:"#ffd166",border:"1px solid #30363d",borderRadius:4,padding:"3px 6px",fontFamily:"monospace",fontSize:11}}/>
          </div>
        </div>
      )}

      {/* Order summary box — always visible */}
      <div style={{background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:6,padding:"8px 10px",marginBottom:10,fontFamily:"monospace",fontSize:11}}>
        <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:6}}>ORDER SUMMARY</div>
        <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
          {[
            ["Action",    `${optType} ${qty}×`,                  th("#e6edf3","#0d0d0b")],
            ["Strike",    `$${trade.strike} ${trade.optType}`,   th("#e6edf3","#0d0d0b")],
            ["Expires",   trade.expiry,                          th("#8b949e","#5a5248")],
            ["Est. Value",estCost!=null?`$${estCost.toFixed(2)}`:"—","#ffd166"],
            ["Live Mid",  preview?.livePrice?.mid!=null?`$${preview.livePrice.mid.toFixed(2)}`:(mid!=null?`$${mid.toFixed(2)}`:"—"),"#00ff88"],
          ].map(([label,val,color])=>(
            <div key={label}>
              <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>{label}</div>
              <div style={{color}}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {error && <div style={{fontSize:11,color:"#ff4560",marginBottom:8,fontFamily:"monospace"}}>⚠ {error}</div>}

      {!preview ? (
        <button onClick={fetchPreview} disabled={loading||!account}
          style={{background:account?"#ffd166":th("#21262d","#c8b8a8"),color:account?th("#010409","#f5f0e8"):th("#3a4050","#8a7e74"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:account?"pointer":"not-allowed"}}>
          {loading?"Fetching…":"Get Live Price →"}
        </button>
      ) : (
        <div>
          <div style={{fontSize:10,color:"#ffd166",fontFamily:"monospace",marginBottom:8}}>
            ⚠ Review carefully. Dry Run logs without submitting. Live submits to {account}.
          </div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            <button onClick={()=>approveOrder(true)} disabled={loading}
              style={{background:"#58a6ff22",color:"#58a6ff",border:"1px solid #58a6ff44",borderRadius:6,padding:"7px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>
              {loading?"…":"🧪 Dry Run"}
            </button>
            <button onClick={()=>approveOrder(false)} disabled={loading}
              style={{background:"#00ff8822",color:"#00ff88",border:"1px solid #00ff8844",borderRadius:6,padding:"7px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>
              {loading?"Submitting…":`✅ Submit to ${account}`}
            </button>
            <button onClick={()=>{setPreview(null);setError(null);}}
              style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer"}}>← Back</button>
            <button onClick={()=>setShowRaw(v=>!v)}
              style={{background:"transparent",color:th("#3a4050","#8a7e74"),border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>
              {showRaw?"▲ Hide":"{ } JSON"}
            </button>
          </div>
          {showRaw && rawPayload && (
            <pre style={{marginTop:8,background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:5,padding:"8px",fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace",overflowX:"auto",whiteSpace:"pre-wrap"}}>
              {JSON.stringify(rawPayload,null,2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── CatalystPanel — upcoming catalysts & research docs for a ticker ──────────
const CATALYST_IMPACT_STYLE = {
  HIGH:   { background: "#ff4d4d22", color: "#ff4d4d", border: "1px solid #ff4d4d55" },
  MEDIUM: { background: "#ffd16622", color: "#ffd166", border: "1px solid #ffd16655" },
  LOW:    { background: "#00ff8822", color: "#00ff88", border: "1px solid #00ff8855" },
};
const CATALYST_TYPE_ICON = { earnings:"📊", product:"🚀", regulatory:"⚖️", macro:"🏦", conference:"🎤" };

function useCatalysts(ticker) {
  const [catalysts, setCatalysts] = useState([]);
  const [research,  setResearch]  = useState([]);
  const [loading,   setLoading]   = useState(false);

  const refresh = async () => {
    if (!ticker) return;
    const today = new Date().toISOString().split("T")[0];
    const [catRes, resRes] = await Promise.all([
      supabase.from("ticker_catalysts").select("*").eq("ticker", ticker.toUpperCase()).gte("event_date", today).order("event_date", { ascending: true }).limit(15),
      supabase.from("ticker_research").select("id,ticker,report_type,report_date,title").eq("ticker", ticker.toUpperCase()).order("report_date", { ascending: false }).limit(8),
    ]);
    setCatalysts(catRes.data ?? []);
    setResearch(resRes.data ?? []);
  };

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [ticker]);

  return { catalysts, research, loading, refresh };
}

function CatalystPanel({ ticker }) {
  const { catalysts, research, loading, refresh } = useCatalysts(ticker);
  const [expanded,     setExpanded]     = useState(null);
  const [showResearch, setShowResearch] = useState(false);
  const [fetching,     setFetching]     = useState(false);
  const [fetchError,   setFetchError]   = useState(null);
  const [fetchMsg,     setFetchMsg]     = useState(null);

  if (!ticker) return null;

  const hasCatalysts = catalysts.length > 0;
  const hasResearch  = research.length > 0;

  const handleFetch = async () => {
    setFetching(true);
    setFetchError(null);
    setFetchMsg(null);
    try {
      const res  = await fetch("/api/claude", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: "catalyst_fetch", ticker }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Fetch failed");

      // Delete existing future catalysts for this ticker, then insert fresh batch
      const today = new Date().toISOString().split("T")[0];
      await supabase.from("ticker_catalysts").delete()
        .eq("ticker", ticker.toUpperCase()).gte("event_date", today);

      if (data.catalysts?.length) {
        const { error } = await supabase.from("ticker_catalysts").insert(data.catalysts);
        if (error) throw new Error(error.message);
      }

      setFetchMsg(`${data.catalysts?.length ?? 0} catalysts loaded`);
      await refresh();
    } catch(e) {
      setFetchError(e.message);
    } finally {
      setFetching(false);
    }
  };

  return (
    <div style={{ background:th("#0a0e14","#f8f3eb"), border:"1px solid #1c2128", borderRadius:8, padding:13 }}>
      {/* Header row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom: hasCatalysts ? 10 : 4 }}>
        <span style={{ fontFamily:"monospace", fontSize:7, color:th("#2a3040","#6b5f55"), letterSpacing:"0.08em" }}>CATALYSTS</span>
        {loading && <span style={{ fontSize:7, color:th("#3a4050","#8a7e74"), fontFamily:"monospace" }}>loading…</span>}
        {fetchMsg && <span style={{ fontSize:8, color:"#00ff88", fontFamily:"monospace" }}>{fetchMsg}</span>}
        {fetchError && <span style={{ fontSize:8, color:"#ff4560", fontFamily:"monospace" }}>{fetchError}</span>}
        <div style={{ marginLeft:"auto", display:"flex", gap:6, alignItems:"center" }}>
          {hasResearch && (
            <button onClick={() => setShowResearch(s => !s)}
              style={{ fontSize:8, fontFamily:"monospace", padding:"2px 8px", borderRadius:3, border:"none", cursor:"pointer", background: showResearch ? "#58a6ff20":th("#0d1117","#f5f0e8"), color: showResearch ? "#58a6ff":th("#3a4050","#8a7e74") }}>
              {showResearch ? "Hide Research" : `Research (${research.length})`}
            </button>
          )}
          <button onClick={handleFetch} disabled={fetching}
            style={{ fontSize:8, fontFamily:"monospace", padding:"2px 8px", borderRadius:3, border:"1px solid #58a6ff40", cursor:"pointer", background:"#58a6ff15", color: fetching ? th("#3a4050","#8a7e74"):"#58a6ff" }}>
            {fetching ? "fetching…" : hasCatalysts ? "↻ Refresh" : `+ Fetch Catalysts`}
          </button>
        </div>
      </div>

      {/* Catalyst rows */}
      {catalysts.map(c => (
        <div key={c.id} onClick={() => setExpanded(expanded === c.id ? null : c.id)}
          style={{ marginBottom:6, padding:"8px 10px", background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:6, cursor:"pointer" }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontSize:13 }}>{CATALYST_TYPE_ICON[c.event_type] ?? "📌"}</span>
            <span style={{ flex:1, fontFamily:"monospace", fontSize:10, color:th("#c9d1d9","#1a1a18"), fontWeight:500 }}>{c.event_name}</span>
            <span style={{ fontSize:8, padding:"2px 6px", borderRadius:4, fontFamily:"monospace", ...CATALYST_IMPACT_STYLE[c.impact] }}>{c.impact}</span>
            <span style={{ color:th("#3a4050","#8a7e74"), fontSize:9, fontFamily:"monospace", minWidth:75, textAlign:"right" }}>{c.event_date}</span>
          </div>
          {expanded === c.id && c.description && (
            <div style={{ marginTop:7, paddingTop:7, borderTop:"1px solid #21262d", color:th("#8b949e","#5a5248"), lineHeight:1.55, fontSize:11 }}>
              {c.description}
              {c.source && <div style={{ marginTop:4, color:"#388bfd", fontSize:10 }}>Source: {c.source}</div>}
            </div>
          )}
        </div>
      ))}

      {/* Empty state */}
      {!hasCatalysts && !loading && (
        <div style={{ fontSize:9, color:th("#3a4050","#8a7e74"), fontFamily:"monospace" }}>
          No catalysts yet — click "+ Fetch Catalysts" to generate them with AI.
        </div>
      )}

      {/* Research docs */}
      {showResearch && hasResearch && (
        <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid #1c2128" }}>
          <div style={{ fontFamily:"monospace", fontSize:7, color:th("#2a3040","#6b5f55"), letterSpacing:"0.08em", marginBottom:6 }}>RESEARCH DOCS</div>
          {research.map(r => (
            <div key={r.id} style={{ display:"flex", justifyContent:"space-between", padding:"6px 10px", background:th("#0d1117","#f5f0e8"), border:"1px solid #21262d", borderRadius:6, marginBottom:5, fontSize:10 }}>
              <span style={{ color:th("#c9d1d9","#1a1a18"), fontFamily:"monospace" }}>{r.title}</span>
              <span style={{ color:th("#3a4050","#8a7e74"), fontFamily:"monospace", whiteSpace:"nowrap", marginLeft:10 }}>{r.report_date}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── StocksChainSection — wrapper for OptionsChainComponent in Stocks tab ─────
function StocksChainSection({ selectedTicker, loadTradeOrders, pendingOrder, onPendingOrderConsumed }) {
  const [stocksChainTrade, setStocksChainTrade] = useState(null);

  // Auto-open order panel when a pendingOrder arrives from a notification deep-link
  useEffect(() => {
    if (!pendingOrder || !selectedTicker) return;
    if (pendingOrder.strike || pendingOrder.expiry) {
      setStocksChainTrade({
        ticker:   selectedTicker,
        type:     "Call",
        optType:  "STO",
        strike:   pendingOrder.strike,
        expiry:   pendingOrder.expiry,
        qty:      pendingOrder.qty   ?? 1,
        limitPrice: pendingOrder.price ?? null,
        account:  pendingOrder.account ?? null,
        fromNotification: true,
      });
      onPendingOrderConsumed?.();
    }
  }, [pendingOrder, selectedTicker]);

  return (
    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,marginTop:9}}>
      <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>OPTION CHAIN — {selectedTicker}</div>
      {/* Order panel — appears when a strike is clicked OR preloaded from notification */}
      {stocksChainTrade && stocksChainTrade.ticker === selectedTicker && (
        <div style={{padding:"0 11px 11px"}}>
          {stocksChainTrade.fromNotification && (
            <div style={{background:"#1f2937",border:"1px solid #d29922",borderRadius:6,padding:"8px 12px",marginBottom:8,fontSize:11,color:"#d29922",display:"flex",alignItems:"center",gap:8}}>
              <span>🔔</span>
              <span>Pre-loaded from SAGE signal — review and confirm before placing</span>
            </div>
          )}
          <ChainOrderPanel
            trade={stocksChainTrade}
            onClose={() => setStocksChainTrade(null)}
            onOrderPlaced={() => { setStocksChainTrade(null); loadTradeOrders?.(); }}
          />
        </div>
      )}
      <div style={{borderTop:"1px solid #1c2128"}}>
        <OptionsChainComponent
          initialTicker={selectedTicker}
          onTrade={trade => setStocksChainTrade(trade)}
          embedded={true}
        />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
function OptionsChainComponent({ initialTicker = "", onTrade = null, embedded = false }) {
  const [ticker,      setTicker]      = useState(initialTicker);
  const [inputVal,    setInputVal]    = useState(initialTicker);
  const [loading,     setLoading]     = useState(false);
  const [loadingExp,  setLoadingExp]  = useState(null); // expiry being loaded
  const [error,       setError]       = useState(null);
  const [stockPrice,  setStockPrice]  = useState(null);
  const [stockChange, setStockChange] = useState(null);
  const [expirations, setExpirations] = useState([]); // [{expiry, dte}]
  const [chains,      setChains]      = useState({}); // {expiry: {calls,puts}}
  const [openExpiry,   setOpenExpiry]  = useState(null);
  const [showType,     setShowType]    = useState("Call");
  const [strikeCount,  setStrikeCount] = useState(5); // null = all

  // ── Fetch quote + expirations ───────────────────────────────────────────────
  const fetchTicker = useCallback(async (sym) => {
    if (!sym) return;
    setTicker(sym);
    setInputVal(sym);
    setLoading(true);
    setError(null);
    setExpirations([]);
    setChains({});
    setOpenExpiry(null);
    setStockPrice(null);

    try {
      // Quote
      const qRes  = await fetch(`/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=${sym}&fields=quote&indicative=false`);
      const qData = await qRes.json();
      const q     = qData?.[sym]?.quote ?? qData?.[sym];
      if (q?.lastPrice) {
        setStockPrice(q.lastPrice);
        setStockChange({ change: q.netChange, pct: q.netPercentChange });
      }

      // Expiration chain
      const eRes  = await fetch(`/api/schwab-proxy?path=/marketdata/v1/expirationchain&symbol=${sym}`);
      const eData = await eRes.json();
      const today = new Date(); today.setHours(0,0,0,0);

      const exps = (eData?.expirationList || [])
        .map(e => {
          const d   = new Date(e.expirationDate+"T12:00:00");
          const dte = Math.ceil((d - today) / 86400000);
          return { expiry: e.expirationDate, dte, dteType: e.dteType };
        })
        .filter(e => e.dte >= 0)
        .sort((a,b) => a.dte - b.dte);

      setExpirations(exps);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch chain for a specific expiry ───────────────────────────────────────
  const fetchChain = useCallback(async (sym, expiry) => {
    if (chains[expiry]) return; // already loaded
    setLoadingExp(expiry);
    try {
      const res  = await fetch(`/api/schwab-proxy?path=/marketdata/v1/chains&symbol=${sym}&contractType=ALL&strikeCount=40&fromDate=${expiry}&toDate=${expiry}`);
      const data = await res.json();

      const calls = [], puts = [];
      for (const [, strikes] of Object.entries(data?.callExpDateMap || {}))
        for (const [, opts] of Object.entries(strikes))
          for (const o of opts) calls.push(o);
      for (const [, strikes] of Object.entries(data?.putExpDateMap || {}))
        for (const [, opts] of Object.entries(strikes))
          for (const o of opts) puts.push(o);

      calls.sort((a,b) => a.strikePrice - b.strikePrice);
      puts.sort((a,b) => a.strikePrice - b.strikePrice);

      setChains(prev => ({ ...prev, [expiry]: { calls, puts } }));
    } catch (err) {
      console.warn("Chain fetch failed:", err.message);
    } finally {
      setLoadingExp(null);
    }
  }, [chains]);

  // ── Auto-fetch if initialTicker provided ───────────────────────────────────
  useEffect(() => {
    if (initialTicker) {
      setTicker(initialTicker);
      setInputVal(initialTicker);
      fetchTicker(initialTicker);
    }
  }, [initialTicker, fetchTicker]);

  // ── Toggle expiry row ───────────────────────────────────────────────────────
  const toggleExpiry = (expiry) => {
    if (openExpiry === expiry) {
      setOpenExpiry(null);
    } else {
      setOpenExpiry(expiry);
      fetchChain(ticker, expiry);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const sym = inputVal.trim().toUpperCase();
    if (sym) { setTicker(sym); fetchTicker(sym); }
  };

  const changeDir = stockChange?.change >= 0;

  return (
    <div style={{...(embedded ? {} : {minHeight:"100vh"}),background:T.bg,color:T.text,fontFamily:T.font}}>
      {!embedded && <style>{css}</style>}

      {/* ── Header — only in standalone mode ───────────────────────────────── */}
      {!embedded && (
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"14px 20px",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:900,margin:"0 auto",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          {/* Title */}
          <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:16,color:T.blue,letterSpacing:"0.04em",flexShrink:0}}>
            OPTIONS<span style={{color:T.green}}>.</span>CHAIN
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} style={{display:"flex",gap:0,flex:1,minWidth:180,maxWidth:320}}>
            <input
              value={inputVal}
              onChange={e => setInputVal(e.target.value.toUpperCase())}
              placeholder="Enter ticker… AAPL"
              style={{flex:1,background:T.card,border:`1px solid ${T.border2}`,borderRight:"none",borderRadius:"6px 0 0 6px",color:T.text,fontFamily:T.font,fontSize:13,padding:"8px 12px",outline:"none"}}
            />
            <button type="submit"
              style={{background:T.blue+"22",border:`1px solid ${T.border2}`,borderRadius:"0 6px 6px 0",color:T.blue,fontFamily:T.font,fontSize:12,padding:"8px 14px",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"}}>
              {loading ? <Spinner/> : "→"}
            </button>
          </form>

          {/* Stock price */}
          {stockPrice && (
            <div style={{display:"flex",alignItems:"baseline",gap:8,flexShrink:0}}>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:20,color:T.text}}>${(+stockPrice).toFixed(2)}</span>
              <span style={{fontSize:11,color:changeDir?T.green:T.red,fontFamily:T.font}}>
                {changeDir?"+":""}{fmt(stockChange?.change)} ({changeDir?"+":""}{fmt(stockChange?.pct,2)}%)
              </span>
            </div>
          )}
        </div>
      </div>
      )} {/* end !embedded header */}

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div style={{...(embedded ? {} : {maxWidth:900,margin:"0 auto"})}}>
        {error && (
          <div style={{padding:"16px 20px",color:T.red,fontSize:12,borderBottom:`1px solid ${T.border}`}}>
            ⚠ {error}
          </div>
        )}

        {!ticker && !loading && (
          <div style={{padding:"80px 20px",textAlign:"center"}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:32,fontWeight:800,color:T.border2,marginBottom:12}}>Enter a ticker</div>
            <div style={{fontSize:12,color:T.dim}}>Type a stock symbol above to view its options chain</div>
          </div>
        )}

        {ticker && !loading && expirations.length === 0 && !error && (
          <div style={{padding:"40px 20px",textAlign:"center",color:T.muted,fontSize:12}}>
            No expirations found for {ticker}
          </div>
        )}

        {/* Expiry list */}
        {expirations.length > 0 && (
          <div>
            {/* Ticker header + strike filter */}
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:T.text}}>{ticker}</span>
              {stockPrice && <span style={{fontFamily:"monospace",fontSize:14,color:T.muted}}>${(+stockPrice).toFixed(2)}</span>}
              <span style={{fontSize:10,color:T.muted,fontFamily:T.font}}>{expirations.length} exp</span>
              {/* Strike count filter */}
              <div style={{display:"flex",alignItems:"center",gap:4,marginLeft:"auto",flexWrap:"wrap"}}>
                <span style={{fontSize:8,color:T.dim,fontFamily:T.font,letterSpacing:"0.06em"}}>STRIKES ±</span>
                {[3,5,7,10,null].map(n => (
                  <button key={String(n)} onClick={() => setStrikeCount(n)}
                    style={{
                      background: strikeCount===n ? T.blue+"22" : "transparent",
                      color:      strikeCount===n ? T.blue : T.dim,
                      border:     `1px solid ${strikeCount===n ? T.blue+"44" : T.border2}`,
                      borderRadius: 4, padding:"2px 8px", fontSize:9, fontFamily:T.font, cursor:"pointer", fontWeight: strikeCount===n ? 700 : 400,
                    }}>
                    {n===null ? "All" : n}
                  </button>
                ))}
              </div>
            </div>

            {expirations.map(({ expiry, dte }) => {
              const chain      = chains[expiry] || { calls: [], puts: [] };
              const isLoading  = loadingExp === expiry;
              const isOpen     = openExpiry === expiry;

              return (
                <div key={expiry}>
                  <ExpiryRow
                    expiry={expiry}
                    dte={dte}
                    isOpen={isOpen}
                    onToggle={() => toggleExpiry(expiry)}
                    calls={chain.calls}
                    puts={chain.puts}
                    stockPrice={stockPrice}
                    showType={showType}
                    onTypeChange={setShowType}
                    ticker={ticker}
                    onTrade={onTrade}
                    strikeCount={strikeCount}
                  />
                  {isLoading && (
                    <div style={{padding:"16px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:T.bg,borderBottom:`1px solid ${T.border}`}}>
                      <Spinner/>
                      <span style={{fontSize:11,color:T.muted}}>Loading {expiry}…</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────

// ─── Opportunity Scanner Tab ──────────────────────────────────────────────────
const SCAN_TICKERS = [
  "AAPL","AMZN","AMD","CAT","CEG","COST","GOOG","GOOGL","JPM","LMT","MSFT","NFLX","NVDA","OKLO","TKO","UPS","WDC",
  "TSLA","META","BAC","GS","WFC","C","MS","BX","PLTR","SMCI",
  "INTC","CSCO","MU","ORCL","CRM","XOM","CVX","OXY","SLB","HAL",
  "PFE","MRNA","JNJ","ABBV","LLY","UBER","F","GM","T","VZ",
  "DIS","BA","GE","V","AVGO"
];

const BTO_STATS = {
  AAPL:{wr:0.167,avgPrem:0.30,avgProfit:1.80,ev:0.05},ABBV:{wr:0.068,avgPrem:0.28,avgProfit:2.87,ev:-0.07},
  AMD:{wr:0.370,avgPrem:2.66,avgProfit:11.07,ev:2.42},AMZN:{wr:0.200,avgPrem:0.43,avgProfit:1.68,ev:-0.01},
  AVGO:{wr:0.239,avgPrem:2.12,avgProfit:6.30,ev:-0.11},BA:{wr:0.178,avgPrem:0.54,avgProfit:2.38,ev:-0.02},
  BAC:{wr:0.094,avgPrem:0.08,avgProfit:0.56,ev:-0.02},BX:{wr:0.178,avgPrem:0.56,avgProfit:1.26,ev:-0.24},
  C:{wr:0.163,avgPrem:0.38,avgProfit:1.81,ev:-0.03},CAT:{wr:0.239,avgPrem:2.89,avgProfit:12.17,ev:0.71},
  CEG:{wr:0.217,avgPrem:2.64,avgProfit:4.63,ev:-1.06},COST:{wr:0.074,avgPrem:0.33,avgProfit:6.30,ev:0.16},
  CRM:{wr:0.141,avgPrem:0.91,avgProfit:1.27,ev:-0.60},CSCO:{wr:0.139,avgPrem:0.26,avgProfit:1.23,ev:-0.06},
  CVX:{wr:0.103,avgPrem:0.21,avgProfit:2.26,ev:0.04},DIS:{wr:0.143,avgPrem:0.20,avgProfit:1.09,ev:-0.01},
  F:{wr:0.152,avgPrem:0.05,avgProfit:0.15,ev:-0.02},GE:{wr:0.141,avgPrem:1.18,avgProfit:6.61,ev:-0.08},
  GM:{wr:0.156,avgPrem:0.21,avgProfit:0.84,ev:-0.05},GOOG:{wr:0.134,avgPrem:0.47,avgProfit:6.35,ev:0.45},
  GOOGL:{wr:0.131,avgPrem:0.53,avgProfit:7.23,ev:0.49},GS:{wr:0.120,avgPrem:2.20,avgProfit:11.85,ev:-0.52},
  HAL:{wr:0.209,avgPrem:0.12,avgProfit:0.45,ev:-0.00},INTC:{wr:0.413,avgPrem:0.93,avgProfit:3.11,ev:0.73},
  JNJ:{wr:0.044,avgPrem:0.05,avgProfit:1.87,ev:0.03},JPM:{wr:0.059,avgPrem:0.38,avgProfit:3.47,ev:-0.16},
  LLY:{wr:0.152,avgPrem:3.88,avgProfit:24.02,ev:0.36},LMT:{wr:0.143,avgPrem:1.00,avgProfit:6.68,ev:0.10},
  META:{wr:0.078,avgPrem:2.67,avgProfit:19.84,ev:-0.92},MRNA:{wr:0.304,avgPrem:0.66,avgProfit:1.50,ev:-0.00},
  MS:{wr:0.125,avgPrem:0.40,avgProfit:2.59,ev:-0.03},MSFT:{wr:0.123,avgPrem:1.02,avgProfit:4.69,ev:-0.32},
  MU:{wr:0.500,avgPrem:6.08,avgProfit:11.79,ev:2.86},NFLX:{wr:0.099,avgPrem:0.42,avgProfit:3.79,ev:-0.00},
  NVDA:{wr:0.207,avgPrem:0.58,avgProfit:2.20,ev:-0.01},OKLO:{wr:0.348,avgPrem:1.75,avgProfit:2.22,ev:-0.37},
  ORCL:{wr:0.283,avgPrem:1.69,avgProfit:2.56,ev:-0.49},OXY:{wr:0.264,avgPrem:0.23,avgProfit:0.60,ev:-0.01},
  PFE:{wr:0.192,avgPrem:0.06,avgProfit:0.17,ev:-0.01},PLTR:{wr:0.272,avgPrem:1.30,avgProfit:0.96,ev:-0.69},
  SLB:{wr:0.200,avgPrem:0.19,avgProfit:0.70,ev:-0.01},SMCI:{wr:0.304,avgPrem:0.57,avgProfit:1.16,ev:-0.04},
  T:{wr:0.158,avgPrem:0.06,avgProfit:0.40,ev:0.01},TKO:{wr:0.092,avgPrem:0.58,avgProfit:1.74,ev:-0.37},
  TSLA:{wr:0.217,avgPrem:1.76,avgProfit:5.63,ev:-0.15},UBER:{wr:0.120,avgPrem:0.21,avgProfit:1.55,ev:0.00},
  UPS:{wr:0.120,avgPrem:0.17,avgProfit:0.90,ev:-0.04},V:{wr:0.036,avgPrem:0.33,avgProfit:6.54,ev:-0.08},
  VZ:{wr:0.190,avgPrem:0.14,avgProfit:0.46,ev:-0.03},WDC:{wr:0.402,avgPrem:4.89,avgProfit:6.05,ev:-0.49},
  WFC:{wr:0.047,avgPrem:0.16,avgProfit:0.60,ev:-0.12},XOM:{wr:0.159,avgPrem:0.25,avgProfit:1.56,ev:0.04},
};

const TICKER_TIERS_SC = {
  COST:"safe",JPM:"safe",NFLX:"safe",TKO:"safe",MSFT:"safe",UPS:"safe",
  AAPL:"safe",GOOG:"safe",GOOGL:"safe",LMT:"safe",AMZN:"safe",
  JNJ:"safe",WFC:"safe",BAC:"safe",META:"safe",ABBV:"safe",CVX:"safe",
  V:"safe",GS:"safe",CRM:"safe",BX:"safe",T:"safe",XOM:"safe",
  NVDA:"watch",CAT:"watch",CEG:"watch",AVGO:"watch",GE:"watch",
  DIS:"watch",BA:"watch",C:"watch",MS:"watch",CSCO:"watch",
  PFE:"watch",UBER:"watch",GM:"watch",HAL:"watch",SLB:"watch",
  OXY:"watch",LLY:"watch",F:"watch",VZ:"watch",
  AMD:"high_risk",OKLO:"high_risk",WDC:"high_risk",MU:"high_risk",
  INTC:"high_risk",SMCI:"high_risk",MRNA:"high_risk",PLTR:"high_risk",
  TSLA:"high_risk",ORCL:"high_risk",
};

function OpportunityScannerTab() {
  const [scanning,       setScanning]       = useState(false);
  const [phase,          setPhase]          = useState(null);
  const [currentTicker,  setCurrentTicker]  = useState(null);
  const [scanIndex,      setScanIndex]      = useState(0);
  const [scanTotal,      setScanTotal]      = useState(SCAN_TICKERS.length);
  const [cycleCount,     setCycleCount]     = useState(0);
  const [opportunities,  setOpportunities]  = useState([]);
  const [expandedOpp,    setExpandedOpp]    = useState(null);
  const [scanLog,        setScanLog]        = useState([]);
  const [lastScan,       setLastScan]       = useState(null);
  const [scannedTickers, setScannedTickers] = useState([]);
  const [chainStatus,    setChainStatus]    = useState({});
  const [customTicker,   setCustomTicker]   = useState("");
  const [customScanning, setCustomScanning] = useState(false);
  const scanningRef    = useRef(false);
  const logRef         = useRef(null);
  const tickerStripRef = useRef(null);

  const QUOTE_BATCH = 5;
  const BATCH_DELAY = 1500;
  const TICK_DELAY  = 500;
  const CHAIN_DELAY = 800;

  const addLog = (msg, type="info") => {
    const ts = new Date().toLocaleTimeString();
    setScanLog(prev => [{ts, msg, type}, ...prev].slice(0, 100));
  };

  function nextMWFExpiries(n=2) {
    const dates=[]; const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+1);
    while(dates.length<n){const dow=d.getDay();if(dow===1||dow===3||dow===5)dates.push(d.toISOString().slice(0,10));d.setDate(d.getDate()+1);}
    return dates;
  }

  function stoRiskScore(ticker, changePct) {
    const tier=TICKER_TIERS_SC[ticker]||"watch"; const flags=[];
    if(tier==="high_risk")             flags.push({name:"High Risk Ticker",sev:3});
    if(tier==="watch")                 flags.push({name:"Watch Tier",sev:2});
    if(changePct<-2)                   flags.push({name:"Big Down >2%",sev:3});
    if(changePct>3)                    flags.push({name:"Big Up >3%",sev:3});
    if(changePct>=-2&&changePct<0)     flags.push({name:"Mild Down",sev:1});
    if(tier==="safe")                  flags.push({name:"Safe Tier",sev:-1});
    if(changePct>=0&&changePct<=2)     flags.push({name:"Sweet Spot",sev:-1});
    return {score:flags.reduce((s,f)=>s+f.sev,0), tier, flags};
  }

  function rankOptions(opts, stockPrice, type) {
    return opts
      .filter(o=>o.bid>0.05&&o.ask>0&&o.openInterest>0)
      .map(o=>{
        const mid=(o.bid+o.ask)/2;
        const otmPct=Math.abs(o.strike-stockPrice)/stockPrice*100;
        const spread=o.ask-o.bid;
        const spreadPct=mid>0?spread/mid:99;
        const today=new Date();today.setHours(0,0,0,0);
        const exp=new Date(o.expiryDate+"T12:00:00");
        const dte=Math.round((exp-today)/86400000);
        const stoScore=dte>0&&otmPct>0?(mid/(otmPct*Math.sqrt(dte)))*(1-Math.min(spreadPct,1)*0.5):0;
        const btoStat=BTO_STATS[o.ticker];
        const btoScore=btoStat&&mid>0?(btoStat.wr*btoStat.avgProfit)/mid:0;
        return {...o,mid,otmPct,dte,spreadPct,stoScore,btoScore};
      })
      .filter(o=>o.spreadPct<0.5)
      .sort((a,b)=>type==="STO"?b.stoScore-a.stoScore:b.btoScore-a.btoScore)
      .slice(0,3);
  }

  async function fetchChainForOpp(opp) {
    const expiries=nextMWFExpiries(2);
    try {
      const calls=[];
      for(const expiry of expiries){
        if(!scanningRef.current&&!customScanning)break;
        const res=await fetch(`/api/schwab-proxy?path=/marketdata/v1/chains&symbol=${opp.ticker}&contractType=ALL&strikeCount=20&fromDate=${expiry}&toDate=${expiry}`);
        const data=await res.json();
        for(const[,strikes]of Object.entries(data?.callExpDateMap||{}))
          for(const[,opts]of Object.entries(strikes))
            for(const o of opts)calls.push({...o,expiryDate:expiry,ticker:opp.ticker,strike:o.strikePrice,bid:o.bid,ask:o.ask,iv:o.volatility,delta:o.delta,openInterest:o.openInterest,volume:o.totalVolume});
      }
      const stockPrice=opp.price;
      const filteredOpts=opp.type==="STO"?calls.filter(o=>o.strike>stockPrice*0.98):calls.filter(o=>o.strike>=stockPrice*0.99&&o.strike<=stockPrice*1.06);
      const ranked=rankOptions(filteredOpts,stockPrice,opp.type);
      return {...opp,chainOptions:ranked,chainFetched:true};
    } catch(e){
      addLog(`Chain fetch failed for ${opp.ticker}: ${e.message}`,"error");
      return {...opp,chainOptions:[],chainFetched:true,chainError:e.message};
    }
  }

  async function runScanCycle() {
    if(!scanningRef.current)return;
    addLog(`Cycle ${cycleCount+1} — pass 1: scanning ${SCAN_TICKERS.length} tickers`,"system");
    setPhase("quotes"); setScanTotal(SCAN_TICKERS.length);
    let vix=null;
    try{const vr=await fetch("/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=%24VIX&fields=quote");const vd=await vr.json();vix=vd?.["$VIX"]?.quote?.lastPrice??null;}catch(e){}
    const shortlist=[];
    for(let i=0;i<SCAN_TICKERS.length;i+=QUOTE_BATCH){
      if(!scanningRef.current)break;
      const batch=SCAN_TICKERS.slice(i,i+QUOTE_BATCH);
      for(const t of batch){
        setCurrentTicker(t);setScanIndex(i+batch.indexOf(t));
        setScannedTickers(prev=>[...prev.filter(x=>x!==t),t]);
        await new Promise(r=>setTimeout(r,TICK_DELAY));
        if(tickerStripRef.current){const el=tickerStripRef.current.querySelector(`[data-ticker="${t}"]`);if(el)el.scrollIntoView({behavior:"smooth",block:"nearest",inline:"center"});}
      }
      try{
        const res=await fetch(`/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(batch.join(","))}&fields=quote`);
        const data=await res.json();
        for(const ticker of batch){
          const q=data?.[ticker]?.quote; if(!q)continue;
          const close=q.closePrice??q.lastPrice??0;
          const last=q.lastPrice??q.mark??0;
          const changePct=close>0?(last-close)/close*100:0;
          const {score,tier,flags}=stoRiskScore(ticker,changePct);
          const btoStat=BTO_STATS[ticker];
          const isSTO=score<=3; const isBTO=btoStat?.ev>0&&Math.abs(changePct)>=1.5;
          const cpStr=`${changePct>=0?"+":""}${changePct.toFixed(2)}%`;
          const flagNames=flags.filter(f=>f.sev>0).map(f=>f.name).join(", ");
          if(isSTO&&isBTO){addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — STO risk:${score} + BTO · ${tier}${flagNames?" · "+flagNames:""}`, "good");}
          else if(isSTO){addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — STO risk:${score} · ${tier}${flagNames?" · flags: "+flagNames:""}`,score<=1?"good":"caution");}
          else if(isBTO){addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — BTO · EV +$${btoStat.ev.toFixed(2)} · ${tier}`,"bto");}
          else{addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — skip · risk:${score} tier:${tier}${flagNames?" · "+flagNames:""}`, "info");}
          if(isSTO)shortlist.push({type:"STO",ticker,price:last,changePct,riskScore:score,tier,flags,vix});
          if(isBTO)shortlist.push({type:"BTO",ticker,price:last,changePct,btoEv:btoStat.ev,btoWr:btoStat.wr,tier,flags:[],vix});
        }
      }catch(e){addLog(`Batch failed: ${e.message}`,"error");}
      if(i+QUOTE_BATCH<SCAN_TICKERS.length&&scanningRef.current)await new Promise(r=>setTimeout(r,BATCH_DELAY));
    }
    if(!scanningRef.current)return;
    addLog(`Pass 1 complete — ${shortlist.length} candidates (${shortlist.filter(o=>o.type==="STO").length} STO, ${shortlist.filter(o=>o.type==="BTO").length} BTO)`,"system");
    if(shortlist.length>0){
      setPhase("chains");setScanTotal(shortlist.length);
      addLog(`Pass 2 — fetching chains for ${shortlist.length} candidates`,"system");
      const enriched=[];
      for(let i=0;i<shortlist.length;i++){
        if(!scanningRef.current)break;
        const opp=shortlist[i];
        setCurrentTicker(opp.ticker);setScanIndex(i);
        setChainStatus(prev=>({...prev,[opp.ticker+"-"+opp.type]:"fetching"}));
        addLog(`${opp.type} ${opp.ticker} — fetching chain · $${opp.price?.toFixed(2)} ${opp.changePct>=0?"+":""}${opp.changePct?.toFixed(2)}% · risk ${opp.riskScore??"BTO"}`,opp.type==="BTO"?"bto":"caution");
        const result=await fetchChainForOpp(opp);
        setChainStatus(prev=>({...prev,[opp.ticker+"-"+opp.type]:result.chainOptions?.length>0?"found":"empty"}));
        if(result.chainOptions?.length>0){
          const top=result.chainOptions[0];
          const mid=top.mid??(top.bid+top.ask)/2;
          const annYield=top.dte>0&&opp.price>0?(mid/opp.price*365/top.dte*100).toFixed(1):"—";
          const ivStr=top.iv?` · IV ${(top.iv*100).toFixed(0)}%`:"";
          const evStr=opp.type==="BTO"&&BTO_STATS[opp.ticker]?` · EV/cost ${((BTO_STATS[opp.ticker].wr*BTO_STATS[opp.ticker].avgProfit)/mid).toFixed(1)}x`:"";
          addLog(`${opp.type} ${opp.ticker} — best: $${top.strike} ${top.expiryDate} ${top.dte}d · bid $${top.bid?.toFixed(2)} ask $${top.ask?.toFixed(2)} mid $${mid?.toFixed(2)}${ivStr} · Δ${top.delta?.toFixed(2)} OI ${top.openInterest?.toLocaleString()}${opp.type==="STO"?" · ann yield "+annYield+"%":evStr}`,"good");
        }else{addLog(`${opp.type} ${opp.ticker} — no liquid options found`,"error");}
        enriched.push(result);
        await new Promise(r=>setTimeout(r,CHAIN_DELAY));
      }
      setOpportunities(enriched.sort((a,b)=>{if(a.type!==b.type)return a.type==="STO"?-1:1;if(a.type==="STO")return a.riskScore-b.riskScore;return(b.btoEv||0)-(a.btoEv||0);}));
    }
    if(scanningRef.current){
      setCycleCount(c=>c+1);setLastScan(new Date());setCurrentTicker(null);setPhase(null);
      addLog("Cycle complete — next cycle starting","system");
      setTimeout(runScanCycle,2000);
    }
  }

  const startScanning=()=>{scanningRef.current=true;setScanning(true);setOpportunities([]);setScanLog([]);setCycleCount(0);setScannedTickers([]);setChainStatus({});runScanCycle();};
  const stopScanning=()=>{scanningRef.current=false;setScanning(false);setCurrentTicker(null);setPhase(null);addLog("Scanning stopped","system");};
  useEffect(()=>{return()=>{scanningRef.current=false;};},[]);

  async function scanSingleTicker(){
    const ticker=customTicker.trim().toUpperCase(); if(!ticker)return;
    setCustomScanning(true);setScanLog([]);setChainStatus({});
    addLog(`Manual scan: ${ticker}`,"system");
    try{
      const res=await fetch(`/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(ticker)}&fields=quote`);
      const data=await res.json();
      const q=data?.[ticker]?.quote;
      if(!q){addLog(`${ticker} — no quote data`,"error");setCustomScanning(false);return;}
      const close=q.closePrice??q.lastPrice??0;const last=q.lastPrice??q.mark??0;
      const changePct=close>0?(last-close)/close*100:0;
      const {score,tier,flags}=stoRiskScore(ticker,changePct);
      const btoStat=BTO_STATS[ticker];
      const cpStr=`${changePct>=0?"+":""}${changePct.toFixed(2)}%`;
      const flagNames=flags.filter(f=>f.sev>0).map(f=>f.name).join(", ");
      addLog(`${ticker} $${last.toFixed(2)} ${cpStr} · ${tier} tier · STO risk: ${score}${flagNames?" · "+flagNames:""}`,score<=1?"good":score<=3?"caution":"error");
      if(btoStat)addLog(`${ticker} BTO — hist EV $${btoStat.ev.toFixed(2)} · win rate ${(btoStat.wr*100).toFixed(0)}% · avg profit $${btoStat.avgProfit.toFixed(2)}`,btoStat.ev>0?"bto":"info");
      const candidates=[];
      candidates.push({type:"STO",ticker,price:last,changePct,riskScore:score,tier,flags,vix:null});
      if(btoStat)candidates.push({type:"BTO",ticker,price:last,changePct,btoEv:btoStat.ev,btoWr:btoStat.wr,tier,flags:[],vix:null});
      addLog(`Fetching chains for ${ticker}...`,"system");
      const enriched=[];
      for(const opp of candidates){
        setChainStatus(prev=>({...prev,[ticker+"-"+opp.type]:"fetching"}));
        addLog(`${opp.type} ${ticker} — fetching chain · risk score ${opp.riskScore??"BTO"}`,opp.type==="BTO"?"bto":"caution");
        const result=await fetchChainForOpp(opp);
        setChainStatus(prev=>({...prev,[ticker+"-"+opp.type]:result.chainOptions?.length>0?"found":"empty"}));
        if(result.chainOptions?.length>0){
          const top=result.chainOptions[0];const mid=top.mid??(top.bid+top.ask)/2;
          const annYield=top.dte>0&&opp.price>0?(mid/opp.price*365/top.dte*100).toFixed(1):"—";
          const ivStr=top.iv?` · IV ${(top.iv*100).toFixed(0)}%`:"";
          const evStr=opp.type==="BTO"&&BTO_STATS[ticker]?` · EV/cost ${((BTO_STATS[ticker].wr*BTO_STATS[ticker].avgProfit)/mid).toFixed(1)}x`:"";
          addLog(`${opp.type} ${ticker} — best: $${top.strike} ${top.expiryDate} ${top.dte}d · bid $${top.bid?.toFixed(2)} ask $${top.ask?.toFixed(2)} mid $${mid?.toFixed(2)}${ivStr} · Δ${top.delta?.toFixed(2)} OI ${top.openInterest?.toLocaleString()}${opp.type==="STO"?" · ann yield "+annYield+"%":evStr}`,"good");
        }else{addLog(`${opp.type} ${ticker} — no liquid options found`,"error");}
        enriched.push(result);
      }
      setOpportunities(prev=>{
        const filtered=prev.filter(o=>o.ticker!==ticker);
        return [...filtered,...enriched].sort((a,b)=>{if(a.type!==b.type)return a.type==="STO"?-1:1;if(a.type==="STO")return a.riskScore-b.riskScore;return(b.btoEv||0)-(a.btoEv||0);});
      });
      addLog(`${ticker} scan complete`,"system");
    }catch(e){addLog(`${ticker} scan failed: ${e.message}`,"error");}
    setCustomScanning(false);
  }

  const pct=scanTotal>0?Math.min((scanIndex/scanTotal)*100,100):0;
  const stoOpps=opportunities.filter(o=>o.type==="STO");
  const btoOpps=opportunities.filter(o=>o.type==="BTO");
  const tierColor=t=>t==="safe"?"#3fb950":t==="watch"?"#ffd166":"#ff4560";
  const riskColor=s=>s<=1?"#3fb950":s<=3?"#ffd166":s<=5?"#ff9500":"#ff4560";
  const logColor=t=>t==="good"?"#3fb950":t==="bto"?"#58a6ff":t==="caution"?"#ffd166":t==="error"?"#ff4560":t==="system"?th("#8b949e","#5a5248"):th("#e6edf3","#0d0d0b");
  const phaseLabel=phase==="quotes"?"SCANNING QUOTES":phase==="chains"?"FETCHING CHAINS":scanning?"IDLE":"";

  const renderChainOptions=(opp)=>{
    if(!opp.chainFetched)return <div style={{padding:"12px",color:th("#8b949e","#5a5248"),fontSize:9,textAlign:"center"}}>⟳ Fetching live chain data...</div>;
    if(!opp.chainOptions?.length)return <div style={{padding:"12px",color:"#484f58",fontSize:9,textAlign:"center"}}>No liquid options found</div>;
    const btoStat=BTO_STATS[opp.ticker];
    return(
      <div style={{borderTop:"1px solid #21262d"}}>
        <div style={{padding:"6px 12px",background:th("#0d1117","#f5f0e8"),display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:8,color:th("#8b949e","#5a5248"),letterSpacing:"0.1em",fontWeight:700}}>TOP {opp.chainOptions.length} CALLS · {opp.type==="STO"?"RANKED: PREMIUM ÷ RISK":"RANKED: EV ÷ COST"}</span>
          <span style={{fontSize:8,color:"#484f58"}}>Stock: ${opp.price?.toFixed(2)} · {opp.changePct>=0?"+":""}{opp.changePct?.toFixed(2)}%</span>
        </div>
        {opp.chainOptions.map((o,i)=>{
          const mid=o.mid??(o.bid+o.ask)/2;
          const annYield=o.dte>0&&opp.price>0?(mid/opp.price*365/o.dte*100):0;
          const otmPct=opp.price>0?(Math.abs(o.strike-opp.price)/opp.price*100):0;
          const evRatio=opp.type==="BTO"&&btoStat&&mid>0?(btoStat.wr*btoStat.avgProfit)/mid:null;
          const premPct=opp.price>0?(mid/opp.price*100):0;
          const spreadTight=o.spreadPct<0.15;
          const rankCol=i===0?"#ffd166":i===1?th("#8b949e","#5a5248"):"#484f58";
          return(
            <div key={i} style={{padding:"10px 12px",borderBottom:"1px solid #21262d",background:i===0?"#ffffff06":"transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:18,height:18,borderRadius:3,background:rankCol+"22",color:rankCol,fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                <span style={{fontSize:13,fontWeight:700,color:th("#e6edf3","#0d0d0b")}}>${o.strike} Call</span>
                <span style={{fontSize:10,color:th("#8b949e","#5a5248")}}>{o.expiryDate}</span>
                <span style={{fontSize:9,background:"#58a6ff22",color:"#58a6ff",border:"1px solid #58a6ff44",borderRadius:3,padding:"1px 6px"}}>{o.dte}d</span>
                <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}>{otmPct.toFixed(1)}% OTM</span>
                {i===0&&<span style={{fontSize:8,color:"#ffd166",fontWeight:700,marginLeft:"auto"}}>★ TOP PICK</span>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:6}}>
                {[{label:"BID",val:`$${o.bid?.toFixed(2)}`,col:th("#e6edf3","#0d0d0b")},{label:"ASK",val:`$${o.ask?.toFixed(2)}`,col:th("#e6edf3","#0d0d0b")},{label:"MID",val:`$${mid?.toFixed(2)}`,col:"#3fb950"},{label:"SPREAD",val:`${(o.spreadPct*100).toFixed(0)}%`,col:spreadTight?"#3fb950":"#ffd166"}].map(({label,val,col})=>(
                  <div key={label} style={{background:th("#21262d","#c8b8a8"),borderRadius:4,padding:"4px 6px",textAlign:"center"}}>
                    <div style={{fontSize:7,color:"#484f58",letterSpacing:"0.06em"}}>{label}</div>
                    <div style={{fontSize:10,fontWeight:700,color:col}}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:6}}>
                {[{label:"IV",val:o.iv?`${(o.iv*100).toFixed(0)}%`:"—",col:"#ffd166"},{label:"DELTA",val:o.delta?o.delta.toFixed(3):"—",col:th("#8b949e","#5a5248")},{label:"OI",val:o.openInterest?o.openInterest.toLocaleString():"—",col:th("#8b949e","#5a5248")},{label:"VOL",val:o.volume?o.volume.toLocaleString():"—",col:th("#8b949e","#5a5248")}].map(({label,val,col})=>(
                  <div key={label} style={{background:th("#21262d","#c8b8a8"),borderRadius:4,padding:"4px 6px",textAlign:"center"}}>
                    <div style={{fontSize:7,color:"#484f58",letterSpacing:"0.06em"}}>{label}</div>
                    <div style={{fontSize:10,fontWeight:700,color:col}}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                {opp.type==="STO"&&<><span style={{fontSize:8,color:"#58a6ff"}}>Ann yield <b>{annYield.toFixed(1)}%</b></span><span style={{fontSize:8,color:th("#8b949e","#5a5248")}}>Prem% <b>{premPct.toFixed(2)}%</b></span><span style={{fontSize:8,color:th("#8b949e","#5a5248")}}>Max profit <b>${(mid*100).toFixed(0)}/contract</b></span></>}
                {opp.type==="BTO"&&evRatio&&<><span style={{fontSize:8,color:"#58a6ff"}}>EV/cost <b>{evRatio.toFixed(1)}x</b></span><span style={{fontSize:8,color:th("#8b949e","#5a5248")}}>Hist win rate <b>{(btoStat.wr*100).toFixed(0)}%</b></span></>}
                <span style={{fontSize:8,color:spreadTight?"#3fb950":"#ffd166",marginLeft:"auto"}}>{spreadTight?"✓ Tight spread":"⚠ Wide spread"}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOppCard=(o,i)=>{
    const isExpanded=expandedOpp===`${o.type}-${o.ticker}`;
    const borderCol=o.type==="BTO"?"#58a6ff":riskColor(o.riskScore);
    return(
      <div key={`${o.ticker}-${o.type}-${i}`} style={{borderBottom:"1px solid #21262d",background:isExpanded?th("#0d1117","#f5f0e8"):"transparent"}}>
        <div onClick={()=>setExpandedOpp(isExpanded?null:`${o.type}-${o.ticker}`)} style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <div style={{width:32,height:32,borderRadius:"50%",border:`2px solid ${borderCol}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,flexDirection:"column",lineHeight:1.1}}>
            {o.type==="STO"?<span style={{fontSize:11,fontWeight:700,color:borderCol}}>{o.riskScore}</span>:<><span style={{fontSize:7,color:borderCol}}>EV</span><span style={{fontSize:9,fontWeight:700,color:borderCol}}>${o.btoEv?.toFixed(1)}</span></>}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,color:th("#e6edf3","#0d0d0b")}}>{o.ticker}</span>
              <span style={{fontSize:9,background:borderCol+"22",color:borderCol,border:`1px solid ${borderCol}44`,borderRadius:3,padding:"1px 6px",fontWeight:600}}>{o.type}</span>
              <span style={{fontSize:9,background:tierColor(o.tier)+"18",color:tierColor(o.tier),border:`1px solid ${tierColor(o.tier)}33`,borderRadius:3,padding:"1px 5px"}}>{o.tier}</span>
              {o.chainOptions?.length>0&&<span style={{fontSize:8,color:"#3fb950"}}>⛓ {o.chainOptions.length} options</span>}
            </div>
            <div style={{fontSize:9,color:th("#8b949e","#5a5248"),marginTop:2}}>
              ${o.price?.toFixed(2)} · {o.changePct>=0?"+":""}{o.changePct?.toFixed(2)}%
              {o.vix&&<span style={{marginLeft:8}}>VIX {o.vix?.toFixed(1)}</span>}
              {o.type==="STO"&&o.flags?.filter(f=>f.sev>0).length>0&&<span style={{color:"#ffd166",marginLeft:8}}>{o.flags.filter(f=>f.sev>0).map(f=>f.name).join(" · ")}</span>}
            </div>
          </div>
          <span style={{fontSize:9,color:"#484f58",flexShrink:0}}>{isExpanded?"▲":"▼"}</span>
        </div>
        {isExpanded&&renderChainOptions(o)}
      </div>
    );
  };

  return(
    <div style={{padding:"16px 20px",fontFamily:"monospace",minHeight:"100vh",background:th("#0d1117","#f5f0e8")}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#58a6ff",letterSpacing:"0.1em"}}>⟳ OPPORTUNITY SCANNER</div>
          <div style={{fontSize:10,color:th("#8b949e","#5a5248"),marginTop:2}}>{SCAN_TICKERS.length} tickers · 2-pass (quotes → chains) · continuous</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <input value={customTicker} onChange={e=>setCustomTicker(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&!customScanning&&scanSingleTicker()} placeholder="TICKER" maxLength={6}
              style={{background:th("#21262d","#c8b8a8"),border:"1px solid #30363d",borderRadius:5,color:th("#e6edf3","#0d0d0b"),fontSize:11,fontWeight:700,padding:"5px 10px",width:80,letterSpacing:"0.08em",outline:"none",fontFamily:"monospace"}}/>
            <button onClick={scanSingleTicker} disabled={!customTicker.trim()||customScanning}
              style={{background:customScanning?"#58a6ff11":"#58a6ff20",color:customScanning?"#484f58":"#58a6ff",border:`1px solid ${customScanning?th("#30363d","#c0b0a0"):"#58a6ff50"}`,borderRadius:5,padding:"5px 12px",fontSize:10,fontWeight:700,cursor:customScanning||!customTicker.trim()?"not-allowed":"pointer"}}>
              {customScanning?"⟳":"SCAN"}
            </button>
          </div>
          <div style={{width:"1px",height:20,background:th("#30363d","#c0b0a0")}}/>
          {lastScan&&<span style={{fontSize:9,color:"#484f58"}}>Last: {lastScan.toLocaleTimeString()}</span>}
          {cycleCount>0&&<span style={{fontSize:9,color:"#484f58"}}>Cycle #{cycleCount}</span>}
          <button onClick={scanning?stopScanning:startScanning}
            style={{background:scanning?"#ff456020":"#3fb95020",color:scanning?"#ff4560":"#3fb950",border:`1px solid ${scanning?"#ff456050":"#3fb95050"}`,borderRadius:6,padding:"6px 16px",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            {scanning?"⏹ STOP":"▶ START SCANNING"}
          </button>
        </div>
      </div>

      {scanning&&(
        <div style={{marginBottom:12,background:th("#161b22","#ede8df"),borderRadius:6,border:"1px solid #30363d",overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #21262d",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.08em",color:phase==="quotes"?"#58a6ff":phase==="chains"?"#ffd166":th("#8b949e","#5a5248")}}>{phaseLabel}</span>
              <span style={{fontSize:8,color:"#484f58"}}>{phase==="quotes"?`${Math.min(scanIndex+1,scanTotal)} / ${scanTotal} tickers`:phase==="chains"?`${Math.min(scanIndex+1,scanTotal)} / ${scanTotal} candidates`:""}</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{fontSize:8,color:phase==="quotes"?"#58a6ff":"#484f58"}}>⬤ Pass 1: Quotes</span>
              <span style={{fontSize:8,color:phase==="chains"?"#ffd166":"#484f58"}}>⬤ Pass 2: Chains</span>
            </div>
          </div>
          <div style={{height:2,background:th("#21262d","#c8b8a8")}}><div style={{width:`${pct}%`,height:"100%",transition:"width 0.3s ease",background:phase==="chains"?"#ffd166":"#58a6ff"}}/></div>
          <div style={{padding:"6px 12px",borderBottom:"1px solid #21262d"}}>
            <div ref={tickerStripRef} style={{display:"flex",gap:4,overflowX:"auto",scrollbarWidth:"none",paddingBottom:2}}>
              {SCAN_TICKERS.map(t=>{
                const isCurrent=t===currentTicker;
                const isScanned=scannedTickers.includes(t);
                return(<span key={t} data-ticker={t} style={{flexShrink:0,fontSize:isCurrent?11:9,fontWeight:isCurrent?700:400,color:isCurrent?"#ffffff":isScanned?"#3fb950":"#484f58",background:isCurrent?"#58a6ff33":"transparent",border:isCurrent?"1px solid #58a6ff88":"1px solid transparent",borderRadius:3,padding:"1px 5px",transition:"all 0.2s ease"}}>{t}</span>);
              })}
            </div>
          </div>
          {phase==="chains"&&(
            <div style={{padding:"6px 12px"}}><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {Object.entries(chainStatus).map(([key,status])=>{
                const [ticker,type]=key.split("-");
                const isActive=ticker===currentTicker;
                const col=status==="found"?"#3fb950":status==="empty"?"#484f58":isActive?"#ffd166":th("#8b949e","#5a5248");
                return(<span key={key} style={{fontSize:9,fontWeight:isActive?700:400,color:col,background:isActive?col+"22":"transparent",border:`1px solid ${isActive?col+"66":"transparent"}`,borderRadius:3,padding:"1px 6px",transition:"all 0.2s ease"}}>{status==="fetching"?`⟳ ${ticker}`:status==="found"?`✓ ${ticker}`:`— ${ticker}`}<span style={{fontSize:7,color:"#484f58",marginLeft:3}}>{type}</span></span>);
              })}
            </div></div>
          )}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div style={{background:th("#161b22","#ede8df"),border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:9,fontWeight:700,color:"#3fb950",letterSpacing:"0.1em"}}>STO OPPORTUNITIES</span>
            <span style={{fontSize:9,color:"#484f58"}}>{stoOpps.length} found</span>
          </div>
          <div style={{maxHeight:360,overflowY:"auto"}}>
            {stoOpps.length===0?<div style={{padding:"24px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>{scanning?"Scanning...":"Start scanner to find opportunities"}</div>:stoOpps.map(renderOppCard)}
          </div>
        </div>
        <div style={{background:th("#161b22","#ede8df"),border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:9,fontWeight:700,color:"#58a6ff",letterSpacing:"0.1em"}}>BTO OPPORTUNITIES</span>
            <span style={{fontSize:9,color:"#484f58"}}>{btoOpps.length} found</span>
          </div>
          <div style={{maxHeight:360,overflowY:"auto"}}>
            {btoOpps.length===0?<div style={{padding:"24px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>{scanning?"Watching for moves ≥1.5%...":"Start scanner to find opportunities"}</div>:btoOpps.map(renderOppCard)}
          </div>
        </div>
      </div>

      <div style={{background:th("#161b22","#ede8df"),border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
        <div style={{padding:"6px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:9,fontWeight:700,color:th("#8b949e","#5a5248"),letterSpacing:"0.1em"}}>SCAN LOG</span>
          <span style={{fontSize:9,color:"#484f58"}}>{scanLog.length} events</span>
        </div>
        <div ref={logRef} style={{maxHeight:130,overflowY:"auto",padding:"2px 0"}}>
          {scanLog.length===0?<div style={{padding:"10px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>No activity yet</div>
            :scanLog.map((l,i)=>(<div key={i} style={{padding:"2px 12px",display:"flex",gap:8,alignItems:"baseline"}}><span style={{fontSize:8,color:"#484f58",flexShrink:0,width:64}}>{l.ts}</span><span style={{fontSize:9,color:logColor(l.type)}}>{l.msg}</span></div>))}
        </div>
      </div>

      {opportunities.length>0&&(
        <div style={{display:"flex",gap:16,marginTop:10,padding:"7px 12px",background:th("#161b22","#ede8df"),borderRadius:6,border:"1px solid #30363d",flexWrap:"wrap"}}>
          <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}><span style={{color:"#3fb950",fontWeight:700}}>{stoOpps.filter(o=>o.riskScore<=1).length}</span> clean STO</span>
          <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}><span style={{color:"#ffd166",fontWeight:700}}>{stoOpps.filter(o=>o.riskScore>1&&o.riskScore<=3).length}</span> caution STO</span>
          <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}><span style={{color:"#58a6ff",fontWeight:700}}>{btoOpps.length}</span> BTO signals</span>
          <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}><span style={{color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{SCAN_TICKERS.length}</span> tickers watched</span>
          <span style={{fontSize:9,color:th("#8b949e","#5a5248")}}><span style={{color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{opportunities.filter(o=>o.chainFetched&&o.chainOptions?.length>0).length}</span> with chain data</span>
        </div>
      )}
    </div>
  );
}


// ─── Monthly Report Component ─────────────────────────────────────────────────
function MonthlyReport({ originals }) {
  const allMonths = [...new Set(originals.map(c => c.closeDate?.slice(0,7) || c.dateExec?.slice(0,7)).filter(Boolean))].sort().reverse();
  const [reportMonth, setReportMonth] = useState(() => allMonths[0] || new Date().toISOString().slice(0,7));
  const monthContracts = originals.filter(c => {
    const d = c.closeDate?.slice(0,7) || c.dateExec?.slice(0,7);
    return d === reportMonth && c.status === "Closed";
  });
  const openInMonth  = originals.filter(c => c.dateExec?.slice(0,7) === reportMonth && c.status === "Open");
  const totalProfit  = monthContracts.reduce((s,c) => s+(c.profit||0), 0);
  const totalPremium = monthContracts.reduce((s,c) => s+(c.premium||0), 0);
  const wins    = monthContracts.filter(c => (c.profit||0) > 0);
  const losses  = monthContracts.filter(c => (c.profit||0) < 0);
  const winRate = monthContracts.length ? Math.round(wins.length/monthContracts.length*100) : null;
  const avgProfit = monthContracts.length ? totalProfit/monthContracts.length : 0;
  const byTicker = {};
  monthContracts.forEach(c => {
    if (!byTicker[c.stock]) byTicker[c.stock] = {profit:0, count:0, wins:0};
    byTicker[c.stock].profit += (c.profit||0);
    byTicker[c.stock].count  += 1;
    if ((c.profit||0) > 0) byTicker[c.stock].wins += 1;
  });
  const sorted = Object.entries(byTicker).sort((a,b) => b[1].profit - a[1].profit);
  const best  = wins.reduce((a,c)  => (c.profit||0) > (a?.profit||0) ? c : a, wins[0]  || null);
  const worst = losses.reduce((a,c) => (c.profit||0) < (a?.profit||0) ? c : a, losses[0] || null);
  return (
    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"12px 14px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
        <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em",fontWeight:700}}>MONTHLY REPORT</span>
        <select value={reportMonth} onChange={e=>setReportMonth(e.target.value)}
          style={{fontSize:11,padding:"3px 6px",background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:4,color:th("#e6edf3","#0d0d0b"),fontFamily:"monospace"}}>
          {allMonths.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={()=>{
          const rows = [["Stock","OptType","Type","Strike","Expires","Premium","Cost","Profit","Profit%","OpenDate","CloseDate","Strategy","Account"],...monthContracts.map(c=>[c.stock,c.optType,c.type,c.strike,c.expires,c.premium,c.costToClose,c.profit,c.profitPct!=null?(+c.profitPct*100).toFixed(1):"",c.dateExec,c.closeDate,c.strategy||"",c.account])];
          const csv = rows.map(r=>r.join(",")).join("\n");
          const a=document.createElement("a"); a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv); a.download=`options-report-${reportMonth}.csv`; a.click();
        }} style={{background:"transparent",border:"1px solid #21262d",color:th("#3a4050","#8a7e74"),borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",cursor:"pointer",marginLeft:"auto"}}>↓ CSV</button>
      </div>
      {monthContracts.length === 0 && openInMonth.length === 0 ? (
        <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",textAlign:"center",padding:"16px 0"}}>No contracts for {reportMonth}</div>
      ) : (<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:8,marginBottom:12}}>
          {[
            {label:"Net P&L",   val:"$"+totalProfit.toFixed(2),  color:totalProfit>=0?"#00ff88":"#ff4560"},
            {label:"Premiums",  val:"$"+totalPremium.toFixed(2), color:th("#c9d1d9","#1a1a18")},
            {label:"Contracts", val:monthContracts.length,        color:th("#c9d1d9","#1a1a18")},
            {label:"Win Rate",  val:winRate!=null?winRate+"%":"—",color:winRate>=70?"#00ff88":winRate>=50?"#ffd166":"#ff4560"},
            {label:"Avg P&L",   val:"$"+avgProfit.toFixed(2),     color:avgProfit>=0?"#00ff88":"#ff4560"},
            {label:"Open Now",  val:openInMonth.length,            color:"#58a6ff"},
          ].map(({label,val,color})=>(
            <div key={label} style={{background:th("#080c12","#ede8df"),border:"1px solid #1c2128",borderRadius:6,padding:"8px 10px",textAlign:"center"}}>
              <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:3}}>{label}</div>
              <div style={{fontSize:14,fontFamily:"monospace",fontWeight:700,color}}>{val}</div>
            </div>
          ))}
        </div>
        {(best||worst) && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {best && <div style={{background:"#00ff8808",border:"1px solid #00ff8820",borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontSize:7,color:"#00ff8880",fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:3}}>🏆 BEST TRADE</div>
              <div style={{fontFamily:"monospace",fontSize:11,color:th("#e6edf3","#0d0d0b"),fontWeight:600}}>{best.stock} ${best.strike} {best.type}</div>
              <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88"}}>+${(best.profit||0).toFixed(2)}{best.profitPct!=null?" ("+((+best.profitPct)*100).toFixed(0)+"%)":""}</div>
            </div>}
            {worst && <div style={{background:"#ff456008",border:"1px solid #ff456020",borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontSize:7,color:"#ff456080",fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:3}}>📉 WORST TRADE</div>
              <div style={{fontFamily:"monospace",fontSize:11,color:th("#e6edf3","#0d0d0b"),fontWeight:600}}>{worst.stock} ${worst.strike} {worst.type}</div>
              <div style={{fontFamily:"monospace",fontSize:10,color:"#ff4560"}}>${(worst.profit||0).toFixed(2)}{worst.profitPct!=null?" ("+((+worst.profitPct)*100).toFixed(0)+"%)":""}</div>
            </div>}
          </div>
        )}
        {sorted.length > 0 && (
          <div style={{marginBottom:12}}>
            <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:6}}>BY TICKER</div>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {sorted.map(([sym,d])=>{
                const maxAbs = Math.max(...sorted.map(([,x])=>Math.abs(x.profit)),1);
                const barPct = Math.min(Math.abs(d.profit)/maxAbs*100,100);
                return (
                  <div key={sym} style={{display:"grid",gridTemplateColumns:"50px 1fr 70px 45px 45px",alignItems:"center",gap:8,fontSize:10,fontFamily:"monospace"}}>
                    <span style={{color:th("#e6edf3","#0d0d0b"),fontWeight:600}}>{sym}</span>
                    <div style={{height:6,background:th("#1c2128","#b8a898"),borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:barPct+"%",background:d.profit>=0?"#00ff88":"#ff4560",borderRadius:3}}/>
                    </div>
                    <span style={{color:(d.profit??0)>=0?"#00ff88":"#ff4560",textAlign:"right",fontWeight:700}}>{(d.profit??0)>=0?"+":""}{(d.profit??0).toFixed(2)}</span>
                    <span style={{color:th("#3a4050","#8a7e74"),textAlign:"right"}}>{d.count} ct</span>
                    <span style={{color:"#555",textAlign:"right"}}>{Math.round(d.wins/d.count*100)}% W</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>CLOSED CONTRACTS</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:"monospace"}}>
            <thead>
              <tr style={{borderBottom:"1px solid #1c2128"}}>
                {["Stock","Strike","Type","OT","Expires","Premium","Cost","Profit","P%","Days","Strategy"].map(h=>(
                  <th key={h} style={{padding:"3px 7px",textAlign:["Profit","P%","Premium","Cost"].includes(h)?"right":"left",color:th("#3a4050","#8a7e74"),fontWeight:400,fontSize:7,letterSpacing:"0.06em"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthContracts.sort((a,b)=>(b.profit||0)-(a.profit||0)).map(c=>{
                const pp = c.profitPct!=null?(+c.profitPct*100).toFixed(0)+"%":"—";
                const pc = c.profit!=null?(c.profit>=0?"#00ff88":"#ff4560"):th("#3a4050","#8a7e74");
                return (
                  <tr key={c.id} style={{borderBottom:"1px solid #0d1117"}}>
                    <td style={{padding:"4px 7px",color:th("#e6edf3","#0d0d0b"),fontWeight:600}}>{c.stock}</td>
                    <td style={{padding:"4px 7px",color:th("#c9d1d9","#1a1a18")}}>${c.strike}</td>
                    <td style={{padding:"4px 7px",color:c.type==="Call"?"#58a6ff":"#c084fc"}}>{c.type}</td>
                    <td style={{padding:"4px 7px",color:c.optType==="STO"?"#00ff88":"#ffd166"}}>{c.optType}</td>
                    <td style={{padding:"4px 7px",color:"#555"}}>{c.expires}</td>
                    <td style={{padding:"4px 7px",color:th("#c9d1d9","#1a1a18"),textAlign:"right"}}>${(c.premium||0).toFixed(2)}</td>
                    <td style={{padding:"4px 7px",color:th("#8b949e","#5a5248"),textAlign:"right"}}>{c.costToClose!=null?"$"+c.costToClose.toFixed(2):"—"}</td>
                    <td style={{padding:"4px 7px",color:pc,fontWeight:700,textAlign:"right"}}>{c.profit!=null?(c.profit>=0?"+":"")+c.profit.toFixed(2):"—"}</td>
                    <td style={{padding:"4px 7px",color:pc,textAlign:"right"}}>{pp}</td>
                    <td style={{padding:"4px 7px",color:th("#3a4050","#8a7e74"),textAlign:"right"}}>{c.daysHeld||"—"}</td>
                    <td style={{padding:"4px 7px",color:"#555",fontSize:8}}>{c.strategy||"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}

// ─── All Transactions Tab ─────────────────────────────────────────────────────
function AllTransactionsTab({ supabase }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [fType,   setFType]   = useState("All");
  const [fAcct,   setFAcct]   = useState("All");
  const [fSym,    setFSym]    = useState("");
  const [fFrom,   setFFrom]   = useState("");
  const [fTo,     setFTo]     = useState("");

  useEffect(() => {
    if (!supabase) return;
    let q = supabase.from("stock_transactions").select("*").order("trade_date", { ascending: false }).limit(500);
    if (fType !== "All") q = q.eq("transaction_type", fType);
    if (fAcct !== "All") q = q.eq("account", fAcct);
    if (fSym.trim())     q = q.ilike("symbol", `%${fSym.trim().toUpperCase()}%`);
    if (fFrom)           q = q.gte("trade_date", fFrom);
    if (fTo)             q = q.lte("trade_date", fTo);
    setLoading(true);
    q.then(({ data, error }) => {
      if (!error && data) setRows(data);
      setLoading(false);
    });
  }, [supabase, fType, fAcct, fSym, fFrom, fTo]);

  const accounts = [...new Set(rows.map(r => r.account).filter(Boolean))].sort();
  const inp = { fontSize: 11, padding: "3px 6px", background: th("#0a0e14","#f8f3eb"), border: "1px solid #21262d", borderRadius: 4, color: th("#c9d1d9","#1a1a18") };

  return (
    <div style={{ padding: "12px 12px 0", maxWidth: 1000 }}>
      <div style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.12em", marginBottom: 12 }}>◈ ALL TRANSACTIONS</div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
        <select value={fType} onChange={e => setFType(e.target.value)} style={inp}>
          <option value="All">All Types</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
          <option value="DIVIDEND">DIVIDEND</option>
          <option value="REINVEST">REINVEST</option>
          <option value="INTEREST">INTEREST</option>
          <option value="TAX_WITHHOLDING">TAX_WITHHOLDING</option>
          <option value="JOURNAL">JOURNAL</option>
          <option value="TRANSFER_IN">TRANSFER_IN</option>
          <option value="TRANSFER_OUT">TRANSFER_OUT</option>
          <option value="DEPOSIT">DEPOSIT</option>
          <option value="WITHDRAWAL">WITHDRAWAL</option>
        </select>
        <select value={fAcct} onChange={e => setFAcct(e.target.value)} style={inp}>
          <option value="All">All Accounts</option>
          {accounts.map(a => <option key={a}>{a}</option>)}
        </select>
        <input placeholder="Symbol" value={fSym} onChange={e => setFSym(e.target.value)} style={{ ...inp, width: 80 }} />
        <input type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} style={{ ...inp, width: 120 }} />
        <span style={{ color: "#555", fontSize: 10 }}>–</span>
        <input type="date" value={fTo} onChange={e => setFTo(e.target.value)} style={{ ...inp, width: 120 }} />
        {(fType !== "All" || fAcct !== "All" || fSym || fFrom || fTo) && (
          <button onClick={() => { setFType("All"); setFAcct("All"); setFSym(""); setFFrom(""); setFTo(""); }}
            style={{ background: "#ff456018", color: "#ff4560", border: "1px solid #ff456030", borderRadius: 4, padding: "3px 7px", fontSize: 9 }}>✕ Clear</button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#555", fontFamily: "monospace" }}>{rows.length} rows</span>
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 11, fontFamily: "monospace", padding: 20 }}>Loading…</div>
      ) : !rows.length ? (
        <div style={{ color: "#555", fontSize: 11, fontFamily: "monospace", padding: 20 }}>No transactions found</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #21262d" }}>
                {["Date","Symbol","Type","Qty","Price","Amount","Account","Rationale"].map(h => (
                  <th key={h} style={{ padding: "6px 8px", textAlign: h === "Qty" || h === "Price" || h === "Amount" ? "right" : "left", color: "#555", fontWeight: 600, fontSize: 9, letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isBuy = r.transaction_type === "BUY";
                const dateStr = r.trade_date ? r.trade_date.slice(0, 10) : "—";
                return (
                  <tr key={r.id ?? i} style={{ borderBottom: "1px solid #161b22" }}>
                    <td style={{ padding: "5px 8px", color: th("#8b949e","#5a5248") }}>{dateStr}</td>
                    <td style={{ padding: "5px 8px", color: th("#c9d1d9","#1a1a18"), fontWeight: 600 }}>{r.symbol}</td>
                    <td style={{ padding: "5px 8px" }}>
                      <span style={{ color: isBuy ? "#00ff88" : "#ff4560", background: isBuy ? "#00ff8818" : "#ff456018", border: `1px solid ${isBuy ? "#00ff8830" : "#ff456030"}`, borderRadius: 3, padding: "1px 5px", fontSize: 9 }}>{r.transaction_type}</span>
                    </td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: th("#c9d1d9","#1a1a18") }}>{r.quantity != null ? (+r.quantity).toLocaleString() : "—"}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: th("#c9d1d9","#1a1a18") }}>{r.price != null ? `$${(+r.price).toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: r.net_amount >= 0 ? "#00ff88" : "#ff4560" }}>{r.net_amount != null ? `${r.net_amount >= 0 ? "+" : ""}$${Math.abs(+r.net_amount).toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "5px 8px", color: th("#8b949e","#5a5248") }}>{r.account}</td>
                    <td style={{ padding: "3px 8px" }}>
                      {isBuy && (
                        <input
                          type="text"
                          defaultValue={r.rationale || ""}
                          placeholder="why bought…"
                          onBlur={async e => {
                            const v = e.target.value.trim();
                            if (v === (r.rationale || "")) return;
                            await supabase.from("stock_transactions").update({ rationale: v || null }).eq("id", r.id);
                          }}
                          style={{ width: 150, fontSize: 9, padding: "2px 5px", background: th("#0a0e14","#f8f3eb"), border: "1px solid #21262d", borderRadius: 3, color: th("#c9d1d9","#1a1a18"), fontFamily: "monospace" }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Import Daily Tab ──────────────────────────────────────────────────────────
function ImportDailyTab({ contracts, supabase }) {
  const [anomalies, setAnomalies] = useState([]);
  useEffect(() => {
    if (!supabase) return;
    const TODAY = new Date().toLocaleDateString("en-CA", {timeZone:"America/New_York"});
    supabase.from("import_anomalies").select("*").gte("created_at", TODAY).order("created_at", {ascending:false}).limit(50)
      .then(({data}) => { if (data) setAnomalies(data); });
  }, [supabase]);
  const TODAY = new Date().toLocaleDateString("en-CA", {timeZone:"America/New_York"});
  const todayContracts = (contracts||[])
    .filter(c => c.dateExec === TODAY && c.createdVia === "Auto Import")
    .sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  const todayAnomalies = (anomalies||[])
    .filter(a => (a.created_at||"").slice(0,10) === TODAY && a.anomaly_type !== "resolved")
    .sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0));
  const manualToday = (contracts||[])
    .filter(c => c.dateExec === TODAY && c.createdVia !== "Auto Import")
    .sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));

  const fSign = v => v == null ? "—" : ((+v >= 0 ? "+" : "-") + "$" + Math.abs(+v).toFixed(2));
  const rowStyle = {display:"grid", gridTemplateColumns:"60px 40px 55px 65px 40px 55px 80px 90px 70px", gap:4, padding:"6px 12px", borderBottom:"1px solid #1c2128", alignItems:"center", fontSize:11, fontFamily:"monospace"};
  const hdrStyle = {...rowStyle, fontSize:9, color:th("#3a4050","#8a7e74"), fontWeight:700, letterSpacing:"0.06em", borderBottom:"1px solid #30363d", paddingTop:4, paddingBottom:4};

  // Gamify: P&L is stored on the PARENT (STO) contract when closed, not the BTC row.
  // Look for any STO/BTO that was closed today (close_date = TODAY) with profit set.
  const todayCloses  = (contracts||[]).filter(c => c.closeDate === TODAY && c.profit != null);
  const todayProfit  = todayCloses.reduce((s,c) => s + (+c.profit||0), 0);
  const todayWins    = todayCloses.filter(c => (+c.profit||0) > 0).length;
  const todayLosses  = todayCloses.filter(c => (+c.profit||0) < 0).length;

  return (
    <div style={{padding:"16px 20px", fontFamily:"monospace", background:th("#0d1117","#f5f0e8"), minHeight:"100vh"}}>
      <div style={{fontSize:13, fontWeight:700, color:"#58a6ff", letterSpacing:"0.08em", marginBottom:4}}>⬇ IMPORT</div>
      <div style={{fontSize:10, color:th("#3a4050","#8a7e74"), marginBottom:12}}>{TODAY} · auto-committed via Schwab/ETrade import</div>

      {/* ── Gamified P&L Banner ── */}
      {todayCloses.length > 0 && (
        <div style={{
          background: todayProfit > 0 ? "linear-gradient(135deg,#00ff8812,#00ff8805)" : todayProfit < 0 ? "linear-gradient(135deg,#ff456012,#ff456005)" : th("#1c2128","#b8a898"),
          border: `1px solid ${todayProfit > 0 ? "#00ff8830" : todayProfit < 0 ? "#ff456030" : th("#21262d","#c8b8a8")}`,
          borderRadius:10, padding:"14px 16px", marginBottom:16,
          display:"flex", alignItems:"center", gap:16, flexWrap:"wrap",
          animation:"fadeIn .3s",
        }}>
          <div style={{fontSize:28}}>{todayProfit > 0 ? "🎰" : todayProfit < 0 ? "📉" : "➖"}</div>
          <div>
            <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:2}}>TODAY&apos;S CLOSED P&amp;L</div>
            <div style={{fontSize:22,fontWeight:700,color:todayProfit>0?"#00ff88":todayProfit<0?"#ff4560":th("#c9d1d9","#1a1a18"),lineHeight:1}}>
              {todayProfit>=0?"+":""}{todayProfit.toFixed(2)}
            </div>
          </div>
          <div style={{display:"flex",gap:12,marginLeft:"auto",flexWrap:"wrap"}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>CLOSES</div>
              <div style={{fontSize:16,fontWeight:700,color:th("#e6edf3","#0d0d0b")}}>{todayCloses.length}</div>
            </div>
            {todayWins > 0 && <div style={{textAlign:"center"}}>
              <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>WINS</div>
              <div style={{fontSize:16,fontWeight:700,color:"#00ff88"}}>{todayWins}</div>
            </div>}
            {todayLosses > 0 && <div style={{textAlign:"center"}}>
              <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>LOSSES</div>
              <div style={{fontSize:16,fontWeight:700,color:"#ff4560"}}>{todayLosses}</div>
            </div>}
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>WIN RATE</div>
              <div style={{fontSize:16,fontWeight:700,color:todayWins/todayCloses.length>=0.7?"#00ff88":"#ffd166"}}>{Math.round(todayWins/todayCloses.length*100)}%</div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-committed today */}
      <div style={{background:th("#161b22","#ede8df"), border:"1px solid #30363d", borderRadius:8, marginBottom:16, overflow:"hidden"}}>
        <div style={{padding:"8px 12px", borderBottom:"1px solid #30363d", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <span style={{fontSize:9, fontWeight:700, color:"#3fb950", letterSpacing:"0.1em"}}>AUTO COMMITTED TODAY</span>
          <span style={{fontSize:9, color:"#484f58"}}>{todayContracts.length} contracts</span>
        </div>
        {todayContracts.length === 0
          ? <div style={{padding:"20px 12px", textAlign:"center", color:"#484f58", fontSize:10}}>No auto-committed contracts today</div>
          : <>
              <div style={hdrStyle}>
                <span>STOCK</span><span>TYPE</span><span>SIDE</span><span>STRIKE</span><span>QTY</span><span>O/C</span><span>PREMIUM</span><span>ACCOUNT</span><span>TIME</span>
              </div>
              {todayContracts.map(c => (
                <div key={c.id} style={rowStyle}>
                  <span style={{color:th("#e6edf3","#0d0d0b"), fontWeight:700}}>{c.stock}</span>
                  <span style={{color:th("#8b949e","#5a5248")}}>{c.type}</span>
                  <span style={{color:["STO","STC"].includes(c.optType)?"#3fb950":"#58a6ff", fontWeight:600}}>{c.optType}</span>
                  <span style={{color:th("#e6edf3","#0d0d0b")}}>${c.strike}</span>
                  <span style={{color:th("#8b949e","#5a5248")}}>{c.qty}</span>
                  <span style={{color:c.status==="Open"?"#3fb950":th("#8b949e","#5a5248"), fontSize:9, fontWeight:600}}>{c.status==="Open"?"Open":"Close"}</span>
                  <span style={{color:+c.premium>=0?"#3fb950":"#ff4560", fontWeight:600}}>{fSign(c.premium)}</span>
                  <span style={{color:"#484f58", fontSize:9}}>{c.account}</span>
                  <span style={{color:th("#3a4050","#8a7e74"), fontSize:9}}>{c.createdAt ? new Date(c.createdAt).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true,timeZone:"America/New_York"}) : "—"}</span>
                </div>
              ))}
              <div style={{padding:"6px 12px", borderTop:"1px solid #21262d", display:"flex", gap:16, flexWrap:"wrap"}}>
                <span style={{fontSize:9, color:th("#8b949e","#5a5248")}}>Total premium: <b style={{color:"#3fb950"}}>{fSign(todayContracts.reduce((s,c)=>s+(+c.premium||0),0))}</b></span>
                <span style={{fontSize:9, color:th("#8b949e","#5a5248")}}>Contracts: <b style={{color:th("#e6edf3","#0d0d0b")}}>{todayContracts.reduce((s,c)=>s+(+c.qty||0),0)}</b></span>
                {todayCloses.length > 0 && <span style={{fontSize:9, color:th("#8b949e","#5a5248")}}>P&amp;L: <b style={{color:todayProfit>=0?"#3fb950":"#ff4560"}}>{todayProfit>=0?"+":""}{todayProfit.toFixed(2)}</b></span>}
              </div>
            </>
        }
      </div>

      {/* Anomalies */}
      {todayAnomalies.length > 0 && (
        <div style={{background:th("#161b22","#ede8df"), border:"1px solid #ff456033", borderRadius:8, marginBottom:16, overflow:"hidden"}}>
          <div style={{padding:"8px 12px", borderBottom:"1px solid #ff456033", display:"flex", justifyContent:"space-between"}}>
            <span style={{fontSize:9, fontWeight:700, color:"#ff4560", letterSpacing:"0.1em"}}>⚠ ANOMALIES — NEEDS ATTENTION</span>
            <span style={{fontSize:9, color:"#484f58"}}>{todayAnomalies.length}</span>
          </div>
          {todayAnomalies.map((a,i) => (
            <div key={a.id||i} style={{padding:"8px 12px", borderBottom:"1px solid #1c2128"}}>
              <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:3}}>
                <span style={{fontSize:11, fontWeight:700, color:th("#e6edf3","#0d0d0b")}}>{a.stock||a.symbol||"?"}</span>
                <span style={{fontSize:9, color:"#ff4560", background:"#ff456015", border:"1px solid #ff456033", borderRadius:3, padding:"1px 6px"}}>{a.anomaly_type||a.opt_type||"anomaly"}</span>
                <span style={{fontSize:9, color:"#484f58"}}>{a.strike ? "$"+a.strike : ""} {a.expires||""}</span>
                <button
                  onClick={async () => {
                    if (!supabase || !a.id) return;
                    await supabase.from("import_anomalies").update({ anomaly_type: "resolved", notes: (a.notes||"") + " [dismissed by user]" }).eq("id", a.id);
                    setAnomalies(prev => prev.filter(x => x.id !== a.id));
                  }}
                  style={{marginLeft:"auto", fontSize:9, color:"#484f58", background:"none", border:"1px solid #30363d", borderRadius:3, padding:"1px 8px", cursor:"pointer", fontFamily:"monospace"}}
                >dismiss</button>
              </div>
              <div style={{fontSize:9, color:th("#8b949e","#5a5248")}}>{a.notes||a.note||"No details"}</div>
            </div>
          ))}
        </div>
      )}

      {/* Manual entries today */}
      {manualToday.length > 0 && (
        <div style={{background:th("#161b22","#ede8df"), border:"1px solid #30363d", borderRadius:8, overflow:"hidden"}}>
          <div style={{padding:"8px 12px", borderBottom:"1px solid #30363d", display:"flex", justifyContent:"space-between"}}>
            <span style={{fontSize:9, fontWeight:700, color:"#ffd166", letterSpacing:"0.1em"}}>MANUAL ENTRIES TODAY</span>
            <span style={{fontSize:9, color:"#484f58"}}>{manualToday.length}</span>
          </div>
          {manualToday.map(c => (
            <div key={c.id} style={rowStyle}>
              <span style={{color:th("#e6edf3","#0d0d0b"), fontWeight:700}}>{c.stock}</span>
              <span style={{color:th("#8b949e","#5a5248")}}>{c.type}</span>
              <span style={{color:["STO","STC"].includes(c.optType)?"#3fb950":"#58a6ff", fontWeight:600}}>{c.optType}</span>
              <span style={{color:th("#e6edf3","#0d0d0b")}}>${c.strike}</span>
              <span style={{color:th("#8b949e","#5a5248")}}>{c.qty}</span>
              <span style={{color:c.status==="Open"?"#3fb950":th("#8b949e","#5a5248"), fontSize:9, fontWeight:600}}>{c.status==="Open"?"Open":"Close"}</span>
              <span style={{color:+c.premium>=0?"#3fb950":"#ff4560", fontWeight:600}}>{fSign(c.premium)}</span>
              <span style={{color:"#484f58", fontSize:9}}>{c.account}</span>
              <span style={{color:th("#3a4050","#8a7e74"), fontSize:9}}>{c.createdAt ? new Date(c.createdAt).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true,timeZone:"America/New_York"}) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // Auth
  const [users,setUsers]         = useState(USERS_DEFAULT);
  const [authUser,setAuthUser]   = useState(null);
  const [loginStep,setLoginStep] = useState("pick");
  const [loginTarget,setLoginTarget] = useState(null);
  const [pinInput,setPinInput]   = useState("");
  const [pinError,setPinError]   = useState("");

  // PIN change (in Profile)
  const [showProfile,setShowProfile] = useState(false);
  const [pinStep,setPinStep]     = useState(1);
  const [pinCur,setPinCur]       = useState("");
  const [pinNew,setPinNew]       = useState("");
  const [pinCon,setPinCon]       = useState("");
  const [pinMsg,setPinMsg]       = useState("");

  // App core
  const [tab,setTab]             = useState("dashboard");
  const [uiScale,setUiScale]     = useState(()=>{ try{ return +localStorage.getItem("pri_ui_scale")||1; }catch{ return 1; } });
  const [lightMode,setLightMode] = useState(()=>{ try{ return localStorage.getItem("pri_light_mode")==="on"; }catch{ return false; } });
  // Sync module-level _lightMode so th() works in all module-level components
  _lightMode = lightMode;

  const [contracts,setContracts] = useState([]);
  const [dbReady,setDbReady]     = useState(false);
  const [form,setForm]           = useState({...EMPTY_NEW});
  const [formErrors,setFormErrors] = useState({});
  const [editing,setEditing]     = useState(null);
  const [showForm,setShowForm]   = useState(false);
  const [formMode,setFormMode]   = useState("new");
  const [closingId,setClosingId] = useState(null);
  const [closeForm,setCloseForm] = useState({...EMPTY_CLOSE});

  // Filters
  const [fStatus,setFStatus]     = useState("Open");
  const [fAcct,setFAcct]         = useState("All");
  const [fSearch,setFSearch]     = useState("");
  const [fDateFrom,setFDateFrom] = useState("");
  const [fDateTo,setFDateTo]     = useState("");
  const [fOriginals,setFOriginals] = useState(true); // hide linked close records by default
  const [fCType,    setFCType]     = useState("All"); // Call / Put
  const [fCOptType, setFCOptType]  = useState("All"); // STO / BTO / BTC / STC
  const [fStrategy, setFStrategy]  = useState("All"); // strategy name
  const [fAuto,     setFAuto]      = useState("All"); // auto / manual
  const [gTicker,setGTicker]     = useState("All");
  const [gOptType,setGOptType]   = useState("All");
  const [gType,setGType]         = useState("All");


  // Chart
  const [chartView,setChartView] = useState("monthly"); // daily/weekly/monthly
  const [chartDate,setChartDate] = useState("executed"); // executed/closed
  const [spxOverlay,setSpxOverlay] = useState(false);
  const [spxData,setSpxData]       = useState([]);

  // Columns
  const [cols,setCols]           = useState(DEFAULT_COLS);
  const [sortKey,setSortKey]     = useState("dateExec");
  const [sortDir,setSortDir]     = useState("desc");
  const [showColPicker,setShowColPicker] = useState(false);

  // Analytics period notes
  const [periodNotes,setPeriodNotes] = useState({});
  const [editingNote,setEditingNote] = useState(null);

  // Strategies
  const [strategies, setStrategies] = useState([]);
  const [linkEditor, setLinkEditor] = useState(null); // { contractId, strategyType, selectedIds, saving }
  const [showStrategies, setShowStrategies] = useState(false);
  const [stratForm, setStratForm] = useState(null); // {name,description,rules}

  // Profit Bands
  const [showBands, setShowBands] = useState(false);
  const DEFAULT_BANDS = {
    band1OTM:3.0, band2OTM:1.5,
    globalTgt1:70, globalTgt2:60, globalTgt3:50,
    stoCallTgt1:"",stoCallTgt2:"",stoCallTgt3:"",
    stoPutTgt1:"",stoPutTgt2:"",stoPutTgt3:"",
    btoCallTgt1:"",btoCallTgt2:"",btoCallTgt3:"",
    btoPutTgt1:"",btoPutTgt2:"",btoPutTgt3:"",
    stoCallOTM1:"",stoCallOTM2:"",stoPutOTM1:"",stoPutOTM2:"",
    btoCallOTM1:"",btoCallOTM2:"",btoPutOTM1:"",btoPutOTM2:"",
  };
  const [bands, setBands] = useState(DEFAULT_BANDS);

  // OTM+DTE Matrix
  const DEFAULT_OTM_ROWS = [{label:">5% OTM",min:5},{label:"3–5% OTM",min:3},{label:"1.5–3% OTM",min:1.5},{label:"<1.5% OTM",min:0}];
  const DEFAULT_DTE_COLS = [{label:"1–3d",max:3},{label:"4–7d",max:7},{label:"8–14d",max:14},{label:"15–30d",max:30},{label:">30d",max:999}];
  const DEFAULT_MATRIX_CALL = [[60,65,70,70,70],[55,60,65,70,70],[50,55,60,65,65],[0,0,50,55,55]];
  const DEFAULT_MATRIX_PUT  = [[60,65,70,70,70],[55,60,65,70,70],[50,55,60,65,65],[0,0,50,55,55]];
  const [showMatrix, setShowMatrix] = useState(false);
  const [matrixOTMRows, setMatrixOTMRows] = useState(DEFAULT_OTM_ROWS);
  const [matrixDTECols, setMatrixDTECols] = useState(DEFAULT_DTE_COLS);
  const [matrixCall, setMatrixCall] = useState(DEFAULT_MATRIX_CALL);
  const [matrixPut,  setMatrixPut]  = useState(DEFAULT_MATRIX_PUT);
  const [matrixTab,  setMatrixTab]  = useState("Call");

  // Trade Rules
  const [showSignalRules, setShowSignalRules] = useState(false);
  const [showTradeRules,  setShowTradeRules]  = useState(false);
  const [tradeRules, setTradeRules] = useState([]);
  const [importState,  setImportState]  = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [tradeRuleForm, setTradeRuleForm] = useState(null);
  const EMPTY_RULE = {name:"",direction:"Open",optType:"STO",type:"Call",minOTM:"",maxOTM:"",minDTE:"",maxDTE:"",stockPerf:"Any",logic:"",tickers:"",minPremium:"",minVIX:"",stockUpPct:"",account:"Schwab",qty:"1",enabled:true};

  // Goals
  const [showGoals, setShowGoals] = useState(false);
  const [goals, setGoals] = useState({dailyPremium:"",dailyProfit:"",weeklyPremium:"",monthlyPremium:"",quarterlyPremium:"",weeklyProfit:"",monthlyProfit:"",quarterlyProfit:""});

  // Storage/UI
  const [storageMsg,setStorageMsg] = useState("");



  const [deleteConfirm,setDeleteConfirm] = useState(null);
  const [viewC,setViewC]           = useState(null);
  const [showMenu,setShowMenu]     = useState(false);
  const [showTeam,setShowTeam]     = useState(false);
  const [celebration,setCelebration] = useState(null); // {profit}
  const [planItems,setPlanItems]   = useState([]);
  const [planForm,setPlanForm]     = useState(null);
  const [pendingSignalId,setPendingSignalId] = useState(null); // signal_id from deep-link, triggers decision banner
  const [signalDecision,setSignalDecision]   = useState(null); // { decision, notes } once logged
  // Auto-reload when a new version is deployed
  useEffect(() => {
    let currentVersion = null;
    const check = async () => {
      try {
        const res  = await fetch("/version.json?t=" + Date.now());
        const data = await res.json();
        if (!currentVersion) {
          currentVersion = data.v;           // first load — store current version
        } else if (data.v !== currentVersion) {
          window.location.reload();          // new version detected — silent reload
        }
      } catch { /* network hiccup — ignore */ }
    };
    check(); // check immediately on mount
    const interval = setInterval(check, 5 * 60 * 1000); // then every 5 minutes
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle deep-link from Pushover notification: ?action=plan&ticker=AAPL or ?action=close&id=123
  // Read params immediately on mount (before auth) so they survive the login flow
  const deepLinkRef = useRef(null);
  useEffect(()=>{
    const params = new URLSearchParams(window.location.search);
    const action    = params.get("action");
    const ticker    = params.get("ticker");
    const id        = params.get("id");
    const signalId  = params.get("signal_id");
    const tab       = params.get("tab");
    const strike    = params.get("strike");
    const expiry    = params.get("expiry");
    const qty       = params.get("qty");
    const price     = params.get("price");
    const account   = params.get("account");
    if (!action && !tab) return;
    // Store for later — will be applied once auth + data are ready
    deepLinkRef.current = { action: action || tab, ticker, id, signalId, strike, expiry, qty, price, account };
    window.history.replaceState({},"",window.location.pathname);
  },[]);

  // Apply deep link once auth + contracts are loaded
  useEffect(()=>{
    if (!deepLinkRef.current || !authUser || !contracts.length || !dbReady) return;
    const { action, ticker, id, signalId, strike, expiry, qty, price, account } = deepLinkRef.current;
    deepLinkRef.current = null; // clear so it only fires once
    if ((action === "stocks" || action === "sto") && ticker) {
      setTab("stocks");
      setSelectedTicker(ticker.toUpperCase());
      if (strike || expiry || qty || price || account) {
        setPendingOrder({
          strike:  strike  ? +strike  : null,
          expiry:  expiry  || null,
          qty:     qty     ? +qty     : null,
          price:   price   ? +price   : null,
          account: account || null,
        });
      }
      if (signalId) { setPendingSignalId(signalId); setSignalDecision(null); }
    } else if (action === "plan" && ticker) {
      setTab("plan");
      if (signalId) { setPendingSignalId(signalId); setSignalDecision(null); }
      setTimeout(()=>openPlanForm(ticker.toUpperCase()), 300);
    } else if (action === "close" && id) {
      const c = contracts.find(x => String(x.id) === String(id));
      if (c) {
        setTab("contracts");
        setViewC(c);
        if (signalId) { setPendingSignalId(signalId); setSignalDecision(null); }
        setTimeout(() => {
          setClosingId(c.id);
          setCloseForm({...EMPTY_CLOSE, notes: c.notes || ""});
          setFormMode("close");
          setShowForm(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }, 200);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[authUser, contracts, dbReady]);
  const [planDateFilter,setPlanDateFilter] = useState(TODAY);

  const menuRef = useRef(null);

  useEffect(() => {
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Keyboard PIN input
  useEffect(() => {
    if (authUser || loginStep !== "pin") return;
    const h = e => {
      if (e.key >= "0" && e.key <= "9") pinDigit(e.key);
      if (e.key === "Backspace") setPinInput(p => p.slice(0,-1));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [authUser, loginStep, pinInput, loginTarget]);

  // ── Supabase CRUD ─────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        // ── Fetch contracts (paginated) + all config in parallel ──────────────
        const loadContracts = async () => {
          let all = [], from = 0;
          const pageSize = 1000;
          while (true) {
            const { data: page, error } = await supabase
              .from("contracts").select("*").order("date_exec", { ascending: false })
              .range(from, from + pageSize - 1);
            if (error) throw error;
            if (!page?.length) break;
            all = [...all, ...page];
            if (page.length < pageSize) break;
            from += pageSize;
          }
          return all;
        };

        const loadPrefs = (id) =>
          supabase.from("col_prefs").select("*").eq("id", id).maybeSingle()
            .then(r => r.data).catch(() => null);

        const loadPrefCols = (id) =>
          supabase.from("col_prefs").select("cols").eq("id", id).maybeSingle()
            .then(r => r.data).catch(() => null);

        // Fire everything at once
        const [
          rawContracts,
          pData, uData, nData, aiData, stratData,
          colData, sdData, chainCache, wlData,
          wlNotesData, wlAlertsData, oppData,
          goalsData, bandsData, mxData, trData,
        ] = await Promise.all([
          loadContracts(),
          supabase.from("plan_items").select("*").order("created_at", { ascending: false }).then(r => r.data),
          supabase.from("app_users").select("*").then(r => r.data),
          supabase.from("period_notes").select("*").then(r => r.data),
          supabase.from("ai_chats").select("*").order("created_at", { ascending: true }).limit(40).then(r => r.data).catch(() => null),
          supabase.from("strategies").select("*").order("created_at", { ascending: true }).then(r => r.data).catch(() => null),
          loadPrefs("default"),
          loadPrefs("stocks_data"),
          loadPrefCols("last_chain_refresh"),
          loadPrefs("watchlist"),
          loadPrefs("watchlist_notes"),
          loadPrefs("watchlist_alerts"),
          loadPrefs("opp_items"),
          loadPrefs("goals"),
          loadPrefs("profit_bands"),
          loadPrefs("dte_matrix"),
          loadPrefs("trade_rules"),
        ]);

        // ── Apply results ─────────────────────────────────────────────────────
        const loaded = rawContracts.map(toApp).filter(Boolean);
        setContracts(loaded.length ? loaded : SEED);
        if (!loaded.length && SEED.length) {
          const { error: seedErr } = await supabase.from("contracts").insert(SEED.map(toDB));
          if (!seedErr) setContracts(SEED);
        }

        if (pData) setPlanItems(pData.map(planToApp));

        if (uData?.length) setUsers(uData);
        else supabase.from("app_users").insert(USERS_DEFAULT).catch(() => {});

        if (nData?.length) {
          const map = {};
          nData.forEach(n => { map[n.period_key] = n.note; });
          setPeriodNotes(map);
        }

        if (aiData?.length)
          setAiMessages(aiData.map(r => ({ id: r.id, role: r.role, content: r.content, saved: true, starred: r.starred||false })));

        if (stratData?.length) setStrategies(stratData);

        if (colData?.cols) {
          const savedKeys = new Set(colData.cols.map(c => c.key));
          setCols([...colData.cols, ...DEFAULT_COLS.filter(c => !savedKeys.has(c.key))]);
        }

        if (chainCache?.cols?.chains) setEtradeChains(chainCache.cols.chains);
        if (sdData?.cols) setStocksData(sdData.cols);
        if (wlData?.cols?.tickers) setWatchlist(wlData.cols.tickers);
        if (wlNotesData?.cols) setWatchlistNotes(wlNotesData.cols);
        if (wlAlertsData?.cols) setWatchlistAlerts(wlAlertsData.cols);
        if (oppData?.cols) setOppItems(Array.isArray(oppData.cols) ? oppData.cols : []);
        if (goalsData?.cols) setGoals(goalsData.cols);
        if (bandsData?.cols) setBands(bandsData.cols);
        if (mxData?.cols) {
          const m = mxData.cols;
          if (m.otmRows) setMatrixOTMRows(m.otmRows);
          if (m.dteCols) setMatrixDTECols(m.dteCols);
          if (m.call)    setMatrixCall(m.call);
          if (m.put)     setMatrixPut(m.put);
        }
        if (trData?.cols) setTradeRules(trData.cols);

        setStorageMsg((loaded.length || SEED.length) + " contracts");
      } catch(err) {
        console.error("Load error:", err);
        setStorageMsg("DB error — check console");
      }
      setDbReady(true);
      loadTradeOrders();
    }
    load();
  }, []);

  const persist = async (updated) => {
    setContracts(updated);
    setStorageMsg(updated.length + " contracts");
    // Upsert all — efficient for small datasets, revisit for large
    try {
      await supabase.from("contracts").upsert(updated.map(toDB));
    } catch(err) { console.error("persist error:", err); }
  };

  const persistOne = async (contract) => {
    try {
      await supabase.from("contracts").upsert(toDB(contract));
    } catch(err) { console.error("persistOne error:", err); }
  };

  const deleteOne = async (id) => {
    try {
      await supabase.from("contracts").delete().eq("id", id);
    } catch(err) { console.error("deleteOne error:", err); }
  };

  const persistPlan = async (items) => {
    setPlanItems(items);
    // Full replace strategy: delete all, reinsert
    try {
      await supabase.from("plan_items").delete().neq("id", 0);
      if (items.length) await supabase.from("plan_items").insert(items.map(planToDB));
    } catch(err) { console.error("persistPlan error:", err); }
  };

  // ── Watchlist notes & alerts persistence ─────────────────────────────────
  const saveWatchlistNote = async (ticker, note) => {
    const updated = { ...watchlistNotes, [ticker]: note };
    setWatchlistNotes(updated);
    try { await supabase.from("col_prefs").upsert({ id: "watchlist_notes", cols: updated, updated_at: new Date().toISOString() }); } catch {}
  };
  const addWatchlistAlert = async (ticker, price) => {
    const cur = watchlistAlerts[ticker] || [];
    if (cur.includes(price)) return;
    const updated = { ...watchlistAlerts, [ticker]: [...cur, price] };
    setWatchlistAlerts(updated);
    try { await supabase.from("col_prefs").upsert({ id: "watchlist_alerts", cols: updated, updated_at: new Date().toISOString() }); } catch {}
  };
  const removeWatchlistAlert = async (ticker, price) => {
    const updated = { ...watchlistAlerts, [ticker]: (watchlistAlerts[ticker] || []).filter(a => a !== price) };
    setWatchlistAlerts(updated);
    try { await supabase.from("col_prefs").upsert({ id: "watchlist_alerts", cols: updated, updated_at: new Date().toISOString() }); } catch {}
  };

  // ── Opportunity items persistence ─────────────────────────────────────────
  const persistOpps = async (items) => {
    setOppItems(items);
    try {
      await supabase.from("col_prefs").upsert({ id: "opp_items", cols: items, updated_at: new Date().toISOString() });
    } catch(err) { console.error("persistOpps error:", err); }
  };
  const saveOppItem = (item) => persistOpps([item, ...oppItems]);
  const markOppDone = (id) => persistOpps(oppItems.map(o => o.id === id ? { ...o, status: "done" } : o));
  const skipOppItem = (id) => persistOpps(oppItems.map(o => o.id === id ? { ...o, status: "skipped" } : o));
  const deleteOppItem = (id) => persistOpps(oppItems.filter(o => o.id !== id));


  const persistCols = async (c) => {
    setCols(c);
    try {
      await supabase.from("col_prefs").upsert({ id:"default", cols:c, updated_at: new Date().toISOString() });
    } catch(err) { console.error("persistCols error:", err); }
  };

  const persistBands = async (b) => {
    setBands(b);
    try { await supabase.from("col_prefs").upsert({id:"profit_bands", cols:b, updated_at:new Date().toISOString()}); } catch {}
  };

  const persistMatrix = async (otmRows, dteCols, call, put) => {
    setMatrixOTMRows(otmRows); setMatrixDTECols(dteCols); setMatrixCall(call); setMatrixPut(put);
    try { await supabase.from("col_prefs").upsert({id:"dte_matrix", cols:{otmRows,dteCols,call,put}, updated_at:new Date().toISOString()}); } catch {}
  };

  const persistTradeRules = async (rules) => {
    setTradeRules(rules);
    try { await supabase.from("col_prefs").upsert({id:"trade_rules", cols:rules, updated_at:new Date().toISOString()}); } catch {}
  };

  // Get target % from OTM+DTE matrix for a contract
  const getMatrixTarget = (c) => {
    const refPrice = c.priceAtExecution || c.currentPrice;
    if (!refPrice || !c.strike || !c.expires) return null;
    const otmPct = c.type==="Put"
      ? ((refPrice - c.strike) / refPrice) * 100
      : ((c.strike - refPrice) / refPrice) * 100;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(c.expires+"T12:00:00");
    const dte = Math.max(0, Math.round((exp - today) / 86400000));
    const matrix = c.type==="Put" ? matrixPut : matrixCall;
    // Find OTM row
    let ri = matrixOTMRows.length - 1;
    for (let i=0; i<matrixOTMRows.length; i++) { if (otmPct >= matrixOTMRows[i].min) { ri=i; break; } }
    // Find DTE col
    let ci = matrixDTECols.length - 1;
    for (let i=0; i<matrixDTECols.length; i++) { if (dte <= matrixDTECols[i].max) { ci=i; break; } }
    const tgtPct = matrix[ri]?.[ci] ?? 0;
    if (!tgtPct) return null;
    const isBTO = c.optType==="BTO";
    const premPerShare = Math.abs(c.premium) / (c.qty||1) / 100;
    const targetPerShare = isBTO ? premPerShare*(1+tgtPct/100) : premPerShare*(1-tgtPct/100);
    const targetClose = targetPerShare * 100 * (c.qty||1);
    // Color by how close to target
    const bandColor = tgtPct>=65?"#00ff88":tgtPct>=55?"#ffd166":"#ff4560";
    return { otmPct, dte, tgtPct, targetPerShare, targetClose, bandColor, ri, ci };
  };

  // Compute OTM% and target profit % for a contract — uses matrix if available, falls back to bands
  const getContractBand = (c) => {
    const refPrice = c.priceAtExecution || c.currentPrice;
    if (!refPrice || !c.strike) {
      // Fallback: compute targetClose/targetPerShare from premium alone
      if (!c.premium || !c.qty) return null;
      const isBTO = c.optType === "BTO";
      const premPerShare = Math.abs(c.premium) / (c.qty||1) / 100;
      const tgtPct = 65;
      const targetPerShare = isBTO ? premPerShare*(1+tgtPct/100) : premPerShare*(1-tgtPct/100);
      const targetClose    = targetPerShare * 100 * (c.qty||1);
      return { otmPct: null, bandLabel: "—", bandColor: "#555", tgtPct, targetPerShare, targetClose, isBTO };
    }
    const otmPct = c.type==="Put"
      ? ((refPrice - c.strike) / refPrice) * 100
      : ((c.strike - refPrice) / refPrice) * 100;
    // Try matrix first — but only use it if tgtPct is non-zero
    const mx = getMatrixTarget(c);
    if (mx && mx.tgtPct) {
      const bandLabel = otmPct>=5?"Far OTM":otmPct>=3?"Mid OTM":otmPct>=1.5?"Near OTM":"Near/ATM";
      return { otmPct, bandLabel, bandColor:mx.bandColor, tgtPct:mx.tgtPct, targetPerShare:mx.targetPerShare, targetClose:mx.targetClose };
    }
    // Fall back to simple bands
    const key = (c.optType||"STO").toLowerCase() + (c.type||"Call");
    const otm1 = +bands[key+"OTM1"] || +bands.band1OTM || 3;
    const otm2 = +bands[key+"OTM2"] || +bands.band2OTM || 1.5;
    const pfx = c.optType==="STO"&&c.type==="Call"?"stoCall":c.optType==="STO"&&c.type==="Put"?"stoPut":c.optType==="BTO"&&c.type==="Call"?"btoCall":"btoPut";
    const t1 = +bands[pfx+"Tgt1"] || +bands.globalTgt1 || 70;
    const t2 = +bands[pfx+"Tgt2"] || +bands.globalTgt2 || 60;
    const t3 = +bands[pfx+"Tgt3"] || +bands.globalTgt3 || 50;
    let bandLabel, tgtPct, bandColor;
    if (otmPct >= otm1)      { bandLabel="Far OTM";  tgtPct=t1; bandColor="#00ff88"; }
    else if (otmPct >= otm2) { bandLabel="Mid OTM";  tgtPct=t2; bandColor="#ffd166"; }
    else                     { bandLabel="Near/ATM"; tgtPct=t3; bandColor="#ff4560"; }
    const isBTO = c.optType==="BTO";
    const premPerShare = Math.abs(c.premium) / (c.qty||1) / 100;
    const targetPerShare = isBTO ? premPerShare*(1+tgtPct/100) : premPerShare*(1-tgtPct/100);
    const targetClose = targetPerShare * 100 * (c.qty||1);
    return { otmPct, bandLabel, bandColor, tgtPct, targetPerShare, targetClose, isBTO };
  };

  const persistNotes = async (n) => {
    setPeriodNotes(n);
    try {
      const rows = Object.entries(n).map(([k,v]) => ({ period_key:k, note:v, updated_at:new Date().toISOString() }));
      if (rows.length) await supabase.from("period_notes").upsert(rows, { onConflict:"period_key" });
    } catch(err) { console.error("persistNotes error:", err); }
  };

  const persistUsers = async (updated) => {
    setUsers(updated);
    try {
      await supabase.from("app_users").upsert(updated);
    } catch(err) { console.error("persistUsers error:", err); }
  };

  // Auto-refresh every 30 seconds to pick up changes from other users
  const loadAllContracts = async () => {
    let all = [], from = 0;
    while (true) {
      const { data: pg, error } = await supabase.from("contracts").select("*").order("date_exec",{ascending:false}).range(from, from+999);
      if (error) { console.error("[loadAllContracts] fetch error:", error?.message, error?.status, error?.code); break; }
      if (!pg?.length) break;
      all = [...all, ...pg];
      if (pg.length < 1000) break;
      from += 1000;
    }
    return all.map(toApp).filter(Boolean);
  };

  useEffect(() => {
    if (!dbReady) return;
    const interval = setInterval(async () => {
      try {
        const loaded = await loadAllContracts();
        if (loaded.length) {
          setContracts(loaded);
          setStorageMsg(loaded.length + " contracts · synced " + new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
        }
      } catch {}
    }, 10000);
    // Supabase realtime subscription for instant sync
    const channel = supabase.channel("contracts-changes")
      .on("postgres_changes", {event:"*",schema:"public",table:"contracts"}, async () => {
        try {
          const loaded = await loadAllContracts();
          if (loaded.length) setContracts(loaded);
        } catch {}
      }).subscribe();
    return () => { clearInterval(interval); supabase.removeChannel(channel); };
  }, [dbReady]);

  // Browser fast-path: while the app is open, poll /api/chase-step every ~15s so
  // active chase orders get tighter re-pricing than the GitHub Actions runner's 20s
  // cadence alone. Purely additive — same idempotent endpoint, no duplicated logic.
  useEffect(() => {
    if (!dbReady) return;
    const poll = () => { fetch(`/api/chase-step?secret=${encodeURIComponent("CronSecret2026!")}`).catch(() => {}); };
    poll();
    const chaseInterval = setInterval(poll, 15000);
    return () => clearInterval(chaseInterval);
  }, [dbReady]);

  const tickerDefaults = ticker => {
    if (!ticker) return {};
    const t = ticker.toUpperCase();
    const tc = contracts.filter(c => c.stock?.toUpperCase() === t).sort((a,b) => new Date(b.dateExec) - new Date(a.dateExec));
    if (!tc.length) return {};
    const accs = [...new Set(tc.map(c => c.account).filter(Boolean))];
    return { account: accs.length === 1 ? accs[0] : "", qty: tc[0]?.qty || 1 };
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  // originals = contracts that are not linked close records (parentId is null)
  // close records (BTC/STC with parentId) only appear in the table, never in aggregations
  const originals = contracts.filter(c => !c.parentId && !["BTC","STC"].includes(c.optType));

  const applyG = list => list.filter(c => {
    if (gTicker  !== "All" && c.stock?.toUpperCase() !== gTicker) return false;
    if (gOptType !== "All" && c.optType !== gOptType) return false;
    if (gType    !== "All" && c.type   !== gType)    return false;
    return true;
  });
  const allF    = applyG(originals);
  const openC   = allF.filter(c => c.status === "Open");
  const closedC = allF.filter(c => c.status === "Closed");
  const totalPrem   = allF.reduce((s,c) => s+(c.premium||0), 0);

  // ── Automation stats ──────────────────────────────────────────────────────
  const autoClosedC    = closedC.filter(c => c.closeMethod === "auto");
  const appClosedC     = closedC.filter(c => c.closeMethod === "app");
  const manualClosedC  = closedC.filter(c => !c.closeMethod || c.closeMethod === "manual");
  const autoOpenC      = allF.filter(c => c.openMethod === "auto");  // all, open+closed
  const appOpenC       = allF.filter(c => c.openMethod === "app");
  const totalClosedAny = closedC.length || 1;
  const autoClosePct   = Math.round(autoClosedC.length / totalClosedAny * 100);
  const appClosePct    = Math.round(appClosedC.length / totalClosedAny * 100);
  const manualClosePct = Math.round(manualClosedC.length / totalClosedAny * 100);
  const autoProfit     = autoClosedC.reduce((s,c) => s+(c.profit||0), 0);
  const totalProfit = closedC.reduce((s,c) => s+(c.profit||0), 0); // ALL time, no date filter
  const openPrem    = openC.reduce((s,c) => s+Math.abs(c.premium||0), 0);
  // committedFunds moved below etradeChains declaration
  const winRate  = closedC.length ? (closedC.filter(c=>c.profit>0).length/closedC.length*100).toFixed(0) : 0;
  const avgProfit = closedC.length ? totalProfit/closedC.length : 0;
  const allTickers = [...new Set(originals.map(c=>c.stock?.toUpperCase()).filter(Boolean))].sort();
  const now2 = new Date();
  const thisYear  = now2.getFullYear().toString();
  const thisMonth = now2.toISOString().slice(0,7);
  const premYTD = allF.filter(c=>c.dateExec?.startsWith(thisYear)).reduce((s,c)=>s+(c.premium||0),0);
  const premMTD = allF.filter(c=>c.dateExec?.startsWith(thisMonth)).reduce((s,c)=>s+(c.premium||0),0);
  // profitMTD/YTD computed after profitDateMode state is declared (see below)
  // Transaction counts (each contract row = 1; open+close = 2 transactions)
  const txCount = contracts.length; // every row is a transaction
  const optionsTxCount = contracts.filter(c=>c.type==="Call"||c.type==="Put").length;
  const mLabel  = now2.toLocaleString("default",{month:"short"})+" "+thisYear;

  // Stocks tab state
  const [stocksData, setStocksData] = useState({}); // {ticker: {sharesSchwab, sharesEtrade, currentPrice, earningsDate}}
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [pendingOrder, setPendingOrder] = useState(null); // { strike, expiry, qty, price, account } — preloaded from notification deep-link
  const [stocksFilter, setStocksFilter] = useState("owned"); // "all" | "owned"
  const [showAddStock, setShowAddStock] = useState(false);
  const [addStockForm, setAddStockForm] = useState({ticker:"",schwabShares:"",etradeShares:"",price:"",earningsDate:""});
  const [stocksSortKey, setStocksSortKey] = useState("ticker");
  const [stocksSortDir, setStocksSortDir] = useState("asc");
  const toggleStocksSort = key => {
    if (stocksSortKey===key) setStocksSortDir(d=>d==="asc"?"desc":"asc");
    else { setStocksSortKey(key); setStocksSortDir("asc"); }
  };
  // Cash balances stored in stocksData under special key "__cash__"
  const cashData = stocksData["__cash__"] || {};

  const [portfolioSnapshots, setPortfolioSnapshots] = useState([]);
  useEffect(() => {
    supabase.from("portfolio_snapshots")
      .select("snapshot_date,total_value,schwab_value,etrade_value,total_cash,daily_change,daily_change_pct,open_contracts_value")
      .order("snapshot_date", { ascending: true })
      .limit(90)
      .then(({ data }) => { if (data) setPortfolioSnapshots(data); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Balance history inline state for analytics table columns
  const [balHistoryInline, setBalHistoryInline] = useState({});
  const nowMonthKey = new Date().toISOString().slice(0,7);
  const [schwabAccountValue, setSchwabAccountValue] = useState(0);
  // Seed from portfolio_snapshots on cold load — most recent daily snapshot has correct account values
  // portfolioSnapshots is ordered ascending by date, so the latest is the LAST entry, not [0]
  const latestSnapshot = portfolioSnapshots[portfolioSnapshots.length - 1] ?? null;
  const snapSchwab = latestSnapshot?.schwab_value > 0 ? +latestSnapshot.schwab_value : null;
  const snapEtrade = latestSnapshot?.etrade_value > 0 ? +latestSnapshot.etrade_value : null;
  // liveEtradeInline: most reliable current ETrade value — snapshot → cachData → null
  const liveEtradeInline = snapEtrade ?? (cashData?.etrade ? +cashData.etrade : null);
  const liveSchwabInline = schwabAccountValue > 0 ? schwabAccountValue : snapSchwab ?? (cashData?.schwab ? +cashData.schwab : null);
  // getMonthTotal: total only counts when BOTH Schwab and ETrade have a value for that month —
  // summing with (x||0) when one side is untracked yet silently inflates gains once the missing
  // account starts being tracked (looks like a huge MoM/YTD jump that isn't a real gain).
  const getMonthTotal = (key) => {
    const b = balHistoryInline?.[key] || {};
    const schwab = b.schwab ?? (key===nowMonthKey && liveSchwabInline ? liveSchwabInline : null);
    const etrade = b.etrade ?? (key===nowMonthKey && liveEtradeInline ? liveEtradeInline : null);
    const total  = (schwab!=null && etrade!=null) ? (+schwab||0)+(+etrade||0) : null;
    return { schwab, etrade, total };
  };
  useEffect(()=>{
    supabase.from("col_prefs").select("cols").eq("id","balance_history").maybeSingle()
      .then(({data})=>{ if(data?.cols) setBalHistoryInline(data.cols); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const updateCash = async (field, value) => {
    const cashVal = value === "" ? null : +value;
    const updated = {...stocksData, "__cash__": {...cashData, [field]: cashVal}};
    setStocksData(updated);
    try { await supabase.from("col_prefs").upsert({id:"stocks_data", cols: updated, updated_at: new Date().toISOString()}); } catch {}
  };
  // AI Chat state
  const [showAI, setShowAI] = useState(false);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiEndRef = useRef(null);

  // Watchlist helpers
  const [selectedWatchTicker, setSelectedWatchTicker] = useState(null);
  const addToWatchlist = async (ticker) => {
    const t = ticker.toUpperCase().trim();
    if (!t || watchlist.includes(t)) return;
    const updated = [...watchlist, t];
    setWatchlist(updated);
    try { await supabase.from("col_prefs").upsert({id:"watchlist", cols:{tickers:updated}, updated_at:new Date().toISOString()}); } catch {}

    // Pull stock info immediately if not already in stocksData
    if (!stocksData[t]?.currentPrice) {
      try {
        const qRes = await fetch(`/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(t)}&fields=quote,fundamental&indicative=false`);
        if (qRes.ok) {
          const qData = await qRes.json();
          const q = qData?.[t]?.quote;
          const fund = qData?.[t]?.fundamental;
          if (q) {
            const info = {
              currentPrice: q.lastPrice ?? q.mark ?? null,
              bid:          q.bidPrice  ?? null,
              ask:          q.askPrice  ?? null,
              changePct:    q.netPercentChangeInDouble != null ? q.netPercentChangeInDouble / 100 : null,
              changeClose:  q.netChange ?? null,
              lastQuoteAt:  new Date().toISOString(),
              // Fundamental data
              week52High:   fund?.["52WeekHigh"]  ?? null,
              week52Low:    fund?.["52WeekLow"]   ?? null,
              peRatio:      fund?.peRatio         ?? null,
              divYield:     fund?.divYield        ?? null,
              marketCap:    fund?.marketCap       ?? null,
              sharesUpdatedAt: new Date().toISOString(),
            };
            const updatedSD = { ...stocksData, [t]: { ...(stocksData[t] || {}), ...info } };
            setStocksData(updatedSD);
            await supabase.from("col_prefs").upsert({ id:"stocks_data", cols:updatedSD, updated_at:new Date().toISOString() });
            console.log(`[watchlist] pulled info for ${t}: $${info.currentPrice}`);
          }
        }
      } catch(e) { console.warn(`[watchlist] failed to pull info for ${t}:`, e.message); }
    }
  };
  const removeFromWatchlist = async (ticker) => {
    const updated = watchlist.filter(t => t !== ticker);
    setWatchlist(updated);
    if (selectedWatchTicker === ticker) setSelectedWatchTicker(null);
    try { await supabase.from("col_prefs").upsert({id:"watchlist", cols:{tickers:updated}, updated_at:new Date().toISOString()}); } catch {}
  };

  const updateStockData = async (ticker, field, value) => {
    const updated = {...stocksData, [ticker]: {...(stocksData[ticker]||{}), [field]: value}};
    setStocksData(updated);
    try { await supabase.from("col_prefs").upsert({id:"stocks_data", cols: updated, updated_at: new Date().toISOString()}); } catch {}
  };

  // ── E*TRADE live data ───────────────────────────────────────────────────────────────────────────
  const [etradeStatus, setEtradeStatus]       = useState("idle"); // idle | loading | ok | error
  const [etradeMsg, setEtradeMsg]             = useState("");
  const [etradeChains, setEtradeChains]       = useState({}); // { "TICKER|YYYY-MM-DD": {calls,puts} }
  // Open Contract Value: STO = negative (liability at market), BTO = positive (asset at market)
  const openContractValue = openC.reduce((s,c) => {
    const lo = findOptionForContract(etradeChains || {}, c);
    const mktVal = (lo?.bid!=null&&lo?.ask!=null) ? (lo.bid+lo.ask)/2*(c.qty||1)*100 : lo?.mark!=null ? lo.mark*(c.qty||1)*100
                 : lo?.last!=null ? lo.last*(c.qty||1)*100
                 : null; // no market data — exclude
    if (mktVal==null) return s;
    return s + (c.optType==="BTO" ? mktVal : -mktVal);
  }, 0);
  // Keep committedFunds for plan tab available-to-write calculation (still uses strike-based for puts)
  const stoLiability   = openC.filter(c=>c.optType==="STO"&&c.type==="Put").reduce((s,c)=>s+(Math.abs(c.strike||0)*(c.qty||0)*100),0);
  const btoAssetVal    = openC.filter(c=>c.optType==="BTO").reduce((s,c)=>{const lo=findOptionForContract(etradeChains||{},c);return s+((lo?.bid!=null&&lo?.ask!=null)?(lo.bid+lo.ask)/2*(c.qty||1)*100:lo?.mark!=null?lo.mark*(c.qty||1)*100:Math.abs(c.premium||0));},0);
  const committedFunds = stoLiability - btoAssetVal;
  const [etradeLastFetch, setEtradeLastFetch] = useState(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(()=>{ try{ return localStorage.getItem("pri_auto_refresh")!=="off"; }catch{ return true; } });
  const [lastAutoRefreshAt, setLastAutoRefreshAt] = useState(null);
  const [schwabPositions, setSchwabPositions]   = useState([]);
  const [watchlist, setWatchlist]               = useState([]); // array of ticker strings
  const [watchlistNotes, setWatchlistNotes]     = useState({});
  const [watchlistAlerts, setWatchlistAlerts]   = useState({});
  const [watchlistChainOpen, setWatchlistChainOpen] = useState({});
  const [oppItems, setOppItems]                 = useState([]);
  const [oppForm, setOppForm]                   = useState(null);
  const [watchlistInput, setWatchlistInput]     = useState("");
  const [stockContractFilter, setStockContractFilter] = useState("open"); // "open" | "all"
  // Option chain controls — per ticker, stored as { [ticker]: { strikes: 5, dates: 3 } }
  // Collapsed expiry dates — set of "TICKER|YYYY-MM-DD" keys, default collapsed
  const [collapsedChainDates, setCollapsedChainDates] = useState(new Set(["__all__"])); // __all__ = all collapsed by default
  const toggleChainDate = (ticker, exp) => {
    const key = `${ticker}|${exp}`;
    setCollapsedChainDates(prev => {
      const next = new Set(prev);
      // Remove __all__ sentinel on first interaction
      next.delete("__all__");
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const isChainDateCollapsed = (ticker, exp) => {
    if (collapsedChainDates.has("__all__")) return true; // all collapsed by default
    return collapsedChainDates.has(`${ticker}|${exp}`);
  };
  const [chainControls, setChainControls] = useState({});
  const getChainControl = (ticker) => ({ strikes: 5, dates: 3, ...chainControls[ticker] });
  const setChainControl = (ticker, key, val) => setChainControls(prev => ({ ...prev, [ticker]: { ...getChainControl(ticker), [key]: val } }));
  // selectedWatchTicker declared above near watchlist helpers
  // Merge live quote prices into stocksData and persist
  const applyQuotesToStocksData = useCallback(async (quotes) => {
    setStocksData(prev => {
      const updated = { ...prev };
      for (const [ticker, q] of Object.entries(quotes)) {
        if (q.lastPrice != null) {
          updated[ticker] = {
            ...(updated[ticker] || {}),
            currentPrice: q.lastPrice,
            bid:          q.bid,
            ask:          q.ask,
            changeClose:  q.changeClose,
            changePct:    q.changePct,
            lastQuoteAt:  q.fetchedAt,
          };
        }
      }
      try { supabase.from("col_prefs").upsert({ id: "stocks_data", cols: updated, updated_at: new Date().toISOString() }); } catch {}
      return updated;
    });
  }, []);

  // Main refresh: quotes for all tracked tickers + option chains for open positions
  const refreshEtrade = useCallback(async () => {
    if (etradeStatus === "loading") return;
    setEtradeStatus("loading");
    setEtradeMsg("Connecting to E*TRADE sandbox…");
    try {
      // Only fetch quotes for tickers that have open contracts
      const openTickers = [
        ...new Set(
          originals
            .filter(c => c.status === "Open" && c.stock)
            .map(c => c.stock.toUpperCase())
        )
      ];
      if (!openTickers.length) {
        setEtradeStatus("ok");
        setEtradeMsg("No open contracts to refresh");
        return;
      }
      // Fetch Schwab stock positions
      setEtradeMsg("Fetching Schwab positions…");
      try {
        const { stocks, cash, accountValue } = await fetchPositions();
        setSchwabPositions(stocks);
        // Auto-populate stocksData with live position data
        setStocksData(prev => {
          const updated = { ...prev };
          const schwabSymbols = new Set(stocks.map(p => p.symbol));
          // Zero out sharesSchwab for any ticker no longer held in Schwab
          for (const sym of Object.keys(updated)) {
            if (sym === "__cash__") continue;
            if (updated[sym]?.sharesSchwab > 0 && !schwabSymbols.has(sym)) {
              updated[sym] = { ...updated[sym], sharesSchwab: 0 };
            }
          }
          for (const pos of stocks) {
            updated[pos.symbol] = {
              ...(updated[pos.symbol] || {}),
              sharesSchwab:  Math.floor(pos.qty),
              currentPrice:  pos.marketValue / pos.qty,
              avgPrice:      pos.avgPrice,
              gainLoss:      pos.gainLoss,
              gainLossPct:   pos.gainLossPct,
              currentDayGL:  pos.currentDayGL,
              currentDayGLPct: pos.currentDayGLPct,
              lastQuoteAt:   new Date().toISOString(),
            };
          }
          try { supabase.from("col_prefs").upsert({ id:"stocks_data", cols:updated, updated_at:new Date().toISOString() }); } catch {}
          return updated;
        });
        // Update Schwab cash
        // Store full liquidation value as the persistent Schwab balance (not just buying power)
        if (accountValue > 0) updateCash("schwab", accountValue.toFixed(2));
        else if (cash > 0)   updateCash("schwab", cash.toFixed(2));
        // Auto-save current month Schwab balance (liquidation value) to balance_history
        if (accountValue > 0) {
          setSchwabAccountValue(accountValue);
          const mk = new Date().toISOString().slice(0,7);
          supabase.from("col_prefs").select("cols").eq("id","balance_history").maybeSingle()
            .then(({data}) => {
              const hist = data?.cols || {};
              const updated = { ...hist, [mk]: { ...(hist[mk]||{}), schwab: accountValue, schwabAuto: true } };
              supabase.from("col_prefs").upsert({ id:"balance_history", cols:updated, updated_at:new Date().toISOString() }, {onConflict:"id"});
              setBalHistoryInline(updated);
            });
        }
        console.log("[schwab] loaded", stocks.length, "positions, cash:", cash, "accountValue:", accountValue);
      } catch (posErr) {
        console.warn("[schwab] positions fetch failed:", posErr.message);
      }

      // Fetch ETrade positions and write sharesEtrade
      try {
        setEtradeMsg("Fetching ETrade positions…");
        const etRes  = await fetch("/api/etrade?action=positions&secret=CronSecret2026!");
        const etData = await etRes.json();
        // Auto-populate ETrade account value from API response
        // ETrade NAV = equity market value + cash (matches Schwab liquidationValue semantics)
        const etNAV = (etData?.accountValue || 0) + (etData?.cash || 0);
        if (etNAV > 0) {
          updateCash("etrade", etNAV.toFixed(2));
          console.log("[etrade] NAV:", etNAV, "(equity:", etData?.accountValue, "+ cash:", etData?.cash, ")");
        }
        if (etData?.positions?.length) {
          // Group by symbol — sum across both ETrade accounts, floor to whole shares
          const etradeShares = {};
          for (const p of etData.positions) {
            const sym = p.symbol?.toUpperCase();
            if (!sym) continue;
            etradeShares[sym] = (etradeShares[sym] || 0) + Math.floor(p.qty || 0);
          }
          setStocksData(prev => {
            const updated = { ...prev };
            // First clear sharesEtrade for any symbol no longer held
            for (const sym of Object.keys(updated)) {
              if (sym === "__cash__") continue;
              if (updated[sym]?.sharesEtrade != null && !etradeShares[sym]) {
                updated[sym] = { ...updated[sym], sharesEtrade: 0 };
              }
            }
            // Write current ETrade holdings
            for (const [sym, qty] of Object.entries(etradeShares)) {
              updated[sym] = { ...(updated[sym] || {}), sharesEtrade: qty };
            }
            try { supabase.from("col_prefs").upsert({ id: "stocks_data", cols: updated, updated_at: new Date().toISOString() }); } catch {}
            return updated;
          });
          console.log("[etrade] loaded", Object.keys(etradeShares).length, "positions");
        }
      } catch (etPosErr) {
        console.warn("[etrade] positions fetch failed:", etPosErr.message);
      }

      setEtradeMsg("Fetching quotes for " + openTickers.length + " open ticker(s)…");
      const quotes = await fetchQuotes(openTickers);
      await applyQuotesToStocksData(quotes);

      // Stamp currentPrice (stock price) onto each open contract for ITM/OTM display
      // Also fetch chains for watchlist tickers (using nearest expiries)
      // We'll fetch for open contracts + watchlist combos
      const openContracts = originals.filter(c => c.status === "Open" && c.stock && c.expires);
      const updatedContracts = contracts.map(c => {
        if (c.status !== "Open" || !c.stock) return c;
        const q = quotes[c.stock.toUpperCase()];
        if (!q || q.lastPrice == null) return c;
        return { ...c, currentPrice: q.lastPrice };
      });
      setContracts(updatedContracts);
      try { await supabase.from("contracts").upsert(updatedContracts.map(toDB)); } catch {}

      // Fetch option chains — sandbox returns errors/empty data, so failures are non-fatal
      let freshChains = {};
      if (openContracts.length) {
        setEtradeMsg("Fetching option chains…");
        try {
          freshChains = await fetchOpenPositionChains(openContracts);

          // Patch live NBBO quotes into chains for all open contracts.
          // Schwab's chain endpoint serves stale mark for low-volume options;
          // the quotes endpoint always returns real-time bid/ask.
          try {
            const occMap = {}; // occSymbol -> { chainKey, type, strike }
            for (const c of openContracts) {
              const occ = buildOCCSymbol(c);
              if (occ) occMap[occ] = { chainKey: `${c.stock.toUpperCase()}|${c.expires}`, type: c.type, strike: Number(c.strike) };
            }
            const occSymbols = Object.keys(occMap);
            console.log("[optQuote] OCC symbols built:", occSymbols);
            if (occSymbols.length) {
              setEtradeMsg("Fetching live option quotes…");
              const liveQuotes = await fetchOptionQuotes(occSymbols);
              for (const [occ, q] of Object.entries(liveQuotes)) {
                const { chainKey, type, strike } = occMap[occ] || {};
                if (!chainKey) continue;
                // Ensure chain bucket exists
                if (!freshChains[chainKey]) freshChains[chainKey] = { calls: [], puts: [] };
                const list = type === "Put" ? freshChains[chainKey].puts : freshChains[chainKey].calls;
                const entry = list.find(o => Math.abs(Number(o.strike ?? o.strikePrice) - strike) < 0.01);
                if (entry) {
                  // Patch existing entry with live NBBO
                  entry.bid = q.bid ?? entry.bid;
                  entry.ask = q.ask ?? entry.ask;
                  entry.last = q.last ?? entry.last;
                } else {
                  // Strike was outside strikeCount window — insert it from live quote
                  list.push({ strike, bid: q.bid, ask: q.ask, last: q.last, mark: q.mark, strikePrice: strike });
                  console.log("[optQuote] INSERTED", occ, "bid:", q.bid, "ask:", q.ask, "into", chainKey, "list now:", list.length);
                }
              }
            }
          } catch (qErr) {
            console.warn("[etrade] live option quote patch failed:", qErr.message);
          }

          setEtradeChains(freshChains);
        } catch (chainErr) {
          console.warn("[etrade] option chains unavailable in sandbox:", chainErr.message);
        }
      }


      // Evaluate signals and send Pushover notifications
      // Notifications handled by market-refresh cron — no browser-side notify needed

      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setEtradeLastFetch(now);
      setEtradeStatus("ok");
      setEtradeMsg("Synced " + Object.keys(quotes).length + " quote(s) at " + now);
    } catch (err) {
      console.error("[etrade] refresh error:", err);
      setEtradeStatus("error");
      const msg = err.message || "Unknown error";
      // Give actionable hints for common errors
      if (msg.includes("401")) {
        setEtradeMsg("401 Unauthorized — access token expired. Re-run OAuth flow to get a new token (tokens expire at midnight ET).");
      } else if (msg.includes("404")) {
        setEtradeMsg("404 Not Found — check that your consumer key is correct and your access token was obtained from the sandbox OAuth flow.");
      } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
        setEtradeMsg("Network error — is the Vite dev server running? The proxy only works in dev (npm run dev).");
      } else {
        setEtradeMsg(msg);
      }
    }
  }, [etradeStatus, originals, contracts, stocksData, applyQuotesToStocksData]);



  // Poll Supabase for background refresh data (quotes updated by server cron)
  // Must be after applyQuotesToStocksData is declared
  useEffect(() => {
    let lastRefreshSeen = null;
    let lastChainSeen = null;

    const pollRefresh = async () => {
      try {
        // Poll quotes (market-refresh cron)
        const { data } = await supabase
          .from("col_prefs")
          .select("cols")
          .eq("id", "last_market_refresh")
          .maybeSingle();

        if (data?.cols?.lastRefresh && data.cols.lastRefresh !== lastRefreshSeen) {
          lastRefreshSeen = data.cols.lastRefresh;
          const freshQuotes = data.cols.quotes || {};
          if (Object.keys(freshQuotes).length > 0) {
            await applyQuotesToStocksData(freshQuotes);
            const t = new Date(data.cols.lastRefresh).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"});
            setEtradeMsg("Auto-refreshed at " + t);
          }
        }

        // Poll chains independently (chain-refresh cron runs separately)
        const { data: chainData } = await supabase
          .from("col_prefs").select("cols").eq("id","last_chain_refresh").maybeSingle();
        if (chainData?.cols?.chains && chainData.cols.lastRefresh !== lastChainSeen) {
          lastChainSeen = chainData.cols.lastRefresh;
          setEtradeChains(chainData.cols.chains);
        }
      } catch { /* network hiccup */ }
    };

    const getInterval = () => {
      const et   = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
      const mins = et.getHours()*60 + et.getMinutes();
      const day  = et.getDay();
      if (day===0||day===6) return 5*60*1000;
      if (mins>=570&&mins<630) return 60*1000;    // 9:30-10:30 ET: every 1 min
      if (mins>=630&&mins<960) return 5*60*1000;  // 10:30-4pm ET: every 5 min
      return 10*60*1000;
    };

    const wrappedPoll = async () => {
      if (!localStorage.getItem("pri_auto_refresh") || localStorage.getItem("pri_auto_refresh") !== "off") {
        await pollRefresh();
        setLastAutoRefreshAt(new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
      }
    };
    wrappedPoll();
    let timer = setInterval(()=>{
      wrappedPoll();
      clearInterval(timer);
      timer = setInterval(wrappedPoll, getInterval());
    }, getInterval());

    return () => clearInterval(timer);
  }, [applyQuotesToStocksData]);

  // Get live bid/ask/last for a specific open contract from cached chains
  const getLiveOption = useCallback((contract) => {
    return findOptionForContract(etradeChains, contract);
  }, [etradeChains]);

  // On-demand chain fetch for a specific ticker with controls
  const fetchChainForTicker = useCallback(async (ticker, strikes = 5, dates = 3) => {
    try {
      const data = await schwabGet("/marketdata/v1/chains", {
        symbol: ticker.toUpperCase(),
        contractType: "ALL",
        strikeCount: strikes * 2,  // above + below ATM
      });
      const calls = [], puts = [];
      const allExpiries = [...new Set([
        ...Object.keys(data?.callExpDateMap || {}),
        ...Object.keys(data?.putExpDateMap  || {}),
      ])].sort().slice(0, dates);  // take first N expiry dates

      for (const expKey of allExpiries) {
        const expDate = expKey.split(":")[0];
        const cStrikes = data?.callExpDateMap?.[expKey] || {};
        const pStrikes = data?.putExpDateMap?.[expKey]  || {};
        for (const [, opts] of Object.entries(cStrikes)) for (const o of opts)
          calls.push({ ticker, expiryDate:expDate, type:"Call", strike:o.strikePrice, bid:o.bid, ask:o.ask, mark:o.mark??(o.bid+o.ask)/2, last:o.last??o.mark??null, volume:o.totalVolume, openInterest:o.openInterest, iv:o.volatility, delta:o.delta, gamma:o.gamma, theta:o.theta, vega:o.vega, inTheMoney:o.inTheMoney });
        for (const [, opts] of Object.entries(pStrikes)) for (const o of opts)
          puts.push({ ticker, expiryDate:expDate, type:"Put", strike:o.strikePrice, bid:o.bid, ask:o.ask, mark:o.mark??(o.bid+o.ask)/2, last:o.last??o.mark??null, volume:o.totalVolume, openInterest:o.openInterest, iv:o.volatility, delta:o.delta, gamma:o.gamma, theta:o.theta, vega:o.vega, inTheMoney:o.inTheMoney });
      }
      setEtradeChains(prev => ({ ...prev, [`${ticker.toUpperCase()}|live`]: { calls, puts, fetchedAt: Date.now() } }));
    } catch(e) { console.warn("[schwab] chain fetch failed:", ticker, e.message); }
  }, []);

  // Signal evaluation + Pushover notifications
  // Chart data builder
  const mkChartData = (list, view, dateField) => {
    const map = {};
    list.forEach(c => {
      const rawDate = dateField === "closed" ? c.closeDate : c.dateExec;
      if (!rawDate || rawDate.length < 7) return;
      let key;
      if (view === "monthly") {
        key = rawDate.slice(0,7);
      } else if (view === "weekly") {
        const d = new Date(rawDate + "T12:00:00"); const wm = new Date(d); wm.setDate(d.getDate()-d.getDay()+1);
        key = wm.toISOString().slice(0,10);
      } else { // daily
        key = rawDate.slice(0,10);
      }
      if (!map[key]) map[key] = {key, label:"", premium:0, profit:0, contracts:0};
      map[key].premium   += (c.premium||0);
      map[key].contracts += 1;
      if (c.status === "Closed" && c.profit != null) map[key].profit += c.profit;
    });
    const ns = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return Object.values(map).sort((a,b)=>a.key.localeCompare(b.key)).map(v => {
      if (view === "monthly") {
        const [yr,mo] = v.key.split("-");
        v.label = ns[+mo] + " " + yr.slice(2);
      } else {
        v.label = v.key.slice(5);
      }
      return v;
    });
  };
  const chartData = mkChartData(allF, chartView, chartDate);

  // Monthly/weekly for Analytics — dateMode: "exec" (default) or "close"
  const mkPeriodData = (list, view, dateMode="exec") => {
    const toKey = (dateStr) => {
      if (!dateStr) return null;
      const d = dateStr.slice(0,10);
      if (view === "monthly") return d.slice(0,7);
      if (view === "weekly") { const dt = new Date(d+"T12:00:00"); const wm = new Date(dt); wm.setDate(dt.getDate()-dt.getDay()+1); return wm.toISOString().slice(0,10); }
      return d;
    };
    const map = {};
    const ensureBucket = (key) => { if (key && !map[key]) map[key] = {key, premium:0, profit:0, contracts:0}; };

    if (dateMode === "accounting") {
      // Accounting mode: cash basis — when was cash received or paid?
      // Only process originals (STO/BTO), skip BTC/STC child rows.
      //
      // CLOSED trades: split into two legs
      //   Open leg (premium) → dateExec bucket. STO=+cash in, BTO=-cash out
      //   Close leg (costToClose) → closeDate bucket. Always cash out (negate positive value)
      //
      // OPEN trades: only the open leg has occurred
      //   Open STO → premium already received = +cash in on dateExec
      //   Open BTO → premium already paid = -cash out on dateExec
      list.filter(c => ["STO","BTO"].includes(c.optType)).forEach(c => {
        const openKey = toKey(c.dateExec);
        if (!openKey) return;
        ensureBucket(openKey);
        map[openKey].premium   += (c.premium || 0);
        map[openKey].contracts += 1;
        // Open leg: STO premium is positive (cash in), BTO premium is negative (cash out)
        map[openKey].profit    += (c.premium || 0);

        // Close leg: only if closed and has costToClose
        if (c.status === "Closed" && c.costToClose != null) {
          const closeKey = toKey(c.closeDate || c.dateExec);
          ensureBucket(closeKey);
          // STO close = buy back = cash OUT → negate costToClose
          // BTO close = sell = cash IN → add costToClose
          if (c.optType === "STO") map[closeKey].profit -= (c.costToClose || 0);
          else                     map[closeKey].profit += (c.costToClose || 0);
        }
      });
    } else {
      // exec or close mode — original behavior
      list.forEach(c => {
        const d = c.dateExec?.slice(0,10); if (!d) return;
        const openKey = toKey(d);
        ensureBucket(openKey);
        map[openKey].premium   += (c.premium||0);
        map[openKey].contracts += 1;
        if (c.status==="Closed" && c.profit!=null) {
          const profitDate = dateMode==="close" && c.closeDate ? c.closeDate.slice(0,10) : d;
          const pk = toKey(profitDate);
          ensureBucket(pk);
          map[pk].profit += c.profit;
        }
      });
    }

    const ns = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return Object.values(map).sort((a,b)=>a.key.localeCompare(b.key)).map(v => {
      if (view==="monthly") { const [yr,mo]=v.key.split("-"); v.label=ns[+mo]+" "+yr.slice(2); }
      else if (view==="weekly") { v.label = "Wk "+v.key.slice(5); }
      else { v.label = v.key.slice(5); }
      return v;
    });
  };
  const [analyticsView,setAnalyticsView] = useState("monthly");
  const [showBalCols,setShowBalCols]     = useState(true);   // hide/show Schwab/ETrade/Total/MoM/YTD cols
  useEffect(() => {
    supabase.from("col_prefs").select("cols").eq("id","balance_cols_visible").maybeSingle()
      .then(({data})=>{ if(data?.cols?.showBalCols!=null) setShowBalCols(data.cols.showBalCols); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleBalCols = () => {
    setShowBalCols(v => {
      const next = !v;
      supabase.from("col_prefs").upsert({id:"balance_cols_visible", cols:{showBalCols:next}, updated_at:new Date().toISOString()}, {onConflict:"id"}).then(()=>{});
      return next;
    });
  };

  const [profitDateMode,setProfitDateMode] = useState("accounting"); // "exec" | "close" | "accounting"
  const [chainTradeOrder, setChainTradeOrder] = useState(null);
  const [orderPreview,   setOrderPreview]   = useState(null);
  const [orderControls,  setOrderControls]  = useState({orderType:"LIMIT",duration:"DAY",specialInstruction:"NONE",limitPrice:null,qty:null});
  const [orderLoading,   setOrderLoading]   = useState(false);
  const [orderError,     setOrderError]     = useState(null);
  const [orderSuccess,   setOrderSuccess]   = useState(null);
  const [showRawJson,    setShowRawJson]    = useState(false);
  const [orderStatuses,  setOrderStatuses]  = useState({});
  const [tradeOrders,    setTradeOrders]    = useState([]);
  const [ordersLoading,  setOrdersLoading]  = useState(false);
  const [chaseModal,     setChaseModal]     = useState(null); // { order, floor, step, saving }

  const loadTradeOrders = async () => {
    setOrdersLoading(true);
    try {
      const r = await fetch(`/api/schwab-orders?action=list&secret=${encodeURIComponent("CronSecret2026!")}`);
      const data = await r.json();
      if (data.ok) setTradeOrders((data.orders||[]).filter(o=>!["filled","cancelled","error"].includes(o.status)));
    } catch(e) { console.warn("loadTradeOrders:", e.message); }
    setOrdersLoading(false);
  };

  const cancelTradeOrder = async (orderId) => {
    try {
      const order    = tradeOrders.find(o => o.id === orderId);
      const isETrade = order?.account?.startsWith("ETrade");
      const url      = isETrade
        ? `/api/schwab-orders?action=order-cancel&secret=${encodeURIComponent("CronSecret2026!")}`
        : `/api/schwab-orders?action=cancel&secret=${encodeURIComponent("CronSecret2026!")}`;
      const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({orderId:String(orderId)}) });
      const data = await r.json();
      if (!r.ok) { alert(`Cancel failed: ${data.error||r.status}`); return; }
      loadTradeOrders();
    } catch(e) { alert(`Cancel error: ${e.message}`); }
  }; // { ticker, expiry, optType, strike, bid, ask, mid }

  const profitDateField = (c) => profitDateMode==="close" ? (c.closeDate || c.dateExec) : c.dateExec;

  // ── Accounting mode: split each trade into open-leg (premium) and close-leg (cost_to_close)
  // Premium (cash received) → attributed to dateExec (open date)
  // Cost to close (cash paid) → attributed to closeDate
  // This matches how brokerages report for tax purposes
  const accountingByPeriod = (contracts, periodPrefix) => {
    let total = 0;
    for (const c of contracts) {
      if (!["STO","BTO"].includes(c.optType)) continue;
      // Open leg: premium in the open period (STO=+cash in, BTO=-cash out)
      if (c.dateExec?.startsWith(periodPrefix)) {
        total += (c.premium || 0);
      }
      // Close leg: STO close = buy back = cash out (-), BTO close = sell = cash in (+)
      if (c.status === "Closed" && c.costToClose != null) {
        const cd = c.closeDate || c.dateExec;
        if (cd?.startsWith(periodPrefix)) {
          if (c.optType === "STO") total -= (c.costToClose || 0);
          else                     total += (c.costToClose || 0);
        }
      }
    }
    return total;
  };

  const profitMTD = profitDateMode === "accounting"
    ? accountingByPeriod(allF, thisMonth)
    : closedC.filter(c=>profitDateField(c)?.startsWith(thisMonth)).reduce((s,c)=>s+(c.profit||0),0);
  const profitYTD = profitDateMode === "accounting"
    ? accountingByPeriod(allF, thisYear)
    : closedC.filter(c=>profitDateField(c)?.startsWith(thisYear)).reduce((s,c)=>s+(c.profit||0),0);
  // Daily
  const todayKey = new Date().toISOString().slice(0,10);
  const profitToday = profitDateMode === "accounting"
    ? accountingByPeriod(allF, todayKey)
    : closedC.filter(c=>profitDateField(c)?.startsWith(todayKey)).reduce((s,c)=>s+(c.profit||0),0);
  const premToday   = allF.filter(c=>c.dateExec?.startsWith(todayKey)).reduce((s,c)=>s+(c.premium||0),0);
  const periodData = mkPeriodData(allF, analyticsView, profitDateMode);

  // ── Per-broker profit — same date-filter logic as the combined Profit/Profit YTD,
  // just pre-filtered to one broker's contracts. Schwab and ETrade are mutually
  // exclusive and exhaustive over allF, so schwabProfit + etradeProfit === combined profit.
  const isSchwabAcct = a => a?.startsWith("Schwab");
  const isEtradeAcct = a => a?.startsWith("ETrade") || a?.startsWith("Etrade");
  const schwabF = allF.filter(c => isSchwabAcct(c.account));
  const etradeF = allF.filter(c => isEtradeAcct(c.account));
  const periodDataSchwab = mkPeriodData(schwabF, analyticsView, profitDateMode);
  const periodDataEtrade = mkPeriodData(etradeF, analyticsView, profitDateMode);
  const schwabProfitByKey = Object.fromEntries(periodDataSchwab.map(v => [v.key, v.profit]));
  const etradeProfitByKey = Object.fromEntries(periodDataEtrade.map(v => [v.key, v.profit]));
  const profitYTDSchwab = profitDateMode === "accounting"
    ? accountingByPeriod(schwabF, thisYear)
    : closedC.filter(c=>isSchwabAcct(c.account)&&profitDateField(c)?.startsWith(thisYear)).reduce((s,c)=>s+(c.profit||0),0);
  const profitYTDEtrade = profitDateMode === "accounting"
    ? accountingByPeriod(etradeF, thisYear)
    : closedC.filter(c=>isEtradeAcct(c.account)&&profitDateField(c)?.startsWith(thisYear)).reduce((s,c)=>s+(c.profit||0),0);
  // Realized P/L — accounting mode uses cash-basis (premium received vs cost to close paid),
  // same formula as Profit MTD/YTD. Open/Close date mode show the same all-time total either way,
  // since a closed position's profit doesn't change based on which date field you attribute it to.
  const realizedPL = profitDateMode === "accounting"
    ? accountingByPeriod(allF, "") // empty prefix matches every date — all-time cash basis
    : totalProfit;

  // Filtered contracts for table
  const sortedFiltered = contracts.filter(c => {
    if (["BTC","STC"].includes(c.optType)) return false; // closers are not standalone contracts
    if (fOriginals && c.parentId) return false; // hide linked close records
    if (fStatus !== "All" && c.status !== fStatus) return false;
    if (fAcct   !== "All" && c.account !== fAcct)  return false;
    if (fSearch && !(c.stock?.toLowerCase().includes(fSearch.toLowerCase()) || fTitle(c).toLowerCase().includes(fSearch.toLowerCase()))) return false;
    if (gTicker  !== "All" && c.stock?.toUpperCase() !== gTicker) return false;
    if (gOptType !== "All" && c.optType !== gOptType) return false;
    if (gType    !== "All" && c.type    !== gType)    return false;
    if (fDateFrom && (c.dateExec||"") < fDateFrom) return false;
    if (fDateTo   && (c.dateExec||"") > fDateTo)   return false;
    if (fCType    !== "All" && c.type    !== fCType)    return false;
    if (fCOptType !== "All" && c.optType !== fCOptType) return false;
    if (fStrategy !== "All" && (c.strategy||"None") !== fStrategy) return false;
    if (fAuto === "yes" && c.openMethod !== "auto")  return false;
    if (fAuto === "no"  && c.openMethod === "auto")  return false;
    return true;
  }).sort((a,b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1; if (bv == null) return -1;
    if (typeof av === "string") av = av.toLowerCase(); if (typeof bv === "string") bv = bv.toLowerCase();
    return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => d==="asc"?"desc":"asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  // Plan derived — use originals only
  const planToday = new Date().toISOString().slice(0,10);
  const ptm = {};
  originals.forEach(c => { if (!c.stock) return; const t=c.stock.toUpperCase(); if (!ptm[t]) ptm[t]={ticker:t,open:0}; if (c.status==="Open") ptm[t].open++; });
  const knownTickers = Object.values(ptm).sort((a,b)=>a.ticker.localeCompare(b.ticker));
  // Always show open items + items from selected date. Open items may have been created on a different day.
  const filteredPlan = planItems.filter(p => p.status==="open" || !planDateFilter || (p.createdAt||"").startsWith(planDateFilter));
  const activePlan = filteredPlan.filter(p=>p.status==="open");
  const donePlan   = filteredPlan.filter(p=>p.status==="done");
  // Hide open contracts already added to any active plan item (regardless of date filter)
  const allActivePlan = planItems.filter(p=>p.status==="open");
  const planOpen = originals.filter(c => {
    if (c.status !== "Open") return false;
    // Always show contracts expiring today — they need action regardless
    if (c.expires === planToday) return true;
    // For future contracts, hide if there's an active plan item already
    const alreadyPlanned = allActivePlan.some(p =>
      p.ticker?.toUpperCase() === c.stock?.toUpperCase() &&
      String(p.strike) === String(c.strike) &&
      (p.expiration === c.expires || p.expiration === c.expires?.slice(0,10)) &&
      (p.account||"")===(c.account||"")
    );
    return !alreadyPlanned;
  }).sort((a,b)=>(a.expires||"").localeCompare(b.expires||""));
  const expToday = originals.filter(c=>c.status==="Open"&&c.expires===planToday);

  const sf = (k,v) => setForm(p=>({...p,[k]:v}));
  const pf = (k,v) => setPlanForm(p=>({...p,[k]:v}));

  // ── Auth ──────────────────────────────────────────────────────────────────
  const selUser = u => { setLoginTarget(u); setPinInput(""); setPinError(""); setLoginStep("pin"); };
  const pinDigit = d => {
    const np = pinInput + d; setPinInput(np);
    if (np.length === 4) {
      if (np === loginTarget.pin) { setAuthUser(loginTarget); setLoginStep("pick"); setPinInput(""); }
      else { setPinError("Wrong PIN"); setTimeout(() => { setPinInput(""); setPinError(""); }, 900); }
    }
  };
  const doPINChange = () => {
    if (pinStep===1) { if (pinCur!==authUser.pin){setPinMsg("Current PIN incorrect");return;} setPinStep(2);setPinMsg(""); }
    else if (pinStep===2) { if (!/^\d{4}$/.test(pinNew)){setPinMsg("Must be 4 digits");return;} setPinStep(3);setPinMsg(""); }
    else {
      if (pinNew!==pinCon){setPinMsg("PINs don't match");return;}
      const u = users.map(x=>x.id===authUser.id?{...x,pin:pinNew}:x);
      persistUsers(u); setAuthUser(p=>({...p,pin:pinNew}));
      setPinMsg("PIN updated ✓");
      setTimeout(()=>{setShowProfile(false);setPinStep(1);setPinCur("");setPinNew("");setPinCon("");setPinMsg("");},1200);
    }
  };

  // ── Contract CRUD ─────────────────────────────────────────────────────────
  const REQUIRED_FIELDS = ["stock","type","optType","strike","qty","premium","dateExec","expires","account"];
  const validateNew = () => {
    const errs = {};
    REQUIRED_FIELDS.forEach(k => { if (!form[k] && form[k] !== 0) errs[k] = true; });
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const saveNew = async () => {
    if (!validateNew()) return;
    const orig = editing ? contracts.find(x=>x.id===editing) : null;
    const ic = orig?.status === "Closed";
    const c = {
      ...form, id:editing??Date.now(),
      strike:+form.strike, qty:+form.qty, premium:+form.premium,
      priceAtExecution:form.priceAtExecution?+form.priceAtExecution:null,
      // When editing a closed contract, use the form values (user may have changed them)
      // Fall back to orig values only if the form field is blank/null
      costToClose: ic ? (form.costToClose!==""&&form.costToClose!=null ? +form.costToClose : (orig.costToClose??null)) : null,
      closeDate:   ic ? (form.closeDate || orig.closeDate || null) : null,
      profit:      ic ? (form.profit!==""&&form.profit!=null ? +form.profit : (orig.profit??null)) : null,
      profitPct:   ic ? (form.profitPct!==""&&form.profitPct!=null ? +form.profitPct : (orig.profitPct??null)) : null,
      daysHeld:    ic ? (form.daysHeld!==""&&form.daysHeld!=null ? +form.daysHeld : (orig.daysHeld??null)) : null,
      exercised:   ic ? (form.exercised ?? orig.exercised ?? null) : null,
      rolledOver:  ic ? (form.rolledOver ?? orig.rolledOver ?? null) : null,
      status:ic?"Closed":"Open", createdVia:form.createdVia||"Manual", createdBy:authUser?.id||null,
      currentPrice:form.currentPrice||null,
      openMethod: editing ? (orig?.openMethod || "manual") : "app",
      closeMethod: ic ? (orig?.closeMethod || "app") : null,
    };
    // BTO and BTC premiums are always negative (cost to buy)
    const rawPremium = +form.premium;
    const finalPremium = (c.optType === "BTO" || c.optType === "BTC")
      ? -Math.abs(rawPremium) : Math.abs(rawPremium);
    const c2 = { ...c, premium: finalPremium };
    const u = editing ? contracts.map(x=>x.id===editing?c2:x) : [c2,...contracts];
    setContracts(u); setStorageMsg(u.length+" contracts");
    await persistOne(c2);
    setForm({...EMPTY_NEW}); setEditing(null); setShowForm(false); setFormErrors({});
  };

  const saveClose = async () => {
    const orig = contracts.find(c=>c.id===closingId); if (!orig) return;
    const ctc = +closeForm.costToClose||0;
    const isBTO = orig.optType === "BTO";
    const qtyToClose = closeForm.qtyToClose ? Math.min(+closeForm.qtyToClose, orig.qty) : orig.qty;
    const isPartial = qtyToClose < orig.qty;
    // Prorate premium for partial close
    const qtyRatio = qtyToClose / orig.qty;
    // proratedPremium = portion of original premium for the qty being closed
    const proratedPremium = orig.premium * qtyRatio;
    // ctc is entered as the TOTAL cost for the qty being closed (not per contract)
    // so we use ctc directly, not multiplied by qtyRatio again
    const profit = isBTO
      ? +(ctc - Math.abs(proratedPremium)).toFixed(2)   // BTO: sold for ctc, paid proratedPremium
      : +(Math.abs(proratedPremium) - ctc).toFixed(2);  // STO: received proratedPremium, paid ctc to close
    const basis = Math.abs(proratedPremium);
    const profitPct = basis > 0 ? +(profit / basis).toFixed(4) : 0;
    const daysHeld = orig.dateExec && closeForm.closeDate ? Math.round((new Date(closeForm.closeDate)-new Date(orig.dateExec))/86400000) : null;
    const closeOptType = isBTO ? "STC" : "BTC";
    const closePremium = isBTO ? Math.abs(ctc) : -ctc;
    const cr = {
      id:Date.now(), parentId:orig.id, stock:orig.stock, type:orig.type, optType:closeOptType,
      strike:orig.strike, qty:qtyToClose, expires:orig.expires, premium:closePremium,
      priceAtExecution:null, dateExec:closeForm.closeDate, account:orig.account,
      status:"Closed", costToClose:ctc, closeDate:closeForm.closeDate,
      profit, profitPct, daysHeld, exercised:closeForm.exercised, rolledOver:closeForm.rolledOver,
      notes:closeForm.notes||orig.notes, createdVia:"Manual", createdBy:authUser?.id||null, currentPrice:null,
      stockPriceAtClose: closeForm.stockPriceAtClose ? +closeForm.stockPriceAtClose : null,
      openMethod: "app", closeMethod: "app",
    };
    let u;
    if (isPartial) {
      // Partial: reduce original qty, keep it Open
      const remaining = orig.qty - qtyToClose;
      const remainingPremium = +(orig.premium * (remaining / orig.qty)).toFixed(2);
      u = contracts.map(x => x.id===closingId ? {...x, qty:remaining, premium:remainingPremium} : x);
      const updatedOrig = u.find(x=>x.id===closingId);
      setContracts([cr,...u]);
      await persistOne(cr);
      await persistOne(updatedOrig);
    } else {
      // Full close
      u = contracts.map(x => x.id===closingId ? {
        ...x, costToClose:ctc, closeDate:closeForm.closeDate, profit, profitPct, daysHeld,
        exercised:closeForm.exercised, rolledOver:closeForm.rolledOver,
        notes:closeForm.notes||x.notes, status:"Closed", closedById:cr.id,
      } : x);
      const updatedOrig = u.find(x=>x.id===closingId);
      setContracts([cr,...u]);
      await persistOne(cr);
      await persistOne(updatedOrig);
    }
    setCloseForm({...EMPTY_CLOSE, stockPriceAtClose: stocksData[viewC?.stock?.toUpperCase()]?.currentPrice || ""}); setClosingId(null); setShowForm(false);
    setCelebration({profit});
    if (profit > 0) playCashRegister(); else playLoss();
    if (pendingSignalId) {
      supabase.from("decision_log").insert({ signal_id: pendingSignalId, contract_id: orig?.id ?? null, decision: "traded", notes: "", created_at: new Date().toISOString() })
        .then(() => { setSignalDecision({ decision: "traded" }); setPendingSignalId(null); });
    }
  };

  const startClose = c => { setClosingId(c.id); setCloseForm({...EMPTY_CLOSE,notes:c.notes||""}); setFormMode("close"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doEdit = c => { setForm({...c,strike:`${c.strike}`,qty:`${c.qty}`,premium:`${c.premium}`,priceAtExecution:c.priceAtExecution??"",costToClose:c.costToClose??"",profit:c.profit??"",daysHeld:c.daysHeld??"",closeDate:c.closeDate||"",exercised:c.exercised||"No",rolledOver:c.rolledOver||"No"}); setEditing(c.id); setFormMode("new"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doDelete = async id => {
    const updated = contracts.filter(c=>c.id!==id);
    setContracts(updated); setStorageMsg(updated.length+" contracts");
    await deleteOne(id);
    setDeleteConfirm(null); setViewC(null);
  };
  const doExport = () => { const b=new Blob([JSON.stringify(contracts,null,2)],{type:"application/json"}); const u=URL.createObjectURL(b); const a=document.createElement("a"); a.href=u; a.download="pri_export_"+TODAY+".json"; a.click(); URL.revokeObjectURL(u); };


  // Update current price on a contract
  const updatePrice = async (id, price) => {
    const updated = contracts.map(c => c.id===id ? {...c, currentPrice: price===""?null:+price} : c);
    setContracts(updated);
    const contract = updated.find(c=>c.id===id);
    if (contract) await persistOne(contract);
  };

  // Plan
  const openPlanForm = (ticker, prefill={}) => {
    const d = tickerDefaults(ticker);
    const defQty = defaultQtyForTicker(ticker);
    const sd = stocksData[ticker?.toUpperCase()] || {};
    setPlanForm({ticker,action:prefill.action||"STO",type:prefill.type||"Call",qty:prefill.qty||d.qty||defQty,strike:prefill.strike||"",expiration:prefill.expiration||nextExpiry(ticker)||"",account:prefill.account||d.account||"",premium:"",stockPrice:prefill.stockPrice||sd.currentPrice||"",bid:prefill.bid||"",ask:prefill.ask||"",last:"",targetPremium:"",notes:prefill.notes||""});
  };
  // Get default qty for plan based on Schwab shares (shares / 100, min 1)
  const defaultQtyForTicker = (ticker) => {
    const pos = schwabPositions.find(p => p.symbol === ticker?.toUpperCase());
    const sd  = stocksData[ticker?.toUpperCase()] || {};
    const shares = pos?.qty ?? sd.sharesSchwab ?? 0;
    return Math.max(1, Math.floor(shares / 100));
  };

  const savePlan = () => {
    if (!planForm?.action) return;
    // Dedupe: only block if an identical open item was created today
    const isDupe = planItems.some(p =>
      p.status==="open" &&
      (p.createdAt||"").startsWith(TODAY) &&
      p.ticker?.toUpperCase()===planForm.ticker?.toUpperCase() &&
      p.action===planForm.action &&
      String(p.strike)===String(planForm.strike) &&
      p.expiration===planForm.expiration &&
      p.account===planForm.account
    );
    if (isDupe) { alert(`${planForm.ticker} ${planForm.action} ${planForm.strike} ${planForm.expiration} is already in today's plan.`); return; }
    const i={...planForm,id:Date.now(),status:"open",createdAt:new Date().toISOString()};
    persistPlan([i,...planItems]);
    setPlanForm(null);
  };
  const closePlan = id => persistPlan(planItems.map(p=>p.id===id?{...p,status:"done"}:p));
  const delPlan   = id => persistPlan(planItems.filter(p=>p.id!==id));

  // Column reorder with up/down arrows
  const moveCol = (key, dir) => {
    const newCols = [...cols];
    const idx = newCols.findIndex(c => c.key === key);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= newCols.length) return;
    [newCols[idx], newCols[swapIdx]] = [newCols[swapIdx], newCols[idx]];
    persistCols(newCols);
  };

  // CSV export of filtered contracts
  const doExportCSV = () => {
    const headers = ["id","stock","contract","type","optType","strike","qty","expires","dateExec","premium","priceAtExecution","account","status","costToClose","closeDate","profit","profitPct","daysHeld","exercised","rolledOver","notes","createdVia"];
    const rows = sortedFiltered.map(c => headers.map(h => {
      if (h === "contract") return `"${fTitle(c)}"`;
      const v = c[h];
      if (v == null) return "";
      if (typeof v === "string" && v.includes(",")) return `"${v}"`;
      return v;
    }).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const b = new Blob([csv], {type:"text/csv"});
    const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u;
    a.download = "pri_contracts_" + TODAY + ".csv";
    a.click(); URL.revokeObjectURL(u);
  };

  // ── AI Assistant ──────────────────────────────────────────────────────────
  const sendAI = async () => {
    const q = aiInput.trim(); if (!q || aiLoading) return;
    setAiInput("");
    const userMsg = {role:"user", content:q};
    const newMsgs = [...aiMessages, userMsg];
    setAiMessages(newMsgs);
    setAiLoading(true);
    // Scroll to bottom
    setTimeout(()=>aiEndRef.current?.scrollIntoView({behavior:"smooth"}),50);
    try {
      // Build a compact data summary to pass to Claude
      const closedContracts = originals.filter(c=>c.status==="Closed"&&c.profit!=null);
      const openContracts   = originals.filter(c=>c.status==="Open");
      // OTM calculation helper: for STO calls, OTM% = (strike - priceAtExec) / priceAtExec * 100
      const otmContracts = originals.filter(c=>c.priceAtExecution&&c.strike&&c.optType==="STO"&&c.type==="Call");
      const otmSamples = otmContracts.slice(0,120).map(c=>({
        ticker:c.stock, strike:c.strike, execPrice:c.priceAtExecution,
        otmPct:+((c.strike-c.priceAtExecution)/c.priceAtExecution*100).toFixed(2),
        profit:c.profit, status:c.status, premium:c.premium, daysHeld:c.daysHeld,
        account:c.account, expires:c.expires, dateExec:c.dateExec,
      }));
      const summary = {
        totalContracts: originals.length,
        openCount: openContracts.length,
        closedCount: closedContracts.length,
        winRate: closedContracts.length ? (closedContracts.filter(c=>c.profit>0).length/closedContracts.length*100).toFixed(1)+"%" : "N/A",
        totalProfit: closedContracts.reduce((s,c)=>s+(c.profit||0),0).toFixed(2),
        avgProfit: closedContracts.length ? (closedContracts.reduce((s,c)=>s+(c.profit||0),0)/closedContracts.length).toFixed(2) : 0,
        avgDaysHeld: closedContracts.filter(c=>c.daysHeld).length ? (closedContracts.filter(c=>c.daysHeld).reduce((s,c)=>s+(c.daysHeld||0),0)/closedContracts.filter(c=>c.daysHeld).length).toFixed(1) : "N/A",
        otmData: otmSamples,
        tickerBreakdown: (() => {
          const m={};
          originals.forEach(c=>{
            const t=c.stock?.toUpperCase()||"?";
            if(!m[t]) m[t]={ticker:t,contracts:0,closed:0,profit:0,premium:0};
            m[t].contracts++; m[t].premium+=(c.premium||0);
            if(c.status==="Closed"&&c.profit!=null){m[t].closed++;m[t].profit+=c.profit;}
          });
          return Object.values(m).sort((a,b)=>b.premium-a.premium).slice(0,20);
        })(),
        monthlyBreakdown: (() => {
          const m={};
          closedContracts.forEach(c=>{
            const mo=c.closeDate?.slice(0,7)||"unknown";
            if(!m[mo]) m[mo]={month:mo,profit:0,count:0};
            m[mo].profit+=(c.profit||0); m[mo].count++;
          });
          return Object.values(m).sort((a,b)=>a.month.localeCompare(b.month));
        })(),
      };

      const systemPrompt = `You are an AI assistant embedded in a trading options dashboard called PRI (Premium Recurring Income). You have access to the user's real trading data. Answer questions concisely and numerically. Use $ and % formatting. If you calculate OTM%, use: OTM% = (strike - priceAtExecution) / priceAtExecution * 100 for calls. For puts it's reversed. Only STO (sell-to-open) contracts are typically OTM writes.

Data summary:
${JSON.stringify(summary, null, 1)}`;

      const resp = await fetch("/api/claude", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-5-20250929",
          max_tokens:1000,
          system: systemPrompt,
          messages: [...newMsgs].map(m=>({role:m.role,content:m.content})),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAiMessages(p=>[...p,{role:"assistant",content:"API Error: " + (typeof data?.error === "string" ? data.error : data?.error?.message || JSON.stringify(data))}]);
      } else {
        const text = data.content?.find(b=>b.type==="text")?.text || "No response content.";
        // Persist both messages and capture their IDs
        let userDbId = null, assistantDbId = null;
        try {
          const {data: inserted} = await supabase.from("ai_chats").insert([
            {role:"user",     content:q,    starred:false, created_by: authUser?.id||null, created_at: new Date().toISOString()},
            {role:"assistant",content:text, starred:false, created_by: authUser?.id||null, created_at: new Date().toISOString()},
          ]).select();
          if (inserted?.length) { userDbId = inserted[0].id; assistantDbId = inserted[1].id; }
        } catch(e) { console.error("ai_chats save error:", e); }
        const assistantMsg = {id: assistantDbId, role:"assistant", content:text, saved:true, starred:false};
        const userMsgWithId = {id: userDbId, role:"user", content:q, saved:true, starred:false};
        setAiMessages(p=>[...p.slice(0,-1), userMsgWithId, assistantMsg]);
      }
    } catch(e) {
      setAiMessages(p=>[...p,{role:"assistant",content:"Error: "+e.message}]);
    }
    setAiLoading(false);
    setTimeout(()=>aiEndRef.current?.scrollIntoView({behavior:"smooth"}),100);
  };

  // ── LOGIN SCREEN ──────────────────────────────────────────────────────────
  if (!dbReady) return (
    <div style={{minHeight:"100vh",background:th("#010409","#f5f0e8"),display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
      <div style={{width:12,height:12,border:"2px solid #1c2128",borderTopColor:"#00ff88",borderRadius:"50%",animation:"spin .7s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (!authUser) return (
    <div style={{minHeight:"100vh",background:th("#010409","#f5f0e8"),display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Inter',sans-serif",padding:16}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      <div style={{width:"100%",maxWidth:340,animation:"fadeIn .3s ease"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:52,height:52,borderRadius:14,background:"linear-gradient(135deg,#0d1f12,#0a1a1f)",border:"1px solid #00ff8830",boxShadow:"0 0 24px #00ff8818",marginBottom:10}}>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:17,color:"#00ff88"}}>PRI</span>
          </div>
          <div style={{fontFamily:"monospace",fontSize:10,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em"}}>PREMIUM RECURRING INCOME</div>
          <div style={{fontFamily:"monospace",fontSize:8,color:th("#2a3040","#6b5f55"),letterSpacing:"0.06em",marginTop:2}}>TRADING OPTIONS DASHBOARD</div>
        </div>
        {loginStep==="pick" ? (
          <div>
            <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",textAlign:"center",marginBottom:14,letterSpacing:"0.06em"}}>SELECT USER</div>
            {users.map(u => (
              <button key={u.id} onClick={()=>selUser(u)} style={{background:th("#0a0e14","#f8f3eb"),border:`1px solid ${u.color}25`,borderRadius:10,padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,width:"100%",marginBottom:8}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:`${u.color}20`,border:`2px solid ${u.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:u.color,fontSize:11,flexShrink:0}}>{u.initials}</div>
                <div style={{textAlign:"left"}}><div style={{color:th("#e6edf3","#0d0d0b"),fontSize:13,fontWeight:600}}>{u.name}</div><div style={{color:th("#3a4050","#8a7e74"),fontSize:9,fontFamily:"monospace",marginTop:1}}>Enter PIN to continue</div></div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setLoginStep("pick")} style={{background:"transparent",border:"none",color:th("#3a4050","#8a7e74"),fontSize:10,fontFamily:"monospace",cursor:"pointer",marginBottom:14,display:"flex",alignItems:"center",gap:6}}>← Back</button>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,padding:"10px 14px",background:th("#0a0e14","#f8f3eb"),borderRadius:8,border:`1px solid ${loginTarget.color}20`}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:`${loginTarget.color}20`,border:`2px solid ${loginTarget.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:loginTarget.color,fontSize:11}}>{loginTarget.initials}</div>
              <div><div style={{color:th("#e6edf3","#0d0d0b"),fontSize:12,fontWeight:600}}>{loginTarget.name}</div><div style={{color:th("#2a3040","#6b5f55"),fontSize:9,fontFamily:"monospace"}}>Enter 4-digit PIN or use keyboard</div></div>
            </div>
            <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:18}}>
              {[0,1,2,3].map(i=><div key={i} style={{width:13,height:13,borderRadius:"50%",background:i<pinInput.length?loginTarget.color:"transparent",border:`2px solid ${i<pinInput.length?loginTarget.color:th("#2a3040","#6b5f55")}`,transition:"all .15s"}}/>)}
            </div>
            {pinError && <div style={{textAlign:"center",color:"#ff4560",fontSize:11,fontFamily:"monospace",marginBottom:10}}>{pinError}</div>}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((d,i)=>(
                <button key={i} onClick={()=>d==="⌫"?setPinInput(p=>p.slice(0,-1)):d!==""?pinDigit(String(d)):null}
                  disabled={d===""}
                  style={{background:d===""?"transparent":th("#0a0e14","#f8f3eb"),border:d===""?"none":"1px solid #1c2128",borderRadius:8,padding:"13px 0",fontSize:d==="⌫"?16:18,fontFamily:"monospace",color:d===""?"transparent":th("#e6edf3","#0d0d0b"),cursor:d===""?"default":"pointer",fontWeight:500}}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ── MAIN APP ──────────────────────────────────────────────────────────────
  return (
    <>
    <div style={{minHeight:"100vh",background:th("#010409","#f5f0e8"),color:th("#e6edf3","#0d0d0b"),fontFamily:"'Inter',sans-serif",fontSize:`${uiScale*100}%`}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-track{background:#080c12}::-webkit-scrollbar-thumb{background:#21262d;border-radius:3px}
        input,select,textarea{background:#0d1219;color:#e6edf3;border:1px solid #2a3550;border-radius:4px;padding:6px 8px;font-family:inherit;font-size:12px;width:100%;outline:none;transition:border .15s}
        @media(max-width:600px){
          .hm{display:none!important}
          input,select{font-size:16px!important}
          .ms{overflow-x:auto;-webkit-overflow-scrolling:touch}
        }
        input:focus,select:focus,textarea:focus{border-color:#00ff8880;background:#0f1820}
        input.err{border-color:#ff456060!important}
        button{cursor:pointer;font-family:inherit}
        .rh:hover>td{background:#0a0e14!important}
        .ms{overflow-x:auto;-webkit-overflow-scrolling:touch}
        .thsort{cursor:pointer;user-select:none}
        .thsort:hover{color:#c9d1d9!important}
        .sticky-col{position:sticky;left:0;z-index:2;background:#010409}
        .rh:hover .sticky-col{background:#0a0e14!important}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
        @keyframes sd{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
        @keyframes coinPop{0%{opacity:0;transform:scale(0.3) translateY(0)}40%{opacity:1;transform:scale(1.3) translateY(-40px)}70%{transform:scale(1) translateY(-60px)}100%{opacity:0;transform:scale(0.8) translateY(-120px)}}
        @keyframes lossSlide{0%{opacity:0;transform:translateY(-20px)}20%{opacity:1}80%{opacity:1}100%{opacity:0;transform:translateY(20px)}}
        @media(max-width:600px){.hm{display:none!important}}
      `}</style>

      {/* Celebration overlay */}
      {celebration && <CelebrationOverlay profit={celebration.profit} onDone={()=>setCelebration(null)}/>}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #ff456040",borderRadius:10,padding:22,width:"100%",maxWidth:280,animation:"fadeIn .15s"}}>
            <div style={{fontFamily:"monospace",color:"#ff4560",fontSize:12,marginBottom:8}}>DELETE CONTRACT?</div>
            <div style={{color:"#888",fontSize:13,marginBottom:18}}>{contracts.find(c=>c.id===deleteConfirm)?.stock||"?"} — cannot be undone.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>doDelete(deleteConfirm)} style={{background:"#ff4560",color:"#fff",border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,flex:1}}>Delete</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{background:"transparent",color:"#666",border:"1px solid #21262d",borderRadius:6,padding:"8px 0",fontSize:12,flex:1}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Contract detail modal */}
      {viewC && (() => {
        const c = viewC;
        const lkOpen = c.parentId ? contracts.find(x=>x.id===c.parentId) : null;
        const itmStatus = getITMStatus(c);
        return (
          <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setViewC(null)}>
            <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:18,width:"100%",maxWidth:500,animation:"fadeIn .15s",maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"monospace",fontWeight:700,fontSize:13,color:th("#e6edf3","#0d0d0b")}}>{fTitle(c)}</span>
                  <Tag color={c.type==="Put"?"amber":"blue"}>{c.type}</Tag>
                  <Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":c.optType==="STC"?"blue":c.optType==="BTO"?"purple":"gray"}>{c.optType}</Tag>
                  <Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag>
                  {itmStatus && <Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus}</Tag>}
                </div>
                <button onClick={()=>setViewC(null)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,lineHeight:1,flexShrink:0}}>✕</button>
              </div>
              <div style={{background:th("#080c12","#ede8df"),borderRadius:8,padding:12,marginBottom:10,border:"1px solid #00ff8820"}}>
                <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.07em",marginBottom:8}}>OPEN — {c.optType}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {[["Strike","$"+c.strike],["Qty",c.qty],["Account",c.account||"—"],["Exec",c.dateExec||"—"],["Expires",c.expires||"—"],["Premium",f$(c.premium)],["Price@Exec",c.priceAtExecution?f$(c.priceAtExecution):"—"],["Strategy",c.strategy||"—"],["Created Via",c.createdVia||"—"],["Opened Via",c.openMethod||"manual"],["By",c.createdBy?users.find(u=>u.id===c.createdBy)?.initials||c.createdBy:"—"]].map(([l,v])=>(
                    <div key={l}><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2}}>{l}</div><div style={{fontSize:11,color:l==="Opened Via"?(v==="auto"?"#00ff88":v==="app"?"#58a6ff":"#888"):th("#c9d1d9","#1a1a18"),fontFamily:"monospace"}}>{v}</div></div>
                  ))}
                </div>
                {c.status==="Open" && (
                  <div style={{marginTop:10,display:"flex",alignItems:"center",gap:8}}>
                    <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>CURRENT PRICE $</div>
                    <input type="number" defaultValue={c.currentPrice||""} placeholder="Live via Schwab API"
                      onBlur={e=>updatePrice(c.id,e.target.value)}
                      style={{width:140,padding:"3px 6px",fontSize:11,border:`1px solid ${itmStatus==="ITM"?"#ff456040":itmStatus==="OTM"?"#00ff8840":th("#21262d","#c8b8a8")}`}}/>
                    <span style={{fontSize:9,color:th("#2a3040","#6b5f55"),fontFamily:"monospace"}}>🔗 Schwab API (coming)</span>
                  </div>
                )}
                {/* Target close display */}
                {(() => {
                  const bd2 = getContractBand(c);
                  if (!bd2) return null;
                  return (
                    <div style={{marginTop:8,display:"flex",gap:14,flexWrap:"wrap"}}>
                      <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:1}}>TGT CLOSE $</div>
                        <div style={{fontFamily:"monospace",fontSize:12,color:"#00ff88",fontWeight:700}}>{bd2.targetClose!=null?f$(bd2.targetClose):"—"}</div>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:1}}>$/SHARE</div>
                        <div style={{fontFamily:"monospace",fontSize:12,color:"#00ff88",fontWeight:700}}>{bd2.targetPerShare!=null?"$"+bd2.targetPerShare.toFixed(2):"—"}</div>
                      </div>
                      {bd2.tgtPct && <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:1}}>TARGET%</div>
                        <div style={{fontFamily:"monospace",fontSize:12,color:bd2.bandColor||"#ffd166"}}>{bd2.tgtPct}%</div>
                      </div>}
                    </div>
                  );
                })()}
                {c.notes && <div style={{marginTop:8,fontSize:10,color:"#555",fontStyle:"italic"}}>"{c.notes}"</div>}
                {/* Exit Plan */}
                {c.status === "Open" && (
                  <div style={{marginTop:10,borderTop:"1px solid #1c2128",paddingTop:8}}>
                    <div style={{fontSize:7,color:"#ffd166",fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:6}}>EXIT PLAN</div>
                    <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
                      <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2}}>STOP LOSS</div>
                        <input type="number" step="0.1" defaultValue={c.stopLossMultiplier ?? 2.0} onBlur={async e=>{
                          const v = parseFloat(e.target.value); if (isNaN(v)) return;
                          const { error } = await supabase.from("contracts").update({stop_loss_multiplier:v}).eq("id",c.id);
                          if (!error) { setContracts(cs=>cs.map(x=>x.id===c.id?{...x,stopLossMultiplier:v}:x)); setViewC(vc=>vc?.id===c.id?{...vc,stopLossMultiplier:v}:vc); }
                          else console.error("[exit plan] stop_loss_multiplier save failed:", error.message);
                        }} style={{width:60,fontSize:11,padding:"2px 5px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace"}}/>
                        <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginLeft:3}}>× premium</span>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2}}>TIME STOP DTE</div>
                        <input type="number" step="1" defaultValue={c.timeStopDte ?? ""} placeholder="—" onBlur={async e=>{
                          const v = e.target.value === "" ? null : parseInt(e.target.value);
                          const { error } = await supabase.from("contracts").update({time_stop_dte:v}).eq("id",c.id);
                          if (!error) { setContracts(cs=>cs.map(x=>x.id===c.id?{...x,timeStopDte:v}:x)); setViewC(vc=>vc?.id===c.id?{...vc,timeStopDte:v}:vc); }
                          else console.error("[exit plan] time_stop_dte save failed:", error.message);
                        }} style={{width:55,fontSize:11,padding:"2px 5px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace"}}/>
                        <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginLeft:3}}>days</span>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2}}>DELTA STOP</div>
                        <input type="number" step="0.01" defaultValue={c.deltaStop ?? 0.30} onBlur={async e=>{
                          const v = parseFloat(e.target.value); if (isNaN(v)) return;
                          const { error } = await supabase.from("contracts").update({delta_stop:v}).eq("id",c.id);
                          if (!error) { setContracts(cs=>cs.map(x=>x.id===c.id?{...x,deltaStop:v}:x)); setViewC(vc=>vc?.id===c.id?{...vc,deltaStop:v}:vc); }
                          else console.error("[exit plan] delta_stop save failed:", error.message);
                        }} style={{width:60,fontSize:11,padding:"2px 5px",background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:3,color:"#ffd166",fontFamily:"monospace"}}/>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {/* Decay chart */}
              <ContractDecayChart contract={c} stocksData={stocksData} />
              {c.status==="Closed" && (() => {
                // Find the btc_auto signal that closed this contract
                const closeSig = c.closeMethod === "auto"
                  ? contracts._btcSignals?.find(s => String(s.contract_id) === String(c.id))
                  : null;
                const closeRule = closeSig ? tradeRules?.find?.(r => r.id === closeSig.rule_id) : null;
                return (
                  <div style={{background:th("#080c12","#ede8df"),borderRadius:8,padding:12,border:"1px solid #ffd16620"}}>
                    <div style={{fontFamily:"monospace",fontSize:8,color:"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>
                      CLOSE — {c.optType==="BTO"?"STC":c.optType==="STO"?"BTC":"CLOSED"}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                      {[["Close Date",c.closeDate||"—"],["Cost",c.costToClose!=null?f$(c.costToClose):"—"],["Profit",c.profit!=null?fSign(c.profit):"—"],["Return",c.profitPct!=null?fPct(c.profitPct):"—"],["Days",c.daysHeld??"—"],["Closed Via",c.closeMethod||"manual"],["Exercised",c.exercised||"—"],["Rolled",c.rolledOver||"—"]].map(([l,v])=>(
                        <div key={l}><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2}}>{l}</div>
                          <div style={{fontSize:11,color:l==="Profit"?(c.profit>=0?"#00ff88":"#ff4560"):l==="Closed Via"?(v==="auto"?"#00ff88":v==="app"?"#58a6ff":"#888"):th("#c9d1d9","#1a1a18"),fontFamily:"monospace",fontWeight:l==="Profit"?700:400}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {c.closeMethod==="auto" && (
                      <div style={{marginTop:8,padding:"5px 8px",background:"#00ff8808",borderRadius:4,border:"1px solid #00ff8820",fontFamily:"monospace",fontSize:9,color:"#00ff88"}}>
                        🤖 auto-closed by Skynet{closeRule ? ` · rule: ${closeRule.name}` : ""}
                      </div>
                    )}
                  </div>
                );
              })()}
              {lkOpen && <div style={{marginTop:8,padding:"6px 10px",background:th("#0a0e14","#f8f3eb"),borderRadius:6,border:"1px solid #58a6ff20",fontSize:9,color:"#58a6ff",fontFamily:"monospace"}}>↑ Close record — linked to open #{lkOpen.id} ({fTitle(lkOpen)})</div>}

              {/* ── Strategy Group Section ── */}
              {(() => {
                const STRATEGY_TYPES = ["Straddle","Strangle","Vertical Spread","Collar","Covered Call","Iron Condor","Wheel","Long Call Hedge","Custom"];
                const groupId = c.strategyGroupId;
                const groupLegs = groupId ? contracts.filter(x => x.strategyGroupId === groupId && x.id !== c.id) : [];
                const isEditing = linkEditor?.contractId === c.id;
                const sameTicker = contracts.filter(x => x.stock === c.stock && x.id !== c.id);
                const openLegs   = sameTicker.filter(x => x.status === "Open");
                const closedLegs = sameTicker.filter(x => x.status !== "Open");
                const [showClosed, setShowClosedLocal] = [linkEditor?.showClosed || false, (v) => setLinkEditor(p => ({...p, showClosed: v}))];
                const displayLegs = isEditing ? (showClosed ? sameTicker : openLegs) : [];

                const saveLinkage = async () => {
                  if (!linkEditor?.strategyType) return;
                  setLinkEditor(p => ({...p, saving: true}));
                  const newGroupId = groupId || Date.now();
                  const idsToLink = [c.id, ...(linkEditor.selectedIds || [])];
                  const updated = contracts.map(x => {
                    if (!idsToLink.includes(x.id)) return x;
                    return {...x, strategyGroupId: newGroupId, strategyType: linkEditor.strategyType};
                  });
                  setContracts(updated);
                  for (const contract of updated.filter(x => idsToLink.includes(x.id))) {
                    await persistOne(contract);
                  }
                  setLinkEditor(null);
                  setViewC(updated.find(x => x.id === c.id));
                };

                const unlinkGroup = async () => {
                  const idsToUnlink = [c.id, ...groupLegs.map(x => x.id)];
                  const updated = contracts.map(x => {
                    if (!idsToUnlink.includes(x.id)) return x;
                    return {...x, strategyGroupId: null, strategyType: null};
                  });
                  setContracts(updated);
                  for (const contract of updated.filter(x => idsToUnlink.includes(x.id))) {
                    await persistOne(contract);
                  }
                  setViewC(updated.find(x => x.id === c.id));
                };

                return (
                  <div style={{marginTop:10, background:th("#080c12","#ede8df"), borderRadius:8, padding:12, border:"1px solid #30363d"}}>
                    <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8}}>
                      <span style={{fontSize:8, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", letterSpacing:"0.07em"}}>STRATEGY GROUP</span>
                      {!isEditing && (
                        <button onClick={() => setLinkEditor({contractId: c.id, strategyType: c.strategyType || null, selectedIds: groupLegs.map(x=>x.id), showClosed: false})}
                          style={{background:"transparent", color:"#58a6ff", border:"none", fontSize:9, fontFamily:"monospace", cursor:"pointer", padding:0}}>
                          {groupId ? "Edit" : "+ Link strategy"}
                        </button>
                      )}
                      {isEditing && (
                        <button onClick={() => setLinkEditor(null)}
                          style={{background:"transparent", color:"#555", border:"none", fontSize:9, fontFamily:"monospace", cursor:"pointer", padding:0}}>
                          Cancel
                        </button>
                      )}
                    </div>

                    {/* View mode — has a group */}
                    {!isEditing && groupId && (
                      <div>
                        <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:8}}>
                          <span style={{background:"#58a6ff20", color:"#58a6ff", border:"1px solid #58a6ff40", borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:600, fontFamily:"monospace"}}>
                            {c.strategyType || "Strategy"}
                          </span>
                          <span style={{fontSize:9, color:th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>{groupLegs.length + 1} leg{groupLegs.length !== 0 ? "s" : ""}</span>
                        </div>
                        {/* This contract */}
                        <div style={{display:"flex", alignItems:"center", gap:8, padding:"5px 8px", background:"#58a6ff12", border:"1px solid #58a6ff25", borderRadius:5, marginBottom:4}}>
                          <span style={{fontSize:9, color:"#58a6ff", fontFamily:"monospace", width:8}}>●</span>
                          <span style={{fontSize:10, color:"#58a6ff", fontFamily:"monospace", flex:1}}>{fTitle(c)} · {c.optType} · {c.qty} ct</span>
                          <span style={{fontSize:9, color:th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>this contract</span>
                        </div>
                        {/* Linked legs */}
                        {groupLegs.map(leg => {
                          const legPnl = leg.profit != null ? leg.profit : null;
                          return (
                            <div key={leg.id} style={{display:"flex", alignItems:"center", gap:8, padding:"5px 8px", background:th("#0d1117","#f5f0e8"), borderRadius:5, marginBottom:4, cursor:"pointer"}}
                              onClick={() => { setViewC(leg); setLinkEditor(null); }}>
                              <span style={{fontSize:9, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", width:8}}>→</span>
                              <span style={{fontSize:10, color:th("#c9d1d9","#1a1a18"), fontFamily:"monospace", flex:1}}>{fTitle(leg)} · {leg.optType} · {leg.qty} ct</span>
                              <span style={{fontSize:9, color:leg.status==="Open"?"#00ff88":"#555", fontFamily:"monospace"}}>{leg.status}</span>
                              {legPnl != null && <span style={{fontSize:9, color:legPnl>=0?"#00ff88":"#ff4560", fontFamily:"monospace"}}>{fSign(legPnl)}</span>}
                            </div>
                          );
                        })}
                        {/* Combined P&L if any legs have profit */}
                        {(() => {
                          const allLegs = [c, ...groupLegs];
                          const withPnl = allLegs.filter(x => x.profit != null);
                          if (withPnl.length < 2) return null;
                          const combined = withPnl.reduce((s, x) => s + x.profit, 0);
                          const totalCost = allLegs.reduce((s, x) => s + (x.premium || 0) * (x.qty || 1) * 100, 0);
                          return (
                            <div style={{display:"flex", gap:12, marginTop:8, padding:"6px 8px", background:th("#0a0e14","#f8f3eb"), borderRadius:5, border:"1px solid #21262d"}}>
                              <div><span style={{fontSize:7, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", display:"block"}}>COMBINED P&L</span>
                                <span style={{fontSize:11, fontFamily:"monospace", fontWeight:700, color:combined>=0?"#00ff88":"#ff4560"}}>{fSign(combined)}</span></div>
                              <div><span style={{fontSize:7, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", display:"block"}}>TOTAL COST</span>
                                <span style={{fontSize:11, fontFamily:"monospace", color:th("#c9d1d9","#1a1a18")}}>{f$(totalCost)}</span></div>
                              <div><span style={{fontSize:7, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", display:"block"}}>COMBINED %</span>
                                <span style={{fontSize:11, fontFamily:"monospace", color:combined>=0?"#00ff88":"#ff4560"}}>{totalCost>0?fPct(combined/totalCost*100):"—"}</span></div>
                            </div>
                          );
                        })()}
                        <button onClick={unlinkGroup}
                          style={{marginTop:8, background:"transparent", color:"#ff456060", border:"none", fontSize:9, fontFamily:"monospace", cursor:"pointer", padding:0}}>
                          Unlink all legs
                        </button>
                      </div>
                    )}

                    {/* View mode — no group */}
                    {!isEditing && !groupId && (
                      <div style={{fontSize:10, color:th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>
                        No strategy linked · <span style={{color:"#58a6ff", cursor:"pointer"}}
                          onClick={() => setLinkEditor({contractId: c.id, strategyType: null, selectedIds: [], showClosed: false})}>
                          link one
                        </span>
                      </div>
                    )}

                    {/* Edit mode */}
                    {isEditing && (
                      <div>
                        {/* Strategy type pills */}
                        <div style={{marginBottom:10}}>
                          <div style={{fontSize:8, color:th("#3a4050","#8a7e74"), fontFamily:"monospace", marginBottom:6}}>STRATEGY TYPE</div>
                          <div style={{display:"flex", gap:5, flexWrap:"wrap"}}>
                            {STRATEGY_TYPES.map(st => (
                              <button key={st} onClick={() => setLinkEditor(p => ({...p, strategyType: st}))}
                                style={{
                                  fontSize:9, padding:"3px 9px", borderRadius:20, fontFamily:"monospace", cursor:"pointer",
                                  background: linkEditor.strategyType === st ? "#58a6ff30" : "transparent",
                                  color:      linkEditor.strategyType === st ? "#58a6ff" : "#555",
                                  border:     `1px solid ${linkEditor.strategyType === st ? "#58a6ff50" : th("#21262d","#c8b8a8")}`,
                                }}>
                                {st}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Contract list — same ticker */}
                        <div style={{marginBottom:10}}>
                          <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6}}>
                            <span style={{fontSize:8, color:th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>LINK CONTRACTS ({c.stock})</span>
                            <button onClick={() => setShowClosedLocal(!showClosed)}
                              style={{fontSize:8, color:"#555", background:"transparent", border:"none", cursor:"pointer", fontFamily:"monospace", padding:0}}>
                              {showClosed ? "Show open only" : `Show closed (${closedLegs.length})`}
                            </button>
                          </div>
                          {displayLegs.length === 0 && (
                            <div style={{fontSize:9, color:th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>
                              No other {showClosed ? "" : "open "}contracts for {c.stock}
                              {!showClosed && closedLegs.length > 0 && <span style={{color:"#555"}}> · <span style={{cursor:"pointer", color:"#58a6ff"}} onClick={() => setShowClosedLocal(true)}>show {closedLegs.length} closed</span></span>}
                            </div>
                          )}
                          {displayLegs.map(leg => {
                            const isSelected = linkEditor.selectedIds?.includes(leg.id);
                            return (
                              <div key={leg.id} onClick={() => setLinkEditor(p => ({...p, selectedIds: isSelected ? p.selectedIds.filter(id => id !== leg.id) : [...(p.selectedIds||[]), leg.id]}))}
                                style={{display:"flex", alignItems:"center", gap:8, padding:"5px 8px", marginBottom:4, borderRadius:5, cursor:"pointer",
                                  background: isSelected ? "#58a6ff15" : th("#0d1117","#f5f0e8"),
                                  border: `1px solid ${isSelected ? "#58a6ff35" : th("#1c2128","#b8a898")}`}}>
                                <div style={{width:12, height:12, borderRadius:2, border:`1px solid ${isSelected ? "#58a6ff" : th("#3a4050","#8a7e74")}`, background: isSelected ? "#58a6ff" : "transparent", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center"}}>
                                  {isSelected && <span style={{color:"#000", fontSize:8, fontWeight:700, lineHeight:1}}>✓</span>}
                                </div>
                                <span style={{fontSize:10, color: isSelected ? th("#c9d1d9","#1a1a18") : "#555", fontFamily:"monospace", flex:1}}>{fTitle(leg)} · {leg.optType} · {leg.qty} ct</span>
                                <span style={{fontSize:9, color:leg.status==="Open"?"#00ff88":th("#3a4050","#8a7e74"), fontFamily:"monospace"}}>{leg.status}</span>
                                {leg.profit != null && <span style={{fontSize:9, color:leg.profit>=0?"#00ff88":"#ff4560", fontFamily:"monospace"}}>{fSign(leg.profit)}</span>}
                              </div>
                            );
                          })}
                        </div>

                        {/* Save button */}
                        <button onClick={saveLinkage}
                          disabled={!linkEditor.strategyType || linkEditor.saving}
                          style={{
                            width:"100%", padding:"7px", borderRadius:5, fontSize:10, fontFamily:"monospace", fontWeight:600, cursor: linkEditor.strategyType ? "pointer" : "not-allowed",
                            background: linkEditor.strategyType ? "#58a6ff20" : th("#1c2128","#b8a898"),
                            color:      linkEditor.strategyType ? "#58a6ff" : th("#3a4050","#8a7e74"),
                            border:     `1px solid ${linkEditor.strategyType ? "#58a6ff40" : th("#1c2128","#b8a898")}`,
                          }}>
                          {linkEditor.saving ? "Saving..." : linkEditor.selectedIds?.length > 0 ? `Link ${linkEditor.selectedIds.length + 1} contracts as ${linkEditor.strategyType || "strategy"}` : `Set strategy type${linkEditor.strategyType ? " — " + linkEditor.strategyType : ""}`}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div style={{display:"flex",gap:7,marginTop:12}}>
                <button onClick={()=>{setViewC(null);doEdit(c);}} style={{background:"#58a6ff18",color:"#58a6ff",border:"1px solid #58a6ff35",borderRadius:6,padding:"7px 0",fontSize:11,fontFamily:"monospace",flex:1}}>Edit</button>
                {c.status==="Open" && <button onClick={()=>{setViewC(null);startClose(c);}} style={{background:"#ffd16618",color:"#ffd166",border:"1px solid #ffd16635",borderRadius:6,padding:"7px 0",fontSize:11,fontFamily:"monospace",flex:1}}>Close</button>}
                {c.status==="Closed" && <button onClick={async()=>{
                  const reopened = {...c, status:"Open", costToClose:null, closeDate:null, profit:null, profitPct:null, daysHeld:null, exercised:null, rolledOver:null, closedById:null};
                  const updated = contracts.map(x=>x.id===c.id?reopened:x);
                  setContracts(updated);
                  await persistOne(reopened);
                  setViewC(null);
                }} style={{background:"#00ff8818",color:"#00ff88",border:"1px solid #00ff8835",borderRadius:6,padding:"7px 0",fontSize:11,fontFamily:"monospace",flex:1}}>Reopen</button>}
                <button onClick={()=>{setViewC(null);setDeleteConfirm(c.id);}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:6,padding:"7px 0",fontSize:11,fontFamily:"monospace",flex:1}}>Delete</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Profile modal */}
      {showProfile && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowProfile(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:22,width:"100%",maxWidth:320,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:`${authUser.color}20`,border:`2px solid ${authUser.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:authUser.color,fontSize:14}}>{authUser.initials}</div>
              <div><div style={{color:th("#e6edf3","#0d0d0b"),fontSize:14,fontWeight:600}}>{authUser.name}</div><div style={{color:th("#3a4050","#8a7e74"),fontSize:9,fontFamily:"monospace",marginTop:1}}>OPTIONS DESK USER</div></div>
            </div>
            <div style={{borderTop:"1px solid #1c2128",paddingTop:14,marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em",marginBottom:10}}>CHANGE PIN</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {pinStep>=1 && <div><FL>Current PIN</FL><input type="password" maxLength={4} value={pinCur} onChange={e=>setPinCur(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" disabled={pinStep>1}/></div>}
                {pinStep>=2 && <div><FL>New PIN (4 digits)</FL><input type="password" maxLength={4} value={pinNew} onChange={e=>setPinNew(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" autoFocus/></div>}
                {pinStep>=3 && <div><FL>Confirm New PIN</FL><input type="password" maxLength={4} value={pinCon} onChange={e=>setPinCon(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" autoFocus/></div>}
              </div>
              {pinMsg && <div style={{marginTop:8,fontSize:11,fontFamily:"monospace",color:pinMsg.includes("✓")?"#00ff88":"#ff4560"}}>{pinMsg}</div>}
              <button onClick={doPINChange} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,width:"100%",marginTop:10}}>{pinStep===3?"Save PIN":"Next →"}</button>
              <div style={{marginTop:6,fontSize:9,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",textAlign:"center"}}>2FA planned for future release</div>
            </div>
            <button onClick={()=>{setAuthUser(null);setShowProfile(false);}} style={{background:"#ff456010",color:"#ff4560",border:"1px solid #ff456030",borderRadius:6,padding:"8px",width:"100%",fontSize:12,marginBottom:8}}>Sign Out</button>
            <button onClick={()=>{setShowProfile(false);setPinStep(1);setPinCur("");setPinNew("");setPinCon("");setPinMsg("");}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12}}>Close</button>
          </div>
        </div>
      )}

      {/* Team modal */}
      {showTeam && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowTeam(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:22,width:"100%",maxWidth:340,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em",marginBottom:14}}>TEAM</div>
            {users.map(u => {
              const uc = originals.filter(c=>c.createdBy===u.id);
              const up = originals.filter(c=>c.createdBy===u.id&&c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
              return (
                <div key={u.id} style={{background:th("#0a0e14","#f8f3eb"),border:`1px solid ${u.color}20`,borderRadius:8,padding:12,marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:8}}>
                    <div style={{width:30,height:30,borderRadius:"50%",background:`${u.color}20`,border:`2px solid ${u.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:u.color,fontSize:10}}>{u.initials}</div>
                    <div><div style={{color:th("#e6edf3","#0d0d0b"),fontSize:12,fontWeight:600}}>{u.name}</div>{u.id===authUser.id&&<div style={{color:u.color,fontSize:8,fontFamily:"monospace"}}>● ACTIVE</div>}</div>
                  </div>
                  <div style={{display:"flex",gap:14}}>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>CONTRACTS</div><div style={{fontSize:14,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{uc.length}</div></div>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>REALIZED P/L</div><div style={{fontSize:14,fontFamily:"monospace",color:up>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(up)}</div></div>
                  </div>
                </div>
              );
            })}
            <button onClick={()=>setShowTeam(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12,marginTop:4}}>Close</button>
          </div>
        </div>
      )}



      {/* Column picker modal */}
      {showColPicker && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowColPicker(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:300,animation:"fadeIn .15s",maxHeight:"85vh",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",marginBottom:4}}>COLUMNS</div>
            <div style={{fontFamily:"monospace",fontSize:8,color:th("#2a3040","#6b5f55"),marginBottom:12}}>Toggle visible · use arrows to reorder</div>
            <div style={{overflowY:"auto",flex:1,marginBottom:10}}>
            {cols.map((col, idx) => (
              <div key={col.key} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:6,marginBottom:5}}>
                <label style={{display:"flex",alignItems:"center",gap:8,flex:1,cursor:"pointer"}}>
                  <input type="checkbox" checked={col.show} onChange={()=>{const nc=cols.map(c=>c.key===col.key?{...c,show:!c.show}:c);persistCols(nc);}} style={{width:14,height:14,accentColor:"#00ff88"}}/>
                  <span style={{fontSize:12,color:th("#c9d1d9","#1a1a18"),fontFamily:"monospace"}}>{col.label}</span>
                </label>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <button onClick={()=>moveCol(col.key,"up")} disabled={idx===0}
                    style={{background:"transparent",border:"1px solid #21262d",borderRadius:3,padding:"1px 5px",fontSize:10,color:idx===0?th("#1c2128","#b8a898"):"#555",lineHeight:1,cursor:idx===0?"default":"pointer"}}>↑</button>
                  <button onClick={()=>moveCol(col.key,"down")} disabled={idx===cols.length-1}
                    style={{background:"transparent",border:"1px solid #21262d",borderRadius:3,padding:"1px 5px",fontSize:10,color:idx===cols.length-1?th("#1c2128","#b8a898"):"#555",lineHeight:1,cursor:idx===cols.length-1?"default":"pointer"}}>↓</button>
                </div>
              </div>
            ))}
            </div>
            <button onClick={()=>setShowColPicker(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12,flexShrink:0}}>Done</button>
          </div>
        </div>
      )}

      {/* ── STRATEGIES MODAL ── */}
      {showStrategies && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowStrategies(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#ffd166",letterSpacing:"0.07em"}}>♟ STRATEGIES</div>
              <button onClick={()=>setShowStrategies(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Add strategy form */}
            {stratForm ? (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:12,marginBottom:12}}>
                <div style={{fontFamily:"monospace",fontSize:9,color:"#ffd166",marginBottom:8}}>{stratForm.id?"EDIT":"NEW"} STRATEGY</div>
                <div style={{display:"flex",flexDirection:"column",gap:7}}>
                  <div><FL req>Name</FL><input type="text" value={stratForm.name} onChange={e=>setStratForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Wheel Strategy"/></div>
                  <div><FL>Description</FL><textarea rows={2} value={stratForm.description||""} onChange={e=>setStratForm(p=>({...p,description:e.target.value}))} style={{resize:"vertical"}} placeholder="Short description of the strategy"/></div>
                  <div><FL>Rules / Notes</FL><textarea rows={3} value={stratForm.rules||""} onChange={e=>setStratForm(p=>({...p,rules:e.target.value}))} style={{resize:"vertical"}} placeholder="Entry criteria, exit rules, position sizing..."/></div>
                </div>
                <div style={{display:"flex",gap:7,marginTop:9,alignItems:"center"}}>
                  <button onClick={async()=>{
                    if(!stratForm.name.trim()) return;
                    const row = {name:stratForm.name,description:stratForm.description||"",rules:stratForm.rules||"",created_at:new Date().toISOString()};
                    try {
                      if(stratForm.id) {
                        const {error} = await supabase.from("strategies").update(row).eq("id",stratForm.id);
                        if(error) throw error;
                        setStrategies(p=>p.map(s=>s.id===stratForm.id?{...s,...row}:s));
                      } else {
                        const {data,error} = await supabase.from("strategies").insert(row).select().single();
                        if(error) throw error;
                        if(data) setStrategies(p=>[...p,data]);
                      }
                      setStratForm(null);
                    } catch(e) {
                      alert("Save failed: " + e.message + "\n\nMake sure you've run this SQL in Supabase:\n\ncreate table if not exists strategies (\n  id bigint generated always as identity primary key,\n  name text not null,\n  description text,\n  rules text,\n  created_at timestamptz default now()\n);");
                    }
                  }} style={{background:"#ffd166",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                  <button onClick={()=>setStratForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={()=>setStratForm({name:"",description:"",rules:""})} style={{background:"#ffd16614",color:"#ffd166",border:"1px solid #ffd16630",borderRadius:6,padding:"7px 14px",fontSize:11,fontFamily:"monospace",marginBottom:12}}>+ New Strategy</button>
            )}
            {/* Strategy list */}
            {strategies.length===0 && !stratForm && <div style={{color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace",padding:"12px 0"}}>No strategies yet — add one above</div>}
            {strategies.map(s=>(
              <div key={s.id} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                  <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:12}}>{s.name}</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>setStratForm({...s})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Edit</button>
                    <button onClick={async()=>{await supabase.from("strategies").delete().eq("id",s.id);setStrategies(p=>p.filter(x=>x.id!==s.id));}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Del</button>
                  </div>
                </div>
                {s.description && <div style={{fontSize:11,color:th("#8b949e","#5a5248"),marginBottom:4}}>{s.description}</div>}
                {s.rules && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",whiteSpace:"pre-wrap",borderTop:"1px solid #1c2128",paddingTop:6,marginTop:4}}>{s.rules}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── GOALS MODAL ── */}
      {showGoals && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowGoals(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:400,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>🎯 GOALS</div>
              <button onClick={()=>setShowGoals(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {[
              {label:"Daily Premium Target $",   key:"dailyPremium"},
              {label:"Daily Profit Target $",    key:"dailyProfit"},
              {label:"Weekly Premium Target $",  key:"weeklyPremium"},
              {label:"Monthly Premium Target $", key:"monthlyPremium"},
              {label:"Quarterly Premium Target $",key:"quarterlyPremium"},
              {label:"Weekly Profit Target $",   key:"weeklyProfit"},
              {label:"Monthly Profit Target $",  key:"monthlyProfit"},
              {label:"Quarterly Profit Target $",key:"quarterlyProfit"},
            ].map(g=>(
              <div key={g.key} style={{marginBottom:8}}>
                <FL>{g.label}</FL>
                <input type="number" value={goals[g.key]||""} onChange={e=>setGoals(p=>({...p,[g.key]:e.target.value}))} placeholder="0"/>
              </div>
            ))}
            <button onClick={async()=>{
              await supabase.from("col_prefs").upsert({id:"goals",cols:goals,updated_at:new Date().toISOString()});
              setShowGoals(false);
            }} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,width:"100%",marginTop:6}}>Save Goals</button>
          </div>
        </div>
      )}

      {/* ── CHASE MODAL ── */}
      {chaseModal && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setChaseModal(null)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #ffd16640",borderRadius:12,padding:20,width:"100%",maxWidth:400,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:13}}>🎯 Chase Order</div>
              <button onClick={()=>setChaseModal(null)} style={{background:"transparent",color:"#555",border:"none",fontSize:16,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontFamily:"monospace",fontSize:11,color:th("#8b949e","#5a5248"),marginBottom:12}}>
              {chaseModal.order.opt_type} {chaseModal.order.ticker} ${chaseModal.order.strike} {chaseModal.order.type} {chaseModal.order.expires}
              <span style={{marginLeft:8,color:"#ffd166"}}>Current limit: ${Number(chaseModal.order.limit_price||0).toFixed(2)}</span>
            </div>
            <div style={{fontSize:10,color:th("#8b949e","#5a5248"),fontFamily:"monospace",marginBottom:12,padding:"8px 10px",background:th("#080c12","#ede8df"),borderRadius:6,border:"1px solid #21262d"}}>
              {["STO","STC"].includes(chaseModal.order.opt_type)
                ? "Will step limit price down just below the ask each refresh cycle until floor is hit or order fills."
                : "Will step limit price up just above the bid each refresh cycle until floor is hit or order fills."}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div>
                <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:4,letterSpacing:"0.06em"}}>FLOOR PRICE $</div>
                <input type="number" step="0.01" min="0.01"
                  value={chaseModal.floor}
                  onChange={e=>setChaseModal(p=>({...p,floor:e.target.value}))}
                  style={{width:"100%",background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:4,padding:"6px 8px",fontSize:12,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b"),boxSizing:"border-box"}}
                  placeholder="e.g. 0.10" />
              </div>
              <div>
                <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:4,letterSpacing:"0.06em"}}>STEP SIZE $</div>
                <input type="number" step="0.01" min="0.01"
                  value={chaseModal.step}
                  onChange={e=>setChaseModal(p=>({...p,step:e.target.value}))}
                  style={{width:"100%",background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:4,padding:"6px 8px",fontSize:12,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b"),boxSizing:"border-box"}} />
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {chaseModal.order.chase_status === "active" ? (
                <button onClick={async()=>{
                  setChaseModal(p=>({...p,saving:true}));
                  try {
                    const r = await fetch(`/api/schwab-orders?action=chase-stop&secret=${encodeURIComponent("CronSecret2026!")}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:String(chaseModal.order.id)})});
                    if(r.ok){loadTradeOrders();setChaseModal(null);}
                    else{const d=await r.json();alert(d.error||"Failed");}
                  }catch(e){alert(e.message);}
                  setChaseModal(p=>p?({...p,saving:false}):p);
                }} disabled={chaseModal.saving}
                  style={{flex:1,padding:"8px 0",borderRadius:6,border:"1px solid #ff456040",background:"#ff456014",color:"#ff4560",fontSize:11,fontFamily:"monospace",fontWeight:600,cursor:"pointer"}}>
                  {chaseModal.saving?"Saving…":"⏹ Stop Chase"}
                </button>
              ) : (
                <button onClick={async()=>{
                  if(!chaseModal.floor||+chaseModal.floor<=0){alert("Set a floor price > 0");return;}
                  setChaseModal(p=>({...p,saving:true}));
                  try {
                    const r = await fetch(`/api/schwab-orders?action=chase-start&secret=${encodeURIComponent("CronSecret2026!")}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:String(chaseModal.order.id),chaseFloor:+chaseModal.floor,chaseStep:+chaseModal.step})});
                    if(r.ok){loadTradeOrders();setChaseModal(null);}
                    else{const d=await r.json();alert(d.error||"Failed");}
                  }catch(e){alert(e.message);}
                  setChaseModal(p=>p?({...p,saving:false}):p);
                }} disabled={chaseModal.saving}
                  style={{flex:1,padding:"8px 0",borderRadius:6,border:"1px solid #ffd16640",background:"#ffd16614",color:"#ffd166",fontSize:11,fontFamily:"monospace",fontWeight:600,cursor:"pointer"}}>
                  {chaseModal.saving?"Saving…":"🎯 Start Chase"}
                </button>
              )}
              <button onClick={()=>setChaseModal(null)}
                style={{padding:"8px 16px",borderRadius:6,border:"1px solid #21262d",background:"transparent",color:"#555",fontSize:11,cursor:"pointer"}}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PROFIT BANDS MODAL ── */}
      {showBands && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowBands(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:560,maxHeight:"88vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>🎯 PROFIT BANDS</div>
              <button onClick={()=>setShowBands(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:12}}>Rules apply top-down. Per-type thresholds/targets override global. Leave blank to inherit global.</div>

            {/* Global thresholds */}
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:10}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.07em",marginBottom:10}}>GLOBAL OTM THRESHOLDS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:8,alignItems:"end"}}>
                {[
                  {label:"Band 1 OTM %",key:"band1OTM",hint:"e.g. 3.0"},
                  {label:"Band 2 OTM %",key:"band2OTM",hint:"e.g. 1.5"},
                  {label:"Band 1 Target %",key:"globalTgt1",hint:"e.g. 70"},
                  {label:"Band 2 Target %",key:"globalTgt2",hint:"e.g. 60"},
                  {label:"Band 3 Target %",key:"globalTgt3",hint:"e.g. 50"},
                ].map(f=>(
                  <div key={f.key}>
                    <FL>{f.label}</FL>
                    <input type="number" value={bands[f.key]||""} onChange={e=>setBands(p=>({...p,[f.key]:e.target.value}))} placeholder={f.hint} step="0.1"/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:8,display:"flex",gap:8,fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",flexWrap:"wrap"}}>
                <span style={{color:"#00ff88"}}>Band 1 (Far OTM)</span>: ≥{bands.band1OTM||3}% → {bands.globalTgt1||70}% target
                <span style={{color:"#ffd166",marginLeft:8}}>Band 2 (Mid OTM)</span>: ≥{bands.band2OTM||1.5}% → {bands.globalTgt2||60}%
                <span style={{color:"#ff4560",marginLeft:8}}>Band 3 (Near/ATM)</span>: &lt;{bands.band2OTM||1.5}% → {bands.globalTgt3||50}%
              </div>
            </div>

            {/* Per-type overrides */}
            {[
              {label:"STO Calls", pfx:"stoCall", optType:"STO", type:"Call", color:"#00ff88"},
              {label:"STO Puts",  pfx:"stoPut",  optType:"STO", type:"Put",  color:"#ffd166"},
              {label:"BTO Calls", pfx:"btoCall", optType:"BTO", type:"Call", color:"#58a6ff"},
              {label:"BTO Puts",  pfx:"btoPut",  optType:"BTO", type:"Put",  color:"#c084fc"},
            ].map(({label,pfx,color})=>(
              <div key={pfx} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{fontFamily:"monospace",fontSize:8,color,letterSpacing:"0.07em",marginBottom:8}}>{label.toUpperCase()} OVERRIDES</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:7}}>
                  <div><FL>OTM Band 1 %</FL><input type="number" value={bands[pfx+"OTM1"]||""} onChange={e=>setBands(p=>({...p,[pfx+"OTM1"]:e.target.value}))} placeholder="global" step="0.1"/></div>
                  <div><FL>OTM Band 2 %</FL><input type="number" value={bands[pfx+"OTM2"]||""} onChange={e=>setBands(p=>({...p,[pfx+"OTM2"]:e.target.value}))} placeholder="global" step="0.1"/></div>
                  <div><FL>Band 1 Target %</FL><input type="number" value={bands[pfx+"Tgt1"]||""} onChange={e=>setBands(p=>({...p,[pfx+"Tgt1"]:e.target.value}))} placeholder="global"/></div>
                  <div><FL>Band 2 Target %</FL><input type="number" value={bands[pfx+"Tgt2"]||""} onChange={e=>setBands(p=>({...p,[pfx+"Tgt2"]:e.target.value}))} placeholder="global"/></div>
                  <div><FL>Band 3 Target %</FL><input type="number" value={bands[pfx+"Tgt3"]||""} onChange={e=>setBands(p=>({...p,[pfx+"Tgt3"]:e.target.value}))} placeholder="global"/></div>
                </div>
              </div>
            ))}

            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
              <button onClick={()=>setShowBands(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px 14px",fontSize:12}}>Cancel</button>
              <button onClick={async()=>{await persistBands(bands);setShowBands(false);}} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"8px 18px",fontSize:12,fontWeight:700}}>Save Bands</button>
            </div>
          </div>
        </div>
      )}

      {/* ── OTM/DTE MATRIX MODAL ── */}
      {showMatrix && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowMatrix(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:720,maxHeight:"90vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>📐 OTM + DTE PROFIT TARGET MATRIX</div>
              <button onClick={()=>setShowMatrix(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Call/Put tab */}
            <div style={{display:"flex",gap:5,marginBottom:14}}>
              {["Call","Put"].map(t=>(
                <button key={t} onClick={()=>setMatrixTab(t)}
                  style={{background:matrixTab===t?(t==="Call"?"#58a6ff14":"#ffd16614"):"transparent",color:matrixTab===t?(t==="Call"?"#58a6ff":"#ffd166"):"#555",border:`1px solid ${matrixTab===t?(t==="Call"?"#58a6ff30":"#ffd16630"):th("#1c2128","#b8a898")}`,borderRadius:5,padding:"4px 14px",fontSize:11,fontFamily:"monospace"}}>{t}s</button>
              ))}
              <span style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginLeft:8,alignSelf:"center"}}>Separate targets for Calls vs Puts</span>
            </div>
            {/* DTE col thresholds */}
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:10,marginBottom:10}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:th("#3a4050","#8a7e74"),marginBottom:8}}>DTE COLUMN BOUNDARIES (max days)</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {matrixDTECols.map((col,ci)=>(
                  <div key={ci}>
                    <FL>{col.label}</FL>
                    <input type="number" value={col.max===999?"":col.max} placeholder="∞" style={{width:60}} onChange={e=>{const nc=[...matrixDTECols];nc[ci]={...nc[ci],max:+e.target.value||999};setMatrixDTECols(nc);}}/>
                  </div>
                ))}
              </div>
            </div>
            {/* Matrix grid */}
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead>
                  <tr>
                    <th style={{padding:"6px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>OTM % \ DTE</th>
                    {matrixDTECols.map((col,ci)=>(
                      <th key={ci} style={{padding:"6px 8px",textAlign:"center",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixOTMRows.map((row,ri)=>{
                    const matrix = matrixTab==="Call" ? matrixCall : matrixPut;
                    const setMatrix = matrixTab==="Call" ? setMatrixCall : setMatrixPut;
                    return (
                      <tr key={ri}>
                        <td style={{padding:"6px 10px",fontFamily:"monospace",fontSize:10,color:th("#c9d1d9","#1a1a18"),background:th("#0a0e14","#f8f3eb"),borderBottom:"1px solid #1c2128",whiteSpace:"nowrap"}}>
                          <input type="number" value={row.min} step="0.5" style={{width:50,marginRight:4}} onChange={e=>{const nr=[...matrixOTMRows];nr[ri]={...nr[ri],min:+e.target.value};setMatrixOTMRows(nr);}}/>
                          <span style={{color:"#555"}}>%+</span>
                        </td>
                        {matrixDTECols.map((col,ci)=>{
                          const v = matrix[ri]?.[ci]??0;
                          const bg = v===0?th("#1c2128","#b8a898"):v>=65?"#00ff8820":v>=55?"#ffd16618":"#ff456018";
                          const color = v===0?th("#3a4050","#8a7e74"):v>=65?"#00ff88":v>=55?"#ffd166":"#ff4560";
                          return (
                            <td key={ci} style={{padding:4,borderBottom:"1px solid #0d1117",textAlign:"center"}}>
                              <div style={{background:bg,borderRadius:5,padding:"4px 2px",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                                <input type="number" value={v} min={0} max={100} style={{width:46,textAlign:"center",background:"transparent",border:"none",color,fontWeight:700,fontSize:12,padding:0}} onChange={e=>{const nm=matrix.map(r=>[...r]);nm[ri][ci]=+e.target.value||0;setMatrix(nm);}}/>
                                <span style={{fontSize:8,color,opacity:0.7}}>{v>0?"buy@"+(100-v)+"%":"avoid"}</span>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginTop:8}}>Value = target profit %. 0 = avoid writing this contract. "buy@X%" = buy back when contract is worth X% of original premium.</div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
              <button onClick={()=>setShowMatrix(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 14px",fontSize:12}}>Cancel</button>
              <button onClick={async()=>{await persistMatrix(matrixOTMRows,matrixDTECols,matrixCall,matrixPut);setShowMatrix(false);}} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:12,fontWeight:700}}>Save Matrix</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TRADE RULES MODAL ── */}
      {showSignalRules && null /* signal rules is now a tab */}
      {showTradeRules && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowTradeRules(false)}>
          <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#ffd166",letterSpacing:"0.07em"}}>⚙ TRADE RULES</div>
              <button onClick={()=>setShowTradeRules(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:12}}>Define criteria for valid trades. Rules are informational — matching contracts will be flagged on the plan tab.</div>
            {!tradeRuleForm ? (
              <button onClick={()=>setTradeRuleForm({...EMPTY_RULE})} style={{background:"#ffd16614",color:"#ffd166",border:"1px solid #ffd16630",borderRadius:6,padding:"6px 14px",fontSize:11,fontFamily:"monospace",marginBottom:12}}>+ New Rule</button>
            ) : (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:12,marginBottom:12,animation:"fadeIn .2s"}}>
                <div style={{fontFamily:"monospace",fontSize:9,color:"#ffd166",marginBottom:10}}>{tradeRuleForm.id?"EDIT":"NEW"} RULE</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:7}}>
                  <div><FL req>Rule Name</FL><input type="text" value={tradeRuleForm.name} onChange={e=>setTradeRuleForm(p=>({...p,name:e.target.value}))} placeholder="e.g. High OTM STO"/></div>
                  <div><FL>Direction</FL><select value={tradeRuleForm.direction} onChange={e=>setTradeRuleForm(p=>({...p,direction:e.target.value}))}><option>Open</option><option>Close</option><option>Both</option></select></div>
                  <div><FL>Opt Type</FL><select value={tradeRuleForm.optType} onChange={e=>setTradeRuleForm(p=>({...p,optType:e.target.value}))}><option>STO</option><option>BTO</option><option>Any</option></select></div>
                  <div><FL>Call / Put</FL><select value={tradeRuleForm.type} onChange={e=>setTradeRuleForm(p=>({...p,type:e.target.value}))}><option>Call</option><option>Put</option><option>Any</option></select></div>
                  <div><FL>Min OTM %</FL><input type="number" value={tradeRuleForm.minOTM} onChange={e=>setTradeRuleForm(p=>({...p,minOTM:e.target.value}))} placeholder="e.g. 2"/></div>
                  <div><FL>Max OTM %</FL><input type="number" value={tradeRuleForm.maxOTM} onChange={e=>setTradeRuleForm(p=>({...p,maxOTM:e.target.value}))} placeholder="e.g. 10"/></div>
                  <div><FL>Min DTE</FL><input type="number" value={tradeRuleForm.minDTE} onChange={e=>setTradeRuleForm(p=>({...p,minDTE:e.target.value}))} placeholder="e.g. 5"/></div>
                  <div><FL>Max DTE</FL><input type="number" value={tradeRuleForm.maxDTE} onChange={e=>setTradeRuleForm(p=>({...p,maxDTE:e.target.value}))} placeholder="e.g. 21"/></div>
                  <div><FL>Stock Perf</FL><select value={tradeRuleForm.stockPerf} onChange={e=>setTradeRuleForm(p=>({...p,stockPerf:e.target.value}))}><option>Any</option><option>Bullish</option><option>Bearish</option><option>Neutral</option></select></div>
                  <div><FL>Account</FL><select value={tradeRuleForm.account||"Schwab"} onChange={e=>setTradeRuleForm(p=>({...p,account:e.target.value}))}><option>Schwab</option><option>ETrade 6917</option><option>ETrade 8222</option></select></div>
                  <div><FL>Default Qty</FL><input type="number" min="1" value={tradeRuleForm.qty||"1"} onChange={e=>setTradeRuleForm(p=>({...p,qty:e.target.value}))} placeholder="1"/></div>
                  <div><FL>Min Premium $</FL><input type="number" value={tradeRuleForm.minPremium||""} onChange={e=>setTradeRuleForm(p=>({...p,minPremium:e.target.value}))} placeholder="e.g. 50"/></div>
                  <div><FL>Min VIX</FL><input type="number" value={tradeRuleForm.minVIX||""} onChange={e=>setTradeRuleForm(p=>({...p,minVIX:e.target.value}))} placeholder="e.g. 20"/></div>
                  <div><FL>Stock Up % Min</FL><input type="number" value={tradeRuleForm.stockUpPct||""} onChange={e=>setTradeRuleForm(p=>({...p,stockUpPct:e.target.value}))} placeholder="e.g. 1.5"/></div>
                  <div style={{display:"flex",alignItems:"center",gap:7,paddingTop:16}}>
                    <input type="checkbox" id="ruleEnabled" checked={tradeRuleForm.enabled!==false} onChange={e=>setTradeRuleForm(p=>({...p,enabled:e.target.checked}))}/>
                    <label htmlFor="ruleEnabled" style={{fontSize:11,color:th("#8b949e","#5a5248"),fontFamily:"monospace",cursor:"pointer"}}>Enabled</label>
                  </div>
                </div>
                <div style={{marginTop:8}}><FL>Tickers (comma-separated)</FL><input type="text" value={tradeRuleForm.tickers||""} onChange={e=>setTradeRuleForm(p=>({...p,tickers:e.target.value}))} placeholder="e.g. AAPL, NVDA, AMZN, WDC"/></div>
                <div style={{marginTop:8}}><FL>Logic / Notes</FL><textarea rows={2} value={tradeRuleForm.logic} onChange={e=>setTradeRuleForm(p=>({...p,logic:e.target.value}))} style={{resize:"vertical"}} placeholder="Describe the reasoning, entry/exit criteria..."/></div>
                <div style={{display:"flex",gap:7,marginTop:9}}>
                  <button onClick={async()=>{
                    if(!tradeRuleForm.name.trim()) return;
                    const rule = {...tradeRuleForm, id:tradeRuleForm.id||Date.now()};
                    const updated = tradeRuleForm.id ? tradeRules.map(r=>r.id===rule.id?rule:r) : [...tradeRules, rule];
                    await persistTradeRules(updated);
                    setTradeRuleForm(null);
                  }} style={{background:"#ffd166",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE RULE</button>
                  <button onClick={()=>setTradeRuleForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}
            {tradeRules.length===0 && !tradeRuleForm && <div style={{color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace",padding:"12px 0"}}>No rules yet — add one above</div>}
            {tradeRules.map(r=>(
              <div key={r.id} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:12}}>{r.name}</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>setTradeRuleForm({...r})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>Edit</button>
                    <button onClick={async()=>{const u=tradeRules.filter(x=>x.id!==r.id);await persistTradeRules(u);}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>Del</button>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[["Dir",r.direction],["Type",r.optType],["Call/Put",r.type],["OTM",r.minOTM&&r.maxOTM?r.minOTM+"–"+r.maxOTM+"%":r.minOTM?">"+r.minOTM+"%":r.maxOTM?"<"+r.maxOTM+"%":"Any"],["DTE",r.minDTE&&r.maxDTE?r.minDTE+"–"+r.maxDTE+"d":r.minDTE?">"+r.minDTE+"d":r.maxDTE?"<"+r.maxDTE+"d":"Any"],["Stock",r.stockPerf],["Acct",r.account],["Qty",r.qty],["Min $",r.minPremium?`$${r.minPremium}`:null],["VIX>",r.minVIX],["Up%",r.stockUpPct?`${r.stockUpPct}%`:null]].map(([l,v])=>(
                    v&&v!=="Any"&&<span key={l} style={{background:th("#1c2128","#b8a898"),borderRadius:4,padding:"2px 7px",fontSize:9,fontFamily:"monospace",color:"#888"}}>{l}: <span style={{color:th("#c9d1d9","#1a1a18")}}>{v}</span></span>
                  ))}
                  {r.enabled===false && <span style={{background:"#ff456014",borderRadius:4,padding:"2px 7px",fontSize:9,fontFamily:"monospace",color:"#ff4560"}}>DISABLED</span>}
                </div>
                {r.tickers && <div style={{fontSize:9,color:"#58a6ff",fontFamily:"monospace",marginTop:4}}>📋 {r.tickers}</div>}
                {r.logic && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",marginTop:6,borderTop:"1px solid #1c2128",paddingTop:6}}>{r.logic}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── TOPBAR ── */}
      <div style={{background:th("#0a0e14","#f8f3eb"),borderBottom:"1px solid #1c2128",padding:"0 10px",display:"flex",alignItems:"center",gap:8,height:50,position:"sticky",top:0,zIndex:100,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,borderRadius:7,background:"linear-gradient(135deg,#0d1f12,#0a1a1f)",border:"1px solid #00ff8830",boxShadow:"0 0 12px #00ff8812"}}>
            <span style={{fontFamily:"monospace",fontWeight:700,fontSize:10,color:"#00ff88"}}>PRI</span>
          </div>
          <div className="hm" style={{overflow:"hidden",minWidth:0,flexShrink:1}}>
            <div style={{fontSize:10,fontWeight:700,fontFamily:"monospace",letterSpacing:"0.03em",lineHeight:1.1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              <span style={{color:"#00ff88"}}>P</span><span style={{color:th("#c9d1d9","#1a1a18")}}>remium </span><span style={{color:"#00ff88"}}>R</span><span style={{color:th("#c9d1d9","#1a1a18")}}>ecurring </span><span style={{color:"#00ff88"}}>I</span><span style={{color:th("#c9d1d9","#1a1a18")}}>ncome</span>
            </div>
            <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.05em",marginTop:1}}>
              <span style={{color:"#00ff8860"}}>T</span>rading <span style={{color:"#00ff8860"}}>O</span>ptions <span style={{color:"#00ff8660"}}>D</span>ashboard · <span style={{color:"#00ff8840"}}>{storageMsg}</span>
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0,marginLeft:"auto"}}>
          <div onClick={()=>setShowProfile(true)} style={{width:26,height:26,borderRadius:"50%",background:`${authUser.color}20`,border:`2px solid ${authUser.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:authUser.color,fontSize:9,flexShrink:0,cursor:"pointer"}} title={authUser.name}>{authUser.initials}</div>
          <button className="hm" onClick={()=>window.open("/api/schwab-auth","_blank")} title="Re-authenticate Schwab (refresh token expires every 7 days)" style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"2px 5px",fontSize:8,color:"#555",fontFamily:"monospace",lineHeight:1.5,whiteSpace:"nowrap"}}>SCH⟳</button>
          <button className="hm" onClick={()=>window.open("/api/etrade?action=auth","_blank")} title="Re-authenticate ETrade" style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"2px 5px",fontSize:8,color:"#555",fontFamily:"monospace",lineHeight:1.5,whiteSpace:"nowrap"}}>ET⟳</button>
          <button className="hm" onClick={()=>{const v=Math.min(+(uiScale+0.1).toFixed(1),1.3);setUiScale(v);try{localStorage.setItem("pri_ui_scale",v)}catch{}}} title="Increase text size" style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"2px 6px",fontSize:10,color:"#555",fontFamily:"monospace",lineHeight:1.5}}>A+</button>
          <button className="hm" onClick={()=>{const v=Math.max(+(uiScale-0.1).toFixed(1),0.8);setUiScale(v);try{localStorage.setItem("pri_ui_scale",v)}catch{}}} title="Decrease text size" style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"2px 6px",fontSize:10,color:"#555",fontFamily:"monospace",lineHeight:1.5}}>A-</button>
          <div style={{display:"flex",borderRadius:20,overflow:"hidden",border:"2px solid #ffffff",flexShrink:0}}>
            <button onClick={()=>{setLightMode(false);try{localStorage.setItem("pri_light_mode","off")}catch{}}} style={{padding:"4px 9px",fontSize:10,fontWeight:700,fontFamily:"monospace",cursor:"pointer",border:"none",background:!lightMode?"#ffffff":"transparent",color:!lightMode?th("#0d1117","#f5f0e8"):"#555",transition:"all 0.15s",whiteSpace:"nowrap"}}>🌙 Dark</button>
            <button onClick={()=>{setLightMode(true);try{localStorage.setItem("pri_light_mode","on")}catch{}}} style={{padding:"4px 9px",fontSize:10,fontWeight:700,fontFamily:"monospace",cursor:"pointer",border:"none",background:lightMode?"#ffffff":"transparent",color:lightMode?th("#0d1117","#f5f0e8"):"#555",transition:"all 0.15s",whiteSpace:"nowrap"}}>☀ Light</button>
          </div>
          <button className="hm" title={autoRefreshEnabled ? "Auto-refresh ON — click to disable" : "Auto-refresh OFF — click to enable"} onClick={()=>{ const next=!autoRefreshEnabled; setAutoRefreshEnabled(next); try{localStorage.setItem("pri_auto_refresh",next?"on":"off")}catch{} }} style={{background:autoRefreshEnabled?"#00ff8814":"transparent",border:`1px solid ${autoRefreshEnabled?"#00ff8830":th("#1c2128","#b8a898")}`,borderRadius:4,padding:"2px 6px",fontSize:9,color:autoRefreshEnabled?"#00ff88":"#555",fontFamily:"monospace",lineHeight:1.5,whiteSpace:"nowrap"}}>
            {autoRefreshEnabled ? "⟳ auto" : "⟳ off"}{lastAutoRefreshAt && autoRefreshEnabled ? <span style={{fontSize:7,opacity:0.6,marginLeft:3}}>{lastAutoRefreshAt}</span> : null}
          </button>
          <div ref={menuRef} style={{position:"relative"}}>
            <button onClick={()=>setShowMenu(p=>!p)} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:5,padding:"4px 6px",display:"flex",flexDirection:"column",gap:2.5,alignItems:"center",justifyContent:"center",width:28,height:28}}>
              {[0,1,2].map(i=><div key={i} style={{width:12,height:1.5,background:"#555",borderRadius:1}}/>)}
            </button>
            {showMenu && (
              <div style={{position:"fixed",top:50,right:10,background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:8,minWidth:180,animation:"sd .15s ease",zIndex:9999,overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.8)"}}>
                {[
                  {label:"Profile",      icon:"👤", fn:()=>{setShowProfile(true);setShowMenu(false);}},
                  {label:"Team",         icon:"👥", fn:()=>{setShowTeam(true);setShowMenu(false);}},
                  {label:"Opportunity Scanner", icon:"⟳", fn:()=>{setTab("scanner");setShowMenu(false);}},
                  {label:"SAGE Explorer", icon:"◈",  fn:()=>{setTab("sage");setShowMenu(false);}},
                  {label:"Signal Log",    icon:"📡", fn:()=>{setTab("signallog");setShowMenu(false);}},
                  {label:"All Transactions", icon:"💰", fn:()=>{setTab("all_transactions");setShowMenu(false);}},
                  {label:"Skynet",        icon:"🤖", fn:()=>{setTab("signalrules");setShowMenu(false);}},
                  {label:"Strategies",   icon:"♟",  fn:()=>{setTab("strategies");setShowMenu(false);}},

                  {label:"Profit Bands", icon:"🎯", fn:()=>{setShowBands(true);setShowMenu(false);}},
                  {label:"OTM/DTE Matrix",icon:"📐",fn:()=>{setShowMatrix(true);setShowMenu(false);}},
                  {label:"Trade Rules",  icon:"⚙", fn:()=>{setShowTradeRules(true);setShowMenu(false);}},
                  {label:"Goals",        icon:"📊", fn:()=>{setShowGoals(true);setShowMenu(false);}},
                  {label:"Schwab Re-Auth",  icon:"🔑", fn:()=>{window.open("/api/schwab-auth","_blank");setShowMenu(false);}},
                  {label:"ETrade Re-Auth",   icon:"🔑", fn:()=>{window.open("/api/etrade?action=auth","_blank");setShowMenu(false);}},
                  {label:"Export JSON",  icon:"⬇",  fn:()=>{doExport();setShowMenu(false);}},

                  {label:"Sign Out",     icon:"⏏",  fn:()=>{setAuthUser(null);setShowMenu(false);}},
                ].map(x=>(
                  <button key={x.label} onClick={x.fn} style={{display:"flex",alignItems:"center",gap:9,width:"100%",padding:"9px 13px",background:"transparent",border:"none",borderBottom:"1px solid #1c2128",color:th("#c9d1d9","#1a1a18"),fontSize:12,textAlign:"left"}}><span style={{fontSize:13}}>{x.icon}</span>{x.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{maxWidth:1440,margin:"0 auto",padding:"10px",animation:"fadeIn .25s ease"}}>

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Global filter */}
            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",padding:"7px 10px",background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}}>
              <span style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.07em"}}>FILTER</span>
              <select value={gTicker} onChange={e=>setGTicker(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">All Tickers</option>{allTickers.map(t=><option key={t}>{t}</option>)}</select>
              <select value={gOptType} onChange={e=>setGOptType(e.target.value)} style={{width:78,fontSize:11,padding:"3px 5px"}}><option value="All">STO/BTO</option><option value="STO">STO</option><option value="BTO">BTO</option></select>
              <select value={gType} onChange={e=>setGType(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">Call/Put</option><option value="Call">Call</option><option value="Put">Put</option></select>
              {(gTicker!=="All"||gOptType!=="All"||gType!=="All") && <button onClick={()=>{setGTicker("All");setGOptType("All");setGType("All");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕</button>}
              <div style={{marginLeft:"auto",display:"flex",gap:3,alignItems:"center"}}>
                <span style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>PROFIT BY</span>
                {["exec","close","accounting"].map(m=>(
                  <button key={m} onClick={()=>setProfitDateMode(m)} style={{background:profitDateMode===m?"#00ff8814":"transparent",color:profitDateMode===m?"#00ff88":th("#2a3040","#6b5f55"),border:profitDateMode===m?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace"}}>{m==="exec"?"Open Date":m==="close"?"Close Date":"Accounting"}</button>
                ))}
              </div>
            </div>
            {/* KPIs */}
            {/* Sleep Number + Skynet Automation — single combined row */}
            {(() => {
              const posValues = Object.entries(stocksData)
                .filter(([sym]) => sym !== "__cash__")
                .map(([sym, sd]) => ({ sym, val: (sd.shares||0) * (sd.currentPrice||0) }))
                .filter(p => p.val > 0);
              const totalEquity = posValues.reduce((s, p) => s + p.val, 0);
              const largest     = posValues.reduce((mx, p) => p.val > mx.val ? p : mx, { sym:"", val:0 });
              const sleepNumber = totalEquity > 0 ? Math.round(largest.val / totalEquity * 1000) / 10 : null;
              const sleepColor  = sleepNumber == null ? "#555" : sleepNumber < 20 ? "#00ff88" : sleepNumber < 30 ? "#ffd166" : "#ff4560";
              return (
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"stretch"}}>
                  {sleepNumber != null && (
                    <div title="Sleep Number: largest single position as % of total equity. Motley Fool rule: stay below 20% to sleep well at night."
                      style={{background:th("#0a0e14","#f8f3eb"),border:`1px solid ${sleepColor}30`,borderRadius:8,padding:"10px 14px",minWidth:120,cursor:"default"}}>
                      <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:2}}>😴 SLEEP NUMBER</div>
                      <div style={{fontSize:22,fontWeight:700,color:sleepColor,fontFamily:"'JetBrains Mono',monospace",lineHeight:1}}>{sleepNumber.toFixed(1)}%</div>
                      <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginTop:2}}>{largest.sym} · {sleepNumber<20?"safe":"⚠ concentrated"}</div>
                    </div>
                  )}
                  <div style={{flex:1,background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8815",borderRadius:8,padding:"10px 14px"}}>
                    <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.07em",marginBottom:8}}>🤖 SKYNET AUTOMATION</div>
                    <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
                      {[
                        { label:"AUTO OPENED", val: autoOpenC.length,    pct: null,           color:"#ffd166" },
                        { label:"AUTO CLOSED", val: autoClosedC.length,  pct: autoClosePct,   color:"#00ff88" },
                        { label:"APP CLOSED",  val: appClosedC.length,   pct: appClosePct,    color:"#58a6ff" },
                        { label:"MANUAL",      val: manualClosedC.length, pct: manualClosePct, color:"#555" },
                      ].map(s => (
                        <div key={s.label} style={{display:"flex",alignItems:"center",gap:8}}>
                          <div>
                            <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>{s.label}</div>
                            <div style={{fontFamily:"monospace",fontSize:16,color:s.color}}>{s.val}</div>
                          </div>
                          {s.pct != null && <div style={{fontFamily:"monospace",fontSize:11,color:s.color,opacity:0.6}}>{s.pct}%</div>}
                        </div>
                      ))}
                      <div style={{marginLeft:"auto",textAlign:"right"}}>
                        <div style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>SKYNET PROFIT</div>
                        <div style={{fontFamily:"monospace",fontSize:16,color:autoProfit>=0?"#00ff88":"#ff4560"}}>{autoProfit>=0?"+":""}{f$0(autoProfit)}</div>
                      </div>
                      <div style={{width:"100%",height:4,borderRadius:2,background:th("#1c2128","#b8a898"),display:"flex",overflow:"hidden"}}>
                        <div style={{width:autoClosePct+"%",background:"#00ff88",transition:"width .5s"}}/>
                        <div style={{width:appClosePct+"%",background:"#58a6ff",transition:"width .5s"}}/>
                        <div style={{width:manualClosePct+"%",background:th("#3a4050","#8a7e74"),transition:"width .5s"}}/>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              <KPI label="Total Premium" value={f$0(totalPrem)}      sub={allF.length+" contracts"}/>
              <KPI label="Realized P/L"  value={fSign0(realizedPL)} sub={winRate+"% win"+(profitDateMode==="accounting"?" · cash basis":"")} color={realizedPL>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Open Contract Value" value={f$0(openContractValue)} sub={openC.length+" contracts at market"} color="#ffd166"/>
              <KPI label="Net Exposure" value={f$0(committedFunds)} sub={"STO puts $"+f$0(stoLiability)+" − BTO assets $"+f$0(btoAssetVal)} color="#c084fc"/>
              <KPI label="Avg Profit"    value={fSign0(avgProfit)}    sub="per close" color={avgProfit>=0?"#58a6ff":"#ff4560"}/>
              <KPI label="Profit MTD"    value={fSign0(profitMTD)}    sub={mLabel+" · "+(profitDateMode==="accounting"?"cash basis":profitDateMode==="exec"?"opened":"closed")} color={profitMTD>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Profit YTD"    value={fSign0(profitYTD)}    sub={thisYear+" · "+(profitDateMode==="accounting"?"cash basis":profitDateMode==="exec"?"opened":"closed")} color={profitYTD>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Schwab YTD"    value={fSign0(profitYTDSchwab)} sub={thisYear+" · Schwab"} color={profitYTDSchwab>=0?"#00ff88":"#ff4560"}/>
              <KPI label="ETrade YTD"    value={fSign0(profitYTDEtrade)} sub={thisYear+" · ETrade"} color={profitYTDEtrade>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Premium MTD"   value={f$0(premMTD)}         sub={mLabel} color="#58a6ff"/>
              <KPI label="Premium YTD"   value={f$0(premYTD)}         sub={thisYear} color="#58a6ff"/>
            </div>
            {/* Goals progress */}
            {(goals.dailyPremium||goals.dailyProfit||goals.weeklyPremium||goals.monthlyPremium||goals.weeklyProfit||goals.monthlyProfit) && (() => {
              const now3 = new Date();
              const dayOfWeek = now3.getDay();
              const startOfWeek = new Date(now3); startOfWeek.setDate(now3.getDate() - (dayOfWeek===0?6:dayOfWeek-1));
              const weekKey = startOfWeek.toISOString().slice(0,10);
              const weekPrem = allF.filter(c=>c.dateExec>=weekKey).reduce((s,c)=>s+(c.premium||0),0);
              // Use profitDateMode for weekly profit too
              const weekProfit = closedC.filter(c=>(profitDateField(c)||"")>=weekKey).reduce((s,c)=>s+(c.profit||0),0);
              const GoalBar = ({label, current, target, color="#00ff88"}) => {
                if (!target) return null;
                const t = +target;
                // For profit goals, target can be negative (e.g. -$25k means keep losses below that)
                // reached = current >= target (for positive goals) or current <= target (if target negative means max loss)
                let pct, reached;
                if (t > 0) { pct = Math.min(100, Math.round(current/t*100)); reached = current >= t; }
                else { // negative target = max acceptable loss; progress = how close to zero we are
                  pct = current >= 0 ? 100 : Math.min(100, Math.round((1 - current/t)*100));
                  reached = current >= 0;
                }
                const barColor = reached ? "#00ff88" : pct >= 50 ? color : "#ff4560";
                return (
                  <div style={{flex:1,minWidth:120}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>{label}</span>
                      <span style={{fontSize:8,color:reached?"#00ff88":"#555",fontFamily:"monospace"}}>{pct}%</span>
                    </div>
                    <div style={{height:5,background:th("#0a0e14","#f8f3eb"),borderRadius:3,overflow:"hidden",border:"1px solid #1c2128"}}>
                      <div style={{height:"100%",width:pct+"%",background:barColor,borderRadius:3,transition:"width .4s"}}/>
                    </div>
                    <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginTop:2}}>{fSign0(current)} / {f$0(Math.abs(t))}</div>
                  </div>
                );
              };
              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:8}}>🎯 GOALS</div>
                  <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                    <GoalBar label="Daily Premium"   current={premToday}  target={goals.dailyPremium}   color="#58a6ff"/>
                    <GoalBar label="Daily Profit"    current={profitToday} target={goals.dailyProfit}   color="#00ff88"/>
                    <GoalBar label="Weekly Premium"  current={weekPrem}   target={goals.weeklyPremium}  color="#58a6ff"/>
                    <GoalBar label="Monthly Premium" current={premMTD}    target={goals.monthlyPremium} color="#58a6ff"/>
                    <GoalBar label="Weekly Profit"   current={weekProfit} target={goals.weeklyProfit}   color="#00ff88"/>
                    <GoalBar label="Monthly Profit"  current={profitMTD}  target={goals.monthlyProfit}  color="#00ff88"/>
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>VIEW</span>
              {["daily","weekly","monthly"].map(v=>(
                <button key={v} onClick={()=>setChartView(v)} style={{background:chartView===v?"#00ff8814":"transparent",color:chartView===v?"#00ff88":th("#2a3040","#6b5f55"),border:chartView===v?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 8px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
              ))}
              <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginLeft:8}}>DATE</span>
              {["executed","closed"].map(v=>(
                <button key={v} onClick={()=>setChartDate(v)} style={{background:chartDate===v?"#58a6ff14":"transparent",color:chartDate===v?"#58a6ff":th("#2a3040","#6b5f55"),border:chartDate===v?"1px solid #58a6ff25":"1px solid #1c2128",borderRadius:4,padding:"2px 8px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
              ))}


            </div>
            {/* Charts */}
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:8}}>
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em",marginBottom:7}}>PREMIUM & PROFIT — {chartView.toUpperCase()} BY DATE {chartDate.toUpperCase()}</div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={chartData} barGap={2} barSize={chartView==="monthly"?20:chartView==="weekly"?12:6}>
                    <CartesianGrid strokeDasharray="2 4" stroke={th("#0d1117","#f5f0e8")} vertical={false}/>
                    <XAxis dataKey="label" tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false} tickFormatter={v=>"$"+(v/1000).toFixed(0)+"k"}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Bar dataKey="premium" name="Premium" fill="#58a6ff" radius={[2,2,0,0]} opacity={0.7}/>
                    <Bar dataKey="profit"  name="Profit"  radius={[2,2,0,0]}>{chartData.map((e,i)=><Cell key={i} fill={e.profit>=0?"#00ff88":"#ff4560"} opacity={0.8}/>)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em",marginBottom:7}}>CONTRACTS / PERIOD</div>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="2 4" stroke={th("#0d1117","#f5f0e8")} vertical={false}/>
                    <XAxis dataKey="label" tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Line type="monotone" dataKey="contracts" name="Contracts" stroke="#ffd166" strokeWidth={2} dot={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            {/* Open positions — stats summary replacing the table */}
            {openC.length>0 && (() => {
              const today3 = new Date(); today3.setHours(0,0,0,0);
              const endOfWeek = new Date(today3); endOfWeek.setDate(today3.getDate()+(6-today3.getDay())); // Saturday
              const endOfNextWeek = new Date(endOfWeek); endOfNextWeek.setDate(endOfWeek.getDate()+7);
              const fmt = d => d.toISOString().slice(0,10);
              const openCalls = openC.filter(c=>c.type==="Call");
              const openPuts  = openC.filter(c=>c.type==="Put");
              const openSTOs  = openC.filter(c=>c.optType==="STO");
              const openBTOs  = openC.filter(c=>c.optType==="BTO");
              const premColl  = openSTOs.reduce((s,c)=>s+(c.premium||0),0);
              const premPaid  = openBTOs.reduce((s,c)=>s+Math.abs(c.premium||0),0);
              // Unrealized P&L: same calc as contracts tab gain$ column
              // STO: premium collected - current cost to buy back
              // BTO: current market value - premium paid
              const unrealPL = openC.reduce((s,c) => {
                if (!c.premium) return s;
                const lo   = findOptionForContract(etradeChains, c);
                const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                if (last == null) return s;
                const mv   = (c.qty||1) * last * 100;
                const prem = Math.abs(c.premium);
                const gain = c.optType==="BTO" ? mv - prem : prem - mv;
                return s + gain;
              }, 0);
              const currVal = openC.reduce((s,c) => {
                const lo   = findOptionForContract(etradeChains, c);
                const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                return last != null ? s + (c.qty||1)*last*100 : s;
              }, 0);
              // Expiry buckets
              const thisWeek  = openC.filter(c=>c.expires&&c.expires<=fmt(endOfWeek));
              const nextWeek  = openC.filter(c=>c.expires&&c.expires>fmt(endOfWeek)&&c.expires<=fmt(endOfNextWeek));
              const later     = openC.filter(c=>c.expires&&c.expires>fmt(endOfNextWeek));
              const bucketRow = (label, arr, color) => arr.length===0 ? null : (
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #1c2128"}}>
                  <span style={{fontSize:9,fontFamily:"monospace",color}}>{label}</span>
                  <span style={{fontSize:9,fontFamily:"monospace",color:th("#8b949e","#5a5248")}}>{arr.length} contracts · {arr.filter(c=>c.type==="Call").length}C {arr.filter(c=>c.type==="Put").length}P · {f$(arr.reduce((s,c)=>s+(c.premium||0),0))}</span>
                </div>
              );
              const statBox = (label, val, sub, col=lightMode?"#0d0d0b":"#e6edf3") => (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:6,padding:"8px 12px",flex:1,minWidth:90}}>
                  <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:4}}>{label}</div>
                  <div style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:col}}>{val}</div>
                  {sub && <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginTop:2}}>{sub}</div>}
                </div>
              );
              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:8}}>OPEN POSITIONS SUMMARY</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                    {statBox("OPEN CALLS",openCalls.length,openCalls.length+" positions","#58a6ff")}
                    {statBox("OPEN PUTS",openPuts.length,openPuts.length+" positions","#ffd166")}
                    {statBox("PREM COLLECTED",f$(premColl),"STO positions","#00ff88")}
                    {statBox("CURRENT VALUE",f$(currVal),"live mark","#c084fc")}
                    {statBox("UNREALIZED P/L",fSign0(unrealPL),"collected − current",unrealPL>=0?"#00ff88":"#ff4560")}
                  </div>
                  <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:5}}>BY EXPIRY</div>
                  {bucketRow("THIS WEEK",thisWeek,"#ff4560")}
                  {bucketRow("NEXT WEEK",nextWeek,"#ffd166")}
                  {bucketRow("LATER",later,"#00ff88")}
                </div>
              );
            })()}
            {/* Weekly Highlights */}
            {(() => {
              const now4 = new Date();
              const dow = now4.getDay();
              const startOfWeek = new Date(now4); startOfWeek.setDate(now4.getDate()-(dow===0?6:dow-1));
              const weekKey = startOfWeek.toISOString().slice(0,10);
              const weekClosed = closedC.filter(c=>c.closeDate>=weekKey);
              if (weekClosed.length===0) return null;
              const sorted = [...weekClosed].sort((a,b)=>(b.profit||0)-(a.profit||0));
              const top3 = sorted.slice(0,3);
              const bot2 = sorted.slice(-2).reverse();
              const weekTotal = weekClosed.reduce((s,c)=>s+(c.profit||0),0);
              const weekPremW = allF.filter(c=>c.dateExec>=weekKey).reduce((s,c)=>s+(c.premium||0),0);
              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:"10px 13px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
                    <div style={{fontFamily:"monospace",fontSize:8,color:"#ffd166",letterSpacing:"0.07em"}}>⚡ WEEKLY HIGHLIGHTS — wk of {weekKey}</div>
                    <div style={{display:"flex",gap:12}}>
                      <span style={{fontSize:10,color:"#58a6ff",fontFamily:"monospace"}}>Premium: {f$0(weekPremW)}</span>
                      <span style={{fontSize:10,color:weekTotal>=0?"#00ff88":"#ff4560",fontFamily:"monospace",fontWeight:700}}>Profit: {fSign0(weekTotal)}</span>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <div style={{fontSize:7,color:"#00ff88",fontFamily:"monospace",marginBottom:5}}>TOP 3 WINNERS</div>
                      {top3.map((c,i)=>(
                        <div key={c.id} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #0d1117"}}>
                          <span style={{fontSize:10,color:th("#c9d1d9","#1a1a18"),fontFamily:"monospace"}}>{i+1}. {c.stock}</span>
                          <span style={{fontSize:10,color:"#00ff88",fontFamily:"monospace",fontWeight:700}}>{fSign0(c.profit)}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{fontSize:7,color:"#ff4560",fontFamily:"monospace",marginBottom:5}}>BOTTOM 2</div>
                      {bot2.filter(c=>c.profit<0).map((c,i)=>(
                        <div key={c.id} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #0d1117"}}>
                          <span style={{fontSize:10,color:th("#c9d1d9","#1a1a18"),fontFamily:"monospace"}}>{i+1}. {c.stock}</span>
                          <span style={{fontSize:10,color:"#ff4560",fontFamily:"monospace",fontWeight:700}}>{fSign0(c.profit)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
            {contracts.length<=13 && (
              <div style={{background:"#ffd16608",border:"1px solid #ffd16630",borderRadius:8,padding:"10px 14px",fontSize:11,color:"#ffd166",fontFamily:"monospace"}}>

              </div>
            )}
          </div>
        )}

        {/* ══ CONTRACTS ══ */}
        {tab==="contracts" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            <div style={{display:"flex",gap:7,flexWrap:"wrap",alignItems:"center"}}>
              <button onClick={()=>{setForm({...EMPTY_NEW,dateExec:TODAY});setEditing(null);setFormMode("new");setShowForm(p=>formMode==="new"?!p:true);}} style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:6,padding:"7px 13px",fontSize:11,fontFamily:"monospace",fontWeight:700}}>+ New Contract</button>
              <button onClick={()=>setShowColPicker(true)} style={{background:"transparent",color:th("#3a4050","#8a7e74"),border:"1px solid #1c2128",borderRadius:6,padding:"7px 10px",fontSize:10,fontFamily:"monospace"}}>⠿ Columns</button>
              <button onClick={doExportCSV} style={{background:"transparent",color:th("#3a4050","#8a7e74"),border:"1px solid #1c2128",borderRadius:6,padding:"7px 10px",fontSize:10,fontFamily:"monospace"}} title={`Export ${sortedFiltered.length} filtered rows to CSV`}>↓ CSV ({sortedFiltered.length})</button>
              <button
                onClick={refreshEtrade}
                disabled={etradeStatus==="loading"}
                style={{
                  background: etradeStatus==="loading"?"#ffd16620":etradeStatus==="ok"?"#00ff8820":etradeStatus==="error"?"#ff456020":"#58a6ff20",
                  color:      etradeStatus==="loading"?"#ffd166":etradeStatus==="ok"?"#00ff88":etradeStatus==="error"?"#ff4560":"#58a6ff",
                  border:"none", borderRadius:6, padding:"7px 13px", fontSize:11, fontFamily:"monospace", fontWeight:700,
                  cursor:etradeStatus==="loading"?"wait":"pointer", display:"flex", alignItems:"center", gap:5,
                }}>
                {etradeStatus==="loading"
                  ? <><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",border:"1.5px solid currentColor",borderTopColor:"transparent",animation:"spin .6s linear infinite"}}/>Syncing…</>
                  : etradeStatus==="ok" ? "✓ Live Data" + (etradeLastFetch ? " · "+etradeLastFetch : "")
                  : etradeStatus==="error" ? "⚠ Retry Live"
                  : "⟳ Live Data"}
              </button>
              {etradeStatus==="error" && <span style={{fontSize:9,color:"#ff4560",fontFamily:"monospace"}}>{etradeMsg}</span>}
              {etradeStatus==="ok" && etradeMsg?.startsWith("Auto-refreshed") && (
                <span style={{fontSize:9,color:"#00ff8860",fontFamily:"monospace",marginLeft:4}}>{etradeMsg}</span>
              )}
            </div>

            {/* New contract form */}
            {showForm && formMode==="new" && (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8825",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:"#00ff88"}}/>
                  <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em"}}>{editing?"EDIT CONTRACT":"NEW CONTRACT"}</span>
                  <span style={{fontSize:9,color:"#58a6ff60",fontFamily:"monospace",marginLeft:4}}>* required</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(125px,1fr))",gap:7}}>
                  <div><FL req>Ticker</FL><input type="text" value={form.stock||""} autoComplete="off" spellCheck="false" className={formErrors.stock?"err":""} style={{textTransform:"uppercase"}} onChange={e=>{const t=e.target.value.toUpperCase();const d=tickerDefaults(t);setForm(p=>({...p,stock:t,expires:nextExpiry(t)||p.expires||"",account:d.account||p.account||"",qty:d.qty||p.qty||""}));}} placeholder=""/></div>
                  <div><FL req>Option Type</FL><select value={form.type} onChange={e=>{sf("type",e.target.value);if(form.optType==="STO"&&e.target.value==="Call")sf("strategy","OTM Covered Call Strategy");else if(form.strategy==="OTM Covered Call Strategy")sf("strategy","");}} className={formErrors.type?"err":""}><option>Call</option><option>Put</option></select></div>
                  <div><FL req>Opt Type</FL><select value={form.optType} onChange={e=>{sf("optType",e.target.value);if(e.target.value==="STO"&&form.type==="Call")sf("strategy","OTM Covered Call Strategy");else if(form.strategy==="OTM Covered Call Strategy")sf("strategy","");}} className={formErrors.optType?"err":""}><option>STO</option><option>BTO</option></select></div>
                  <div><FL req>Strike</FL><input type="number" value={form.strike} onChange={e=>sf("strike",e.target.value)} className={formErrors.strike?"err":""}/></div>
                  <div><FL req>Quantity</FL><input type="number" value={form.qty} onChange={e=>sf("qty",e.target.value)} className={formErrors.qty?"err":""}/></div>
                  <div><FL req>Premium $</FL><input type="number" value={form.premium} onChange={e=>sf("premium",e.target.value)} className={formErrors.premium?"err":""}/></div>
                  <div><FL>Price @ Exec $</FL><input type="number" value={form.priceAtExecution||""} onChange={e=>sf("priceAtExecution",e.target.value)}/></div>
                  <div><FL req>Date Executed</FL><input type="date" value={form.dateExec} onChange={e=>sf("dateExec",e.target.value)} className={formErrors.dateExec?"err":""}/></div>
                  <div>
                    <FL req>Expires</FL>
                    <input type="date" value={form.expires||""} onChange={e=>sf("expires",e.target.value)} className={formErrors.expires?"err":""}/>
                    {form.stock && EXPIRY_SCHEDULES[form.stock.toUpperCase()] && <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),marginTop:1,fontFamily:"monospace"}}>{EXPIRY_SCHEDULES[form.stock.toUpperCase()].join("/")}</div>}
                  </div>
                  <div><FL req>Account</FL><select value={form.account||""} onChange={e=>sf("account",e.target.value)} className={formErrors.account?"err":""}><option value="">—</option><option>Schwab</option><option>Etrade</option></select></div>
                  <div><FL>Strategy</FL><select value={form.strategy||""} onChange={e=>sf("strategy",e.target.value)}><option value="">— none —</option>{strategies.map(s=><option key={s.id} value={s.name}>{s.name}</option>)}</select></div>
                  <div><FL>Trade Rule</FL><select value={form.tradeRule||""} onChange={e=>sf("tradeRule",e.target.value)}><option value="">— none —</option>{tradeRules.map((r,i)=><option key={i} value={r.name||r.title||r.rule||JSON.stringify(r)}>{r.name||r.title||r.rule||("Rule "+(i+1))}</option>)}</select></div>
                </div>
                <div style={{marginTop:7}}><FL>Notes</FL><textarea rows={2} value={form.notes||""} onChange={e=>sf("notes",e.target.value)} style={{resize:"vertical"}}/></div>
                {editing && contracts.find(x=>x.id===editing)?.status==="Closed" && (
                  <div style={{borderTop:"1px solid #1c2128",marginTop:11,paddingTop:11}}>
                    <div style={{fontFamily:"monospace",fontSize:8,color:"#ffd166",letterSpacing:"0.07em",marginBottom:7}}>CLOSE DETAILS</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(125px,1fr))",gap:7}}>
                      <div><FL>Cost to Close $</FL><input type="number" value={form.costToClose||""} onChange={e=>{const ctc=+e.target.value||0;const pr=+form.premium||0;const p=+(pr-ctc).toFixed(2);setForm(x=>({...x,costToClose:e.target.value,profit:`${p}`,profitPct:`${pr>0?+(p/pr).toFixed(4):0}`}));}}/></div>
                      <div><FL>Date Closed</FL><input type="date" value={form.closeDate||""} onChange={e=>{const dy=form.dateExec&&e.target.value?Math.round((new Date(e.target.value)-new Date(form.dateExec))/86400000):"";setForm(x=>({...x,closeDate:e.target.value,daysHeld:`${dy}`}));}}/></div>
                      <div><FL>Profit $</FL><input type="number" value={form.profit||""} onChange={e=>sf("profit",e.target.value)}/></div>
                      <div><FL>Days Held</FL><input type="number" value={form.daysHeld||""} onChange={e=>sf("daysHeld",e.target.value)}/></div>
                      <div><FL>Exercised?</FL><select value={form.exercised||"No"} onChange={e=>sf("exercised",e.target.value)}><option>No</option><option>Yes</option></select></div>
                      <div><FL>Rolled Over?</FL><select value={form.rolledOver||"No"} onChange={e=>sf("rolledOver",e.target.value)}><option>No</option><option>Yes</option></select></div>
                    </div>
                  </div>
                )}
                {Object.keys(formErrors).length>0 && <div style={{marginTop:8,fontSize:10,color:"#ff4560",fontFamily:"monospace"}}>⚠ Please fill in all required fields (*)</div>}
                <div style={{display:"flex",gap:7,marginTop:11}}>
                  <button onClick={saveNew} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>{editing?"UPDATE":"SAVE OPEN"}</button>
                  <button onClick={()=>{setShowForm(false);setEditing(null);setForm({...EMPTY_NEW});setFormErrors({});}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}

            {/* Close form */}
            {showForm && (formMode==="close" || formMode==="manualClose") && (() => {
              const orig = contracts.find(c=>c.id===closingId);
              const ctc = +closeForm.costToClose||0;
              const isBTO = orig?.optType === "BTO";
              const ep  = orig ? (isBTO ? +(ctc - Math.abs(orig.premium)).toFixed(2) : +(orig.premium - ctc).toFixed(2)) : null;
              const basis = orig ? Math.abs(orig.premium) : 0;
              const epct = basis > 0 ? (ep/basis*100).toFixed(1) : null;
              const ed  = orig&&closeForm.closeDate ? Math.round((new Date(closeForm.closeDate)-new Date(orig.dateExec))/86400000) : null;
              const closeLabel = isBTO ? "STC (Sell to Close)" : "BTC (Buy to Close)";
              const isApiAccount = !!(orig?.account?.startsWith("Schwab") || orig?.account?.startsWith("ETrade")) && formMode !== "manualClose";
              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:"#ffd166"}}/>
                    <span style={{fontFamily:"monospace",fontSize:10,color:"#ffd166",letterSpacing:"0.07em"}}>CLOSE CONTRACT — {closeLabel}</span>
                    {orig && <span style={{fontSize:10,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>{fTitle(orig)} — opened at <span style={{color:"#58a6ff"}}>{fMoney(orig.premium)}</span></span>}
                    <button onClick={()=>{setShowForm(false);setClosingId(null);setCloseForm({...EMPTY_CLOSE});}} style={{marginLeft:"auto",background:"transparent",border:"none",color:"#555",cursor:"pointer",fontSize:14}}>✕</button>
                  </div>

                  {/* ── Signal decision banner ── */}
                  {pendingSignalId && !signalDecision && (
                    <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #ffd16630",borderRadius:6,padding:"10px 12px",marginBottom:12}}>
                      <div style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74"),letterSpacing:"0.07em",marginBottom:8}}>📡 signal · closing trade will auto-log if submitted · or log a pass below</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input id="signal-dec-notes-close" type="text" placeholder="reason for passing (optional)..." style={{flex:1,background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:4,padding:"5px 8px",fontSize:9,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18")}} />
                        <button onClick={async () => {
                          const notes = document.getElementById("signal-dec-notes-close")?.value || "";
                          const { error } = await supabase.from("decision_log").insert({ signal_id: pendingSignalId, source_table: "signal_log", source_id: pendingSignalId, decision: "passed", notes, created_at: new Date().toISOString() });
                          if (error) { alert("Save failed: " + error.message); return; }
                          setSignalDecision({ decision: "passed", notes });
                          setPendingSignalId(null);
                        }} style={{background:"transparent",border:"1px solid #ff456040",borderRadius:4,padding:"4px 12px",fontSize:9,fontFamily:"monospace",color:"#ff4560",cursor:"pointer",whiteSpace:"nowrap"}}>
                          PASSED
                        </button>
                        <button onClick={() => { setPendingSignalId(null); setSignalDecision(null); }} style={{background:"transparent",border:"none",color:th("#3a4050","#8a7e74"),fontSize:12,cursor:"pointer",lineHeight:1}}>×</button>
                      </div>
                    </div>
                  )}
                  {signalDecision && (
                    <div style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #ffd16620",borderRadius:6,padding:"7px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontFamily:"monospace",fontSize:9,color:"#555"}}>✓ logged as <span style={{color:"#ff4560"}}>passed</span>{signalDecision.notes ? ` — ${signalDecision.notes}` : ""}</span>
                      <button onClick={()=>setSignalDecision(null)} style={{background:"transparent",border:"none",color:th("#3a4050","#8a7e74"),fontSize:11,cursor:"pointer",marginLeft:"auto"}}>×</button>
                    </div>
                  )}
                  {/* For API accounts — go straight to order panel */}
                  {isApiAccount ? (
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <div style={{fontSize:11,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>
                        This contract is held at <span style={{color:"#ffd166"}}>{orig.account}</span>. Place a closing order via the API:
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{
                          setOrderControls({orderType:"LIMIT",duration:"DAY",specialInstruction:"NONE",limitPrice:null,qty:orig.qty});
                          setOrderPreview(null); setOrderError(null); setOrderSuccess(null); setShowRawJson(false);
                          setShowForm(false);
                          setClosingId(orig.id);
                          setFormMode("order");
                          setShowForm(true);
                        }}
                          style={{background:"#00ff8822",color:"#00ff88",border:"1px solid #00ff8844",borderRadius:6,padding:"8px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>
                          📤 Place {closeLabel} Order via {orig.account}
                        </button>
                        <button onClick={()=>{setShowForm(false);setClosingId(null);setCloseForm({...EMPTY_CLOSE});}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px 13px",fontSize:11,cursor:"pointer"}}>Cancel</button>
                      </div>
                      <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",borderTop:"1px solid #1c2128",paddingTop:8,marginTop:4}}>
                        Need to record a manual close instead? 
                        <button onClick={()=>setFormMode("manualClose")} style={{background:"transparent",color:"#58a6ff",border:"none",cursor:"pointer",fontSize:9,fontFamily:"monospace",marginLeft:4,textDecoration:"underline"}}>
                          Record manually →
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(135px,1fr))",gap:7,marginBottom:9}}>
                    {orig && orig.qty > 1 && <div><FL>Qty to Close (of {orig.qty})</FL><input type="number" min={1} max={orig.qty} value={closeForm.qtyToClose||orig.qty} onChange={e=>setCloseForm(p=>({...p,qtyToClose:Math.min(orig.qty,Math.max(1,+e.target.value||1))}))} /></div>}
                    <div><FL>Cost to Close $</FL><input type="number" value={closeForm.costToClose} onChange={e=>setCloseForm(p=>({...p,costToClose:e.target.value}))}/></div>
                    <div><FL>Date Closed</FL><input type="date" value={closeForm.closeDate} onChange={e=>setCloseForm(p=>({...p,closeDate:e.target.value}))}/></div>
                    <div><FL>Exercised?</FL><select value={closeForm.exercised} onChange={e=>setCloseForm(p=>({...p,exercised:e.target.value}))}><option>No</option><option>Yes</option></select></div>
                    <div><FL>Rolled Over?</FL><select value={closeForm.rolledOver} onChange={e=>setCloseForm(p=>({...p,rolledOver:e.target.value}))}><option>No</option><option>Yes</option></select></div>
                  </div>
                  <div style={{marginBottom:9}}><FL>Stock Price at Close</FL><input type="number" value={closeForm.stockPriceAtClose||""} placeholder={stocksData[viewC?.stock?.toUpperCase()]?.currentPrice ? "~"+stocksData[viewC?.stock?.toUpperCase()]?.currentPrice : "enter price"} onChange={e=>setCloseForm(p=>({...p,stockPriceAtClose:e.target.value}))}/></div>
                  <div style={{marginBottom:9}}><FL>Notes</FL><textarea rows={2} value={closeForm.notes||""} onChange={e=>setCloseForm(p=>({...p,notes:e.target.value}))} style={{resize:"vertical"}}/></div>
                  {orig && ctc>0 && (
                    <div style={{display:"flex",gap:14,padding:"7px 11px",background:th("#080c12","#ede8df"),borderRadius:6,marginBottom:9,fontFamily:"monospace",fontSize:11}}>
                      <span style={{color:th("#8b949e","#5a5248")}}>Profit: <span style={{color:ep>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(ep)}</span></span>
                      <span style={{color:th("#8b949e","#5a5248")}}>Return: <span style={{color:ep>=0?"#00ff88":"#ff4560",fontWeight:700}}>{epct}%</span></span>
                      {ed!=null && <span style={{color:th("#8b949e","#5a5248")}}>Days: <span style={{color:"#888"}}>{ed}</span></span>}
                      <span style={{fontSize:16}}>{ep>=0?"🪙":"📉"}</span>
                    </div>
                  )}
                  <div style={{display:"flex",gap:7}}>
                    <button onClick={saveClose} style={{background:"#ffd166",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>CLOSE CONTRACT</button>
                    <button onClick={()=>{setShowForm(false);setClosingId(null);setCloseForm({...EMPTY_CLOSE});}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11}}>Cancel</button>
                  </div>
                    </>
                  )}
                </div>
              );
            })()}

            {showForm && formMode==="order" && (() => {
              const orig = contracts.find(c=>c.id===closingId);
              if (!orig) return null;
              const isETrade = orig.account?.startsWith("ETrade");
              const isBTO = orig.optType === "BTO";
              const closeLabel = isBTO ? "STC" : "BTC";
              const previewAction = isETrade ? "order-preview" : "preview";
              const approveAction = isETrade ? "order-place" : "approve";
              const apiBase = `/api/schwab-orders`;

              const fetchPreview = async () => {
                setOrderLoading(true); setOrderError(null); setOrderPreview(null); setOrderSuccess(null);
                try {
                  const r = await fetch(`${apiBase}?action=${previewAction}&secret=${encodeURIComponent("CronSecret2026!")}`, {
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({ contract_id: orig.id, qty: orderControls.qty||orig.qty, limit_price: orderControls.limitPrice||undefined, order_type: orderControls.orderType, duration: orderControls.duration, special_instruction: orderControls.specialInstruction }),
                  });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || "Preview failed");
                  setOrderControls(c => ({...c, limitPrice: data.livePrice?.mid ?? c.limitPrice}));
                  setOrderPreview(data);
                } catch(e) { setOrderError(e.message); }
                setOrderLoading(false);
              };

              const approveOrder = async (dryRun) => {
                if (!orderPreview?.order?.id) return;
                setOrderLoading(true); setOrderError(null);
                try {
                  const r = await fetch(`${apiBase}?action=${approveAction}&secret=${encodeURIComponent("CronSecret2026!")}`, {
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({ orderId: orderPreview.order.id, dry_run: dryRun, limit_price: orderControls.limitPrice, order_type: orderControls.orderType, duration: orderControls.duration, special_instruction: orderControls.specialInstruction }),
                  });
                  const data = await r.json();
                  if (r.status === 429 && data.retryable) {
                    let secs = 60;
                    setOrderError(`⏱ Rate limit — retrying in ${secs}s`);
                    const cd = setInterval(()=>{ secs--; if(secs<=0){clearInterval(cd);setOrderError(null);approveOrder(dryRun);}else{setOrderError(`⏱ Rate limit — retrying in ${secs}s`);} }, 1000);
                    setOrderLoading(false); return;
                  }
                  if (!r.ok) throw new Error(data.error || "Failed");
                  setOrderSuccess(dryRun ? "✓ Dry run approved." : `✅ Order submitted to ${orig.account}!`);
                  setOrderPreview(null);
                  if (!dryRun) {
                    loadTradeOrders?.();
                    if (pendingSignalId) {
                      supabase.from("decision_log").insert({ signal_id: pendingSignalId, contract_id: orig?.id ?? null, decision: "traded", notes: "", created_at: new Date().toISOString() })
                        .then(() => { setSignalDecision({ decision: "traded" }); setPendingSignalId(null); });
                    }
                  }
                } catch(e) { setOrderError(e.message); }
                setOrderLoading(false);
              };

              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8825",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:"#00ff88"}}/>
                    <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em"}}>PLACE ORDER — {closeLabel} · {orig.account}</span>
                    {orig && <span style={{fontSize:10,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>{fTitle(orig)}</span>}
                    <button onClick={()=>{setShowForm(false);setClosingId(null);setOrderPreview(null);setOrderError(null);setOrderSuccess(null);}} style={{marginLeft:"auto",background:"transparent",border:"none",color:"#555",cursor:"pointer",fontSize:14}}>✕</button>
                  </div>
                  {!orderSuccess ? (
                    <div>
                      {/* Controls */}
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                        <div>
                          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:4}}>QTY</div>
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <button onClick={()=>setOrderControls(c=>({...c,qty:Math.max(1,(c.qty||orig.qty)-1)}))} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer"}}>−</button>
                            <span style={{fontFamily:"monospace",fontSize:13,color:th("#e6edf3","#0d0d0b"),minWidth:20,textAlign:"center"}}>{orderControls.qty||orig.qty}</span>
                            <button onClick={()=>setOrderControls(c=>({...c,qty:Math.min(orig.qty,(c.qty||orig.qty)+1)}))} style={{width:22,height:22,background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,cursor:"pointer"}}>+</button>
                          </div>
                        </div>
                        {[["ORDER TYPE",["LIMIT","MARKET"],"orderType","#ffd166"],["DURATION",[["DAY","Day"],["GTC","GTC"]],"duration","#58a6ff"]].map(([label,opts,key,color])=>(
                          <div key={key}>
                            <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:4}}>{label}</div>
                            <div style={{display:"flex"}}>
                              {opts.map(o=>{const[val,lbl]=Array.isArray(o)?o:[o,o];return(
                                <button key={val} onClick={()=>setOrderControls(c=>({...c,[key]:val}))}
                                  style={{background:orderControls[key]===val?color+"22":"transparent",color:orderControls[key]===val?color:"#555",border:"1px solid #21262d",borderRadius:val===opts[0]||val===opts[0]?.[0]?"4px 0 0 4px":"0 4px 4px 0",padding:"4px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer"}}>{lbl}</button>
                              );})}
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Bid/Mid/Ask after preview */}
                      {orderPreview?.livePrice && orderControls.orderType==="LIMIT" && (
                        <div style={{background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:6,padding:"8px 10px",marginBottom:10}}>
                          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:6}}>LIMIT PRICE</div>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            {[["Bid",orderPreview.livePrice.bid,"#ff4560"],["Mid",orderPreview.livePrice.mid,"#00ff88"],["Ask",orderPreview.livePrice.ask,"#58a6ff"]].map(([lbl,val,color])=>(
                              <button key={lbl} onClick={()=>setOrderControls(c=>({...c,limitPrice:Math.round(val*100)/100}))}
                                style={{background:Math.abs((orderControls.limitPrice||0)-val)<0.005?color+"22":"transparent",color,border:`1px solid ${color}44`,borderRadius:4,padding:"3px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer",fontWeight:600}}>
                                {lbl} ${val?.toFixed(2)}
                              </button>
                            ))}
                            <button onClick={()=>setOrderControls(c=>({...c,limitPrice:Math.max(0.01,Math.round(((c.limitPrice||0)-0.01)*100)/100)}))} style={{background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,width:22,height:22,cursor:"pointer",fontSize:13}}>−</button>
                            <span style={{fontFamily:"monospace",fontSize:13,color:"#ffd166",minWidth:40,textAlign:"center"}}>${(orderControls.limitPrice||0).toFixed(2)}</span>
                            <button onClick={()=>setOrderControls(c=>({...c,limitPrice:Math.round(((c.limitPrice||0)+0.01)*100)/100}))} style={{background:th("#21262d","#c8b8a8"),color:th("#e6edf3","#0d0d0b"),border:"none",borderRadius:3,width:22,height:22,cursor:"pointer",fontSize:13}}>+</button>
                            <input type="number" step="0.01" min="0.01" value={orderControls.limitPrice||""} onChange={e=>setOrderControls(c=>({...c,limitPrice:+e.target.value}))} style={{width:64,background:th("#161b22","#ede8df"),color:"#ffd166",border:"1px solid #30363d",borderRadius:4,padding:"3px 6px",fontFamily:"monospace",fontSize:11}}/>
                          </div>
                        </div>
                      )}
                      {/* Position summary */}
                      {orderPreview && (
                        <div style={{background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:6,padding:"8px 10px",marginBottom:10,fontFamily:"monospace",fontSize:11}}>
                          <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em",marginBottom:6}}>POSITION SUMMARY</div>
                          <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                            {[
                              ["Opened At", orig.premium != null ? (orig.premium >= 0 ? "+$"+orig.premium.toFixed(2) : "-$"+Math.abs(orig.premium).toFixed(2)) : "—", orig.premium >= 0 ? "#00ff88" : "#ff4560"],
                              ["Stock Price", stocksData[orig.stock?.toUpperCase()]?.currentPrice ? "$"+(stocksData[orig.stock?.toUpperCase()].currentPrice.toFixed(2)) : "—", th("#e6edf3","#0d0d0b")],
                              ["Est. Cost", orderControls.limitPrice ? "$"+(orderControls.limitPrice*(orderControls.qty||orig.qty)*100).toFixed(2) : "—", "#ffd166"],
                              ["Est. Profit", (() => {
                                if (!orderControls.limitPrice) return "—";
                                const closeQty = orderControls.qty || orig.qty;
                                const openQty  = orig.qty || 1;
                                const proratedPrem = Math.abs(orig.premium||0) * (closeQty/openQty);
                                const closeCost = orderControls.limitPrice * closeQty * 100;
                                const profit = orig.optType==="STO" ? proratedPrem - closeCost : closeCost - proratedPrem;
                                return (profit>=0?"+":"")+`$${profit.toFixed(2)}`;
                              })(), (() => {
                                if (!orderControls.limitPrice) return "#555";
                                const closeQty = orderControls.qty || orig.qty;
                                const openQty  = orig.qty || 1;
                                const proratedPrem = Math.abs(orig.premium||0) * (closeQty/openQty);
                                const closeCost = orderControls.limitPrice * closeQty * 100;
                                const profit = orig.optType==="STO" ? proratedPrem - closeCost : closeCost - proratedPrem;
                                return profit >= 0 ? "#00ff88" : "#ff4560";
                              })()],
                            ].map(([label,val,color])=>(
                              <div key={label}>
                                <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),letterSpacing:"0.06em"}}>{label}</div>
                                <div style={{color}}>{val}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {orderError && <div style={{fontSize:11,color:"#ff4560",marginBottom:8,fontFamily:"monospace"}}>⚠ {orderError}</div>}
                      {!orderPreview ? (
                        <button onClick={fetchPreview} disabled={orderLoading}
                          style={{background:"#ffd166",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:orderLoading?"wait":"pointer"}}>
                          {orderLoading?"Fetching…":"Get Live Price →"}
                        </button>
                      ) : (
                        <div>
                          <div style={{fontSize:10,color:"#ffd166",fontFamily:"monospace",marginBottom:8}}>⚠ Review carefully. Dry Run logs without submitting. Live submits to {orig.account}.</div>
                          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                            <button onClick={()=>approveOrder(true)} disabled={orderLoading} style={{background:"#58a6ff22",color:"#58a6ff",border:"1px solid #58a6ff44",borderRadius:6,padding:"7px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>{orderLoading?"…":"🧪 Dry Run"}</button>
                            <button onClick={()=>approveOrder(false)} disabled={orderLoading} style={{background:"#00ff8822",color:"#00ff88",border:"1px solid #00ff8844",borderRadius:6,padding:"7px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>{orderLoading?"Submitting…":`✅ Submit to ${orig.account}`}</button>
                            <button onClick={()=>{setOrderPreview(null);setOrderError(null);}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer"}}>← Back</button>
                            <button onClick={()=>setShowRawJson(v=>!v)} style={{background:"transparent",color:th("#3a4050","#8a7e74"),border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>{showRawJson?"▲ Hide":"{ } JSON"}</button>
                          </div>
                          {showRawJson && (() => {
                            const closingAction = orig.optType === "STO" ? (isETrade ? "BUY_CLOSE" : "BUY_TO_CLOSE") : (isETrade ? "SELL_CLOSE" : "SELL_TO_CLOSE");
                            const expires = new Date(orig.expires||"");
                            const payload = isETrade ? {
                              PreviewOrderRequest: {
                                orderType:"OPTN", clientOrderId:`app_preview`,
                                Order:[{ priceType: orderControls.orderType==="MARKET"?"MARKET":"LIMIT",
                                  ...(orderControls.orderType!=="MARKET"&&orderControls.limitPrice?{limitPrice:orderControls.limitPrice}:{}),
                                  orderTerm: orderControls.duration==="GTC"?"GOOD_UNTIL_CANCEL":"GOOD_FOR_DAY",
                                  marketSession:"REGULAR",
                                  Instrument:[{Product:{securityType:"OPTN",symbol:orig.stock,callPut:orig.type?.toUpperCase(),expiryYear:expires.getFullYear(),expiryMonth:expires.getMonth()+1,expiryDay:expires.getDate(),strikePrice:orig.strike},orderAction:closingAction,quantityType:"QUANTITY",quantity:orderControls.qty||orig.qty}]
                                }]
                              }
                            } : {
                              orderType: orderControls.orderType,
                              session: "NORMAL",
                              duration: orderControls.duration,
                              orderStrategyType: "SINGLE",
                              ...(orderControls.orderType==="LIMIT"&&orderControls.limitPrice?{price:(orderControls.limitPrice).toFixed(2)}:{}),
                              ...(orderControls.specialInstruction!=="NONE"?{specialInstruction:orderControls.specialInstruction}:{}),
                              orderLegCollection:[{instruction:closingAction,quantity:orderControls.qty||orig.qty,instrument:{symbol:`${orig.stock?.toUpperCase().padEnd(6)}${orig.expires?.replace(/-/g,"").slice(2)}${orig.type==="Call"?"C":"P"}${((orig.strike||0)*1000).toFixed(0).padStart(8,"0")}`,assetType:"OPTION"}}],
                            };
                            return <pre style={{marginTop:8,background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:5,padding:"8px",fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace",overflowX:"auto",whiteSpace:"pre-wrap"}}>{JSON.stringify(payload,null,2)}</pre>;
                          })()}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div style={{fontSize:13,color:"#00ff88",fontFamily:"monospace",marginBottom:8}}>{orderSuccess}</div>
                      <button onClick={()=>{setShowForm(false);setClosingId(null);setOrderPreview(null);setOrderSuccess(null);}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11,cursor:"pointer"}}>Done</button>
                    </div>
                  )}
                </div>
              );
            })()}
            {(() => {
              const strategyOpts = ["All","None",...[...new Set(contracts.map(c=>c.strategy).filter(Boolean))].sort()];
              const acctOpts     = ["All",...[...new Set(contracts.map(c=>c.account).filter(Boolean))].sort()];
              const hasAdv = fCType!=="All"||fCOptType!=="All"||fStrategy!=="All"||fAuto!=="All";
              const sel = {fontSize:11,padding:"3px 5px"};
              return (
                <>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                    <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{...sel,width:85}}><option value="All">All</option><option value="Open">Open</option><option value="Closed">Closed</option></select>
                    <select value={fAcct}   onChange={e=>setFAcct(e.target.value)}   style={{...sel,width:110}}>{acctOpts.map(a=><option key={a} value={a}>{a==="All"?"All Accounts":a}</option>)}</select>
                    <input type="text" placeholder="Search…" value={fSearch} onChange={e=>setFSearch(e.target.value)} style={{...sel,width:100}}/>
                    <input type="date" value={fDateFrom} onChange={e=>setFDateFrom(e.target.value)} style={{...sel,width:120}} title="From date"/>
                    <input type="date" value={fDateTo}   onChange={e=>setFDateTo(e.target.value)}   style={{...sel,width:120}} title="To date"/>
                    {(fDateFrom||fDateTo) && <button onClick={()=>{setFDateFrom("");setFDateTo("");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕ dates</button>}
                    <button onClick={()=>setFOriginals(p=>!p)}
                      style={{background:fOriginals?"#00ff8814":"#58a6ff14",color:fOriginals?"#00ff88":"#58a6ff",border:`1px solid ${fOriginals?"#00ff8830":"#58a6ff30"}`,borderRadius:4,padding:"3px 8px",fontSize:9,fontFamily:"monospace",whiteSpace:"nowrap"}}>
                      {fOriginals?"Originals only":"All records"}
                    </button>
                    <span style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>{sortedFiltered.length} rows</span>
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                    <select value={fCType}    onChange={e=>setFCType(e.target.value)}    style={{...sel,width:80}}><option value="All">Call/Put</option><option value="Call">Call</option><option value="Put">Put</option></select>
                    <select value={fCOptType} onChange={e=>setFCOptType(e.target.value)} style={{...sel,width:85}}><option value="All">STO/BTO…</option><option value="STO">STO</option><option value="BTO">BTO</option><option value="BTC">BTC</option><option value="STC">STC</option></select>
                    <select value={fStrategy} onChange={e=>setFStrategy(e.target.value)} style={{...sel,width:160}}>{strategyOpts.map(s=><option key={s} value={s}>{s==="All"?"All Strategies":s}</option>)}</select>
                    <select value={fAuto}     onChange={e=>setFAuto(e.target.value)}     style={{...sel,width:95}}><option value="All">Auto/Manual</option><option value="yes">Auto only</option><option value="no">Manual only</option></select>
                    {hasAdv && <button onClick={()=>{setFCType("All");setFCOptType("All");setFStrategy("All");setFAuto("All");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕ filters</button>}
                  </div>
                </>
              );
            })()}

            {/* Contracts table */}
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}} className="ms">
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead>
                  <tr>
                    {cols.filter(c=>c.show).map(col => (
                      <th key={col.key} className={col.sortKey?"thsort":""} onClick={()=>col.sortKey&&toggleSort(col.sortKey)}
                        style={{padding:"6px 8px",textAlign:col.right?"right":"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,letterSpacing:"0.04em",fontWeight:500,whiteSpace:"nowrap",borderBottom:"1px solid #1c2128",userSelect:"none"}}>
                        {col.label}{sortKey===col.sortKey ? (sortDir==="asc"?" ↑":" ↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.map(c => {
                    const itmStatus = getITMStatus(c);
                    const bd = getContractBand(c);
                    return (
                      <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer",background:c.status==="Open"&&itmStatus==="ITM"?"#ff456005":c.status==="Open"&&itmStatus==="OTM"?"#00ff8803":"transparent"}} onClick={()=>setViewC(c)}>
                        {cols.filter(x=>x.show).map(col => {
                          switch(col.key) {
                            case "ticker":  return <td key="ticker" className="sticky-col" style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:c.parentId?"#58a6ff":th("#e6edf3","#0d0d0b"),fontSize:12}}>{c.stock||"—"}{c.parentId&&<span style={{fontSize:7,color:"#58a6ff",marginLeft:2}}>BTC</span>}</td>;
                            case "contract":return <td key="contract" style={{padding:"5px 8px",fontFamily:"monospace",color:th("#8b949e","#5a5248"),fontSize:10,whiteSpace:"nowrap"}}>{fTitle(c)}</td>;
                            case "optType": return <td key="optType" style={{padding:"5px 8px"}}><Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":c.optType==="STC"?"blue":c.optType==="BTO"?"purple":"gray"}>{c.optType}</Tag></td>;
                            case "strike":  return <td key="strike" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${c.strike}</td>;
                            case "qty":     return <td key="qty" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),fontWeight:600}}>{c.qty}</td>;
                            case "expires": return <td key="expires" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:th("#c9d1d9","#1a1a18")}}>{c.expires||"—"}</td>;
                            case "dateExec":return <td key="dateExec" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:th("#1c2128","#b8a898")}}>{c.dateExec||"—"}</td>;
                            case "premium":     return <td key="premium" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:c.premium<0?"#ff4560":"#58a6ff"}}>{fMoney(c.premium)}</td>;
                            case "costToClose": return <td key="costToClose" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:th("#2a3040","#6b5f55")}}>{c.costToClose!=null?fMoney(c.costToClose):"—"}</td>;
                            case "closeDate":   return <td key="closeDate" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#555"}}>{c.closeDate||"—"}</td>;
                            case "profit": {
                              // For STO parent: find profit from linked BTC/STC child
                              const closeChild = c.profit == null
                                ? contracts.find(x => x.parentId === c.id && x.profit != null)
                                : null;
                              const displayProfit = c.profit ?? closeChild?.profit ?? null;
                              const displayPct    = c.profitPct ?? closeChild?.profitPct ?? null;
                              return <td key="profit" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>
                                {displayProfit!=null
                                  ? <><span style={{color:displayProfit>=0?"#00ff88":"#ff4560"}}>{fSign(displayProfit)}</span>
                                      {displayPct!=null && <span style={{fontSize:8,color:displayProfit>=0?"#00ff8870":"#ff456070",marginLeft:3}}>{(displayPct*100).toFixed(1)}%</span>}</>
                                  : <span style={{color:th("#1c2128","#b8a898")}}>—</span>}
                              </td>;
                            }
                            case "profitPct": {
                              const closeChild2 = c.profitPct == null ? contracts.find(x => x.parentId === c.id && x.profitPct != null) : null;
                              const pct = c.profitPct ?? closeChild2?.profitPct ?? null;
                              return <td key="profitPct" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>
                                {pct!=null ? <span style={{color:pct>=0?"#00ff88":"#ff4560"}}>{(pct*100).toFixed(1)}%</span> : <span style={{color:th("#1c2128","#b8a898")}}>—</span>}
                              </td>;
                            }
                            case "daysHeld": return <td key="daysHeld" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555",fontSize:11}}>{c.daysHeld!=null?c.daysHeld:"—"}</td>;
                            case "account": return <td key="account" style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>;
                            case "status":  return <td key="status" style={{padding:"5px 8px"}}><Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag></td>;
                            case "itmotm":  return <td key="itmotm" style={{padding:"5px 8px",textAlign:"center"}}>{c.status==="Open"&&itmStatus?<Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴":"🟢"}</Tag>:<span style={{color:th("#1c2128","#b8a898"),fontSize:10}}>—</span>}</td>;
                            case "otmPct":  return <td key="otmPct" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:bd?bd.bandColor:"#555"}}>{bd&&bd.otmPct!=null?bd.otmPct.toFixed(2)+"%":"—"}</td>;
                            case "band":    return <td key="band" style={{padding:"5px 8px"}}>{bd?<span style={{fontSize:9,fontFamily:"monospace",background:bd.bandColor+"22",color:bd.bandColor,border:`1px solid ${bd.bandColor}40`,borderRadius:3,padding:"1px 5px"}}>{bd.bandLabel}</span>:<span style={{color:th("#1c2128","#b8a898"),fontSize:10}}>—</span>}</td>;
                            case "tgtPerShare": return <td key="tgtPerShare" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88",fontWeight:700}}>{bd&&bd.targetPerShare!=null?"$"+(bd.targetPerShare).toFixed(2):"—"}</td>;
                            case "tgtClose": return <td key="tgtClose" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88"}}>{bd?f$(bd.targetClose):"—"}</td>;
                            case "liveStockPrice": {
                              if (c.status!=="Open") return <td key="liveStockPrice" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const sq = c.stock ? stocksData[c.stock.toUpperCase()] : null;
                              return <td key="liveStockPrice" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:sq?.lastQuoteAt?th("#e6edf3","#0d0d0b"):"#555"}}>
                                {sq?.currentPrice ? f$(sq.currentPrice) : "—"}
                                {sq?.lastQuoteAt && <span style={{fontSize:7,color:"#00ff8870",marginLeft:3}}>●</span>}
                              </td>;
                            }
                            case "liveChange": {
                              if (c.status!=="Open") return <td key="liveChange" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const sq = c.stock ? stocksData[c.stock.toUpperCase()] : null;
                              const chg = sq?.changeClose;
                              const pct = sq?.changePct; // already normalized to decimal e.g. 0.012 = 1.2%
                              return <td key="liveChange" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,fontWeight:700,color:chg==null?"#555":chg>=0?"#00ff88":"#ff4560"}}>
                                {chg!=null
                                  ? <>{chg>=0?"+":""}{f$(chg)}{pct!=null && <><br/><span style={{fontSize:8,opacity:0.8}}>{pct>=0?"+":""}{(pct*100).toFixed(2)}%</span></>}</>
                                  : "—"}
                              </td>;
                            }
                            case "liveBid": {
                              if (c.status!=="Open") return <td key="liveBid" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveBid" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.bid!=null?"#00ff88":"#555"}}>
                                {lo?.bid!=null ? f$(lo.bid) : "—"}
                              </td>;
                            }
                            case "liveAsk": {
                              if (c.status!=="Open") return <td key="liveAsk" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveAsk" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.ask!=null?"#58a6ff":"#555"}}>
                                {lo?.ask!=null ? f$(lo.ask) : "—"}
                              </td>;
                            }
                            case "liveLast": {
                              if (c.status!=="Open") return <td key="liveLast" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveLast" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.last!=null?th("#c9d1d9","#1a1a18"):"#555"}}>
                                {lo?.last!=null ? f$(lo.last) : "—"}
                              </td>;
                            }
                            case "mktValue": {
                              // Mkt Value = qty * mark (mid) * 100
                              if (c.status!=="Open") return <td key="mktValue" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const price = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                              const mv = price != null ? (c.qty||1) * price * 100 : null;
                              return <td key="mktValue" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:mv!=null?th("#c9d1d9","#1a1a18"):"#555"}}>
                                {mv!=null ? f$(mv) : "—"}
                              </td>;
                            }
                            case "liveGain": {
                              // Gain$ = Premium received - current market value
                              // For STO Call/Put: gain = premium - mktValue (positive = good, option lost value)
                              // For BTO: gain = mktValue - premium (positive = good, option gained value)
                              if (c.status!=="Open") return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                              if (last == null || c.premium == null) return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",color:"#555",fontFamily:"monospace"}}>—</td>;
                              const mv   = (c.qty||1) * last * 100;
                              const prem = Math.abs(c.premium);
                              const gain = c.optType==="BTO" ? mv - prem : prem - mv;
                              return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,fontWeight:700,color:gain>=0?"#00ff88":"#ff4560"}}>
                                {gain>=0?"+":""}{f$(gain)}
                              </td>;
                            }
                            case "liveGainPct": {
                              if (c.status!=="Open") return <td key="liveGainPct" style={{padding:"5px 8px",textAlign:"right",color:th("#1c2128","#b8a898"),fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                              if (last == null || !c.premium) return <td key="liveGainPct" style={{padding:"5px 8px",textAlign:"right",color:"#555",fontFamily:"monospace"}}>—</td>;
                              const mv   = (c.qty||1) * last * 100;
                              const prem = Math.abs(c.premium);
                              const gain = c.optType==="BTO" ? mv - prem : prem - mv;
                              const pct  = prem > 0 ? (gain / prem * 100) : null;
                              return <td key="liveGainPct" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,fontWeight:700,color:gain>=0?"#00ff88":"#ff4560"}}>
                                {pct!=null ? (gain>=0?"+":"")+pct.toFixed(1)+"%" : "—"}
                              </td>;
                            }
                            case "signal": {
                              if (c.status!=="Open") return <td key="signal" style={{padding:"5px 8px"}}></td>;
                              const bd  = getContractBand(c);
                              const lo  = getLiveOption(c);
                              const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                              if (!bd || last == null || !c.premium) return <td key="signal" style={{padding:"5px 8px",color:th("#1c2128","#b8a898"),fontSize:10,fontFamily:"monospace"}}>—</td>;
                              const mv      = (c.qty||1) * last * 100;
                              const prem    = Math.abs(c.premium);
                              const gain    = c.optType==="BTO" ? mv - prem : prem - mv;
                              const gainPct = prem > 0 ? (gain/prem)*100 : 0;
                              const tgtPct  = bd.tgtPct;
                              const target  = bd.targetClose;
                              const isBTO2  = c.optType === "BTO";
                              const expToday = c.expires === TODAY;
                              let label, color, bg;
                              if (gainPct >= tgtPct && c.qty > 1 && isBTO2 && !expToday) {
                                const perC = prem/(c.qty||1), gainPerU = gain/(c.qty||1);
                                const pq   = gainPerU > 0 ? Math.ceil(perC/gainPerU) : null;
                                label = pq && pq < c.qty ? "Sell "+pq+" of "+c.qty : "Close Now";
                                color = "#ffd166"; bg = "#ffd16620";
                              } else if (gainPct >= tgtPct) {
                                label = "Close Now"; color = "#00ff88"; bg = "#00ff8820";
                              } else if (gainPct >= tgtPct*0.75) {
                                label = "Approaching"; color = "#58a6ff"; bg = "#58a6ff20";
                              } else {
                                return <td key="signal" style={{padding:"5px 8px",color:th("#2a3040","#6b5f55"),fontSize:9,fontFamily:"monospace"}}>hold</td>;
                              }
                              return <td key="signal" style={{padding:"5px 8px"}}>
                                <span style={{fontSize:9,fontFamily:"monospace",background:bg,color,border:`1px solid ${color}40`,borderRadius:4,padding:"2px 7px",whiteSpace:"nowrap"}}>{label}</span>
                              </td>;
                            }
                            default: return null;
                          }
                        })}
                        {/* Close button on open rows */}
                        <td style={{padding:"4px 6px"}} onClick={e=>e.stopPropagation()}>
                          {c.status==="Open" && (
                            <button onClick={()=>startClose(c)}
                              style={{background:"#ffd16618",color:"#ffd166",border:"1px solid #ffd16635",borderRadius:4,padding:"3px 8px",fontSize:9,fontFamily:"monospace",whiteSpace:"nowrap"}}>
                              Close
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {sortedFiltered.length===0 && <tr><td colSpan={cols.filter(c=>c.show).length} style={{padding:22,textAlign:"center",color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace"}}>No contracts match filters</td></tr>}
                </tbody>
                {sortedFiltered.length > 0 && (() => {
                  const vis = cols.filter(c=>c.show).map(c=>c.key);
                  const totalsPremium    = sortedFiltered.filter(c=>["STO","BTO"].includes(c.optType)).reduce((s,c)=>s+(+c.premium||0),0);
                  const totalsProfit     = sortedFiltered.filter(c=>c.status==="Closed"&&c.profit!=null).reduce((s,c)=>s+(+c.profit||0),0);
                  const totalsCostClose  = sortedFiltered.filter(c=>c.status==="Open"&&c.costToClose!=null).reduce((s,c)=>s+(+c.costToClose||0),0);
                  // Gain $ total — mirrors the per-row liveGain calc (case "liveGain" above), summed across Open rows with a live quote
                  const liveGainRows = sortedFiltered.filter(c => {
                    if (c.status!=="Open" || c.premium==null) return false;
                    const lo = getLiveOption(c);
                    const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                    return last != null;
                  });
                  const totalsLiveGain = liveGainRows.reduce((s,c) => {
                    const lo = getLiveOption(c);
                    const last = (lo?.bid != null && lo?.ask != null) ? (lo.bid + lo.ask) / 2 : lo?.mark ?? lo?.last ?? lo?.bid ?? null;
                    const mv   = (c.qty||1) * last * 100;
                    const prem = Math.abs(c.premium);
                    const gain = c.optType==="BTO" ? mv - prem : prem - mv;
                    return s + gain;
                  }, 0);
                  const totalsCount      = sortedFiltered.length;
                  const closedCount      = sortedFiltered.filter(c=>c.status==="Closed").length;
                  const openCount        = sortedFiltered.filter(c=>c.status==="Open").length;
                  const tdS = {padding:"5px 8px",background:th("#0a0e14","#f8f3eb"),borderTop:"2px solid #1c2128",fontFamily:"monospace",fontSize:10,color:"#555",fontWeight:700};
                  return (
                    <tfoot>
                      <tr>
                        {vis.map(key => {
                          if (key==="ticker")   return <td key={key} style={{...tdS,textAlign:"left",color:th("#3a4050","#8a7e74")}}>TOTALS ({totalsCount})</td>;
                          if (key==="premium")  return <td key={key} style={{...tdS,textAlign:"right",color:totalsPremium>=0?"#58a6ff":"#ff4560"}}>{fMoney(totalsPremium)}</td>;
                          if (key==="profit")   return <td key={key} style={{...tdS,textAlign:"right",color:totalsProfit>=0?"#00ff88":"#ff4560"}}>{closedCount>0?fSign(totalsProfit):"—"}</td>;
                          if (key==="costToClose") return <td key={key} style={{...tdS,textAlign:"right",color:"#ffd166"}}>{openCount>0?fMoney(totalsCostClose):"—"}</td>;
                          if (key==="liveGain")  return <td key={key} style={{...tdS,textAlign:"right",color:totalsLiveGain>=0?"#00ff88":"#ff4560"}}>{liveGainRows.length>0?fSign(totalsLiveGain):"—"}</td>;
                          if (key==="status")   return <td key={key} style={{...tdS,textAlign:"left"}}>{openCount}o/{closedCount}c</td>;
                          return <td key={key} style={tdS}/>;
                        })}
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>

            {/* ── Pending Orders ── */}
            {(() => {
              const activeOrders = tradeOrders.filter(o => ["pending_approval","dry_run_approved","submitted"].includes(o.status));
              if (!activeOrders.length && !ordersLoading) return null;
              return (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #58a6ff25",borderRadius:8,padding:"10px 13px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <span style={{fontSize:9,color:"#58a6ff",fontFamily:"monospace",letterSpacing:"0.08em",fontWeight:700}}>PENDING ORDERS</span>
                    <button onClick={loadTradeOrders} disabled={ordersLoading} style={{background:"transparent",color:th("#3a4050","#8a7e74"),border:"1px solid #1c2128",borderRadius:3,padding:"1px 7px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>{ordersLoading?"…":"⟳ Refresh"}</button>
                  </div>
                  {activeOrders.length === 0 ? (
                    <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>No pending orders</div>
                  ) : (
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"monospace"}}>
                        <thead>
                          <tr style={{borderBottom:"1px solid #1c2128"}}>
                            {["Contract","Acct","Side","Qty","Limit","Type","Dur","Bid","Ask","Last","Status","Dry Run","Date",""].map(h=>(
                              <th key={h} style={{padding:"3px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontWeight:400,fontSize:8,letterSpacing:"0.06em"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {activeOrders.map(o => {
                            const statusColor = o.status==="submitted"?"#00ff88":o.status==="dry_run_approved"?"#58a6ff":"#ffd166";
                            const sc = orderStatuses[o.id];
                            const isExpanded = sc?.expanded;
                            const lq = o.live_quote;
                            return [
                              <tr key={`order-${o.id}`} style={{borderBottom: isExpanded?"none":"1px solid #0d1117",cursor:"pointer"}}
                                onClick={()=>setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],expanded:!p[o.id]?.expanded}}))}>
                                <td style={{padding:"4px 8px",color:th("#e6edf3","#0d0d0b"),fontWeight:600}}>{o.ticker} ${o.strike} {o.type} {o.expires}</td>
                                <td style={{padding:"4px 8px",color:o.account?.startsWith("Schwab")?"#58a6ff":"#ffd166",fontSize:9,fontFamily:"monospace"}}>{o.account||"—"}</td>
                                <td style={{padding:"4px 8px"}}><span style={{color:o.side==="BUY"?"#ff4560":"#00ff88",fontWeight:700,fontSize:9}}>{o.opt_type}</span></td>
                                <td style={{padding:"4px 8px",color:th("#e6edf3","#0d0d0b")}}>{o.qty}</td>
                                <td style={{padding:"4px 8px",color:"#ffd166"}}>{o.order_type==="MARKET"?"MKT":o.limit_price!=null?"$"+Number(o.limit_price).toFixed(2):"—"}</td>
                                <td style={{padding:"4px 8px",color:th("#8b949e","#5a5248")}}>{o.order_type||"LIMIT"}</td>
                                <td style={{padding:"4px 8px",color:th("#8b949e","#5a5248")}}>{o.duration==="GTC"?"GTC":"Day"}</td>
                                <td style={{padding:"4px 8px",color:"#ff4560",fontFamily:"monospace"}}>{lq?.bid!=null?`$${Number(lq.bid).toFixed(2)}`:"—"}</td>
                                <td style={{padding:"4px 8px",color:"#58a6ff",fontFamily:"monospace"}}>{lq?.ask!=null?`$${Number(lq.ask).toFixed(2)}`:"—"}</td>
                                <td style={{padding:"4px 8px",color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>{lq?.last!=null?`$${Number(lq.last).toFixed(2)}`:"—"}</td>
                                <td style={{padding:"4px 8px"}}><span style={{color:statusColor,fontSize:9,fontWeight:600}}>{o.status.replace(/_/g," ").toUpperCase()}</span></td>
                                <td style={{padding:"4px 8px",color:"#555"}}>{o.dry_run?"Yes":"—"}</td>
                                <td style={{padding:"4px 8px",color:th("#3a4050","#8a7e74")}}>{o.created_at?.slice(0,10)}</td>
                                <td style={{padding:"4px 8px"}} onClick={e=>e.stopPropagation()}>
                                  <div style={{display:"flex",gap:4}}>
                                    {o.status==="submitted" && o.schwab_order_id && (
                                      <button onClick={async()=>{
                                        setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],loading:true}}));
                                        try {
                                          const r = await fetch(`/api/schwab-orders?action=status&orderId=${o.id}&secret=${encodeURIComponent("CronSecret2026!")}`);
                                          const data = await r.json();
                                          setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],loading:false,result:data}}));
                                          loadTradeOrders();
                                        } catch(e) { setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],loading:false,result:{error:e.message}}})); }
                                      }} disabled={sc?.loading}
                                        style={{background:"#58a6ff14",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:3,padding:"2px 7px",fontSize:9,cursor:"pointer"}}>
                                        {sc?.loading?"…":"⟳"}
                                      </button>
                                    )}
                                    {["submitted","pending_approval","dry_run_approved"].includes(o.status) && (
                                      <button onClick={e=>{e.stopPropagation();setChaseModal({order:o,floor:o.chase_bound??"",step:o.chase_step??0.05,saving:false});}}
                                        style={{background:o.chase_status==="active"?"#ffd16620":"#ffd16610",color:o.chase_status==="active"?"#ffd166":"#ffd16688",border:`1px solid ${o.chase_status==="active"?"#ffd16650":"#ffd16620"}`,borderRadius:3,padding:"2px 7px",fontSize:9,cursor:"pointer"}}>
                                        {o.chase_status==="active"?"🎯 Chasing":"🎯 Chase"}
                                      </button>
                                    )}
                                    <button onClick={()=>cancelTradeOrder(o.id)}
                                      style={{background:orderStatuses[o.id]?.confirmCancel?"#ff4560":"#ff456014",color:orderStatuses[o.id]?.confirmCancel?"#fff":"#ff4560",border:"1px solid #ff456030",borderRadius:3,padding:"2px 7px",fontSize:9,cursor:"pointer",transition:"all 0.2s"}}
                                      onClickCapture={e=>{
                                        if (!orderStatuses[o.id]?.confirmCancel) {
                                          e.stopPropagation();
                                          setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],confirmCancel:true}}));
                                          setTimeout(()=>setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],confirmCancel:false}})),3000);
                                        }
                                      }}>
                                      {orderStatuses[o.id]?.confirmCancel?"Confirm?":"Cancel"}
                                    </button>
                                  </div>
                                </td>
                              </tr>,
                              isExpanded && (() => {
                                const history = Array.isArray(o.price_history) ? o.price_history : [];
                                return (
                                  <tr key={`detail-${o.id}`} style={{borderBottom:"1px solid #0d1117"}}>
                                    <td colSpan={14} style={{padding:"6px 10px 10px",background:th("#080c12","#ede8df")}}>
                                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

                                        {/* Left: reprice */}
                                        <div>
                                          <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:6}}>CHANGE LIMIT PRICE</div>
                                          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8}}>
                                            <input type="number" step="0.01" min="0.01"
                                              defaultValue={o.limit_price != null ? Number(o.limit_price).toFixed(2) : ""}
                                              id={`reprice-${o.id}`}
                                              style={{width:80,background:th("#0d1117","#f5f0e8"),border:"1px solid #21262d",borderRadius:4,padding:"5px 7px",fontSize:11,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b")}}
                                              placeholder="0.00"
                                            />
                                            <button onClick={async e=>{
                                              e.stopPropagation();
                                              const inp = document.getElementById(`reprice-${o.id}`);
                                              const val = parseFloat(inp?.value);
                                              if (!val || val <= 0) { alert("Enter a valid price"); return; }
                                              setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],repricing:true}}));
                                              try {
                                                const r = await fetch(`/api/schwab-orders?action=reprice&secret=${encodeURIComponent("CronSecret2026!")}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:String(o.id),newPrice:val,reason:"manual"})});
                                                const d = await r.json();
                                                if(r.ok){loadTradeOrders();setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],repricing:false,repriceResult:"✓ Repriced to $"+val.toFixed(2)}}));}
                                                else{setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],repricing:false,repriceResult:"⚠ "+d.error}}));}
                                              } catch(e){setOrderStatuses(p=>({...p,[o.id]:{...p[o.id],repricing:false,repriceResult:"⚠ "+e.message}}));}
                                            }} disabled={sc?.repricing}
                                              style={{background:"#58a6ff14",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"5px 10px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>
                                              {sc?.repricing?"…":"Update Price"}
                                            </button>
                                          </div>
                                          {sc?.repriceResult && <div style={{fontSize:9,fontFamily:"monospace",color:sc.repriceResult.startsWith("✓")?"#00ff88":"#ff4560",marginBottom:6}}>{sc.repriceResult}</div>}

                                          {/* Live quote status */}
                                          {sc?.result && (
                                            <div style={{padding:"5px 8px",background:th("#0d1117","#f5f0e8"),border:`1px solid ${sc.result.error?"#ff456030":sc.result.schwabStatus==="FILLED"?"#00ff8830":"#58a6ff30"}`,borderRadius:4,fontFamily:"monospace",fontSize:10}}>
                                              {sc.result.error ? <span style={{color:"#ff4560"}}>⚠ {sc.result.error}</span> : (
                                                <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                                                  <div><span style={{color:th("#3a4050","#8a7e74")}}>Schwab: </span><span style={{color:sc.result.schwabStatus==="FILLED"?"#00ff88":sc.result.schwabStatus==="CANCELED"?"#ff4560":"#ffd166",fontWeight:700}}>{sc.result.schwabStatus||"—"}</span></div>
                                                  {o.schwab_order_id && <div><span style={{color:th("#3a4050","#8a7e74")}}>ID: </span><span style={{color:"#555"}}>{o.schwab_order_id}</span></div>}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          {o.schwab_order_id && !sc?.result && <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginTop:4}}>Schwab ID: {o.schwab_order_id}</div>}
                                          {o.notes && <div style={{fontSize:9,color:"#555",fontFamily:"monospace",marginTop:6,fontStyle:"italic"}}>{o.notes}</div>}
                                        </div>

                                        {/* Right: price history */}
                                        <div>
                                          <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:6}}>PRICE HISTORY</div>
                                          {history.length === 0 ? (
                                            <div style={{fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>No changes yet</div>
                                          ) : (
                                            <div style={{display:"flex",flexDirection:"column",gap:3,maxHeight:100,overflowY:"auto"}}>
                                              {[...history].reverse().map((h,i) => (
                                                <div key={i} style={{display:"flex",gap:8,alignItems:"center",fontSize:9,fontFamily:"monospace"}}>
                                                  <span style={{color:"#ffd166",fontWeight:600}}>${Number(h.price).toFixed(2)}</span>
                                                  <span style={{color:th("#3a4050","#8a7e74")}}>{h.at?.slice(0,16).replace("T"," ")}</span>
                                                  <span style={{color:"#555",fontSize:8}}>{h.reason||""}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {/* Timeline summary */}
                                          <div style={{marginTop:8,fontSize:9,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",display:"flex",gap:10,flexWrap:"wrap"}}>
                                            <span>Created: {o.created_at?.slice(0,16).replace("T"," ")}</span>
                                            {o.submitted_at && <span>Submitted: {o.submitted_at.slice(0,16).replace("T"," ")}</span>}
                                          </div>
                                        </div>

                                      </div>
                                    </td>
                                  </tr>
                                );
                              })()
                            ];
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ══ ANALYTICS ══ */}
        {tab==="analytics" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Search filter */}
            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",padding:"7px 10px",background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}}>
              <span style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",letterSpacing:"0.07em"}}>SEARCH FILTER</span>
              <select value={gTicker} onChange={e=>setGTicker(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">All Tickers</option>{allTickers.map(t=><option key={t}>{t}</option>)}</select>
              <select value={gOptType} onChange={e=>setGOptType(e.target.value)} style={{width:78,fontSize:11,padding:"3px 5px"}}><option value="All">STO/BTO</option><option value="STO">STO</option><option value="BTO">BTO</option></select>
              <select value={gType} onChange={e=>setGType(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">Call/Put</option><option value="Call">Call</option><option value="Put">Put</option></select>
              {(gTicker!=="All"||gOptType!=="All"||gType!=="All") && <button onClick={()=>{setGTicker("All");setGOptType("All");setGType("All");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕</button>}
              <div style={{marginLeft:"auto",display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",gap:3}}>
                  <span style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>PROFIT BY</span>
                  {["exec","close","accounting"].map(m=>(
                    <button key={m} onClick={()=>setProfitDateMode(m)} style={{background:profitDateMode===m?"#00ff8814":"transparent",color:profitDateMode===m?"#00ff88":th("#2a3040","#6b5f55"),border:profitDateMode===m?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace"}}>{m==="exec"?"Open Date":m==="close"?"Close Date":"Accounting"}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:3}}>
                  {["daily","weekly","monthly"].map(v=>(
                    <button key={v} onClick={()=>setAnalyticsView(v)} style={{background:analyticsView===v?"#00ff8814":"transparent",color:analyticsView===v?"#00ff88":th("#2a3040","#6b5f55"),border:analyticsView===v?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Period breakdown with notes */}
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}} className="ms">
              <div style={{padding:"7px 11px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>{analyticsView.toUpperCase()} BREAKDOWN — {profitDateMode==="accounting"?"accounting (cash basis)":"profit by "+(profitDateMode==="exec"?"open date":"close date")}</span>
                {analyticsView==="monthly" && (
                  <button onClick={toggleBalCols} style={{fontSize:8,fontFamily:"monospace",padding:"2px 8px",borderRadius:3,border:"1px solid #21262d",cursor:"pointer",background:showBalCols?"#00ff8810":"transparent",color:showBalCols?"#00ff88":th("#3a4050","#8a7e74")}}>
                    {showBalCols?"▼ Hide Balances":"▶ Show Balances"}
                  </button>
                )}
              </div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>
                  <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Period</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Profit</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#58a6ff",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Schwab Profit</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#ffd166",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>ETrade Profit</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Margin</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contracts</th>
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#58a6ff",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Schwab $</th>}
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#ffd166",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>ETrade $</th>}
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#00ff88",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Total $</th>}
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#ff4560",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Distrib $</th>}
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#c084fc",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>MoM%</th>}
                  {analyticsView==="monthly" && showBalCols && <th style={{padding:"5px 8px",textAlign:"right",color:"#ff9f1c",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>YTD%</th>}
                  {analyticsView!=="daily" && <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Notes</th>}
                </tr></thead>
                <tbody>
                  {[...periodData].reverse().map((m,i) => {
                    const pp = m.premium>0 ? m.profit/m.premium : 0;
                    const note = periodNotes[m.key] || "";
                    return (
                      <tr key={i} className="rh" style={{borderTop:"1px solid #0d1117"}}>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),fontSize:12}}>{m.label}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(m.premium)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:m.profit>=0?"#00ff88":"#ff4560"}}>{fSign(m.profit)}</td>
                        {(() => {
                          const schwabProfit = schwabProfitByKey[m.key] || 0;
                          const etradeProfit = etradeProfitByKey[m.key] || 0;
                          return (<>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:schwabProfit>0?"#00ff88":schwabProfit<0?"#ff4560":th("#3a4050","#8a7e74")}}>{schwabProfit!==0?fSign(schwabProfit):"—"}</td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:etradeProfit>0?"#00ff88":etradeProfit<0?"#ff4560":th("#3a4050","#8a7e74")}}>{etradeProfit!==0?fSign(etradeProfit):"—"}</td>
                          </>);
                        })()}
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:pp<0?"#ff4560":pp>=0.6?"#00ff88":pp>=0.3?"#ffd166":"#58a6ff"}}>{(pp*100).toFixed(1)}%</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:th("#2a3040","#6b5f55")}}>{m.contracts}</td>
                        {analyticsView==="monthly" && showBalCols && (() => {
                          const b = balHistoryInline?.[m.key] || {};
                          const schwab = b.schwab ?? (m.key===nowMonthKey&&liveSchwabInline ? liveSchwabInline : null);
                          const etrade = b.etrade ?? (m.key===nowMonthKey&&liveEtradeInline ? liveEtradeInline : null);
                          const total  = getMonthTotal(m.key).total;
                          const fBal = v => v!=null ? "\$"+(+v).toLocaleString("en-US",{maximumFractionDigits:0}) : "—";
                          const fPct = (v,col1,col2) => v!=null ? <span style={{color:v>0?col1:v<0?col2:th("#3a4050","#8a7e74")}}>{v>0?"+":""}{v.toFixed(1)}%</span> : "—";
                          return (<>
                            <td style={{padding:"4px 6px",textAlign:"right"}} onClick={e=>e.stopPropagation()}>
                              {b.schwabAuto
                                ? <span style={{fontFamily:"monospace",fontSize:11,color:"#58a6ff"}}>{fBal(schwab)}<span style={{fontSize:7,color:"#00ff8860",marginLeft:3}}>●</span></span>
                                : <input type="number" value={schwab??""} placeholder="—"
                                    onChange={e=>{
                                      const val = e.target.value ? +e.target.value : null;
                                      const updated = {...balHistoryInline,[m.key]:{...(balHistoryInline[m.key]||{}),schwab:val}};
                                      setBalHistoryInline(updated);
                                      supabase.from("col_prefs").upsert({id:"balance_history",cols:updated,updated_at:new Date().toISOString()},{onConflict:"id"}).then(r=>{if(r.error)console.error("[bal save]",r.error.message);});
                                    }}
                                    style={{width:80,background:"transparent",border:"1px solid #58a6ff30",borderRadius:3,color:"#58a6ff",fontFamily:"monospace",fontSize:11,padding:"2px 4px",textAlign:"right",outline:"none"}}/>
                              }
                            </td>
                            <td style={{padding:"4px 6px",textAlign:"right"}} onClick={e=>e.stopPropagation()}>
                              <input type="number" value={etrade??""} placeholder="—"
                                onChange={e=>{
                                  const val = e.target.value ? +e.target.value : null;
                                  const updated = {...balHistoryInline,[m.key]:{...(balHistoryInline[m.key]||{}),etrade:val}};
                                  setBalHistoryInline(updated);
                                  supabase.from("col_prefs").upsert({id:"balance_history",cols:updated,updated_at:new Date().toISOString()},{onConflict:"id"}).then(r=>{if(r.error)console.error("[bal save]",r.error.message);});
                                }}
                                style={{width:80,background:"transparent",border:"1px solid #ffd16630",borderRadius:3,color:"#ffd166",fontFamily:"monospace",fontSize:11,padding:"2px 4px",textAlign:"right",outline:"none"}}/>
                            </td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88",fontWeight:700}}>{fBal(total)}</td>
                          </>);
                        })()}
                        {/* Distrib $ — entry field, shown when balances visible */}
                        {analyticsView==="monthly" && showBalCols && (() => {
                          const bd = balHistoryInline?.[m.key] || {};
                          return (
                            <td style={{padding:"4px 6px",textAlign:"right"}} onClick={e=>e.stopPropagation()}>
                              <input type="number" value={bd.distrib??""} placeholder="—"
                                onChange={e=>{
                                  const val = e.target.value ? +e.target.value : null;
                                  const updated = {...balHistoryInline,[m.key]:{...(balHistoryInline[m.key]||{}),distrib:val}};
                                  setBalHistoryInline(updated);
                                  supabase.from("col_prefs").upsert({id:"balance_history",cols:updated,updated_at:new Date().toISOString()},{onConflict:"id"}).then(r=>{if(r.error)console.error("[bal save]",r.error.message);});
                                }}
                                style={{width:80,background:"transparent",border:"1px solid #ff456030",borderRadius:3,color:"#ff4560",fontFamily:"monospace",fontSize:11,padding:"2px 4px",textAlign:"right",outline:"none"}}/>
                            </td>
                          );
                        })()}
                        {/* MoM%: (end - start) / (start - distributions) */}
                        {analyticsView==="monthly" && showBalCols && (() => {
                          const totalM = getMonthTotal(m.key).total;
                          const [yr,mo] = m.key.split("-").map(Number);
                          const prevMo = mo===1 ? 12 : mo-1;
                          const prevYr = mo===1 ? yr-1 : yr;
                          const prevKM = prevYr+"-"+(prevMo<10?"0":"")+prevMo;
                          const prevTM = getMonthTotal(prevKM).total;
                          const distrib = +(balHistoryInline?.[m.key]?.distrib||0);
                          const adjDenom = prevTM ? Math.max(prevTM - distrib, 1) : null;
                          const momM = totalM!=null&&adjDenom ? ((totalM-prevTM)/adjDenom*100) : null;
                          return <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:momM>0?"#00ff88":momM<0?"#ff4560":th("#3a4050","#8a7e74")}}>{momM!=null?(momM>0?"+":"")+momM.toFixed(1)+"%":"—"}</td>;
                        })()}
                        {/* YTD%: (current total - Jan 1 total) / Jan 1 total */}
                        {analyticsView==="monthly" && showBalCols && (() => {
                          const total2  = getMonthTotal(m.key).total;
                          const janKey  = m.key.slice(0,4)+"-01";
                          const janTotal = getMonthTotal(janKey).total;
                          const ytd2 = total2!=null&&janTotal!=null&&m.key!==janKey ? ((total2-janTotal)/janTotal*100) : null;
                          return <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:ytd2>0?"#ff9f1c":ytd2<0?"#ff4560":th("#3a4050","#8a7e74")}}>{ytd2!=null?(ytd2>0?"+":"")+ytd2.toFixed(1)+"%":"—"}</td>;
                        })()}
                        {analyticsView!=="daily" && (
                          <td style={{padding:"5px 8px",minWidth:180}} onClick={e=>e.stopPropagation()}>
                            {editingNote===m.key ? (
                              <input type="text" defaultValue={note} autoFocus
                                onBlur={e=>{const n={...periodNotes,[m.key]:e.target.value};persistNotes(n);setEditingNote(null);}}
                                onKeyDown={e=>{if(e.key==="Enter"||e.key==="Escape"){const n={...periodNotes,[m.key]:e.target.value};persistNotes(n);setEditingNote(null);}}}
                                style={{fontSize:10,padding:"2px 5px"}}/>
                            ) : (
                              <span onClick={()=>setEditingNote(m.key)} style={{fontSize:10,color:note?"#888":th("#2a3040","#6b5f55"),fontStyle:note?"normal":"italic",cursor:"pointer"}}>
                                {note||"+ add note"}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {periodData.length===0 && <tr><td colSpan={analyticsView!=="daily"?8:7} style={{padding:18,textAlign:"center",color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace"}}>No data — import history first</td></tr>}
                </tbody>
              </table>
            </div>

            {/* S&P 500 vs Portfolio Balance Chart */}
            {analyticsView==="monthly" && (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>PORTFOLIO BALANCE vs S&P 500 — MONTHLY</div>
                  <button onClick={async()=>{
                    if(spxOverlay){setSpxOverlay(false);return;}
                    try {
                      const end = Date.now();
                      const start = end - 365*3*24*60*60*1000;
                      // Use SPY ETF as S&P 500 proxy — $SPX index not available via Schwab price history
                      const url = "/api/schwab-proxy?path=/marketdata/v1/pricehistory&symbol=SPY&periodType=year&period=3&frequencyType=monthly&frequency=1&needExtendedHoursData=false";
                      const res = await fetch(url);
                      const d = await res.json();
                      console.log("[SPX] response:", JSON.stringify(d).slice(0,300));
                      if(d?.candles?.length){
                        // Store raw close prices — % will be computed relative to portfolio's first month
                        const spx = d.candles.map(c=>({
                          label: new Date(c.datetime).toISOString().slice(0,7),
                          close: c.close,
                        }));
                        setSpxData(spx);
                        setSpxOverlay(true);
                      }
                    } catch(e){console.warn("SPX fetch failed:",e.message);}
                  }} style={{background:spxOverlay?"#ff9f1c14":"transparent",color:spxOverlay?"#ff9f1c":th("#3a4050","#8a7e74"),border:spxOverlay?"1px solid #ff9f1c25":"1px solid #21262d",borderRadius:4,padding:"3px 10px",fontSize:8,fontFamily:"monospace",cursor:"pointer"}}>
                    {spxOverlay?"✓ S&P 500 ON":"+ Compare S&P 500"}
                  </button>
                </div>
                {(()=>{
                  // Build chart data: one point per month with total balance + S&P % vs same base
                  const months = Object.keys(balHistoryInline).sort().filter(mk=>{
                    const b=balHistoryInline[mk]||{};
                    return (+b.schwab||0)+(+b.etrade||0)>0;
                  });
                  if(months.length < 2) return <div style={{padding:"20px 0",textAlign:"center",color:th("#3a4050","#8a7e74"),fontSize:10,fontFamily:"monospace"}}>Enter balance data above to see chart</div>;
                  const firstMk = months[0];
                  const firstB = balHistoryInline[firstMk]||{};
                  const firstTotal = (+firstB.schwab||0)+(+firstB.etrade||0);
                  // SPX: find close price for the same starting month, normalize from there
                  const spxCloseMap = Object.fromEntries(spxData.map(s=>[s.label,s.close]));
                  const spxBase = spxCloseMap[firstMk] || spxData[0]?.close;
                  const chartBalData = months.map(mk=>{
                    const b = balHistoryInline[mk]||{};
                    const total = (+b.schwab||0)+(+b.etrade||0);
                    // Distributions adjust the denominator: perf = (end-start)/(start-distrib)
                    const cumDistrib = months.slice(0,months.indexOf(mk)+1)
                      .reduce((s,m)=>s+(+balHistoryInline[m]?.distrib||0),0);
                    const adjBase = Math.max(firstTotal - cumDistrib, 1);
                    const portPct = firstTotal>0 ? +((total-firstTotal)/adjBase*100).toFixed(2) : null;
                    const spxClose = spxCloseMap[mk];
                    const spxPct = spxBase&&spxClose ? +((spxClose-spxBase)/spxBase*100).toFixed(2) : null;
                    return {label:mk.slice(5), fullLabel:mk, portPct, spxPct, total};
                  });
                  return (
                    <ResponsiveContainer width="100%" height={180}>
                      <ComposedChart data={chartBalData}>
                        <CartesianGrid strokeDasharray="2 4" stroke={th("#0d1117","#f5f0e8")} vertical={false}/>
                        <XAxis dataKey="label" tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                        <YAxis tick={{fill:th("#2a3040","#6b5f55"),fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false} tickFormatter={v=>(v>0?"+":"")+v.toFixed(0)+"%"}/>
                        <Tooltip formatter={(val,name)=>[val!=null?(val>0?"+":"")+val.toFixed(1)+"%":"—",name]} labelFormatter={l=>l}/>
                        <Line type="monotone" dataKey="portPct" name="Portfolio" stroke="#00ff88" strokeWidth={2} dot={{fill:"#00ff88",r:3}} connectNulls/>
                        {spxOverlay&&<Line type="monotone" dataKey="spxPct" name="S&P 500" stroke="#ff9f1c" strokeWidth={2} dot={{fill:"#ff9f1c",r:3}} connectNulls/>}
                      </ComposedChart>
                    </ResponsiveContainer>
                  );
                })()}
              </div>
            )}

            {/* Account + Call/Put breakdown */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
              {["Schwab","Etrade"].map(acct=>{
                const ac=allF.filter(c=> acct==="Schwab" ? c.account?.startsWith("Schwab") : c.account?.startsWith("ETrade")||c.account?.startsWith("Etrade"));
                const acp=ac.filter(c=>c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
                return(<div key={acct} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:acct==="Schwab"?"#58a6ff":"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>{acct.toUpperCase()}</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>PREMIUM</div><div style={{fontSize:14,fontFamily:"monospace",color:"#58a6ff",fontWeight:700}}>{f$(ac.reduce((s,c)=>s+(c.premium||0),0))}</div></div>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>PROFIT</div><div style={{fontSize:14,fontFamily:"monospace",color:acp>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(acp)}</div></div>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>COUNT</div><div style={{fontSize:14,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{ac.length}</div></div>
                  </div>
                </div>);
              })}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
              {["Call","Put"].map(t=>{
                const tc=allF.filter(c=>c.type===t);
                const tcp=tc.filter(c=>c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
                return(<div key={t} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:12}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:t==="Call"?"#58a6ff":"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>{t.toUpperCase()}S</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>COUNT</div><div style={{fontSize:14,fontFamily:"monospace",color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{tc.length}</div></div>
                    <div><div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>PROFIT</div><div style={{fontSize:14,fontFamily:"monospace",color:tcp>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(tcp)}</div></div>
                  </div>
                </div>);
              })}
            </div>

            {/* ── AI ASSISTANT (inline in Analytics) ── */}
            <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #c084fc25",borderRadius:8,display:"flex",flexDirection:"column",overflow:"hidden"}}>
              {/* Header */}
              <div style={{padding:"10px 14px",borderBottom:"1px solid #1c2128",display:"flex",alignItems:"center",gap:9}}>
                <div style={{width:24,height:24,borderRadius:6,background:"linear-gradient(135deg,#1a0a1f,#0d1f12)",border:"1px solid #c084fc30",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>🤖</div>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"monospace",fontSize:10,color:"#c084fc",letterSpacing:"0.06em"}}>AI ASSISTANT</div>
                  <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>Ask questions about your trading data</div>
                </div>
                {aiMessages.length>0 && (
                  <button onClick={async()=>{setAiMessages([]);try{await supabase.from("ai_chats").delete().neq("id",0);}catch{}}} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"3px 8px",fontSize:8,color:"#555",fontFamily:"monospace",cursor:"pointer"}}>Clear</button>
                )}
              </div>
              {/* Suggestions */}
              {aiMessages.length===0 && (
                <div style={{padding:"10px 14px",borderBottom:"1px solid #0d1117"}}>
                  <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:7,letterSpacing:"0.06em"}}>SUGGESTED QUESTIONS</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                    {[
                      "How far OTM do I write the average contract?",
                      "Avg OTM for profitable vs losing contracts?",
                      "What's my win rate by ticker?",
                      "Which ticker generates the most premium?",
                      "What's my average days held?",
                      "What's my best month for profit?",
                      "How many contracts expire worthless?",
                      "What's my average profit per contract?",
                    ].map(q=>(
                      <button key={q} onClick={()=>setAiInput(q)} style={{background:"#c084fc12",color:"#c084fc",border:"1px solid #c084fc25",borderRadius:5,padding:"4px 9px",fontSize:9,fontFamily:"monospace",cursor:"pointer",textAlign:"left"}}>{q}</button>
                    ))}
                  </div>
                </div>
              )}
              {/* Messages */}
              {aiMessages.length>0 && (
                <div style={{maxHeight:320,overflowY:"auto",padding:"10px 14px",display:"flex",flexDirection:"column",gap:10}}>
                  {aiMessages.map((m,i)=>(
                    <div key={i} style={{display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start",gap:4}}>
                      <div
                        onClick={()=>{if(m.role==="assistant"){navigator.clipboard?.writeText(m.content).catch(()=>{});setAiMessages(p=>p.map((x,j)=>j===i?{...x,copied:true}:x));setTimeout(()=>setAiMessages(p=>p.map((x,j)=>j===i?{...x,copied:false}:x)),1500);}}}
                        style={{maxWidth:"85%",background:m.role==="user"?"#1a2030":th("#080c12","#ede8df"),border:`1px solid ${m.role==="user"?"#58a6ff30":m.starred?"#ffd16660":th("#21262d","#c8b8a8")}`,borderRadius:8,padding:"8px 11px",fontSize:12,color:m.role==="user"?"#58a6ff":th("#c9d1d9","#1a1a18"),fontFamily:m.role==="assistant"?"monospace":"inherit",lineHeight:1.6,whiteSpace:"pre-wrap",cursor:m.role==="assistant"?"pointer":"default"}}
                        title={m.role==="assistant"?"Click to copy":""}
                      >
                        {m.content}
                      </div>
                      {m.role==="assistant" && (
                        <div style={{display:"flex",gap:8,alignItems:"center",paddingLeft:2}}>
                          <span style={{fontSize:9,color:m.copied?"#00ff88":th("#3a4050","#8a7e74"),fontFamily:"monospace",transition:"color .2s"}}>{m.copied?"✓ copied":"⎘ click to copy"}</span>
                          <button
                            onClick={async e=>{
                              e.stopPropagation();
                              const newStarred = !m.starred;
                              setAiMessages(p=>p.map((x,j)=>j===i?{...x,starred:newStarred}:x));
                              if (m.id) {
                                try { await supabase.from("ai_chats").update({starred:newStarred}).eq("id",m.id); } catch {}
                              }
                            }}
                            style={{background:m.starred?"#ffd16620":"transparent",border:m.starred?"1px solid #ffd16640":"1px solid #21262d",borderRadius:4,padding:"2px 7px",fontSize:11,cursor:"pointer",color:m.starred?"#ffd166":"#555",lineHeight:1}}
                            title="Star this response"
                          >{m.starred?"⭐ starred":"☆ star"}</button>
                        </div>
                      )}
                    </div>
                  ))}
                  {aiLoading && (
                    <div style={{display:"flex",alignItems:"center",gap:7,padding:"4px 0"}}>
                      <div style={{width:8,height:8,borderRadius:"50%",border:"1.5px solid #c084fc",borderTopColor:"transparent",animation:"spin .6s linear infinite"}}/>
                      <span style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>Analyzing your data…</span>
                    </div>
                  )}
                  <div ref={aiEndRef}/>
                </div>
              )}
              {/* Input */}
              <div style={{padding:"10px 14px",borderTop:"1px solid #1c2128",display:"flex",gap:7}}>
                <input
                  type="text"
                  value={aiInput}
                  onChange={e=>setAiInput(e.target.value)}
                  onKeyDown={async e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();await sendAI();}}}
                  placeholder="Ask about your options data…"
                  style={{flex:1,fontSize:12,padding:"8px 10px"}}
                />
                <button onClick={sendAI} disabled={aiLoading||!aiInput.trim()} style={{background:"#c084fc",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"8px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",opacity:aiLoading||!aiInput.trim()?0.5:1,cursor:aiLoading||!aiInput.trim()?"default":"pointer"}}>Ask</button>
              </div>
            </div>

            {/* ── Monthly Report ── */}
            <MonthlyReport originals={originals} />

          </div>
        )}

        {/* ══ STRATEGIES ══ */}


        {tab==="strategies" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Header + new button */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#ffd166",letterSpacing:"0.07em"}}>♟ STRATEGIES</div>
              <button onClick={()=>setStratForm(stratForm?null:{name:"",description:"",rules:""})}
                style={{background:"#ffd16614",color:"#ffd166",border:"1px solid #ffd16630",borderRadius:6,padding:"6px 14px",fontSize:11,fontFamily:"monospace"}}>
                {stratForm?"✕ Cancel":"+ New Strategy"}
              </button>
            </div>

            {/* New/edit form */}
            {stratForm && (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16625",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                <div style={{fontFamily:"monospace",fontSize:9,color:"#ffd166",marginBottom:8}}>{stratForm.id?"EDIT":"NEW"} STRATEGY</div>
                <div style={{display:"flex",flexDirection:"column",gap:7}}>
                  <div><FL req>Name</FL><input type="text" value={stratForm.name} onChange={e=>setStratForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Wheel Strategy"/></div>
                  <div><FL>Description</FL><textarea rows={2} value={stratForm.description||""} onChange={e=>setStratForm(p=>({...p,description:e.target.value}))} style={{resize:"vertical"}} placeholder="Short description"/></div>
                  <div><FL>Rules / Notes</FL><textarea rows={3} value={stratForm.rules||""} onChange={e=>setStratForm(p=>({...p,rules:e.target.value}))} style={{resize:"vertical"}} placeholder="Entry criteria, exit rules, position sizing..."/></div>
                </div>
                <div style={{display:"flex",gap:7,marginTop:9}}>
                  <button onClick={async()=>{
                    if(!stratForm.name.trim()) return;
                    const row={name:stratForm.name,description:stratForm.description||"",rules:stratForm.rules||"",created_at:new Date().toISOString()};
                    try {
                      if(stratForm.id){const{error}=await supabase.from("strategies").update(row).eq("id",stratForm.id);if(error)throw error;setStrategies(p=>p.map(s=>s.id===stratForm.id?{...s,...row}:s));}
                      else{const{data,error}=await supabase.from("strategies").insert(row).select().single();if(error)throw error;if(data)setStrategies(p=>[...p,data]);}
                      setStratForm(null);
                    }catch(e){alert("Save failed: "+e.message);}
                  }} style={{background:"#ffd166",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                  <button onClick={()=>setStratForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}

            {/* Strategy cards with stats */}
            {strategies.length===0 && !stratForm && (
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:24,textAlign:"center",color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace"}}>
                No strategies yet — click + New Strategy to add one
              </div>
            )}
            {strategies.map(s=>{
              const sc = originals.filter(c=>c.strategy===s.name);
              const scClosed = sc.filter(c=>c.status==="Closed"&&c.profit!=null);
              const scOpen = sc.filter(c=>c.status==="Open");
              const totalProfit = scClosed.reduce((sum,c)=>sum+(c.profit||0),0);
              const totalPremium = sc.reduce((sum,c)=>sum+Math.abs(c.premium||0),0);
              const winRate = scClosed.length?(scClosed.filter(c=>c.profit>0).length/scClosed.length*100).toFixed(0):null;
              const avgProfit = scClosed.length?(totalProfit/scClosed.length).toFixed(2):null;
              const avgDays = scClosed.filter(c=>c.daysHeld).length
                ?(scClosed.filter(c=>c.daysHeld).reduce((sum,c)=>sum+(c.daysHeld||0),0)/scClosed.filter(c=>c.daysHeld).length).toFixed(1)
                :null;
              return (
                <div key={s.id} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div>
                      <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:14}}>{s.name}</div>
                      {s.description && <div style={{fontSize:11,color:th("#8b949e","#5a5248"),marginTop:2}}>{s.description}</div>}
                    </div>
                    <div style={{display:"flex",gap:5}}>
                      <button onClick={()=>setStratForm({...s})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"3px 10px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Edit</button>
                      <button onClick={async()=>{if(!window.confirm("Delete "+s.name+"?"))return;await supabase.from("strategies").delete().eq("id",s.id);setStrategies(p=>p.filter(x=>x.id!==s.id));}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 10px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Delete</button>
                    </div>
                  </div>
                  {/* Stats row */}
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:s.rules?10:0}}>
                    {[
                      {label:"Contracts", value:sc.length, color:th("#e6edf3","#0d0d0b")},
                      {label:"Open",      value:scOpen.length, color:"#ffd166"},
                      {label:"Closed",    value:scClosed.length, color:"#555"},
                      {label:"Win Rate",  value:winRate!=null?winRate+"%":"—", color:winRate>=60?"#00ff88":winRate>=40?"#ffd166":"#ff4560"},
                      {label:"Total Profit", value:fSign0(totalProfit), color:totalProfit>=0?"#00ff88":"#ff4560"},
                      {label:"Total Premium", value:f$0(totalPremium), color:"#58a6ff"},
                      {label:"Avg Profit", value:avgProfit!=null?fSign(+avgProfit):"—", color:+avgProfit>=0?"#00ff88":"#ff4560"},
                      {label:"Avg Days",  value:avgDays!=null?avgDays+"d":"—", color:"#555"},
                    ].map(({label,value,color})=>(
                      <div key={label} style={{background:th("#080c12","#ede8df"),border:"1px solid #1c2128",borderRadius:6,padding:"6px 10px",minWidth:80}}>
                        <div style={{fontSize:7,color:th("#3a4050","#8a7e74"),fontFamily:"monospace",marginBottom:2,textTransform:"uppercase"}}>{label}</div>
                        <div style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {s.rules && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",whiteSpace:"pre-wrap",borderTop:"1px solid #1c2128",paddingTop:8,marginTop:4}}>{s.rules}</div>}
                </div>
              );
            })}

            {/* ── Wheel P&L View ── */}
            {(() => {
              const wheelGroups = {};
              allF.forEach(c => {
                if (c.strategy !== "Wheel" || !c.strategyGroupId) return;
                const gid = c.strategyGroupId;
                if (!wheelGroups[gid]) wheelGroups[gid] = { id: gid, stock: c.stock, contracts: [] };
                wheelGroups[gid].contracts.push(c);
              });
              const groups = Object.values(wheelGroups);
              if (!groups.length) return null;
              return (
                <div style={{marginTop:16}}>
                  <div style={{fontFamily:"monospace",fontSize:9,color:"#00ff88",letterSpacing:"0.08em",marginBottom:10}}>🔄 WHEEL P&L BY GROUP</div>
                  {groups.map(g => {
                    const totalPrem  = g.contracts.reduce((s,c)=>s+(c.premium||0),0);
                    const closedP    = g.contracts.filter(c=>c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
                    const openPrem   = g.contracts.filter(c=>c.status==="Open").reduce((s,c)=>s+Math.abs(c.premium||0),0);
                    const currentCostToClose = g.contracts.filter(c=>c.status==="Open").reduce((s,c)=>s+(c.costToClose||0),0);
                    return (
                      <div key={g.id} style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8820",borderRadius:6,padding:"10px 12px",marginBottom:8}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                          <span style={{fontFamily:"monospace",fontSize:11,fontWeight:700,color:th("#e6edf3","#0d0d0b")}}>{g.stock} — Wheel Group #{g.id}</span>
                          <span style={{fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>{g.contracts.length} contracts</span>
                        </div>
                        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                          <span style={{fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>Premium collected: <b style={{color:"#00ff88"}}>{f$(totalPrem)}</b></span>
                          <span style={{fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>Realized P/L: <b style={{color:closedP>=0?"#00ff88":"#ff4560"}}>{fSign(closedP)}</b></span>
                          <span style={{fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>Open premium: <b style={{color:"#ffd166"}}>{f$(openPrem)}</b></span>
                          {currentCostToClose > 0 && <span style={{fontSize:9,color:th("#8b949e","#5a5248"),fontFamily:"monospace"}}>Current close cost: <b style={{color:"#ff4560"}}>{f$(currentCostToClose)}</b></span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {/* ══ PLAN ══ */}
        {/* ══ STOCKS ══ */}
        {tab==="plan" && (() => {
          // ── helpers ────────────────────────────────────────────────────────
          const T = (sym) => stocksData[sym] || {};
          const hasDani = (sym) => {
            // check if any DANI-sourced opp exists for this ticker
            return oppItems.some(o => o.ticker === sym && o.src === "dani" && o.status === "open");
          };

          // ── watchlist row ──────────────────────────────────────────────────
          const WatchRow = ({ sym }) => {
            const sd   = T(sym);
            const chg  = sd.changeClose;
            const chgPct = sd.changePct;
            const chgColor = chg == null ? th("#3a4050","#8a7e74") : chg >= 0 ? "#00ff88" : "#ff4560";
            const alerts = watchlistAlerts[sym] || [];
            const note   = watchlistNotes[sym] || "";
            const pos    = schwabPositions.find(p => p.symbol === sym);
            const openC2 = originals.filter(c => c.status === "Open" && c.stock?.toUpperCase() === sym);
            const isOpen = selectedWatchTicker === sym;
            const chainOp = watchlistChainOpen[sym];

            return (
              <div key={sym} style={{marginBottom: isOpen ? 6 : 2}}>
                {/* Row */}
                <div
                  onClick={() => setSelectedWatchTicker(isOpen ? null : sym)}
                  style={{display:"grid",gridTemplateColumns:"62px 88px 110px 1fr auto 80px",alignItems:"center",gap:8,
                    background: isOpen ? "#58a6ff0a" : th("#0a0e14","#f8f3eb"),
                    border:`1px solid ${isOpen ? "#58a6ff50" : alerts.length ? "#c084fc30" : th("#1c2128","#b8a898")}`,
                    borderRadius:6,padding:"5px 10px",cursor:"pointer",minHeight:34,
                    transition:"border-color .12s,background .12s"}}
                >
                  <span style={{fontFamily:"monospace",fontWeight:700,fontSize:12,color:th("#e6edf3","#0d0d0b")}}>{sym}</span>
                  <span style={{fontFamily:"monospace",fontSize:11,color:th("#c9d1d9","#1a1a18"),textAlign:"right"}}>
                    {sd.currentPrice ? "$"+sd.currentPrice.toFixed(2) : "—"}
                  </span>
                  <span style={{fontFamily:"monospace",fontSize:10,color:chgColor,textAlign:"right"}}>
                    {chg != null ? (chg>=0?"+":"")+chg.toFixed(2)+" ("+(chgPct!=null?(chgPct*100).toFixed(1):"")+"%)" : ""}
                  </span>
                  <div style={{display:"flex",gap:3,flexWrap:"wrap",alignItems:"center"}}>
                    {pos && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:"#00ff88",border:"1px solid #00ff8840",background:"#00ff8810"}}>pos</span>}
                    {sd.earningsDate && sd.earningsDate >= TODAY && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:"#ffd166",border:"1px solid #ffd16640",background:"#ffd16610"}}>⚡ earn</span>}
                    {alerts.length > 0 && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:"#c084fc",border:"1px solid #c084fc40",background:"#c084fc10"}}>🔔 {alerts.length}</span>}
                    {hasDani(sym) && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:"#ff4560",border:"1px solid #ff456040",background:"#ff456010"}}>DANI</span>}
                    {note && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:th("#3a4050","#8a7e74"),border:"1px solid #1c2128"}}>note</span>}
                    {openC2.length > 0 && <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:"#58a6ff",border:"1px solid #58a6ff40",background:"#58a6ff10"}}>{openC2.length} contract{openC2.length>1?"s":""}</span>}
                  </div>
                  <span/>
                  <div style={{display:"flex",gap:4,alignItems:"center",justifyContent:"flex-end"}}>
                    <button
                      onClick={e=>{e.stopPropagation();setOppForm({ticker:sym,type:"WATCH",detail:"",target:"",note:""});}}
                      style={{background:"transparent",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 7px",borderRadius:4,cursor:"pointer"}}
                    >+ Opp</button>
                    <button
                      onClick={e=>{e.stopPropagation();
                        setOrderStatuses(p=>({...p,[`wl_del_${sym}`]:{confirm:true}}));
                        setTimeout(()=>setOrderStatuses(p=>({...p,[`wl_del_${sym}`]:{confirm:false}})),3000);
                      }}
                      onClickCapture={e=>{
                        if(orderStatuses[`wl_del_${sym}`]?.confirm){
                          e.stopPropagation();
                          removeFromWatchlist(sym);
                        }
                      }}
                      style={{background:orderStatuses[`wl_del_${sym}`]?.confirm?"#ff456020":"transparent",border:`1px solid ${orderStatuses[`wl_del_${sym}`]?.confirm?"#ff456050":th("#1c2128","#b8a898")}`,color:orderStatuses[`wl_del_${sym}`]?.confirm?"#ff4560":"#555",cursor:"pointer",fontSize:9,padding:"2px 7px",borderRadius:4,fontFamily:"monospace",transition:"all 0.2s"}}
                    >{orderStatuses[`wl_del_${sym}`]?.confirm?"Remove?":"🗑"}</button>
                  </div>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div style={{background:th("#080c12","#ede8df"),border:"1px solid #21262d",borderRadius:"0 0 8px 8px",borderTop:"none",animation:"fadeIn .15s",overflow:"hidden"}}>
                    {/* Header with price */}
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 13px",borderBottom:"1px solid #1c2128",flexWrap:"wrap"}}>
                      <span style={{fontFamily:"monospace",fontWeight:700,fontSize:16,color:th("#e6edf3","#0d0d0b")}}>{sym}</span>
                      {sd.currentPrice && <span style={{fontFamily:"monospace",fontSize:14,color:th("#c9d1d9","#1a1a18")}}>${sd.currentPrice.toFixed(2)}</span>}
                      {chg != null && <span style={{fontFamily:"monospace",fontSize:11,fontWeight:700,color:chgColor}}>{chg>=0?"+":""}{chg.toFixed(2)} ({chgPct!=null?(chgPct*100).toFixed(2)+"%":""})</span>}
                      {sd.earningsDate && <span style={{fontSize:9,fontFamily:"monospace",padding:"2px 7px",borderRadius:3,background:sd.earningsDate>=TODAY?"#ffd16620":th("#1c2128","#b8a898"),color:sd.earningsDate>=TODAY?"#ffd166":th("#3a4050","#8a7e74"),border:`1px solid ${sd.earningsDate>=TODAY?"#ffd16640":th("#21262d","#c8b8a8")}`}}>{sd.earningsDate>=TODAY?"⚡ Earnings ":""}{sd.earningsDate}</span>}
                    </div>

                    {/* Two-col body */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr"}}>
                      {/* Left: notes + alerts */}
                      <div style={{padding:"11px 13px",borderRight:"1px solid #1c2128"}}>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>NOTES / THESIS</div>
                        <textarea
                          defaultValue={note}
                          id={`wl-note-${sym}`}
                          placeholder="Entry thesis, levels to watch, catalyst…"
                          style={{width:"100%",background:th("#0d1117","#f5f0e8"),border:"1px solid #1c2128",color:th("#8b949e","#5a5248"),fontFamily:"monospace",fontSize:11,padding:"6px 8px",borderRadius:5,resize:"none",outline:"none",height:52}}
                          onFocus={e=>{e.target.style.borderColor="#58a6ff40";e.target.style.color=th("#c9d1d9","#1a1a18");}}
                          onBlur={e=>{e.target.style.borderColor=th("#1c2128","#b8a898");e.target.style.color=th("#8b949e","#5a5248");}}
                        />
                        <div style={{display:"flex",justifyContent:"flex-end",marginTop:4}}>
                          <button onClick={()=>saveWatchlistNote(sym, document.getElementById(`wl-note-${sym}`)?.value||"")}
                            style={{background:"transparent",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 8px",borderRadius:4,cursor:"pointer"}}>Save</button>
                        </div>

                        <div style={{marginTop:9}}>
                          <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>PRICE ALERTS</div>
                          <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                            {alerts.map(a => (
                              <div key={a} style={{display:"flex",alignItems:"center",gap:3,background:"#c084fc12",border:"1px solid #c084fc30",borderRadius:20,padding:"2px 8px",fontSize:10,color:"#c084fc"}}>
                                ${(+a||0).toFixed(2)}
                                <button onClick={()=>removeWatchlistAlert(sym,a)} style={{background:"none",border:"none",color:"#c084fc60",cursor:"pointer",fontSize:9,padding:0,lineHeight:1}}>✕</button>
                              </div>
                            ))}
                            <input id={`wl-alrt-${sym}`} type="number" placeholder="$0.00"
                              onKeyDown={e=>{if(e.key==="Enter"){const v=parseFloat(e.target.value);if(v){addWatchlistAlert(sym,v);e.target.value="";}}}}
                              style={{background:th("#0d1117","#f5f0e8"),border:"1px solid #1c2128",color:th("#c9d1d9","#1a1a18"),fontFamily:"monospace",fontSize:11,padding:"3px 7px",borderRadius:5,width:75,outline:"none"}}/>
                            <button onClick={()=>{const v=parseFloat(document.getElementById(`wl-alrt-${sym}`)?.value);if(v){addWatchlistAlert(sym,v);document.getElementById(`wl-alrt-${sym}`).value="";}}}
                              style={{background:"transparent",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 8px",borderRadius:4,cursor:"pointer"}}>+ Alert</button>
                          </div>
                        </div>

                        {/* Open contracts for this ticker */}
                        {openC2.length > 0 && (
                          <div style={{marginTop:9}}>
                            <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>OPEN CONTRACTS</div>
                            {openC2.map(c => {
                              const lo = getLiveOption(c);
                              return (
                                <div key={c.id} onClick={()=>setViewC(c)} style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",fontSize:10,fontFamily:"monospace",color:"#555",padding:"3px 0",borderTop:"1px solid #1c2128",cursor:"pointer"}}>
                                  <span style={{color:th("#e6edf3","#0d0d0b"),fontWeight:700}}>{fTitle(c)}</span>
                                  <span>×{c.qty}</span>
                                  {lo && <><span style={{color:"#00ff88"}}>b:{f$(lo.bid)}</span><span style={{color:"#58a6ff"}}>a:{f$(lo.ask)}</span></>}
                                  {lo?.delta && <span style={{color:"#58a6ff"}}>Δ{lo.delta.toFixed(2)}</span>}
                                  {lo?.iv && <span style={{color:"#c084fc"}}>IV{lo.iv.toFixed(1)}%</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Right: DANI signal + quick actions */}
                      <div style={{padding:"11px 13px"}}>
                        {(() => {
                          const sig = oppItems.find(o => o.ticker === sym && o.src === "dani" && o.status === "open");
                          if (!sig) return (
                            <div style={{marginBottom:10}}>
                              <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>DANI SIGNAL</div>
                              <div style={{fontSize:10,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>No signal this week</div>
                            </div>
                          );
                          return (
                            <div style={{marginBottom:10}}>
                              <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>DANI SIGNAL</div>
                              <div style={{display:"flex",alignItems:"center",gap:8,background:"#ff456008",border:"1px solid #ff456025",borderRadius:6,padding:"7px 10px"}}>
                                <span style={{fontSize:8,padding:"2px 5px",borderRadius:3,background:"#ff456020",color:"#ff4560",border:"1px solid #ff456040",fontWeight:700,flexShrink:0}}>DANI</span>
                                <div style={{flex:1}}>
                                  <div style={{fontFamily:"monospace",fontWeight:700,fontSize:11,color:th("#e6edf3","#0d0d0b"),marginBottom:2}}>{sig.detail}</div>
                                  <div style={{fontFamily:"monospace",fontSize:10,color:th("#8b949e","#5a5248")}}>{sig.note}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>QUICK ADD</div>
                        <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                          {["STO","BTO","WATCH"].map(t => (
                            <button key={t} onClick={()=>setOppForm({ticker:sym,type:t,detail:"",target:"",note:""})}
                              style={{background:"transparent",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"3px 9px",borderRadius:4,cursor:"pointer"}}>+ {t}</button>
                          ))}
                        </div>

                        {pos && (
                          <div>
                            <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:5}}>STOCK POSITION</div>
                            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                              {[["Shares",pos.qty],["Avg Cost",f$(pos.avgPrice)],["Gain",`${pos.gainLoss>=0?"+":""}${f$(pos.gainLoss)}`]].map(([l,v])=>(
                                <div key={l}><div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace"}}>{l}</div><div style={{fontSize:11,fontFamily:"monospace",color:th("#c9d1d9","#1a1a18")}}>{v}</div></div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Option chain toggle */}
                    <div style={{borderTop:"1px solid #1c2128"}}>
                      <div onClick={()=>setWatchlistChainOpen(p=>({...p,[sym]:!p[sym]}))}
                        style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 13px",cursor:"pointer",background:th("#080c12","#ede8df")}}>
                        <span style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em"}}>OPTION CHAIN — {sym}</span>
                        <span style={{fontSize:9,color:th("#3a4050","#8a7e74")}}>{chainOp ? "▲ collapse" : "▼ expand"}</span>
                      </div>
                      {chainOp && (
                        <div style={{padding:"0 0 11px"}}>
                          {chainTradeOrder && chainTradeOrder.ticker === sym && (
                            <div style={{padding:"0 13px 8px"}}>
                              <ChainOrderPanel
                                trade={chainTradeOrder}
                                onClose={() => setChainTradeOrder(null)}
                                onOrderPlaced={() => { setChainTradeOrder(null); loadTradeOrders(); }}
                              />
                            </div>
                          )}
                          <div style={{borderTop:"1px solid #1c2128"}}>
                            <OptionsChainComponent
                              initialTicker={sym}
                              onTrade={trade => setChainTradeOrder(trade)}
                              embedded={true}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          };

          // ── opp row ────────────────────────────────────────────────────────
          const OppRow = ({ o }) => {
            const typeColors = {STO:"#00ff88",BTO:"#c084fc",WATCH:"#58a6ff",BTC:"#ffd166"};
            const typeBg = {STO:"#00ff8818",BTO:"#c084fc18",WATCH:"#58a6ff18",BTC:"#ffd16618"};
            const typeBorder = {STO:"#00ff8830",BTO:"#c084fc30",WATCH:"#58a6ff30",BTC:"#ffd16630"};
            const srcColor = {dani:"#ff4560",sage:"#c084fc",manual:th("#3a4050","#8a7e74")};
            const srcBg = {dani:"#ff456010",sage:"#c084fc10",manual:"transparent"};
            const srcBorder = {dani:"#ff456030",sage:"#c084fc30",manual:th("#1c2128","#b8a898")};
            const isDone = o.status !== "open";
            return (
              <div onClick={()=>setSelectedWatchTicker(o.ticker)}
                style={{display:"grid",gridTemplateColumns:"56px 68px 1fr auto auto 72px",alignItems:"center",gap:8,
                  background:th("#0a0e14","#f8f3eb"),border:`1px solid ${isDone?th("#1c2128","#b8a898"):th("#21262d","#c8b8a8")}`,
                  borderLeft:`2px solid ${o.src==="dani"?"#ff456040":o.src==="sage"?"#c084fc40":"#58a6ff30"}`,
                  borderRadius:6,padding:"6px 10px",cursor:"pointer",opacity:isDone?0.4:1,
                  transition:"border-color .12s"}}>
                <span style={{fontFamily:"monospace",fontWeight:700,fontSize:11,color:th("#e6edf3","#0d0d0b")}}>{o.ticker}</span>
                <span style={{fontSize:9,padding:"2px 6px",borderRadius:3,fontWeight:700,textAlign:"center",
                  color:typeColors[o.type]||"#555",background:typeBg[o.type]||"transparent",border:`1px solid ${typeBorder[o.type]||th("#1c2128","#b8a898")}`}}>{o.type}</span>
                <span style={{fontFamily:"monospace",fontSize:10,color:th("#8b949e","#5a5248")}}>
                  {o.detail && <span style={{color:th("#c9d1d9","#1a1a18"),marginRight:6}}>{o.detail}</span>}
                  {o.note}
                </span>
                {o.target ? <span style={{fontFamily:"monospace",fontSize:10,color:"#ffd166",whiteSpace:"nowrap"}}>${(+o.target).toFixed(2)}</span> : <span/>}
                <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,color:srcColor[o.src],background:srcBg[o.src],border:`1px solid ${srcBorder[o.src]}`}}>{o.src}</span>
                <div style={{display:"flex",gap:3}} onClick={e=>e.stopPropagation()}>
                  {o.status==="open" && <>
                    <button onClick={()=>markOppDone(o.id)} style={{background:"none",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 6px",borderRadius:3,cursor:"pointer"}}>✓</button>
                    <button onClick={()=>skipOppItem(o.id)} style={{background:"none",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 6px",borderRadius:3,cursor:"pointer"}}>skip</button>
                  </>}
                  <button onClick={()=>deleteOppItem(o.id)} style={{background:"none",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 6px",borderRadius:3,cursor:"pointer"}}>✕</button>
                </div>
              </div>
            );
          };

          const openOpps   = oppItems.filter(o => o.status === "open");
          const doneOpps   = oppItems.filter(o => o.status !== "open");
          const daniOpps   = openOpps.filter(o => o.src === "dani");
          const sageOpps   = openOpps.filter(o => o.src === "sage");
          const manualOpps = openOpps.filter(o => o.src === "manual");

          return (
            <div style={{display:"flex",flexDirection:"column",gap:9}}>

              {/* ── WATCHLIST ── */}
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>WATCHLIST</span>
                  <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>click row to expand · alerts · chain · notes</span>
                </div>

                {/* Add bar */}
                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
                  <input value={watchlistInput} onChange={e=>setWatchlistInput(e.target.value.toUpperCase())}
                    onKeyDown={e=>{if(e.key==="Enter"&&watchlistInput.trim()){addToWatchlist(watchlistInput);setWatchlistInput("");}}}
                    placeholder="Add ticker…" style={{width:110,fontSize:11,padding:"4px 7px",textTransform:"uppercase"}}/>
                  <button onClick={()=>{if(watchlistInput.trim()){addToWatchlist(watchlistInput);setWatchlistInput("");}}}
                    style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:5,padding:"4px 10px",fontSize:10,fontFamily:"monospace"}}>+ Watch</button>
                  <button onClick={async()=>{
                    // Refresh quotes for all watchlist tickers missing price data
                    const missing = watchlist.filter(t => !stocksData[t]?.currentPrice);
                    const toRefresh = missing.length > 0 ? missing : watchlist;
                    if (!toRefresh.length) return;
                    try {
                      const qRes = await fetch(`/api/schwab-proxy?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(toRefresh.join(","))}&fields=quote,fundamental&indicative=false`);
                      if (!qRes.ok) return;
                      const qData = await qRes.json();
                      const updatedSD = { ...stocksData };
                      toRefresh.forEach(t => {
                        const q = qData?.[t]?.quote;
                        const fund = qData?.[t]?.fundamental;
                        if (q) updatedSD[t] = {
                          ...(updatedSD[t]||{}),
                          currentPrice: q.lastPrice ?? q.mark ?? null,
                          bid:          q.bidPrice  ?? null,
                          ask:          q.askPrice  ?? null,
                          changePct:    q.netPercentChangeInDouble != null ? q.netPercentChangeInDouble/100 : null,
                          changeClose:  q.netChange ?? null,
                          lastQuoteAt:  new Date().toISOString(),
                          week52High:   fund?.["52WeekHigh"]  ?? updatedSD[t]?.week52High  ?? null,
                          week52Low:    fund?.["52WeekLow"]   ?? updatedSD[t]?.week52Low   ?? null,
                          peRatio:      fund?.peRatio         ?? updatedSD[t]?.peRatio     ?? null,
                          divYield:     fund?.divYield        ?? updatedSD[t]?.divYield    ?? null,
                          marketCap:    fund?.marketCap       ?? updatedSD[t]?.marketCap   ?? null,
                        };
                      });
                      setStocksData(updatedSD);
                      await supabase.from("col_prefs").upsert({id:"stocks_data",cols:updatedSD,updated_at:new Date().toISOString()});
                    } catch(e) { console.warn("[watchlist refresh]",e.message); }
                  }} style={{background:"#58a6ff14",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:5,padding:"4px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer",marginLeft:"auto"}}>⟳ Refresh</button>
                </div>

                {/* Column headers */}
                <div style={{display:"grid",gridTemplateColumns:"62px 88px 110px 1fr auto 80px",gap:8,padding:"2px 10px",marginBottom:3}}>
                  {["TICKER","PRICE","CHG","","",""].map((h,i) => (
                    <span key={i} style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",textAlign:i===1||i===2?"right":"left"}}>{h}</span>
                  ))}
                </div>

                {/* Rows */}
                {watchlist.length === 0
                  ? <div style={{color:th("#2a3040","#6b5f55"),fontSize:10,fontFamily:"monospace",padding:"8px 10px"}}>Add tickers above to start watching</div>
                  : watchlist.map(sym => <WatchRow key={sym} sym={sym} />)
                }
              </div>

              {/* ── OPPORTUNITIES ── */}
              <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>OPPORTUNITIES</span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>DANI · SAGE · manual flags</span>
                    <button onClick={()=>setOppForm({ticker:"",type:"WATCH",detail:"",target:"",note:""})}
                      style={{background:"transparent",border:"1px solid #1c2128",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,padding:"2px 8px",borderRadius:4,cursor:"pointer"}}>+ Add</button>
                  </div>
                </div>

                {/* Add opp form */}
                {oppForm && (
                  <div style={{background:th("#080c12","#ede8df"),border:"1px solid #00ff8820",borderRadius:7,padding:"11px 13px",marginBottom:10,animation:"fadeIn .15s"}}>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:7}}>
                      <div>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:3}}>TICKER</div>
                        <input value={oppForm.ticker} onChange={e=>setOppForm(p=>({...p,ticker:e.target.value.toUpperCase()}))}
                          placeholder="NVDA" style={{width:"100%",fontSize:11,padding:"4px 7px",textTransform:"uppercase"}}/>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:3}}>TYPE</div>
                        <select value={oppForm.type} onChange={e=>setOppForm(p=>({...p,type:e.target.value}))} style={{width:"100%",fontSize:11,padding:"4px 7px"}}>
                          <option>WATCH</option><option>STO</option><option>BTO</option><option>BTC</option>
                        </select>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:3}}>DETAIL</div>
                        <input value={oppForm.detail} onChange={e=>setOppForm(p=>({...p,detail:e.target.value}))}
                          placeholder="$310 Call Jun 5" style={{width:"100%",fontSize:11,padding:"4px 7px"}}/>
                      </div>
                      <div>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:3}}>TARGET $</div>
                        <input type="number" value={oppForm.target} onChange={e=>setOppForm(p=>({...p,target:e.target.value}))}
                          placeholder="—" style={{width:"100%",fontSize:11,padding:"4px 7px"}}/>
                      </div>
                    </div>
                    <div style={{marginBottom:7}}>
                      <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",marginBottom:3}}>NOTE / THESIS</div>
                      <input value={oppForm.note} onChange={e=>setOppForm(p=>({...p,note:e.target.value}))}
                        placeholder="Why is this interesting?" style={{width:"100%",fontSize:11,padding:"4px 7px"}}/>
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>{
                        if (!oppForm.ticker.trim()) return;
                        saveOppItem({id:Date.now(),ticker:oppForm.ticker.trim().toUpperCase(),type:oppForm.type,
                          detail:oppForm.detail,target:oppForm.target?+oppForm.target:null,note:oppForm.note,src:"manual",status:"open",createdAt:new Date().toISOString()});
                        setOppForm(null);
                      }} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:5,padding:"5px 14px",fontSize:10,fontWeight:700,fontFamily:"monospace",cursor:"pointer"}}>Save</button>
                      <button onClick={()=>setOppForm(null)}
                        style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:5,padding:"5px 10px",fontSize:10,fontFamily:"monospace",cursor:"pointer"}}>Cancel</button>
                    </div>
                  </div>
                )}

                {/* Grouped opp rows */}
                {openOpps.length === 0 && doneOpps.length === 0 && (
                  <div style={{color:th("#2a3040","#6b5f55"),fontSize:10,fontFamily:"monospace",padding:"8px 10px"}}>No opportunities yet — DANI signals and manual flags appear here</div>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {daniOpps.length > 0 && <>
                    <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",padding:"4px 10px 2px"}}>DANI SIGNALS</div>
                    {daniOpps.map(o => <OppRow key={o.id} o={o}/>)}
                  </>}
                  {sageOpps.length > 0 && <>
                    <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",padding:"8px 10px 2px"}}>SAGE / SYSTEM</div>
                    {sageOpps.map(o => <OppRow key={o.id} o={o}/>)}
                  </>}
                  {manualOpps.length > 0 && <>
                    <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",padding:"8px 10px 2px"}}>MANUAL FLAGS</div>
                    {manualOpps.map(o => <OppRow key={o.id} o={o}/>)}
                  </>}
                  {doneOpps.length > 0 && <>
                    <div style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",padding:"8px 10px 2px"}}>DONE / SKIPPED</div>
                    {doneOpps.map(o => <OppRow key={o.id} o={o}/>)}
                  </>}
                </div>
              </div>

            </div>
          );
        })()}
        {tab==="stocks" && (() => {
          // Build per-ticker summary from originals only (no double-counting)
          const tickerMap = {};
          originals.forEach(c => {
            const t = c.stock?.toUpperCase(); if (!t) return;
            if (!tickerMap[t]) tickerMap[t] = {ticker:t, totalPremium:0, totalProfit:0, contracts:[], openCount:0, closedCount:0};
            tickerMap[t].totalPremium += (c.premium||0);
            if (c.status==="Closed") { tickerMap[t].totalProfit += (c.profit||0); tickerMap[t].closedCount++; }
            if (c.status==="Open") tickerMap[t].openCount++;
            tickerMap[t].contracts.push(c);
          });
          const tickers = Object.values(tickerMap).sort((a,b)=>a.ticker.localeCompare(b.ticker));

          if (selectedTicker && (tickerMap[selectedTicker] || stocksData[selectedTicker])) {
            const td = tickerMap[selectedTicker] || {ticker:selectedTicker, totalPremium:0, totalProfit:0, contracts:[], openCount:0, closedCount:0};
            const sd = stocksData[selectedTicker] || {};
            const tickerContracts = contracts.filter(c => c.stock?.toUpperCase()===selectedTicker).sort((a,b)=>new Date(b.dateExec)-new Date(a.dateExec));
            return (<>
              <div style={{display:"flex",flexDirection:"column",gap:9}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <button onClick={()=>setSelectedTicker(null)} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:6,padding:"5px 10px",fontSize:11,color:"#555",fontFamily:"monospace"}}>← Stocks</button>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:20,color:th("#e6edf3","#0d0d0b")}}>{selectedTicker}</span>
                  <Tag color={td.openCount>0?"green":"gray"}>{td.openCount} open</Tag>
                </div>
                {/* Stock info cards */}
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <KPI label="Total Premium" value={f$(td.totalPremium)} sub={td.contracts.length+" contracts"}/>
                  <KPI label="Total Profit"  value={fSign(td.totalProfit)} sub={td.closedCount+" closed"} color={td.totalProfit>=0?"#00ff88":"#ff4560"}/>
                  <KPI label="Open"          value={td.openCount} sub="active contracts" color="#ffd166"/>
                </div>
                {/* Editable stock data */}
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:13}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <span style={{fontFamily:"monospace",fontSize:8,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>STOCK DATA</span>
                    {sd.earningsDate && (
                      <span style={{
                        fontSize:9, fontFamily:"monospace", padding:"2px 8px", borderRadius:4,
                        background: sd.earningsDate >= TODAY ? "#ffd16620" : th("#1c2128","#b8a898"),
                        color:      sd.earningsDate >= TODAY ? "#ffd166"   : th("#3a4050","#8a7e74"),
                        border:     `1px solid ${sd.earningsDate >= TODAY ? "#ffd16640" : th("#21262d","#c8b8a8")}`,
                      }}>
                        {sd.earningsDate >= TODAY ? "⚡ Earnings " : "Earnings "}{sd.earningsDate}
                      </span>
                    )}
                    {sd.lastQuoteAt && (
                      <span style={{fontSize:7,color:"#00ff8870",fontFamily:"monospace",background:"#00ff8812",border:"1px solid #00ff8820",borderRadius:3,padding:"1px 5px"}}>
                        live · {sd.lastQuoteAt ? new Date(sd.lastQuoteAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : ""}
                      </span>
                    )}
                    {sd.changePct!=null && (
                      <span style={{fontSize:8,fontFamily:"monospace",color:sd.changePct>=0?"#00ff88":"#ff4560",fontWeight:700}}>
                        {sd.changePct>=0?"+":""}{(sd.changePct*100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Greeks summary from open contracts */}
                  {(() => {
                    const openForTicker = originals.filter(c => c.status==="Open" && c.stock?.toUpperCase()===selectedTicker);
                    const greeks = openForTicker.map(c => {
                      const lo = getLiveOption(c);
                      if (!lo) return null;
                      return { label: `${c.expires} $${c.strike} ${c.type}`, delta: lo.delta, gamma: lo.gamma, theta: lo.theta, vega: lo.vega, iv: lo.iv };
                    }).filter(Boolean);
                    if (!greeks.length) return null;
                    return (
                      <div style={{marginBottom:10}}>
                        <div style={{fontSize:7,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:6}}>GREEKS — OPEN CONTRACTS</div>
                        <div style={{display:"flex",flexDirection:"column",gap:4}}>
                          {greeks.map((g,i) => (
                            <div key={i} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                              <span style={{fontSize:9,color:"#555",fontFamily:"monospace",minWidth:160}}>{g.label}</span>
                              {[["Δ",g.delta,"#58a6ff"],["Γ",g.gamma,"#ffd166"],["Θ",g.theta,"#ff4560"],["V",g.vega,"#00ff88"],["IV",g.iv!=null?g.iv.toFixed(1)+"%":null,"#c084fc"]].map(([lbl,val,col])=>
                                val!=null && (
                                  <span key={lbl} style={{fontSize:9,fontFamily:"monospace",background:col+"18",color:col,border:`1px solid ${col}30`,borderRadius:3,padding:"1px 6px"}}>
                                    {lbl} {typeof val==="number" && lbl!=="IV" ? val.toFixed(3) : val}
                                  </span>
                                )
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
                    <div><FL>Shares — Schwab</FL><input type="number" defaultValue={sd.sharesSchwab||""} onBlur={e=>updateStockData(selectedTicker,"sharesSchwab",e.target.value?+e.target.value:null)}/></div>
                    <div><FL>Shares — Etrade</FL><input type="number" defaultValue={sd.sharesEtrade||""} onBlur={e=>updateStockData(selectedTicker,"sharesEtrade",e.target.value?+e.target.value:null)}/></div>
                    <div>
                      <FL>🤖 Skynet Auto-STO</FL>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                        <div onClick={()=>updateStockData(selectedTicker,"autoSto",!sd.autoSto)}
                          style={{width:36,height:20,borderRadius:10,background:sd.autoSto?"#00ff88":th("#21262d","#c8b8a8"),position:"relative",cursor:"pointer",transition:"background .2s",border:`1px solid ${sd.autoSto?"#00ff88":th("#30363d","#c0b0a0")}`}}>
                          <div style={{position:"absolute",top:3,left:sd.autoSto?17:3,width:14,height:14,borderRadius:"50%",background:sd.autoSto?th("#010409","#f5f0e8"):"#555",transition:"left .2s"}}/>
                        </div>
                        <span style={{fontFamily:"monospace",fontSize:9,color:sd.autoSto?"#00ff88":"#555"}}>
                          {sd.autoSto?"ENABLED — Skynet will auto-sell covered calls":"OFF"}
                        </span>
                      </div>
                    </div>
                    <div>
                      <FL>Current Price $</FL>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <input type="number" defaultValue={sd.currentPrice||""} onBlur={e=>updateStockData(selectedTicker,"currentPrice",e.target.value?+e.target.value:null)} key={sd.currentPrice}/>
                        {sd.bid!=null && <span style={{fontSize:8,color:"#555",fontFamily:"monospace",whiteSpace:"nowrap"}}>b:{sd.bid} a:{sd.ask}</span>}
                      </div>
                    </div>
                    <div><FL>IV % <span style={{color:th("#2a3040","#6b5f55"),fontSize:7}}>(manual)</span></FL><input type="number" defaultValue={sd.iv||""} placeholder="e.g. 45.2" onBlur={e=>updateStockData(selectedTicker,"iv",e.target.value?+e.target.value:null)}/></div>
                    <div><FL>Next Earnings Date</FL><input type="date" defaultValue={sd.earningsDate||""} onBlur={e=>updateStockData(selectedTicker,"earningsDate",e.target.value||null)}/></div>
                  </div>
                </div>
                {/* Contract history for this ticker */}
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}} className="ms">
                  <div style={{padding:"7px 11px",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>CONTRACT HISTORY</span>
                  <button onClick={()=>setStockContractFilter("open")} style={{fontSize:8,fontFamily:"monospace",padding:"1px 7px",borderRadius:3,border:"none",cursor:"pointer",background:stockContractFilter==="open"?"#00ff8820":"transparent",color:stockContractFilter==="open"?"#00ff88":th("#3a4050","#8a7e74")}}>Open</button>
                  <button onClick={()=>setStockContractFilter("all")} style={{fontSize:8,fontFamily:"monospace",padding:"1px 7px",borderRadius:3,border:"none",cursor:"pointer",background:stockContractFilter==="all"?"#58a6ff20":"transparent",color:stockContractFilter==="all"?"#58a6ff":th("#3a4050","#8a7e74")}}>All</button>
                </div>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr>
                      <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contract</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Opt</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Executed</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#00ff8860",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Live Bid</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#00ff8860",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Live Ask</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Profit</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Acct</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Status</th>
                    </tr></thead>
                    <tbody>
                      {tickerContracts.filter(c => stockContractFilter==="open" ? c.status==="Open" : true).map(c=>(
                        <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer"}} onClick={()=>setViewC(c)}>
                          {(() => { const lo = c.status==="Open" ? getLiveOption(c) : null; return (<>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),fontSize:10,whiteSpace:"nowrap"}}>{fTitle(c)}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":"gray"}>{c.optType}</Tag></td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),fontWeight:600}}>{c.qty}</td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#555"}}>{c.dateExec||"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:c.premium<0?"#ff4560":"#58a6ff"}}>{fMoney(c.premium)}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:"#00ff88"}}>
                            {lo?.bid!=null ? f$(lo.bid) : <span style={{color:th("#1c2128","#b8a898")}}>—</span>}
                          </td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:"#58a6ff"}}>
                            {lo?.ask!=null ? f$(lo.ask) : <span style={{color:th("#1c2128","#b8a898")}}>—</span>}
                          </td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>{(() => {
                            const cc = c.profit == null ? contracts.find(x => x.parentId === c.id && x.profit != null) : null;
                            const dp = c.profit ?? cc?.profit ?? null;
                            const dpp = c.profitPct ?? cc?.profitPct ?? null;
                            return dp!=null
                              ? <><span style={{color:dp>=0?"#00ff88":"#ff4560"}}>{fSign(dp)}</span>{dpp!=null&&<span style={{fontSize:8,color:dp>=0?"#00ff8870":"#ff456070",marginLeft:3}}>{(dpp*100).toFixed(1)}%</span>}</>
                              : <span style={{color:th("#1c2128","#b8a898")}}>—</span>;
                          })()}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag></td>
                          </>); })()}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Catalyst calendar & research docs */}
                <CatalystPanel ticker={selectedTicker} />
              </div>
              {/* Option Chain — Schwab live chain (same as Plan tab) */}
              <StocksChainSection
                selectedTicker={selectedTicker}
                loadTradeOrders={loadTradeOrders}
                pendingOrder={pendingOrder}
                onPendingOrderConsumed={() => setPendingOrder(null)}
              />
            </>);
          }

          // Stocks list view
          // Merge tickerMap with manually-added stocks from stocksData
          const allStockKeys = new Set([
            ...Object.keys(tickerMap),
            ...Object.keys(stocksData).filter(k=>k!=="__cash__")
          ]);
          const mergedTickers = Array.from(allStockKeys).sort().map(ticker => {
            const tm = tickerMap[ticker] || {ticker, totalPremium:0, totalProfit:0, contracts:[], openCount:0, closedCount:0};
            return tm;
          });
          const ownedTickers = mergedTickers.filter(t => {
            const sd = stocksData[t.ticker]||{};
            return (sd.sharesSchwab||0)+(sd.sharesEtrade||0) > 0;
          });
          const displayTickers = stocksFilter==="owned" ? ownedTickers : mergedTickers;

          const sortedDisplayTickers = [...displayTickers].sort((a,b)=>{
            const sda = stocksData[a.ticker]||{};
            const sdb = stocksData[b.ticker]||{};
            let av, bv;
            switch(stocksSortKey) {
              case "ticker":    av=a.ticker;            bv=b.ticker;            break;
              case "schwab":    av=sda.sharesSchwab||0; bv=sdb.sharesSchwab||0; break;
              case "etrade":    av=sda.sharesEtrade||0; bv=sdb.sharesEtrade||0; break;
              case "price":     av=sda.currentPrice||0; bv=sdb.currentPrice||0; break;
              case "iv":        av=sda.iv||0;          bv=sdb.iv||0;          break;
              case "earnings":  av=sda.earningsDate||""; bv=sdb.earningsDate||""; break;
              case "premium":   av=a.totalPremium;      bv=b.totalPremium;      break;
              case "profit":    av=a.totalProfit;       bv=b.totalProfit;       break;
              case "contracts": av=a.contracts.length;  bv=b.contracts.length;  break;
              case "open":      av=a.openCount;         bv=b.openCount;         break;
              default:          av=a.ticker;            bv=b.ticker;
            }
            if (av==null) return 1; if (bv==null) return -1;
            if (typeof av==="string") return stocksSortDir==="asc"?av.localeCompare(bv):bv.localeCompare(av);
            return stocksSortDir==="asc"?av-bv:bv-av;
          });
          const sth = (key,label,right=false) => (
            <th onClick={()=>toggleStocksSort(key)} className="thsort"
              style={{padding:"5px 8px",textAlign:right?"right":"left",color:stocksSortKey===key?th("#c9d1d9","#1a1a18"):th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128",whiteSpace:"nowrap"}}>
              {label}{stocksSortKey===key?(stocksSortDir==="asc"?" ↑":" ↓"):""}
            </th>
          );
          return (
            <div style={{display:"flex",flexDirection:"column",gap:9}}>

              {/* E*TRADE live data bar — always visible at top of Stocks tab */}
              <div style={{background:"#0a0e1a",border:"1px solid #58a6ff25",borderRadius:8,padding:"9px 13px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:8,color:"#58a6ff",fontFamily:"monospace",letterSpacing:"0.08em",flexShrink:0}}>E*TRADE SANDBOX</span>
                <button
                  onClick={refreshEtrade}
                  disabled={etradeStatus==="loading"}
                  style={{
                    background: etradeStatus==="loading"?"#ffd16620":etradeStatus==="ok"?"#00ff8820":etradeStatus==="error"?"#ff456020":"#58a6ff20",
                    color:      etradeStatus==="loading"?"#ffd166":etradeStatus==="ok"?"#00ff88":etradeStatus==="error"?"#ff4560":"#58a6ff",
                    border:     "none", borderRadius:5, padding:"5px 14px", fontSize:11, fontFamily:"monospace", fontWeight:700,
                    cursor: etradeStatus==="loading"?"wait":"pointer", display:"flex", alignItems:"center", gap:6, flexShrink:0,
                  }}>
                  {etradeStatus==="loading"
                    ? <><span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",border:"1.5px solid currentColor",borderTopColor:"transparent",animation:"spin .6s linear infinite"}}/>Syncing…</>
                    : etradeStatus==="ok"  ? "✓ Refresh Live Data"
                    : etradeStatus==="error" ? "⚠ Retry"
                    : "⟳ Refresh Live Data"}
                </button>
                <span style={{fontSize:9,color:etradeStatus==="error"?"#ff4560":etradeStatus==="ok"?"#00ff8870":th("#3a4050","#8a7e74"),fontFamily:"monospace",flex:1}}>
                  {etradeMsg || "Click to pull live quotes & option chains from E*TRADE sandbox"}
                </span>
                {etradeLastFetch && <span style={{fontSize:8,color:th("#2a3040","#6b5f55"),fontFamily:"monospace",flexShrink:0}}>last sync {etradeLastFetch}</span>}
              </div>

              {/* Unified Positions + Tickers table */}
              {(() => {
                // Build combined symbol list from live Schwab positions + stocksData holdings
                // Includes any ticker with shares in either broker, auto-removes tickers with 0 shares
                const posMap    = Object.fromEntries(schwabPositions.map(p => [p.symbol, p]));
                const tickerMap = Object.fromEntries(sortedDisplayTickers.map(t => [t.ticker, t]));

                // Union of: live Schwab positions + any stocksData entry with shares in either broker
                const ownedFromData = Object.keys(stocksData).filter(k => {
                  if (k === "__cash__") return false;
                  const sd = stocksData[k];
                  return (sd.sharesSchwab || 0) > 0 || (sd.sharesEtrade || 0) > 0;
                });
                const allSymbols = [...new Set([
                  ...schwabPositions.map(p => p.symbol),
                  ...ownedFromData,
                  // keep tickers that have open contracts even if 0 shares
                  ...sortedDisplayTickers.filter(t => t.openCount > 0 && !posMap[t.ticker]).map(t => t.ticker),
                ])];

                return (
                  <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8}} className="ms">
                    <div style={{padding:"7px 11px",display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontFamily:"monospace",fontSize:7,color:th("#2a3040","#6b5f55"),letterSpacing:"0.08em"}}>POSITIONS — click to view details</span>
                      {schwabPositions.length > 0 && <span style={{fontSize:7,color:"#00ff8870",fontFamily:"monospace"}}>● {schwabPositions.length} live from Schwab</span>}
                    </div>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                      <thead><tr>
                        <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Ticker</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:"#58a6ff",fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Schwab Qty</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:"#ffd166",fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>ETrade Qty</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Avg Cost</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Mkt Value</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Gain $</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Gain %</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Day $</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Day %</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>IV %</th>
                        <th style={{padding:"5px 8px",textAlign:"left",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Earnings</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Premium</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Profit</th>
                        <th style={{padding:"5px 8px",textAlign:"right",color:th("#3a4050","#8a7e74"),fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>Open</th>
                      </tr></thead>
                      <tbody>
                        {allSymbols.map(sym => {
                          const pos = posMap[sym];
                          const tk  = tickerMap[sym];
                          const sd  = stocksData[sym] || {};
                          const schwabQty = pos ? Math.floor(pos.qty) : (sd.sharesSchwab || 0);
                          const etradeQty = sd.sharesEtrade || 0;
                          return (
                            <tr key={sym} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer"}} onClick={()=>setSelectedTicker(sym)}>
                              <td style={{padding:"5px 8px",fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:th("#e6edf3","#0d0d0b"),fontSize:13}}>
                                {sym}
                                {(pos || etradeQty > 0) && <span style={{fontSize:7,color: pos ? "#00ff8870" : "#ffd16670",marginLeft:4}}>●</span>}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color: schwabQty > 0 ? "#58a6ff" : th("#3a4050","#8a7e74"),fontSize:10}}>
                                {schwabQty > 0 ? schwabQty : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color: etradeQty > 0 ? "#ffd166" : th("#3a4050","#8a7e74"),fontSize:10}}>
                                {etradeQty > 0 ? etradeQty : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555",fontSize:10}}>
                                {pos ? f$(pos.avgPrice) : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:th("#c9d1d9","#1a1a18"),fontWeight:600}}>
                                {pos ? f$(pos.marketValue) : (sd.currentPrice && (schwabQty + etradeQty) > 0 ? f$(sd.currentPrice * (schwabQty + etradeQty)) : "—")}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,fontSize:10,color:pos?(pos.gainLoss>=0?"#00ff88":"#ff4560"):"#555"}}>
                                {pos ? (pos.gainLoss>=0?"+":"")+f$(pos.gainLoss) : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,fontWeight:700,color:pos?(pos.gainLossPct>=0?"#00ff88":"#ff4560"):"#555"}}>
                                {pos ? (pos.gainLossPct>=0?"+":"")+pos.gainLossPct.toFixed(2)+"%" : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:pos?(pos.currentDayGL>=0?"#00ff88":"#ff4560"):"#555"}}>
                                {pos ? (pos.currentDayGL>=0?"+":"")+f$(pos.currentDayGL) : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:pos?(pos.currentDayGLPct>=0?"#00ff88":"#ff4560"):"#555"}}>
                                {pos ? (pos.currentDayGLPct>=0?"+":"")+pos.currentDayGLPct.toFixed(2)+"%" : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:sd.iv>50?"#ff4560":sd.iv>30?"#ffd166":"#00ff88",fontSize:10}}>
                                {sd.iv!=null ? sd.iv.toFixed(1)+"%" : "—"}
                              </td>
                              <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:sd.earningsDate&&sd.earningsDate>=TODAY?"#ffd166":"#555"}}>
                                {sd.earningsDate||"—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>
                                {tk ? f$(tk.totalPremium) : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:tk?(tk.totalProfit>=0?"#00ff88":"#ff4560"):"#555"}}>
                                {tk ? fSign(tk.totalProfit) : "—"}
                              </td>
                              <td style={{padding:"5px 8px",textAlign:"right"}}>
                                {tk?.openCount>0 ? <Tag color="green">{tk.openCount}</Tag> : <span style={{color:th("#1c2128","#b8a898"),fontSize:10}}>—</span>}
                              </td>
                            </tr>
                          );
                        })}
                        {allSymbols.length===0 && <tr><td colSpan={14} style={{padding:20,textAlign:"center",color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace"}}>No positions — click ⟳ Live Data to sync from Schwab</td></tr>}
                      </tbody>
                      {schwabPositions.length > 0 && (
                        <tfoot>
                          <tr style={{borderTop:"1px solid #21262d"}}>
                            <td colSpan={4} style={{padding:"6px 8px",fontFamily:"monospace",fontSize:9,color:th("#3a4050","#8a7e74")}}>TOTAL</td>
                            <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:th("#c9d1d9","#1a1a18")}}>{f$(schwabPositions.reduce((s,p)=>s+p.marketValue,0))}</td>
                            <td style={{padding:"6px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:schwabPositions.reduce((s,p)=>s+p.gainLoss,0)>=0?"#00ff88":"#ff4560"}}>{schwabPositions.reduce((s,p)=>s+p.gainLoss,0)>=0?"+":""}{f$(schwabPositions.reduce((s,p)=>s+p.gainLoss,0))}</td>
                            <td colSpan={9}/>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                );
              })()}

              {/* Cash row — Schwab auto-populated, E*TRADE manual */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"stretch"}}>
                {/* Schwab cash — live from API */}
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #58a6ff30",borderRadius:8,padding:"8px 12px",minWidth:120,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <span style={{fontSize:7,color:"#58a6ff",fontFamily:"monospace",letterSpacing:"0.08em"}}>SCHWAB ACCT</span>
                    {cashData.schwab && <span style={{fontSize:7,color:"#00ff8870",fontFamily:"monospace"}}>live</span>}
                  </div>
                  <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#58a6ff"}}>
                    {cashData.schwab ? f$(+cashData.schwab) : <span style={{color:th("#2a3040","#6b5f55"),fontSize:11}}>—</span>}
                  </div>
                </div>
                {/* E*TRADE cash — manual entry, falls back for accounts not yet synced via live snapshot (6917 + 8222 combined) */}
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #ffd16630",borderRadius:8,padding:"8px 12px",minWidth:120,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <span style={{fontSize:7,color:"#ffd166",fontFamily:"monospace",letterSpacing:"0.08em"}}>E*TRADE ACCT</span>
                    {liveEtradeInline!=null && <span style={{fontSize:7,color:"#00ff8870",fontFamily:"monospace"}}>live · both accts</span>}
                  </div>
                  <input type="number" defaultValue={cashData.etrade||""} placeholder="0.00"
                    onBlur={e=>updateCash("etrade",e.target.value)}
                    style={{width:"100%",fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#ffd166",background:"transparent",border:"none",borderBottom:"1px solid #ffd16630",padding:"2px 0",outline:"none"}}/>
                </div>
                {/* Total — prefers combined live ETrade value (both accounts) over the single manual entry */}
                {(() => {
                  const etradeCombined = liveEtradeInline ?? (+cashData.etrade || 0);
                  const totalAcct = (+cashData.schwab||0) + etradeCombined;
                  return totalAcct>0 && (
                    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8830",borderRadius:8,padding:"8px 12px",minWidth:120,display:"flex",flexDirection:"column",gap:4}}>
                      <div style={{fontSize:7,color:"#00ff88",fontFamily:"monospace",letterSpacing:"0.08em"}}>TOTAL ACCT</div>
                      <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#00ff88"}}>{f$(totalAcct)}</div>
                    </div>
                  );
                })()}
                {/* Committed funds + available to write puts */}
                {(() => {
                  const etradeCombined = liveEtradeInline ?? (+cashData.etrade || 0);
                  const schwabCommitted = openC.filter(c=>c.optType==="STO"&&c.type==="Put"&&c.account==="Schwab").reduce((s,c)=>s+(Math.abs(c.strike||0)*(c.qty||0)*100),0);
                  const schwabBTOAssets = openC.filter(c=>c.optType==="BTO"&&c.account==="Schwab").reduce((s,c)=>{const lo=findOptionForContract(etradeChains,c);return s+((lo?.bid!=null&&lo?.ask!=null)?(lo.bid+lo.ask)/2*(c.qty||1)*100:lo?.mark!=null?lo.mark*(c.qty||1)*100:Math.abs(c.premium||0));},0);
                  const etradeCommitted = openC.filter(c=>c.optType==="STO"&&c.type==="Put"&&c.account==="Etrade").reduce((s,c)=>s+(Math.abs(c.strike||0)*(c.qty||0)*100),0);
                  const etradeBTOAssets = openC.filter(c=>c.optType==="BTO"&&c.account==="Etrade").reduce((s,c)=>{const lo=findOptionForContract(etradeChains,c);return s+((lo?.bid!=null&&lo?.ask!=null)?(lo.bid+lo.ask)/2*(c.qty||1)*100:lo?.mark!=null?lo.mark*(c.qty||1)*100:Math.abs(c.premium||0));},0);
                  const schwabAvail = (+cashData.schwab||0) - schwabCommitted + schwabBTOAssets;
                  const etradeAvail = etradeCombined - etradeCommitted + etradeBTOAssets;
                  return (<>
                    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #c084fc30",borderRadius:8,padding:"8px 12px",minWidth:140,display:"flex",flexDirection:"column",gap:3}}>
                      <div style={{fontSize:7,color:"#c084fc",fontFamily:"monospace",letterSpacing:"0.08em"}}>SCHWAB AVAILABLE</div>
                      <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:schwabAvail>=0?"#00ff88":"#ff4560"}}>{f$(schwabAvail)}</div>
                      <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>acct {f$(+cashData.schwab||0)} − STO {f$(schwabCommitted)} + BTO {f$(schwabBTOAssets)}</div>
                    </div>
                    <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #c084fc30",borderRadius:8,padding:"8px 12px",minWidth:140,display:"flex",flexDirection:"column",gap:3}}>
                      <div style={{fontSize:7,color:"#c084fc",fontFamily:"monospace",letterSpacing:"0.08em"}}>ETRADE AVAILABLE</div>
                      <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:etradeAvail>=0?"#00ff88":"#ff4560"}}>{f$(etradeAvail)}</div>
                      <div style={{fontSize:8,color:th("#3a4050","#8a7e74"),fontFamily:"monospace"}}>acct {f$(etradeCombined)} − STO {f$(etradeCommitted)} + BTO {f$(etradeBTOAssets)}</div>
                    </div>
                  </>);
                })()}
                {/* Filter + Add Stock */}
                <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  <button onClick={()=>setStocksFilter("all")} style={{background:stocksFilter==="all"?"#00ff8814":"transparent",color:stocksFilter==="all"?"#00ff88":"#444",border:stocksFilter==="all"?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"4px 10px",fontSize:9,fontFamily:"monospace"}}>All</button>
                  <button onClick={()=>setStocksFilter("owned")} style={{background:stocksFilter==="owned"?"#00ff8814":"transparent",color:stocksFilter==="owned"?"#00ff88":"#444",border:stocksFilter==="owned"?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"4px 10px",fontSize:9,fontFamily:"monospace"}}>Owned ({ownedTickers.length})</button>
                  <button onClick={()=>setShowAddStock(p=>!p)} style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:6,padding:"5px 11px",fontSize:10,fontFamily:"monospace",fontWeight:700}}>+ Add Stock</button>
                </div>
              </div>

              {/* Add Stock form */}
              {showAddStock && (
                <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #00ff8825",borderRadius:8,padding:12,animation:"fadeIn .2s"}}>
                  <div style={{fontFamily:"monospace",fontSize:9,color:"#00ff88",marginBottom:8,letterSpacing:"0.07em"}}>ADD / UPDATE STOCK</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:7}}>
                    <div><FL req>Ticker</FL><input type="text" value={addStockForm.ticker} onChange={e=>setAddStockForm(p=>({...p,ticker:e.target.value.toUpperCase()}))} style={{textTransform:"uppercase"}}/></div>
                    <div><FL>Schwab Shares</FL><input type="number" value={addStockForm.schwabShares} onChange={e=>setAddStockForm(p=>({...p,schwabShares:e.target.value}))}/></div>
                    <div><FL>Etrade Shares</FL><input type="number" value={addStockForm.etradeShares} onChange={e=>setAddStockForm(p=>({...p,etradeShares:e.target.value}))}/></div>
                    <div><FL>Price $</FL><input type="number" value={addStockForm.price} onChange={e=>setAddStockForm(p=>({...p,price:e.target.value}))}/></div>
                    <div><FL>Earnings Date</FL><input type="date" value={addStockForm.earningsDate} onChange={e=>setAddStockForm(p=>({...p,earningsDate:e.target.value}))}/></div>
                  </div>
                  <div style={{display:"flex",gap:7,marginTop:9}}>
                    <button onClick={async()=>{
                      if(!addStockForm.ticker)return;
                      const t=addStockForm.ticker;
                      const updated={...stocksData,[t]:{...(stocksData[t]||{}),sharesSchwab:addStockForm.schwabShares?+addStockForm.schwabShares:null,sharesEtrade:addStockForm.etradeShares?+addStockForm.etradeShares:null,currentPrice:addStockForm.price?+addStockForm.price:null,earningsDate:addStockForm.earningsDate||null}};
                      setStocksData(updated);
                      try{await supabase.from("col_prefs").upsert({id:"stocks_data",cols:updated,updated_at:new Date().toISOString()});}catch{}
                      setAddStockForm({ticker:"",schwabShares:"",etradeShares:"",price:"",earningsDate:""});
                      setShowAddStock(false);
                    }} style={{background:"#00ff88",color:th("#010409","#f5f0e8"),border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                    <button onClick={()=>setShowAddStock(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                  </div>
                </div>
              )}



              {/* Portfolio Value Chart */}
              {(() => {
                const snaps = portfolioSnapshots;
                if (!snaps.length) return (
                  <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:24,textAlign:"center"}}>
                    <div style={{color:th("#3a4050","#8a7e74"),fontSize:11,fontFamily:"monospace"}}>No portfolio snapshots yet — data will appear after market close today</div>
                  </div>
                );

                // Chart dimensions
                const W = 680, H = 180, PAD = { top: 16, right: 16, bottom: 28, left: 64 };
                const chartW = W - PAD.left - PAD.right;
                const chartH = H - PAD.top - PAD.bottom;

                const values  = snaps.map(s => +s.total_value).filter(Boolean);
                const minVal  = Math.min(...values) * 0.995;
                const maxVal  = Math.max(...values) * 1.005;
                const range   = maxVal - minVal || 1;

                const xScale = i => PAD.left + (i / (snaps.length - 1 || 1)) * chartW;
                const yScale = v => PAD.top + chartH - ((v - minVal) / range) * chartH;

                // Build SVG path
                const points = snaps.map((s, i) => [xScale(i), yScale(+s.total_value)]);
                const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
                const areaPath = `${linePath} L${points[points.length-1][0].toFixed(1)},${(PAD.top+chartH).toFixed(1)} L${PAD.left},${(PAD.top+chartH).toFixed(1)} Z`;

                const latest  = snaps[snaps.length - 1];
                const first   = snaps[0];
                const totalChg     = latest?.total_value && first?.total_value ? +latest.total_value - +first.total_value : null;
                const totalChgPct  = totalChg != null && first?.total_value ? (totalChg / +first.total_value) * 100 : null;
                const todayChg     = latest?.daily_change;
                const todayChgPct  = latest?.daily_change_pct;
                const isUp         = todayChg >= 0;

                // Y axis ticks
                const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => minVal + t * range);

                // X axis — show month labels
                const xLabels = snaps.reduce((acc, s, i) => {
                  const mo = s.snapshot_date?.slice(0, 7);
                  if (!acc.find(a => a.mo === mo)) acc.push({ mo, i });
                  return acc;
                }, []);

                return (
                  <div style={{background:th("#0a0e14","#f8f3eb"),border:"1px solid #1c2128",borderRadius:8,padding:"12px 14px"}}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:10,flexWrap:"wrap"}}>
                      <span style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em"}}>PORTFOLIO VALUE</span>
                      {latest?.total_value && (
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:18,fontWeight:700,color:th("#e6edf3","#0d0d0b")}}>{f$(+latest.total_value)}</span>
                      )}
                      {todayChg != null && (
                        <span style={{fontFamily:"monospace",fontSize:11,color: isUp ? "#00ff88" : "#ff4560"}}>
                          {isUp ? "+" : ""}{f$(todayChg)} ({isUp ? "+" : ""}{todayChgPct?.toFixed(2)}%) today
                        </span>
                      )}
                      {totalChg != null && snaps.length > 1 && (
                        <span style={{fontFamily:"monospace",fontSize:10,color:th("#3a4050","#8a7e74")}}>
                          {totalChg >= 0 ? "+" : ""}{f$(totalChg)} ({totalChgPct?.toFixed(1)}%) since {first.snapshot_date}
                        </span>
                      )}
                    </div>

                    {/* SVG Chart */}
                    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block",overflow:"visible"}}>
                      {/* Grid lines + Y labels */}
                      {yTicks.map((v, i) => (
                        <g key={i}>
                          <line x1={PAD.left} y1={yScale(v)} x2={PAD.left+chartW} y2={yScale(v)} stroke={th("#1c2128","#b8a898")} strokeWidth={1}/>
                          <text x={PAD.left-6} y={yScale(v)+4} textAnchor="end" fill={th("#3a4050","#8a7e74")} fontSize={9} fontFamily="monospace">{f$(v,0)}</text>
                        </g>
                      ))}

                      {/* Area fill */}
                      <defs>
                        <linearGradient id="pgrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#00ff88" stopOpacity="0.15"/>
                          <stop offset="100%" stopColor="#00ff88" stopOpacity="0.01"/>
                        </linearGradient>
                      </defs>
                      <path d={areaPath} fill="url(#pgrad)"/>

                      {/* Line */}
                      <path d={linePath} fill="none" stroke="#00ff88" strokeWidth={1.5} strokeLinejoin="round"/>

                      {/* X axis labels */}
                      {xLabels.map(({ mo, i }) => (
                        <text key={mo} x={xScale(i)} y={PAD.top+chartH+16} textAnchor="middle" fill={th("#3a4050","#8a7e74")} fontSize={8} fontFamily="monospace">
                          {mo?.slice(5)}
                        </text>
                      ))}

                      {/* Latest dot */}
                      {snaps.length > 0 && (
                        <circle cx={xScale(snaps.length-1)} cy={yScale(+latest.total_value)} r={3} fill="#00ff88"/>
                      )}
                    </svg>

                    {/* Breakdown row */}
                    <div style={{display:"flex",gap:16,marginTop:10,flexWrap:"wrap"}}>
                      {[
                        { label: "Schwab",    value: latest?.schwab_value ?? (liveSchwabInline||null),  color: "#58a6ff" },
                        { label: "ETrade",    value: latest?.etrade_value ?? liveEtradeInline,           color: "#ffd166" },
                        { label: "Cash",      value: latest?.total_cash,            color: "#888" },
                        { label: "Contracts", value: latest?.open_contracts_value,  color: "#00ff88" },
                      ].map(({ label, value, color }) => value != null && (
                        <div key={label} style={{display:"flex",flexDirection:"column",gap:2}}>
                          <span style={{fontFamily:"monospace",fontSize:7,color:th("#3a4050","#8a7e74"),letterSpacing:"0.08em"}}>{label}</span>
                          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,fontWeight:600,color}}>{f$(+value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}


        {/* ══ SAGE EXPLORER ══ */}
        {tab==="scanner" && <OpportunityScannerTab />}
        {tab==="sage" && <SageTab supabase={supabase} setTab={setTab} setSelectedTicker={setSelectedTicker} />}

        {/* ══ SIGNAL LOG ══ */}
        {tab==="signallog" && <SignalLogTab supabase={supabase} />}
        {tab==="signalrules" && <SignalRulesTab supabase={supabase} />}

        {/* ══ ALL TRANSACTIONS ══ */}
        {tab==="all_transactions" && <AllTransactionsTab supabase={supabase} />}

        {/* ══ IMPORT ══ */}
        {tab==="import" && <ImportDailyTab contracts={contracts} supabase={supabase} />}

                {/* Bottom padding so content isn't hidden behind mobile ribbon */}
        <div style={{height:70}}/>
      </div>
    </div>

    {/* ── Mobile bottom ribbon ──────────────────────────────────────────── */}
    <div style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:9000,
      background:th("#0a0e14","#f8f3eb"), borderTop:"1px solid #1c2128",
      display:"flex", alignItems:"stretch",
      paddingBottom:"env(safe-area-inset-bottom)",
    }}>
      {[
        {id:"dashboard", icon:"📊", label:"Dash"},
        {id:"contracts", icon:"📋", label:"Contracts"},
        {id:"analytics", icon:"📈", label:"Analytics"},
        {id:"plan",      icon:"🗓", label:"Plan"},
        {id:"stocks",    icon:"💹", label:"Stocks"},
        {id:"import",    icon:"⬇", label:"Import"},
      ].map(({id, icon, label}) => (
        <button key={id} onClick={()=>setTab(id)}
          style={{
            flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
            gap:2, padding:"8px 2px 6px", border:"none", background:"transparent",
            color: tab===id ? "#00ff88" : "#444",
            borderTop: tab===id ? "2px solid #00ff88" : "2px solid transparent",
            cursor:"pointer", position:"relative",
            transition:"color 0.15s",
          }}>
          <span style={{fontSize:18, lineHeight:1}}>{icon}</span>
          <span style={{fontSize:9, fontFamily:"monospace", letterSpacing:"0.03em", textTransform:"uppercase"}}>{label}</span>
          {id==="import" && pendingCount > 0 && (
            <span style={{position:"absolute",top:4,right:"calc(50% - 14px)",background:"#ff6b2b",color:"#fff",borderRadius:8,fontSize:7,fontWeight:700,padding:"1px 4px",lineHeight:1.4}}>{pendingCount}</span>
          )}
        </button>
      ))}
    </div>
    </>
  );
}

