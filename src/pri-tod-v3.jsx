import { useState, useEffect, useRef, useCallback } from "react";
import { fetchQuotes, fetchOpenPositionChains, findOptionForContract } from "./etrade.js";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
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
const TODAY = new Date().toISOString().slice(0,10);

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
  const now = new Date();
  for (let i=1;i<=14;i++) { const d=new Date(now); d.setDate(now.getDate()+i); if (targets.includes(d.getDay())) return d.toISOString().slice(0,10); }
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
const EMPTY_NEW = {stock:"",type:"Call",optType:"STO",strike:"",qty:"",expires:"",premium:"",priceAtExecution:"",dateExec:TODAY,account:"",notes:"",strategy:"",createdVia:"Manual",currentPrice:null};
const EMPTY_CLOSE = {costToClose:"",closeDate:TODAY,exercised:"No",rolledOver:"No",notes:""};

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

// ── UI Primitives ─────────────────────────────────────────────────────────────
const Tag = ({children, color="green"}) => {
  const pal = {green:"#00ff88",red:"#ff4560",blue:"#58a6ff",amber:"#ffd166",gray:"#555",purple:"#c084fc"};
  const c = pal[color]||pal.gray;
  return <span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",background:`${c}18`,color:c,border:`1px solid ${c}30`,borderRadius:3,padding:"1px 6px",whiteSpace:"nowrap"}}>{children}</span>;
};
const KPI = ({label,value,sub,color="#00ff88"}) => (
  <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:"10px 12px",flex:1,minWidth:88}}>
    <div style={{fontSize:8,color:"#3a4050",fontFamily:"monospace",letterSpacing:"0.08em",marginBottom:2,textTransform:"uppercase"}}>{label}</div>
    <div style={{fontSize:15,fontWeight:700,color,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.2}}>{value}</div>
    {sub && <div style={{fontSize:8,color:"#2a3040",marginTop:1,fontFamily:"monospace"}}>{sub}</div>}
  </div>
);
const FL = ({children,req}) => (
  <div style={{fontSize:9,color:"#2a3040",fontFamily:"monospace",marginBottom:3,textTransform:"uppercase",letterSpacing:"0.06em"}}>
    {children}{req && <span style={{color:"#ff4560",marginLeft:2}}>*</span>}
  </div>
);
const ChartTip = ({active,payload,label}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:5,padding:"8px 11px"}}>
      <div style={{color:"#555",fontSize:10,marginBottom:4,fontFamily:"monospace"}}>{label}</div>
      {payload.map((p,i) => <div key={i} style={{color:p.color,fontSize:11,fontFamily:"monospace"}}>{p.name}: {p.name==="Contracts"?p.value:f$(p.value)}</div>)}
    </div>
  );
};

// ── Coin / Loss animation overlay ─────────────────────────────────────────────
function CelebrationOverlay({profit, onDone}) {
  useEffect(() => { const t = setTimeout(onDone, 2800); return () => clearTimeout(t); }, []);
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
  const [gTicker,setGTicker]     = useState("All");
  const [gOptType,setGOptType]   = useState("All");
  const [gType,setGType]         = useState("All");

  // Chart
  const [chartView,setChartView] = useState("monthly"); // daily/weekly/monthly
  const [chartDate,setChartDate] = useState("executed"); // executed/closed

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
  const [showTradeRules, setShowTradeRules] = useState(false);
  const [tradeRules, setTradeRules] = useState([]);
  const [tradeRuleForm, setTradeRuleForm] = useState(null);
  const EMPTY_RULE = {name:"",direction:"Open",optType:"STO",type:"Call",minOTM:"",maxOTM:"",minDTE:"",maxDTE:"",stockPerf:"Any",logic:""};

  // Goals
  const [showGoals, setShowGoals] = useState(false);
  const [goals, setGoals] = useState({dailyPremium:"",dailyProfit:"",weeklyPremium:"",monthlyPremium:"",quarterlyPremium:"",weeklyProfit:"",monthlyProfit:"",quarterlyProfit:""});

  // Storage/UI
  const [storageMsg,setStorageMsg] = useState("");
  const [showImport,setShowImport] = useState(false);
  const [importText,setImportText] = useState("");
  const [importMsg,setImportMsg]   = useState("");
  const [deleteConfirm,setDeleteConfirm] = useState(null);
  const [viewC,setViewC]           = useState(null);
  const [showMenu,setShowMenu]     = useState(false);
  const [showTeam,setShowTeam]     = useState(false);
  const [celebration,setCelebration] = useState(null); // {profit}
  const [planItems,setPlanItems]   = useState([]);
  const [planForm,setPlanForm]     = useState(null);
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
        // Load contracts
        const { data: cData, error: cErr } = await supabase
          .from("contracts").select("*").order("date_exec", { ascending: false });
        if (cErr) throw cErr;
        const loaded = cData?.map(toApp) || [];
        setContracts(loaded.length ? loaded : SEED);
        // If first run, seed the DB
        if (!loaded.length && SEED.length) {
          const { error: seedErr } = await supabase.from("contracts").insert(SEED.map(toDB));
          if (!seedErr) setContracts(SEED);
        }

        // Load plan items
        const { data: pData } = await supabase.from("plan_items").select("*").order("created_at", { ascending: false });
        if (pData) setPlanItems(pData.map(planToApp));

        // Load users (PINs)
        const { data: uData } = await supabase.from("app_users").select("*");
        if (uData?.length) setUsers(uData);
        else {
          // Seed default users
          await supabase.from("app_users").insert(USERS_DEFAULT);
        }

        // Load col prefs — merge with DEFAULT_COLS so new columns always appear
        const { data: colData } = await supabase.from("col_prefs").select("*").eq("id","default").single();
        if (colData?.cols) {
          // Any column in DEFAULT_COLS not in saved prefs gets appended (defaulting to show:false)
          const savedKeys = new Set(colData.cols.map(c=>c.key));
          const merged = [
            ...colData.cols,
            ...DEFAULT_COLS.filter(c=>!savedKeys.has(c.key)),
          ];
          setCols(merged);
        }

        // Load stocks data
        const { data: sdData } = await supabase.from("col_prefs").select("*").eq("id","stocks_data").single();
        if (sdData?.cols) setStocksData(sdData.cols);

        // Load period notes
        const { data: nData } = await supabase.from("period_notes").select("*");
        if (nData?.length) {
          const map = {};
          nData.forEach(n => { map[n.period_key] = n.note; });
          setPeriodNotes(map);
        }

        // Load AI chat history (last 40 messages)
        try {
          const { data: aiData } = await supabase.from("ai_chats").select("*").order("created_at", { ascending: true }).limit(40);
          if (aiData?.length) {
            setAiMessages(aiData.map(r => ({id: r.id, role: r.role, content: r.content, saved: true, starred: r.starred||false})));
          }
        } catch {}

        // Load strategies (table may not exist yet)
        try {
          const { data: stratData } = await supabase.from("strategies").select("*").order("created_at", { ascending: true });
          if (stratData?.length) setStrategies(stratData);
        } catch {}

        // Load goals
        try {
          const { data: goalsData } = await supabase.from("col_prefs").select("*").eq("id","goals").single();
          if (goalsData?.cols) setGoals(goalsData.cols);
        } catch {}

        // Load profit bands
        try {
          const { data: bandsData } = await supabase.from("col_prefs").select("*").eq("id","profit_bands").single();
          if (bandsData?.cols) setBands(bandsData.cols);
        } catch {}

        // Load OTM/DTE matrix
        try {
          const { data: mx } = await supabase.from("col_prefs").select("*").eq("id","dte_matrix").single();
          if (mx?.cols) { const m=mx.cols; if(m.otmRows)setMatrixOTMRows(m.otmRows); if(m.dteCols)setMatrixDTECols(m.dteCols); if(m.call)setMatrixCall(m.call); if(m.put)setMatrixPut(m.put); }
        } catch {}

        // Load trade rules
        try {
          const { data: trData } = await supabase.from("col_prefs").select("*").eq("id","trade_rules").single();
          if (trData?.cols) setTradeRules(trData.cols);
        } catch {}

        setStorageMsg((loaded.length || SEED.length) + " contracts");
      } catch(err) {
        console.error("Load error:", err);
        setStorageMsg("DB error — check console");
      }
      setDbReady(true);
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
    if (!c.priceAtExecution || !c.strike || !c.expires) return null;
    const otmPct = c.type==="Put"
      ? ((c.priceAtExecution - c.strike) / c.priceAtExecution) * 100
      : ((c.strike - c.priceAtExecution) / c.priceAtExecution) * 100;
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
    if (!c.priceAtExecution || !c.strike) return null;
    const otmPct = c.type==="Put"
      ? ((c.priceAtExecution - c.strike) / c.priceAtExecution) * 100
      : ((c.strike - c.priceAtExecution) / c.priceAtExecution) * 100;
    // Try matrix first
    const mx = getMatrixTarget(c);
    if (mx) {
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
  useEffect(() => {
    if (!dbReady) return;
    const interval = setInterval(async () => {
      try {
        const { data, error } = await supabase
          .from("contracts").select("*").order("date_exec", { ascending: false });
        if (!error && data) {
          const loaded = data.map(toApp);
          setContracts(loaded);
          setStorageMsg(loaded.length + " contracts · synced " + new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
        }
      } catch {}
    }, 10000);
    // Supabase realtime subscription for instant sync
    const channel = supabase.channel("contracts-changes")
      .on("postgres_changes", {event:"*",schema:"public",table:"contracts"}, async () => {
        try {
          const {data,error} = await supabase.from("contracts").select("*").order("date_exec",{ascending:false});
          if(!error&&data) setContracts(data.map(toApp));
        } catch {}
      }).subscribe();
    return () => { clearInterval(interval); supabase.removeChannel(channel); };
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
  const originals = contracts.filter(c => !c.parentId);

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
  const totalProfit = closedC.reduce((s,c) => s+(c.profit||0), 0);
  const openPrem    = openC.reduce((s,c) => s+Math.abs(c.premium||0), 0);
  const committedFunds = openC.filter(c=>c.optType==="STO"&&c.type==="Put").reduce((s,c)=>s+(Math.abs(c.strike||0)*(c.qty||0)*100),0);
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
  const [stocksFilter, setStocksFilter] = useState("all"); // "all" | "owned"
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

  const updateStockData = async (ticker, field, value) => {
    const updated = {...stocksData, [ticker]: {...(stocksData[ticker]||{}), [field]: value}};
    setStocksData(updated);
    try { await supabase.from("col_prefs").upsert({id:"stocks_data", cols: updated, updated_at: new Date().toISOString()}); } catch {}
  };

  // ── E*TRADE live data ───────────────────────────────────────────────────────────────────────────
  const [etradeStatus, setEtradeStatus]       = useState("idle"); // idle | loading | ok | error
  const [etradeMsg, setEtradeMsg]             = useState("");
  const [etradeChains, setEtradeChains]       = useState({}); // { "TICKER|YYYY-MM-DD": {calls,puts} }
  const [etradeLastFetch, setEtradeLastFetch] = useState(null);

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
      setEtradeMsg("Fetching quotes for " + openTickers.length + " open ticker(s)…");
      const quotes = await fetchQuotes(openTickers);
      await applyQuotesToStocksData(quotes);

      // Stamp currentPrice (stock price) onto each open contract for ITM/OTM display
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
          setEtradeChains(freshChains);
        } catch (chainErr) {
          console.warn("[etrade] option chains unavailable in sandbox:", chainErr.message);
        }
      }

      const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setEtradeLastFetch(now);
      setEtradeStatus("ok");
      setEtradeMsg("Synced " + Object.keys(quotes).length + " quote(s) at " + now + (openContracts.length ? " · chains: sandbox limited" : ""));
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

  // Get live bid/ask/last for a specific open contract from cached chains
  const getLiveOption = useCallback((contract) => {
    return findOptionForContract(etradeChains, contract);
  }, [etradeChains]);


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
    const map = {};
    list.forEach(c => {
      const d = c.dateExec?.slice(0,10); if (!d) return;
      let key;
      if (view === "monthly") { key = d.slice(0,7); }
      else if (view === "weekly") { const dt = new Date(d+"T12:00:00"); const wm = new Date(dt); wm.setDate(dt.getDate()-dt.getDay()+1); key = wm.toISOString().slice(0,10); }
      else { key = d; }
      if (!map[key]) map[key] = {key, premium:0, profit:0, contracts:0};
      map[key].premium   += (c.premium||0);
      map[key].contracts += 1;
      // For profit: use closeDate bucket if dateMode==="close", else use same exec bucket
      if (c.status==="Closed" && c.profit!=null) {
        const profitDate = dateMode==="close" && c.closeDate ? c.closeDate.slice(0,10) : d;
        let pk;
        if (view === "monthly") { pk = profitDate.slice(0,7); }
        else if (view === "weekly") { const dt = new Date(profitDate+"T12:00:00"); const wm = new Date(dt); wm.setDate(dt.getDate()-dt.getDay()+1); pk = wm.toISOString().slice(0,10); }
        else { pk = profitDate; }
        if (!map[pk]) map[pk] = {key:pk, premium:0, profit:0, contracts:0};
        map[pk].profit += c.profit;
      }
    });
    const ns = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return Object.values(map).sort((a,b)=>a.key.localeCompare(b.key)).map(v => {
      if (view==="monthly") { const [yr,mo]=v.key.split("-"); v.label=ns[+mo]+" "+yr.slice(2); }
      else if (view==="weekly") { v.label = "Wk "+v.key.slice(5); }
      else { v.label = v.key.slice(5); }
      return v;
    });
  };
  const [analyticsView,setAnalyticsView] = useState("monthly");
  const [profitDateMode,setProfitDateMode] = useState("exec"); // "exec" | "close"
  const profitDateField = (c) => profitDateMode==="close" ? c.closeDate : c.dateExec;
  const profitMTD = closedC.filter(c=>profitDateField(c)?.startsWith(thisMonth)).reduce((s,c)=>s+(c.profit||0),0);
  const profitYTD = closedC.filter(c=>profitDateField(c)?.startsWith(thisYear)).reduce((s,c)=>s+(c.profit||0),0);
  // Daily
  const todayKey = new Date().toISOString().slice(0,10);
  const profitToday = closedC.filter(c=>profitDateField(c)?.startsWith(todayKey)).reduce((s,c)=>s+(c.profit||0),0);
  const premToday   = allF.filter(c=>c.dateExec?.startsWith(todayKey)).reduce((s,c)=>s+(c.premium||0),0);
  const periodData = mkPeriodData(allF, analyticsView, profitDateMode);

  // Filtered contracts for table
  const sortedFiltered = contracts.filter(c => {
    if (fOriginals && c.parentId) return false; // hide linked close records
    if (fStatus !== "All" && c.status !== fStatus) return false;
    if (fAcct   !== "All" && c.account !== fAcct)  return false;
    if (fSearch && !(c.stock?.toLowerCase().includes(fSearch.toLowerCase()) || fTitle(c).toLowerCase().includes(fSearch.toLowerCase()))) return false;
    if (gTicker  !== "All" && c.stock?.toUpperCase() !== gTicker) return false;
    if (gOptType !== "All" && c.optType !== gOptType) return false;
    if (gType    !== "All" && c.type    !== gType)    return false;
    if (fDateFrom && (c.dateExec||"") < fDateFrom) return false;
    if (fDateTo   && (c.dateExec||"") > fDateTo)   return false;
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
  const filteredPlan = planItems.filter(p => !planDateFilter || (p.createdAt||"").startsWith(planDateFilter));
  const activePlan = filteredPlan.filter(p=>p.status==="open");
  const donePlan   = filteredPlan.filter(p=>p.status==="done");
  // Hide open contracts already added to any active plan item (regardless of date filter)
  const allActivePlan = planItems.filter(p=>p.status==="open");
  const planOpen = originals.filter(c => {
    if (c.status !== "Open") return false;
    const alreadyPlanned = allActivePlan.some(p =>
      p.ticker?.toUpperCase() === c.stock?.toUpperCase() &&
      String(p.strike) === String(c.strike) &&
      p.expiration === c.expires &&
      p.account === c.account
    );
    return !alreadyPlanned;
  }).sort((a,b)=>(a.expires||"").localeCompare(b.expires||""));
  const expToday = planOpen.filter(c=>c.expires===planToday);

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
      costToClose:ic?(orig.costToClose??null):null, closeDate:ic?(orig.closeDate??null):null,
      profit:ic?(orig.profit??null):null, profitPct:ic?(orig.profitPct??null):null,
      daysHeld:ic?(orig.daysHeld??null):null, exercised:ic?(orig.exercised??null):null,
      rolledOver:ic?(orig.rolledOver??null):null,
      status:ic?"Closed":"Open", createdVia:form.createdVia||"Manual", createdBy:authUser?.id||null,
      currentPrice:form.currentPrice||null,
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
    const proratedPremium = orig.premium * qtyRatio;
    const proratedCTC = ctc * qtyRatio; // ctc entered as total for qty being closed
    const profit = isBTO
      ? +(proratedCTC - Math.abs(proratedPremium)).toFixed(2)
      : +(Math.abs(proratedPremium) - ctc).toFixed(2);
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
    setCloseForm({...EMPTY_CLOSE}); setClosingId(null); setShowForm(false);
    setCelebration({profit});
    if (profit > 0) playCashRegister(); else playLoss();
  };

  const startClose = c => { setClosingId(c.id); setCloseForm({...EMPTY_CLOSE,notes:c.notes||""}); setFormMode("close"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doEdit = c => { setForm({...c,strike:`${c.strike}`,qty:`${c.qty}`,premium:`${c.premium}`,priceAtExecution:c.priceAtExecution??"",costToClose:c.costToClose??"",profit:c.profit??"",daysHeld:c.daysHeld??""}); setEditing(c.id); setFormMode("new"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doDelete = async id => {
    const updated = contracts.filter(c=>c.id!==id);
    setContracts(updated); setStorageMsg(updated.length+" contracts");
    await deleteOne(id);
    setDeleteConfirm(null); setViewC(null);
  };
  const doExport = () => { const b=new Blob([JSON.stringify(contracts,null,2)],{type:"application/json"}); const u=URL.createObjectURL(b); const a=document.createElement("a"); a.href=u; a.download="pri_export_"+TODAY+".json"; a.click(); URL.revokeObjectURL(u); };
  const doImport = async () => {
    try {
      const p = JSON.parse(importText);
      if (!Array.isArray(p)) throw new Error("Expected array");
      // Upsert all into Supabase
      const { error } = await supabase.from("contracts").upsert(p.map(toDB));
      if (error) throw error;
      setContracts(p); setStorageMsg(p.length+" contracts");
      setImportMsg("✓ Imported "+p.length+" contracts");
      setImportText("");
      setTimeout(()=>{setShowImport(false);setImportMsg("");},1500);
    } catch(e) { setImportMsg("Error: "+e.message); }
  };

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
    setPlanForm({ticker,action:prefill.action||"STO",type:prefill.type||"Call",qty:prefill.qty||d.qty||1,strike:prefill.strike||"",expiration:prefill.expiration||nextExpiry(ticker)||"",account:prefill.account||d.account||"",premium:"",stockPrice:"",bid:"",ask:"",last:"",targetPremium:"",notes:prefill.notes||""});
  };
  const savePlan = () => {
    if (!planForm?.action) return;
    // Dedupe: don't add if identical ticker+action+strike+expiration+account already exists as open
    const isDupe = planItems.some(p =>
      p.status==="open" &&
      p.ticker?.toUpperCase()===planForm.ticker?.toUpperCase() &&
      p.action===planForm.action &&
      String(p.strike)===String(planForm.strike) &&
      p.expiration===planForm.expiration &&
      p.account===planForm.account
    );
    if (isDupe) { alert(`${planForm.ticker} ${planForm.action} ${planForm.strike} ${planForm.expiration} is already in your plan.`); return; }
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
          model:"claude-sonnet-4-5",
          max_tokens:1000,
          system: systemPrompt,
          messages: [...newMsgs].map(m=>({role:m.role,content:m.content})),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAiMessages(p=>[...p,{role:"assistant",content:"API Error: " + (data?.error || JSON.stringify(data))}]);
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
    <div style={{minHeight:"100vh",background:"#010409",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
      <div style={{width:12,height:12,border:"2px solid #1c2128",borderTopColor:"#00ff88",borderRadius:"50%",animation:"spin .7s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (!authUser) return (
    <div style={{minHeight:"100vh",background:"#010409",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Inter',sans-serif",padding:16}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      <div style={{width:"100%",maxWidth:340,animation:"fadeIn .3s ease"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:52,height:52,borderRadius:14,background:"linear-gradient(135deg,#0d1f12,#0a1a1f)",border:"1px solid #00ff8830",boxShadow:"0 0 24px #00ff8818",marginBottom:10}}>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:17,color:"#00ff88"}}>PRI</span>
          </div>
          <div style={{fontFamily:"monospace",fontSize:10,color:"#3a4050",letterSpacing:"0.08em"}}>PREMIUM RECURRING INCOME</div>
          <div style={{fontFamily:"monospace",fontSize:8,color:"#2a3040",letterSpacing:"0.06em",marginTop:2}}>TRADING OPTIONS DASHBOARD</div>
        </div>
        {loginStep==="pick" ? (
          <div>
            <div style={{fontSize:10,color:"#3a4050",fontFamily:"monospace",textAlign:"center",marginBottom:14,letterSpacing:"0.06em"}}>SELECT USER</div>
            {users.map(u => (
              <button key={u.id} onClick={()=>selUser(u)} style={{background:"#0a0e14",border:`1px solid ${u.color}25`,borderRadius:10,padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,width:"100%",marginBottom:8}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:`${u.color}20`,border:`2px solid ${u.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:u.color,fontSize:11,flexShrink:0}}>{u.initials}</div>
                <div style={{textAlign:"left"}}><div style={{color:"#e6edf3",fontSize:13,fontWeight:600}}>{u.name}</div><div style={{color:"#3a4050",fontSize:9,fontFamily:"monospace",marginTop:1}}>Enter PIN to continue</div></div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setLoginStep("pick")} style={{background:"transparent",border:"none",color:"#3a4050",fontSize:10,fontFamily:"monospace",cursor:"pointer",marginBottom:14,display:"flex",alignItems:"center",gap:6}}>← Back</button>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,padding:"10px 14px",background:"#0a0e14",borderRadius:8,border:`1px solid ${loginTarget.color}20`}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:`${loginTarget.color}20`,border:`2px solid ${loginTarget.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:loginTarget.color,fontSize:11}}>{loginTarget.initials}</div>
              <div><div style={{color:"#e6edf3",fontSize:12,fontWeight:600}}>{loginTarget.name}</div><div style={{color:"#2a3040",fontSize:9,fontFamily:"monospace"}}>Enter 4-digit PIN or use keyboard</div></div>
            </div>
            <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:18}}>
              {[0,1,2,3].map(i=><div key={i} style={{width:13,height:13,borderRadius:"50%",background:i<pinInput.length?loginTarget.color:"transparent",border:`2px solid ${i<pinInput.length?loginTarget.color:"#2a3040"}`,transition:"all .15s"}}/>)}
            </div>
            {pinError && <div style={{textAlign:"center",color:"#ff4560",fontSize:11,fontFamily:"monospace",marginBottom:10}}>{pinError}</div>}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((d,i)=>(
                <button key={i} onClick={()=>d==="⌫"?setPinInput(p=>p.slice(0,-1)):d!==""?pinDigit(String(d)):null}
                  disabled={d===""}
                  style={{background:d===""?"transparent":"#0a0e14",border:d===""?"none":"1px solid #1c2128",borderRadius:8,padding:"13px 0",fontSize:d==="⌫"?16:18,fontFamily:"monospace",color:d===""?"transparent":"#e6edf3",cursor:d===""?"default":"pointer",fontWeight:500}}>
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
    <div style={{minHeight:"100vh",background:"#010409",color:"#e6edf3",fontFamily:"'Inter',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-track{background:#080c12}::-webkit-scrollbar-thumb{background:#21262d;border-radius:3px}
        input,select,textarea{background:#0d1219;color:#e6edf3;border:1px solid #2a3550;border-radius:4px;padding:6px 8px;font-family:inherit;font-size:12px;width:100%;outline:none;transition:border .15s}
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
          <div style={{background:"#0d1117",border:"1px solid #ff456040",borderRadius:10,padding:22,width:"100%",maxWidth:280,animation:"fadeIn .15s"}}>
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
            <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:18,width:"100%",maxWidth:500,animation:"fadeIn .15s",maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"monospace",fontWeight:700,fontSize:13,color:"#e6edf3"}}>{fTitle(c)}</span>
                  <Tag color={c.type==="Put"?"amber":"blue"}>{c.type}</Tag>
                  <Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":c.optType==="STC"?"blue":c.optType==="BTO"?"purple":"gray"}>{c.optType}</Tag>
                  <Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag>
                  {itmStatus && <Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus}</Tag>}
                </div>
                <button onClick={()=>setViewC(null)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,lineHeight:1,flexShrink:0}}>✕</button>
              </div>
              <div style={{background:"#080c12",borderRadius:8,padding:12,marginBottom:10,border:"1px solid #00ff8820"}}>
                <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.07em",marginBottom:8}}>OPEN — {c.optType}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {[["Strike","$"+c.strike],["Qty",c.qty],["Account",c.account||"—"],["Exec",c.dateExec||"—"],["Expires",c.expires||"—"],["Premium",f$(c.premium)],["Price@Exec",c.priceAtExecution?f$(c.priceAtExecution):"—"],["Strategy",c.strategy||"—"],["Created Via",c.createdVia||"—"],["By",c.createdBy?users.find(u=>u.id===c.createdBy)?.initials||c.createdBy:"—"]].map(([l,v])=>(
                    <div key={l}><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace",marginBottom:2}}>{l}</div><div style={{fontSize:11,color:"#c9d1d9",fontFamily:"monospace"}}>{v}</div></div>
                  ))}
                </div>
                {c.status==="Open" && (
                  <div style={{marginTop:10,display:"flex",alignItems:"center",gap:8}}>
                    <div style={{fontSize:8,color:"#3a4050",fontFamily:"monospace"}}>CURRENT PRICE $</div>
                    <input type="number" defaultValue={c.currentPrice||""} placeholder="Live via Schwab API"
                      onBlur={e=>updatePrice(c.id,e.target.value)}
                      style={{width:140,padding:"3px 6px",fontSize:11,border:`1px solid ${itmStatus==="ITM"?"#ff456040":itmStatus==="OTM"?"#00ff8840":"#21262d"}`}}/>
                    <span style={{fontSize:9,color:"#2a3040",fontFamily:"monospace"}}>🔗 Schwab API (coming)</span>
                  </div>
                )}
                {c.notes && <div style={{marginTop:8,fontSize:10,color:"#555",fontStyle:"italic"}}>"{c.notes}"</div>}
              </div>
              {c.status==="Closed" && (
                <div style={{background:"#080c12",borderRadius:8,padding:12,border:"1px solid #ffd16620"}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>
                    CLOSE — {c.optType==="BTO"?"STC":c.optType==="STO"?"BTC":"CLOSED"}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    {[["Close Date",c.closeDate||"—"],["Cost",c.costToClose!=null?f$(c.costToClose):"—"],["Profit",c.profit!=null?fSign(c.profit):"—"],["Return",c.profitPct!=null?fPct(c.profitPct):"—"],["Days",c.daysHeld??"—"],["Exercised",c.exercised||"—"],["Rolled",c.rolledOver||"—"]].map(([l,v])=>(
                      <div key={l}><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace",marginBottom:2}}>{l}</div>
                        <div style={{fontSize:11,color:l==="Profit"?(c.profit>=0?"#00ff88":"#ff4560"):"#c9d1d9",fontFamily:"monospace",fontWeight:l==="Profit"?700:400}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {lkOpen && <div style={{marginTop:8,padding:"6px 10px",background:"#0a0e14",borderRadius:6,border:"1px solid #58a6ff20",fontSize:9,color:"#58a6ff",fontFamily:"monospace"}}>↑ Close record — linked to open #{lkOpen.id} ({fTitle(lkOpen)})</div>}
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
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:22,width:"100%",maxWidth:320,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:`${authUser.color}20`,border:`2px solid ${authUser.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:authUser.color,fontSize:14}}>{authUser.initials}</div>
              <div><div style={{color:"#e6edf3",fontSize:14,fontWeight:600}}>{authUser.name}</div><div style={{color:"#3a4050",fontSize:9,fontFamily:"monospace",marginTop:1}}>OPTIONS DESK USER</div></div>
            </div>
            <div style={{borderTop:"1px solid #1c2128",paddingTop:14,marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:9,color:"#3a4050",letterSpacing:"0.07em",marginBottom:10}}>CHANGE PIN</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {pinStep>=1 && <div><FL>Current PIN</FL><input type="password" maxLength={4} value={pinCur} onChange={e=>setPinCur(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" disabled={pinStep>1}/></div>}
                {pinStep>=2 && <div><FL>New PIN (4 digits)</FL><input type="password" maxLength={4} value={pinNew} onChange={e=>setPinNew(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" autoFocus/></div>}
                {pinStep>=3 && <div><FL>Confirm New PIN</FL><input type="password" maxLength={4} value={pinCon} onChange={e=>setPinCon(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" autoFocus/></div>}
              </div>
              {pinMsg && <div style={{marginTop:8,fontSize:11,fontFamily:"monospace",color:pinMsg.includes("✓")?"#00ff88":"#ff4560"}}>{pinMsg}</div>}
              <button onClick={doPINChange} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,width:"100%",marginTop:10}}>{pinStep===3?"Save PIN":"Next →"}</button>
              <div style={{marginTop:6,fontSize:9,color:"#2a3040",fontFamily:"monospace",textAlign:"center"}}>2FA planned for future release</div>
            </div>
            <button onClick={()=>{setAuthUser(null);setShowProfile(false);}} style={{background:"#ff456010",color:"#ff4560",border:"1px solid #ff456030",borderRadius:6,padding:"8px",width:"100%",fontSize:12,marginBottom:8}}>Sign Out</button>
            <button onClick={()=>{setShowProfile(false);setPinStep(1);setPinCur("");setPinNew("");setPinCon("");setPinMsg("");}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12}}>Close</button>
          </div>
        </div>
      )}

      {/* Team modal */}
      {showTeam && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowTeam(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:22,width:"100%",maxWidth:340,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em",marginBottom:14}}>TEAM</div>
            {users.map(u => {
              const uc = originals.filter(c=>c.createdBy===u.id);
              const up = originals.filter(c=>c.createdBy===u.id&&c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
              return (
                <div key={u.id} style={{background:"#0a0e14",border:`1px solid ${u.color}20`,borderRadius:8,padding:12,marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:8}}>
                    <div style={{width:30,height:30,borderRadius:"50%",background:`${u.color}20`,border:`2px solid ${u.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:u.color,fontSize:10}}>{u.initials}</div>
                    <div><div style={{color:"#e6edf3",fontSize:12,fontWeight:600}}>{u.name}</div>{u.id===authUser.id&&<div style={{color:u.color,fontSize:8,fontFamily:"monospace"}}>● ACTIVE</div>}</div>
                  </div>
                  <div style={{display:"flex",gap:14}}>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>CONTRACTS</div><div style={{fontSize:14,fontFamily:"monospace",color:"#e6edf3",fontWeight:700}}>{uc.length}</div></div>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>REALIZED P/L</div><div style={{fontSize:14,fontFamily:"monospace",color:up>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(up)}</div></div>
                  </div>
                </div>
              );
            })}
            <button onClick={()=>setShowTeam(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12,marginTop:4}}>Close</button>
          </div>
        </div>
      )}

      {/* Import modal */}
      {showImport && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:420}}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",marginBottom:10}}>IMPORT JSON</div>
            <div style={{fontSize:10,color:"#3a4050",fontFamily:"monospace",marginBottom:10}}>Paste the full contract JSON array. Replaces all current data.</div>
            <textarea rows={7} value={importText} onChange={e=>setImportText(e.target.value)} placeholder='[{"id":1,"stock":"AAPL",...}]' style={{resize:"vertical",marginBottom:8}}/>
            {importMsg && <div style={{fontSize:11,fontFamily:"monospace",color:importMsg.startsWith("✓")?"#00ff88":"#ff4560",marginBottom:8}}>{importMsg}</div>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={doImport} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,flex:1}}>Import</button>
              <button onClick={()=>{setShowImport(false);setImportText("");setImportMsg("");}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px 12px",fontSize:12}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Column picker modal */}
      {showColPicker && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowColPicker(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:300,animation:"fadeIn .15s",maxHeight:"85vh",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",marginBottom:4}}>COLUMNS</div>
            <div style={{fontFamily:"monospace",fontSize:8,color:"#2a3040",marginBottom:12}}>Toggle visible · use arrows to reorder</div>
            <div style={{overflowY:"auto",flex:1,marginBottom:10}}>
            {cols.map((col, idx) => (
              <div key={col.key} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"#0a0e14",border:"1px solid #1c2128",borderRadius:6,marginBottom:5}}>
                <label style={{display:"flex",alignItems:"center",gap:8,flex:1,cursor:"pointer"}}>
                  <input type="checkbox" checked={col.show} onChange={()=>{const nc=cols.map(c=>c.key===col.key?{...c,show:!c.show}:c);persistCols(nc);}} style={{width:14,height:14,accentColor:"#00ff88"}}/>
                  <span style={{fontSize:12,color:"#c9d1d9",fontFamily:"monospace"}}>{col.label}</span>
                </label>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <button onClick={()=>moveCol(col.key,"up")} disabled={idx===0}
                    style={{background:"transparent",border:"1px solid #21262d",borderRadius:3,padding:"1px 5px",fontSize:10,color:idx===0?"#1c2128":"#555",lineHeight:1,cursor:idx===0?"default":"pointer"}}>↑</button>
                  <button onClick={()=>moveCol(col.key,"down")} disabled={idx===cols.length-1}
                    style={{background:"transparent",border:"1px solid #21262d",borderRadius:3,padding:"1px 5px",fontSize:10,color:idx===cols.length-1?"#1c2128":"#555",lineHeight:1,cursor:idx===cols.length-1?"default":"pointer"}}>↓</button>
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
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#ffd166",letterSpacing:"0.07em"}}>♟ STRATEGIES</div>
              <button onClick={()=>setShowStrategies(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Add strategy form */}
            {stratForm ? (
              <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:12,marginBottom:12}}>
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
                  }} style={{background:"#ffd166",color:"#010409",border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                  <button onClick={()=>setStratForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={()=>setStratForm({name:"",description:"",rules:""})} style={{background:"#ffd16614",color:"#ffd166",border:"1px solid #ffd16630",borderRadius:6,padding:"7px 14px",fontSize:11,fontFamily:"monospace",marginBottom:12}}>+ New Strategy</button>
            )}
            {/* Strategy list */}
            {strategies.length===0 && !stratForm && <div style={{color:"#3a4050",fontSize:11,fontFamily:"monospace",padding:"12px 0"}}>No strategies yet — add one above</div>}
            {strategies.map(s=>(
              <div key={s.id} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                  <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:12}}>{s.name}</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>setStratForm({...s})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Edit</button>
                    <button onClick={async()=>{await supabase.from("strategies").delete().eq("id",s.id);setStrategies(p=>p.filter(x=>x.id!==s.id));}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Del</button>
                  </div>
                </div>
                {s.description && <div style={{fontSize:11,color:"#8b949e",marginBottom:4}}>{s.description}</div>}
                {s.rules && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",whiteSpace:"pre-wrap",borderTop:"1px solid #1c2128",paddingTop:6,marginTop:4}}>{s.rules}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── GOALS MODAL ── */}
      {showGoals && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowGoals(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:400,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
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
            }} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:700,width:"100%",marginTop:6}}>Save Goals</button>
          </div>
        </div>
      )}

      {/* ── PROFIT BANDS MODAL ── */}
      {showBands && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowBands(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:560,maxHeight:"88vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>🎯 PROFIT BANDS</div>
              <button onClick={()=>setShowBands(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:10,color:"#3a4050",fontFamily:"monospace",marginBottom:12}}>Rules apply top-down. Per-type thresholds/targets override global. Leave blank to inherit global.</div>

            {/* Global thresholds */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:10}}>
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
              <div style={{marginTop:8,display:"flex",gap:8,fontSize:10,color:"#3a4050",fontFamily:"monospace",flexWrap:"wrap"}}>
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
              <div key={pfx} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
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
              <button onClick={async()=>{await persistBands(bands);setShowBands(false);}} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"8px 18px",fontSize:12,fontWeight:700}}>Save Bands</button>
            </div>
          </div>
        </div>
      )}

      {/* ── OTM/DTE MATRIX MODAL ── */}
      {showMatrix && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowMatrix(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:720,maxHeight:"90vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#00ff88",letterSpacing:"0.07em"}}>📐 OTM + DTE PROFIT TARGET MATRIX</div>
              <button onClick={()=>setShowMatrix(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Call/Put tab */}
            <div style={{display:"flex",gap:5,marginBottom:14}}>
              {["Call","Put"].map(t=>(
                <button key={t} onClick={()=>setMatrixTab(t)}
                  style={{background:matrixTab===t?(t==="Call"?"#58a6ff14":"#ffd16614"):"transparent",color:matrixTab===t?(t==="Call"?"#58a6ff":"#ffd166"):"#555",border:`1px solid ${matrixTab===t?(t==="Call"?"#58a6ff30":"#ffd16630"):"#1c2128"}`,borderRadius:5,padding:"4px 14px",fontSize:11,fontFamily:"monospace"}}>{t}s</button>
              ))}
              <span style={{fontSize:9,color:"#3a4050",fontFamily:"monospace",marginLeft:8,alignSelf:"center"}}>Separate targets for Calls vs Puts</span>
            </div>
            {/* DTE col thresholds */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:10,marginBottom:10}}>
              <div style={{fontFamily:"monospace",fontSize:8,color:"#3a4050",marginBottom:8}}>DTE COLUMN BOUNDARIES (max days)</div>
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
                    <th style={{padding:"6px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>OTM % \ DTE</th>
                    {matrixDTECols.map((col,ci)=>(
                      <th key={ci} style={{padding:"6px 8px",textAlign:"center",color:"#3a4050",fontFamily:"monospace",fontSize:9,borderBottom:"1px solid #1c2128"}}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixOTMRows.map((row,ri)=>{
                    const matrix = matrixTab==="Call" ? matrixCall : matrixPut;
                    const setMatrix = matrixTab==="Call" ? setMatrixCall : setMatrixPut;
                    return (
                      <tr key={ri}>
                        <td style={{padding:"6px 10px",fontFamily:"monospace",fontSize:10,color:"#c9d1d9",background:"#0a0e14",borderBottom:"1px solid #1c2128",whiteSpace:"nowrap"}}>
                          <input type="number" value={row.min} step="0.5" style={{width:50,marginRight:4}} onChange={e=>{const nr=[...matrixOTMRows];nr[ri]={...nr[ri],min:+e.target.value};setMatrixOTMRows(nr);}}/>
                          <span style={{color:"#555"}}>%+</span>
                        </td>
                        {matrixDTECols.map((col,ci)=>{
                          const v = matrix[ri]?.[ci]??0;
                          const bg = v===0?"#1c2128":v>=65?"#00ff8820":v>=55?"#ffd16618":"#ff456018";
                          const color = v===0?"#3a4050":v>=65?"#00ff88":v>=55?"#ffd166":"#ff4560";
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
            <div style={{fontSize:9,color:"#3a4050",fontFamily:"monospace",marginTop:8}}>Value = target profit %. 0 = avoid writing this contract. "buy@X%" = buy back when contract is worth X% of original premium.</div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
              <button onClick={()=>setShowMatrix(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 14px",fontSize:12}}>Cancel</button>
              <button onClick={async()=>{await persistMatrix(matrixOTMRows,matrixDTECols,matrixCall,matrixPut);setShowMatrix(false);}} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"7px 18px",fontSize:12,fontWeight:700}}>Save Matrix</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TRADE RULES MODAL ── */}
      {showTradeRules && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={()=>setShowTradeRules(false)}>
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto",animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#ffd166",letterSpacing:"0.07em"}}>⚙ TRADE RULES</div>
              <button onClick={()=>setShowTradeRules(false)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:10,color:"#3a4050",fontFamily:"monospace",marginBottom:12}}>Define criteria for valid trades. Rules are informational — matching contracts will be flagged on the plan tab.</div>
            {!tradeRuleForm ? (
              <button onClick={()=>setTradeRuleForm({...EMPTY_RULE})} style={{background:"#ffd16614",color:"#ffd166",border:"1px solid #ffd16630",borderRadius:6,padding:"6px 14px",fontSize:11,fontFamily:"monospace",marginBottom:12}}>+ New Rule</button>
            ) : (
              <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:12,marginBottom:12,animation:"fadeIn .2s"}}>
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
                </div>
                <div style={{marginTop:8}}><FL>Logic / Notes</FL><textarea rows={2} value={tradeRuleForm.logic} onChange={e=>setTradeRuleForm(p=>({...p,logic:e.target.value}))} style={{resize:"vertical"}} placeholder="Describe the reasoning, entry/exit criteria..."/></div>
                <div style={{display:"flex",gap:7,marginTop:9}}>
                  <button onClick={async()=>{
                    if(!tradeRuleForm.name.trim()) return;
                    const rule = {...tradeRuleForm, id:tradeRuleForm.id||Date.now()};
                    const updated = tradeRuleForm.id ? tradeRules.map(r=>r.id===rule.id?rule:r) : [...tradeRules, rule];
                    await persistTradeRules(updated);
                    setTradeRuleForm(null);
                  }} style={{background:"#ffd166",color:"#010409",border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE RULE</button>
                  <button onClick={()=>setTradeRuleForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}
            {tradeRules.length===0 && !tradeRuleForm && <div style={{color:"#3a4050",fontSize:11,fontFamily:"monospace",padding:"12px 0"}}>No rules yet — add one above</div>}
            {tradeRules.map(r=>(
              <div key={r.id} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:12}}>{r.name}</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>setTradeRuleForm({...r})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>Edit</button>
                    <button onClick={async()=>{const u=tradeRules.filter(x=>x.id!==r.id);await persistTradeRules(u);}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>Del</button>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[["Dir",r.direction],["Type",r.optType],["Call/Put",r.type],["OTM",r.minOTM&&r.maxOTM?r.minOTM+"–"+r.maxOTM+"%":r.minOTM?">"+r.minOTM+"%":r.maxOTM?"<"+r.maxOTM+"%":"Any"],["DTE",r.minDTE&&r.maxDTE?r.minDTE+"–"+r.maxDTE+"d":r.minDTE?">"+r.minDTE+"d":r.maxDTE?"<"+r.maxDTE+"d":"Any"],["Stock",r.stockPerf]].map(([l,v])=>(
                    v&&v!=="Any"&&<span key={l} style={{background:"#1c2128",borderRadius:4,padding:"2px 7px",fontSize:9,fontFamily:"monospace",color:"#888"}}>{l}: <span style={{color:"#c9d1d9"}}>{v}</span></span>
                  ))}
                </div>
                {r.logic && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",marginTop:6,borderTop:"1px solid #1c2128",paddingTop:6}}>{r.logic}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── TOPBAR ── */}
      <div style={{background:"#0a0e14",borderBottom:"1px solid #1c2128",padding:"0 10px",display:"flex",alignItems:"center",gap:8,height:50,position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,borderRadius:7,background:"linear-gradient(135deg,#0d1f12,#0a1a1f)",border:"1px solid #00ff8830",boxShadow:"0 0 12px #00ff8812"}}>
            <span style={{fontFamily:"monospace",fontWeight:700,fontSize:10,color:"#00ff88"}}>PRI</span>
          </div>
          <div className="hm">
            <div style={{fontSize:10,fontWeight:700,fontFamily:"monospace",letterSpacing:"0.03em",lineHeight:1.1}}>
              <span style={{color:"#00ff88"}}>P</span><span style={{color:"#c9d1d9"}}>remium </span><span style={{color:"#00ff88"}}>R</span><span style={{color:"#c9d1d9"}}>ecurring </span><span style={{color:"#00ff88"}}>I</span><span style={{color:"#c9d1d9"}}>ncome</span>
            </div>
            <div style={{fontSize:7,color:"#2a3040",fontFamily:"monospace",letterSpacing:"0.05em",marginTop:1}}>
              <span style={{color:"#00ff8860"}}>T</span>rading <span style={{color:"#00ff8860"}}>O</span>ptions <span style={{color:"#00ff8660"}}>D</span>ashboard · <span style={{color:"#00ff8840"}}>{storageMsg}</span>
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:2,flex:1,justifyContent:"center"}}>
          {["dashboard","contracts","analytics","plan"].map(n=>(
            <button key={n} onClick={()=>setTab(n)} style={{background:tab===n?"#00ff8814":"transparent",color:tab===n?"#00ff88":"#444",border:tab===n?"1px solid #00ff8825":"1px solid transparent",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace",letterSpacing:"0.05em",textTransform:"uppercase",whiteSpace:"nowrap"}}>{n}</button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
          <Tag color="green">{openC.length}</Tag>
          <div onClick={()=>setShowProfile(true)} style={{width:26,height:26,borderRadius:"50%",background:`${authUser.color}20`,border:`2px solid ${authUser.color}50`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontWeight:700,color:authUser.color,fontSize:9,flexShrink:0,cursor:"pointer"}} title={authUser.name}>{authUser.initials}</div>
          <div ref={menuRef} style={{position:"relative"}}>
            <button onClick={()=>setShowMenu(p=>!p)} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:5,padding:"4px 6px",display:"flex",flexDirection:"column",gap:2.5,alignItems:"center",justifyContent:"center",width:28,height:28}}>
              {[0,1,2].map(i=><div key={i} style={{width:12,height:1.5,background:"#555",borderRadius:1}}/>)}
            </button>
            {showMenu && (
              <div style={{position:"absolute",top:"calc(100% + 5px)",right:0,background:"#0d1117",border:"1px solid #21262d",borderRadius:8,minWidth:160,animation:"sd .15s ease",zIndex:200,overflow:"hidden"}}>
                {[
                  {label:"Profile",      icon:"👤", fn:()=>{setShowProfile(true);setShowMenu(false);}},
                  {label:"Team",         icon:"👥", fn:()=>{setShowTeam(true);setShowMenu(false);}},
                  {label:"Stocks",       icon:"📈", fn:()=>{setTab("stocks");setShowMenu(false);}},
                  {label:"Strategies",   icon:"♟",  fn:()=>{setTab("strategies");setShowMenu(false);}},
                  {label:"Profit Bands", icon:"🎯", fn:()=>{setShowBands(true);setShowMenu(false);}},
                  {label:"OTM/DTE Matrix",icon:"📐",fn:()=>{setShowMatrix(true);setShowMenu(false);}},
                  {label:"Trade Rules",  icon:"⚙", fn:()=>{setShowTradeRules(true);setShowMenu(false);}},
                  {label:"Goals",        icon:"📊", fn:()=>{setShowGoals(true);setShowMenu(false);}},
                  {label:"Export JSON",  icon:"⬇",  fn:()=>{doExport();setShowMenu(false);}},
                  {label:"Import JSON",  icon:"⬆",  fn:()=>{setShowImport(true);setShowMenu(false);}},
                  {label:"Sign Out",     icon:"⏏",  fn:()=>{setAuthUser(null);setShowMenu(false);}},
                ].map(x=>(
                  <button key={x.label} onClick={x.fn} style={{display:"flex",alignItems:"center",gap:9,width:"100%",padding:"9px 13px",background:"transparent",border:"none",borderBottom:"1px solid #1c2128",color:"#c9d1d9",fontSize:12,textAlign:"left"}}><span style={{fontSize:13}}>{x.icon}</span>{x.label}</button>
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
            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",padding:"7px 10px",background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}}>
              <span style={{fontSize:7,color:"#3a4050",fontFamily:"monospace",letterSpacing:"0.07em"}}>FILTER</span>
              <select value={gTicker} onChange={e=>setGTicker(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">All Tickers</option>{allTickers.map(t=><option key={t}>{t}</option>)}</select>
              <select value={gOptType} onChange={e=>setGOptType(e.target.value)} style={{width:78,fontSize:11,padding:"3px 5px"}}><option value="All">STO/BTO</option><option value="STO">STO</option><option value="BTO">BTO</option></select>
              <select value={gType} onChange={e=>setGType(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">Call/Put</option><option value="Call">Call</option><option value="Put">Put</option></select>
              {(gTicker!=="All"||gOptType!=="All"||gType!=="All") && <button onClick={()=>{setGTicker("All");setGOptType("All");setGType("All");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕</button>}
              <div style={{marginLeft:"auto",display:"flex",gap:3,alignItems:"center"}}>
                <span style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>PROFIT BY</span>
                {["exec","close"].map(m=>(
                  <button key={m} onClick={()=>setProfitDateMode(m)} style={{background:profitDateMode===m?"#00ff8814":"transparent",color:profitDateMode===m?"#00ff88":"#2a3040",border:profitDateMode===m?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace"}}>{m==="exec"?"Open Date":"Close Date"}</button>
                ))}
              </div>
            </div>
            {/* KPIs */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              <KPI label="Total Premium" value={f$0(totalPrem)}      sub={allF.length+" contracts"}/>
              <KPI label="Realized P/L"  value={fSign0(totalProfit)} sub={winRate+"% win"} color={totalProfit>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Open Exposure" value={f$0(openPrem)}       sub={openC.length+" open"} color="#ffd166"/>
              <KPI label="Committed Funds" value={f$0(committedFunds)} sub="STO Put × strike" color="#c084fc"/>
              <KPI label="Avg Profit"    value={fSign0(avgProfit)}    sub="per close" color={avgProfit>=0?"#58a6ff":"#ff4560"}/>
              <KPI label="Profit MTD"    value={fSign0(profitMTD)}    sub={mLabel+" · "+(profitDateMode==="exec"?"opened":"closed")} color={profitMTD>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Profit YTD"    value={fSign0(profitYTD)}    sub={thisYear+" · "+(profitDateMode==="exec"?"opened":"closed")} color={profitYTD>=0?"#00ff88":"#ff4560"}/>
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
                      <span style={{fontSize:8,color:"#3a4050",fontFamily:"monospace"}}>{label}</span>
                      <span style={{fontSize:8,color:reached?"#00ff88":"#555",fontFamily:"monospace"}}>{pct}%</span>
                    </div>
                    <div style={{height:5,background:"#0a0e14",borderRadius:3,overflow:"hidden",border:"1px solid #1c2128"}}>
                      <div style={{height:"100%",width:pct+"%",background:barColor,borderRadius:3,transition:"width .4s"}}/>
                    </div>
                    <div style={{fontSize:7,color:"#2a3040",fontFamily:"monospace",marginTop:2}}>{fSign0(current)} / {f$0(Math.abs(t))}</div>
                  </div>
                );
              };
              return (
                <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:7,color:"#2a3040",fontFamily:"monospace",letterSpacing:"0.07em",marginBottom:8}}>🎯 GOALS</div>
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
              <span style={{fontSize:8,color:"#3a4050",fontFamily:"monospace"}}>VIEW</span>
              {["daily","weekly","monthly"].map(v=>(
                <button key={v} onClick={()=>setChartView(v)} style={{background:chartView===v?"#00ff8814":"transparent",color:chartView===v?"#00ff88":"#2a3040",border:chartView===v?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 8px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
              ))}
              <span style={{fontSize:8,color:"#3a4050",fontFamily:"monospace",marginLeft:8}}>DATE</span>
              {["executed","closed"].map(v=>(
                <button key={v} onClick={()=>setChartDate(v)} style={{background:chartDate===v?"#58a6ff14":"transparent",color:chartDate===v?"#58a6ff":"#2a3040",border:chartDate===v?"1px solid #58a6ff25":"1px solid #1c2128",borderRadius:4,padding:"2px 8px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
              ))}
            </div>
            {/* Charts */}
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:8}}>
              <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:7}}>PREMIUM & PROFIT — {chartView.toUpperCase()} BY DATE {chartDate.toUpperCase()}</div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={chartData} barGap={2} barSize={chartView==="monthly"?20:chartView==="weekly"?12:6}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#0d1117" vertical={false}/>
                    <XAxis dataKey="label" tick={{fill:"#2a3040",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:"#2a3040",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false} tickFormatter={v=>"$"+(v/1000).toFixed(0)+"k"}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Bar dataKey="premium" name="Premium" fill="#58a6ff" radius={[2,2,0,0]} opacity={0.7}/>
                    <Bar dataKey="profit"  name="Profit"  radius={[2,2,0,0]}>{chartData.map((e,i)=><Cell key={i} fill={e.profit>=0?"#00ff88":"#ff4560"} opacity={0.8}/>)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:11}}>
                <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:7}}>CONTRACTS / PERIOD</div>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#0d1117" vertical={false}/>
                    <XAxis dataKey="label" tick={{fill:"#2a3040",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:"#2a3040",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Line type="monotone" dataKey="contracts" name="Contracts" stroke="#ffd166" strokeWidth={2} dot={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            {/* Open positions with ITM/OTM */}
            {openC.length>0 && (
              <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}}>
                <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>OPEN POSITIONS</div>
                <div className="ms">
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contract</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Type</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Strike</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Expires</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Acct</th>
                      <th style={{padding:"5px 8px",textAlign:"center",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>ITM/OTM</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Current $</th>
                    </tr></thead>
                    <tbody>
                      {openC.map(c => {
                        const itmStatus = getITMStatus(c);
                        return (
                          <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer",background:itmStatus==="ITM"?"#ff456005":itmStatus==="OTM"?"#00ff8803":"transparent"}} onClick={()=>setViewC(c)}>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:11}}>{fTitle(c)}</td>
                            <td style={{padding:"5px 8px"}}><Tag color={c.type==="Put"?"amber":"blue"}>{c.type}</Tag></td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${c.strike}</td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{c.qty}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#2a3040"}}>{c.expires||"—"}</td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(c.premium)}</td>
                            <td style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>
                            <td style={{padding:"5px 8px",textAlign:"center"}}>
                              {itmStatus ? <Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴 ITM":"🟢 OTM"}</Tag> : <span style={{color:"#2a3040",fontSize:10,fontFamily:"monospace"}}>—</span>}
                            </td>
                            <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#888",fontSize:10}} onClick={e=>e.stopPropagation()}>
                              <input type="number" defaultValue={c.currentPrice||""} placeholder="—" onBlur={e=>updatePrice(c.id,e.target.value)}
                                style={{width:70,padding:"2px 4px",fontSize:10,background:"transparent",border:"1px solid #21262d",textAlign:"right"}}/>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
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
                <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:"10px 13px"}}>
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
                          <span style={{fontSize:10,color:"#c9d1d9",fontFamily:"monospace"}}>{i+1}. {c.stock}</span>
                          <span style={{fontSize:10,color:"#00ff88",fontFamily:"monospace",fontWeight:700}}>{fSign0(c.profit)}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{fontSize:7,color:"#ff4560",fontFamily:"monospace",marginBottom:5}}>BOTTOM 2</div>
                      {bot2.filter(c=>c.profit<0).map((c,i)=>(
                        <div key={c.id} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #0d1117"}}>
                          <span style={{fontSize:10,color:"#c9d1d9",fontFamily:"monospace"}}>{i+1}. {c.stock}</span>
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
                ⚡ First run — import <strong>pri_history_386.json</strong> via ☰ → Import JSON to load all historical contracts.
              </div>
            )}
          </div>
        )}

        {/* ══ CONTRACTS ══ */}
        {tab==="contracts" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            <div style={{display:"flex",gap:7,flexWrap:"wrap",alignItems:"center"}}>
              <button onClick={()=>{setForm({...EMPTY_NEW,dateExec:TODAY});setEditing(null);setFormMode("new");setShowForm(p=>formMode==="new"?!p:true);}} style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:6,padding:"7px 13px",fontSize:11,fontFamily:"monospace",fontWeight:700}}>+ New Contract</button>
              <button onClick={()=>setShowColPicker(true)} style={{background:"transparent",color:"#3a4050",border:"1px solid #1c2128",borderRadius:6,padding:"7px 10px",fontSize:10,fontFamily:"monospace"}}>⠿ Columns</button>
              <button onClick={doExportCSV} style={{background:"transparent",color:"#3a4050",border:"1px solid #1c2128",borderRadius:6,padding:"7px 10px",fontSize:10,fontFamily:"monospace"}} title={`Export ${sortedFiltered.length} filtered rows to CSV`}>↓ CSV ({sortedFiltered.length})</button>
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
            </div>

            {/* New contract form */}
            {showForm && formMode==="new" && (
              <div style={{background:"#0a0e14",border:"1px solid #00ff8825",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:"#00ff88"}}/>
                  <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em"}}>{editing?"EDIT CONTRACT":"NEW CONTRACT"}</span>
                  <span style={{fontSize:9,color:"#3a4050",fontFamily:"monospace",marginLeft:4}}>* required</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(125px,1fr))",gap:7}}>
                  <div><FL req>Ticker</FL><input type="text" value={form.stock||""} autoComplete="off" spellCheck="false" className={formErrors.stock?"err":""} style={{textTransform:"uppercase"}} onChange={e=>{const t=e.target.value.toUpperCase();const d=tickerDefaults(t);setForm(p=>({...p,stock:t,expires:nextExpiry(t)||p.expires||"",account:d.account||p.account||"",qty:d.qty||p.qty||""}));}} placeholder=""/></div>
                  <div><FL req>Option Type</FL><select value={form.type} onChange={e=>sf("type",e.target.value)} className={formErrors.type?"err":""}><option>Call</option><option>Put</option></select></div>
                  <div><FL req>Opt Type</FL><select value={form.optType} onChange={e=>sf("optType",e.target.value)} className={formErrors.optType?"err":""}><option>STO</option><option>BTO</option></select></div>
                  <div><FL req>Strike</FL><input type="number" value={form.strike} onChange={e=>sf("strike",e.target.value)} className={formErrors.strike?"err":""}/></div>
                  <div><FL req>Quantity</FL><input type="number" value={form.qty} onChange={e=>sf("qty",e.target.value)} className={formErrors.qty?"err":""}/></div>
                  <div><FL req>Premium $</FL><input type="number" value={form.premium} onChange={e=>sf("premium",e.target.value)} className={formErrors.premium?"err":""}/></div>
                  <div><FL>Price @ Exec $</FL><input type="number" value={form.priceAtExecution||""} onChange={e=>sf("priceAtExecution",e.target.value)}/></div>
                  <div><FL req>Date Executed</FL><input type="date" value={form.dateExec} onChange={e=>sf("dateExec",e.target.value)} className={formErrors.dateExec?"err":""}/></div>
                  <div>
                    <FL req>Expires</FL>
                    <input type="date" value={form.expires||""} onChange={e=>sf("expires",e.target.value)} className={formErrors.expires?"err":""}/>
                    {form.stock && EXPIRY_SCHEDULES[form.stock.toUpperCase()] && <div style={{fontSize:7,color:"#2a3040",marginTop:1,fontFamily:"monospace"}}>{EXPIRY_SCHEDULES[form.stock.toUpperCase()].join("/")}</div>}
                  </div>
                  <div><FL req>Account</FL><select value={form.account||""} onChange={e=>sf("account",e.target.value)} className={formErrors.account?"err":""}><option value="">—</option><option>Schwab</option><option>Etrade</option></select></div>
                  <div><FL>Strategy</FL><select value={form.strategy||""} onChange={e=>sf("strategy",e.target.value)}><option value="">— none —</option>{strategies.map(s=><option key={s.id} value={s.name}>{s.name}</option>)}</select></div>
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
                  <button onClick={saveNew} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>{editing?"UPDATE":"SAVE OPEN"}</button>
                  <button onClick={()=>{setShowForm(false);setEditing(null);setForm({...EMPTY_NEW});setFormErrors({});}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}

            {/* Close form */}
            {showForm && formMode==="close" && (() => {
              const orig = contracts.find(c=>c.id===closingId);
              const ctc = +closeForm.costToClose||0;
              const isBTO = orig?.optType === "BTO";
              const ep  = orig ? (isBTO ? +(ctc - Math.abs(orig.premium)).toFixed(2) : +(orig.premium - ctc).toFixed(2)) : null;
              const basis = orig ? Math.abs(orig.premium) : 0;
              const epct = basis > 0 ? (ep/basis*100).toFixed(1) : null;
              const ed  = orig&&closeForm.closeDate ? Math.round((new Date(closeForm.closeDate)-new Date(orig.dateExec))/86400000) : null;
              const closeLabel = isBTO ? "STC (Sell to Close)" : "BTC (Buy to Close)";
              return (
                <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:"#ffd166"}}/>
                    <span style={{fontFamily:"monospace",fontSize:10,color:"#ffd166",letterSpacing:"0.07em"}}>CLOSE CONTRACT — {closeLabel}</span>
                    {orig && <span style={{fontSize:10,color:"#555",fontFamily:"monospace"}}>{fTitle(orig)} — opened at <span style={{color:"#58a6ff"}}>{fMoney(orig.premium)}</span></span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(135px,1fr))",gap:7,marginBottom:9}}>
                    {orig && orig.qty > 1 && <div><FL>Qty to Close (of {orig.qty})</FL><input type="number" min={1} max={orig.qty} value={closeForm.qtyToClose||orig.qty} onChange={e=>setCloseForm(p=>({...p,qtyToClose:Math.min(orig.qty,Math.max(1,+e.target.value||1))}))} /></div>}
                    <div><FL>Cost to Close $</FL><input type="number" value={closeForm.costToClose} onChange={e=>setCloseForm(p=>({...p,costToClose:e.target.value}))}/></div>
                    <div><FL>Date Closed</FL><input type="date" value={closeForm.closeDate} onChange={e=>setCloseForm(p=>({...p,closeDate:e.target.value}))}/></div>
                    <div><FL>Exercised?</FL><select value={closeForm.exercised} onChange={e=>setCloseForm(p=>({...p,exercised:e.target.value}))}><option>No</option><option>Yes</option></select></div>
                    <div><FL>Rolled Over?</FL><select value={closeForm.rolledOver} onChange={e=>setCloseForm(p=>({...p,rolledOver:e.target.value}))}><option>No</option><option>Yes</option></select></div>
                  </div>
                  <div style={{marginBottom:9}}><FL>Notes</FL><textarea rows={2} value={closeForm.notes||""} onChange={e=>setCloseForm(p=>({...p,notes:e.target.value}))} style={{resize:"vertical"}}/></div>
                  {orig && ctc>0 && (
                    <div style={{display:"flex",gap:14,padding:"7px 11px",background:"#080c12",borderRadius:6,marginBottom:9,fontFamily:"monospace",fontSize:11}}>
                      <span style={{color:"#555"}}>Profit: <span style={{color:ep>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(ep)}</span></span>
                      <span style={{color:"#555"}}>Return: <span style={{color:ep>=0?"#00ff88":"#ff4560",fontWeight:700}}>{epct}%</span></span>
                      {ed!=null && <span style={{color:"#555"}}>Days: <span style={{color:"#888"}}>{ed}</span></span>}
                      <span style={{fontSize:16}}>{ep>=0?"🪙":"📉"}</span>
                    </div>
                  )}
                  <div style={{display:"flex",gap:7}}>
                    <button onClick={saveClose} style={{background:"#ffd166",color:"#010409",border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>CLOSE CONTRACT</button>
                    <button onClick={()=>{setShowForm(false);setClosingId(null);setCloseForm({...EMPTY_CLOSE});}} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 13px",fontSize:11}}>Cancel</button>
                  </div>
                </div>
              );
            })()}

            {/* Table filters */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              <select value={fStatus} onChange={e=>setFStatus(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">All</option><option value="Open">Open</option><option value="Closed">Closed</option></select>
              <select value={fAcct} onChange={e=>setFAcct(e.target.value)} style={{width:100,fontSize:11,padding:"3px 5px"}}><option value="All">All Accounts</option><option>Schwab</option><option>Etrade</option></select>
              <input type="text" placeholder="Search…" value={fSearch} onChange={e=>setFSearch(e.target.value)} style={{width:100,fontSize:11,padding:"3px 5px"}}/>
              <input type="date" value={fDateFrom} onChange={e=>setFDateFrom(e.target.value)} style={{width:120,fontSize:11,padding:"3px 5px"}} title="From date"/>
              <input type="date" value={fDateTo}   onChange={e=>setFDateTo(e.target.value)}   style={{width:120,fontSize:11,padding:"3px 5px"}} title="To date"/>
              {(fDateFrom||fDateTo) && <button onClick={()=>{setFDateFrom("");setFDateTo("");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕ dates</button>}
              <button onClick={()=>setFOriginals(p=>!p)}
                style={{background:fOriginals?"#00ff8814":"#58a6ff14",color:fOriginals?"#00ff88":"#58a6ff",border:`1px solid ${fOriginals?"#00ff8830":"#58a6ff30"}`,borderRadius:4,padding:"3px 8px",fontSize:9,fontFamily:"monospace",whiteSpace:"nowrap"}}>
                {fOriginals?"Originals only":"All records"}
              </button>
              <span style={{fontSize:9,color:"#3a4050",fontFamily:"monospace"}}>{sortedFiltered.length} rows</span>
            </div>

            {/* Contracts table */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}} className="ms">
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead>
                  <tr>
                    {cols.filter(c=>c.show).map(col => (
                      <th key={col.key} className={col.sortKey?"thsort":""} onClick={()=>col.sortKey&&toggleSort(col.sortKey)}
                        style={{padding:"6px 8px",textAlign:col.right?"right":"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,letterSpacing:"0.04em",fontWeight:500,whiteSpace:"nowrap",borderBottom:"1px solid #1c2128",userSelect:"none"}}>
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
                            case "ticker":  return <td key="ticker" className="sticky-col" style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:c.parentId?"#58a6ff":"#e6edf3",fontSize:12}}>{c.stock||"—"}{c.parentId&&<span style={{fontSize:7,color:"#58a6ff",marginLeft:2}}>BTC</span>}</td>;
                            case "contract":return <td key="contract" style={{padding:"5px 8px",fontFamily:"monospace",color:"#8b949e",fontSize:10,whiteSpace:"nowrap"}}>{fTitle(c)}</td>;
                            case "optType": return <td key="optType" style={{padding:"5px 8px"}}><Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":c.optType==="STC"?"blue":c.optType==="BTO"?"purple":"gray"}>{c.optType}</Tag></td>;
                            case "strike":  return <td key="strike" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${c.strike}</td>;
                            case "qty":     return <td key="qty" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#c9d1d9",fontWeight:600}}>{c.qty}</td>;
                            case "expires": return <td key="expires" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#c9d1d9"}}>{c.expires||"—"}</td>;
                            case "dateExec":return <td key="dateExec" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#1c2128"}}>{c.dateExec||"—"}</td>;
                            case "premium":     return <td key="premium" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:c.premium<0?"#ff4560":"#58a6ff"}}>{fMoney(c.premium)}</td>;
                            case "costToClose": return <td key="costToClose" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{c.costToClose!=null?fMoney(c.costToClose):"—"}</td>;
                            case "closeDate":   return <td key="closeDate" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#555"}}>{c.closeDate||"—"}</td>;
                            case "profit":  return <td key="profit" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>{c.profit!=null?<span style={{color:c.profit>=0?"#00ff88":"#ff4560"}}>{fSign(c.profit)}</span>:<span style={{color:"#1c2128"}}>—</span>}</td>;
                            case "profitPct": return <td key="profitPct" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>{c.profitPct!=null?<span style={{color:c.profitPct>=0?"#00ff88":"#ff4560"}}>{(c.profitPct*100).toFixed(1)}%</span>:<span style={{color:"#1c2128"}}>—</span>}</td>;
                            case "daysHeld": return <td key="daysHeld" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555",fontSize:11}}>{c.daysHeld!=null?c.daysHeld:"—"}</td>;
                            case "account": return <td key="account" style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>;
                            case "status":  return <td key="status" style={{padding:"5px 8px"}}><Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag></td>;
                            case "itmotm":  return <td key="itmotm" style={{padding:"5px 8px",textAlign:"center"}}>{c.status==="Open"&&itmStatus?<Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴":"🟢"}</Tag>:<span style={{color:"#1c2128",fontSize:10}}>—</span>}</td>;
                            case "otmPct":  return <td key="otmPct" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:bd?bd.bandColor:"#555"}}>{bd?bd.otmPct.toFixed(2)+"%":"—"}</td>;
                            case "band":    return <td key="band" style={{padding:"5px 8px"}}>{bd?<span style={{fontSize:9,fontFamily:"monospace",background:bd.bandColor+"22",color:bd.bandColor,border:`1px solid ${bd.bandColor}40`,borderRadius:3,padding:"1px 5px"}}>{bd.bandLabel}</span>:<span style={{color:"#1c2128",fontSize:10}}>—</span>}</td>;
                            case "tgtPerShare": return <td key="tgtPerShare" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88",fontWeight:700}}>{bd?"$"+bd.targetPerShare.toFixed(2):"—"}</td>;
                            case "tgtClose": return <td key="tgtClose" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88"}}>{bd?f$(bd.targetClose):"—"}</td>;
                            case "liveStockPrice": {
                              if (c.status!=="Open") return <td key="liveStockPrice" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const sq = c.stock ? stocksData[c.stock.toUpperCase()] : null;
                              return <td key="liveStockPrice" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:sq?.lastQuoteAt?"#e6edf3":"#555"}}>
                                {sq?.currentPrice ? f$(sq.currentPrice) : "—"}
                                {sq?.lastQuoteAt && <span style={{fontSize:7,color:"#00ff8870",marginLeft:3}}>●</span>}
                              </td>;
                            }
                            case "liveChange": {
                              if (c.status!=="Open") return <td key="liveChange" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
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
                              if (c.status!=="Open") return <td key="liveBid" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveBid" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.bid!=null?"#00ff88":"#555"}}>
                                {lo?.bid!=null ? f$(lo.bid) : "—"}
                              </td>;
                            }
                            case "liveAsk": {
                              if (c.status!=="Open") return <td key="liveAsk" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveAsk" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.ask!=null?"#58a6ff":"#555"}}>
                                {lo?.ask!=null ? f$(lo.ask) : "—"}
                              </td>;
                            }
                            case "liveLast": {
                              if (c.status!=="Open") return <td key="liveLast" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              return <td key="liveLast" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:lo?.last!=null?"#c9d1d9":"#555"}}>
                                {lo?.last!=null ? f$(lo.last) : "—"}
                              </td>;
                            }
                            case "mktValue": {
                              // Mkt Value = qty * last option price * 100
                              if (c.status!=="Open") return <td key="mktValue" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const last = lo?.last ?? lo?.bid ?? null;
                              const mv = last != null ? (c.qty||1) * last * 100 : null;
                              return <td key="mktValue" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:mv!=null?"#c9d1d9":"#555"}}>
                                {mv!=null ? f$(mv) : "—"}
                              </td>;
                            }
                            case "liveGain": {
                              // Gain$ = Premium received - current market value
                              // For STO Call/Put: gain = premium - mktValue (positive = good, option lost value)
                              // For BTO: gain = mktValue - premium (positive = good, option gained value)
                              if (c.status!=="Open") return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const last = lo?.last ?? lo?.bid ?? null;
                              if (last == null || c.premium == null) return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",color:"#555",fontFamily:"monospace"}}>—</td>;
                              const mv   = (c.qty||1) * last * 100;
                              const prem = Math.abs(c.premium);
                              const gain = c.optType==="BTO" ? mv - prem : prem - mv;
                              return <td key="liveGain" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,fontWeight:700,color:gain>=0?"#00ff88":"#ff4560"}}>
                                {gain>=0?"+":""}{f$(gain)}
                              </td>;
                            }
                            case "liveGainPct": {
                              if (c.status!=="Open") return <td key="liveGainPct" style={{padding:"5px 8px",textAlign:"right",color:"#1c2128",fontFamily:"monospace"}}>—</td>;
                              const lo = getLiveOption(c);
                              const last = lo?.last ?? lo?.bid ?? null;
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
                              const last = lo?.last ?? lo?.bid ?? null;
                              if (!bd || last == null || !c.premium) return <td key="signal" style={{padding:"5px 8px",color:"#1c2128",fontSize:10,fontFamily:"monospace"}}>—</td>;
                              const mv      = (c.qty||1) * last * 100;
                              const prem    = Math.abs(c.premium);
                              const gain    = c.optType==="BTO" ? mv - prem : prem - mv;
                              const gainPct = prem > 0 ? (gain/prem)*100 : 0;
                              const target  = bd.targetClose;
                              let label, color, bg;
                              if (gain >= target) {
                                label = "Close Now"; color = "#00ff88"; bg = "#00ff8820";
                              } else if (gainPct >= 90 && c.qty > 1) {
                                const perC = prem/(c.qty||1), gainPerU = gain/(c.qty||1);
                                const pq   = gainPerU > 0 ? Math.ceil(perC/gainPerU) : null;
                                label = pq ? "Sell "+pq+" of "+c.qty : "Partial Close";
                                color = "#ffd166"; bg = "#ffd16620";
                              } else if (gain >= target * 0.75) {
                                label = "Approaching"; color = "#58a6ff"; bg = "#58a6ff20";
                              } else {
                                return <td key="signal" style={{padding:"5px 8px",color:"#2a3040",fontSize:9,fontFamily:"monospace"}}>hold</td>;
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
                  {sortedFiltered.length===0 && <tr><td colSpan={cols.filter(c=>c.show).length} style={{padding:22,textAlign:"center",color:"#3a4050",fontSize:11,fontFamily:"monospace"}}>No contracts match filters</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══ ANALYTICS ══ */}
        {tab==="analytics" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Search filter */}
            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",padding:"7px 10px",background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}}>
              <span style={{fontSize:7,color:"#3a4050",fontFamily:"monospace",letterSpacing:"0.07em"}}>SEARCH FILTER</span>
              <select value={gTicker} onChange={e=>setGTicker(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">All Tickers</option>{allTickers.map(t=><option key={t}>{t}</option>)}</select>
              <select value={gOptType} onChange={e=>setGOptType(e.target.value)} style={{width:78,fontSize:11,padding:"3px 5px"}}><option value="All">STO/BTO</option><option value="STO">STO</option><option value="BTO">BTO</option></select>
              <select value={gType} onChange={e=>setGType(e.target.value)} style={{width:85,fontSize:11,padding:"3px 5px"}}><option value="All">Call/Put</option><option value="Call">Call</option><option value="Put">Put</option></select>
              {(gTicker!=="All"||gOptType!=="All"||gType!=="All") && <button onClick={()=>{setGTicker("All");setGOptType("All");setGType("All");}} style={{background:"#ff456018",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 7px",fontSize:9,fontFamily:"monospace"}}>✕</button>}
              <div style={{marginLeft:"auto",display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",gap:3}}>
                  <span style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>PROFIT BY</span>
                  {["exec","close"].map(m=>(
                    <button key={m} onClick={()=>setProfitDateMode(m)} style={{background:profitDateMode===m?"#00ff8814":"transparent",color:profitDateMode===m?"#00ff88":"#2a3040",border:profitDateMode===m?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace"}}>{m==="exec"?"Open Date":"Close Date"}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:3}}>
                  {["daily","weekly","monthly"].map(v=>(
                    <button key={v} onClick={()=>setAnalyticsView(v)} style={{background:analyticsView===v?"#00ff8814":"transparent",color:analyticsView===v?"#00ff88":"#2a3040",border:analyticsView===v?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Period breakdown with notes */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}} className="ms">
              <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>{analyticsView.toUpperCase()} BREAKDOWN — profit by {profitDateMode==="exec"?"open date":"close date"}</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>
                  <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Period</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Profit</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Margin</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contracts</th>
                  {analyticsView!=="daily" && <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Notes</th>}
                </tr></thead>
                <tbody>
                  {[...periodData].reverse().map((m,i) => {
                    const pp = m.premium>0 ? m.profit/m.premium : 0;
                    const note = periodNotes[m.key] || "";
                    return (
                      <tr key={i} className="rh" style={{borderTop:"1px solid #0d1117"}}>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",color:"#c9d1d9",fontSize:12}}>{m.label}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(m.premium)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:m.profit>=0?"#00ff88":"#ff4560"}}>{fSign(m.profit)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:pp<0?"#ff4560":pp>=0.6?"#00ff88":pp>=0.3?"#ffd166":"#58a6ff"}}>{(pp*100).toFixed(1)}%</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{m.contracts}</td>
                        {analyticsView!=="daily" && (
                          <td style={{padding:"5px 8px",minWidth:180}} onClick={e=>e.stopPropagation()}>
                            {editingNote===m.key ? (
                              <input type="text" defaultValue={note} autoFocus
                                onBlur={e=>{const n={...periodNotes,[m.key]:e.target.value};persistNotes(n);setEditingNote(null);}}
                                onKeyDown={e=>{if(e.key==="Enter"||e.key==="Escape"){const n={...periodNotes,[m.key]:e.target.value};persistNotes(n);setEditingNote(null);}}}
                                style={{fontSize:10,padding:"2px 5px"}}/>
                            ) : (
                              <span onClick={()=>setEditingNote(m.key)} style={{fontSize:10,color:note?"#888":"#2a3040",fontStyle:note?"normal":"italic",cursor:"pointer"}}>
                                {note||"+ add note"}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {periodData.length===0 && <tr><td colSpan={analyticsView!=="daily"?6:5} style={{padding:18,textAlign:"center",color:"#3a4050",fontSize:11,fontFamily:"monospace"}}>No data — import history first</td></tr>}
                </tbody>
              </table>
            </div>

            {/* Account + Call/Put breakdown */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
              {["Schwab","Etrade"].map(acct=>{
                const ac=allF.filter(c=>c.account===acct);
                const acp=ac.filter(c=>c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
                return(<div key={acct} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:acct==="Schwab"?"#58a6ff":"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>{acct.toUpperCase()}</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>PREMIUM</div><div style={{fontSize:14,fontFamily:"monospace",color:"#58a6ff",fontWeight:700}}>{f$(ac.reduce((s,c)=>s+(c.premium||0),0))}</div></div>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>PROFIT</div><div style={{fontSize:14,fontFamily:"monospace",color:acp>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(acp)}</div></div>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>COUNT</div><div style={{fontSize:14,fontFamily:"monospace",color:"#e6edf3",fontWeight:700}}>{ac.length}</div></div>
                  </div>
                </div>);
              })}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
              {["Call","Put"].map(t=>{
                const tc=allF.filter(c=>c.type===t);
                const tcp=tc.filter(c=>c.status==="Closed").reduce((s,c)=>s+(c.profit||0),0);
                return(<div key={t} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12}}>
                  <div style={{fontFamily:"monospace",fontSize:8,color:t==="Call"?"#58a6ff":"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>{t.toUpperCase()}S</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>COUNT</div><div style={{fontSize:14,fontFamily:"monospace",color:"#e6edf3",fontWeight:700}}>{tc.length}</div></div>
                    <div><div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace"}}>PROFIT</div><div style={{fontSize:14,fontFamily:"monospace",color:tcp>=0?"#00ff88":"#ff4560",fontWeight:700}}>{fSign(tcp)}</div></div>
                  </div>
                </div>);
              })}
            </div>

            {/* ── AI ASSISTANT (inline in Analytics) ── */}
            <div style={{background:"#0a0e14",border:"1px solid #c084fc25",borderRadius:8,display:"flex",flexDirection:"column",overflow:"hidden"}}>
              {/* Header */}
              <div style={{padding:"10px 14px",borderBottom:"1px solid #1c2128",display:"flex",alignItems:"center",gap:9}}>
                <div style={{width:24,height:24,borderRadius:6,background:"linear-gradient(135deg,#1a0a1f,#0d1f12)",border:"1px solid #c084fc30",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>🤖</div>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"monospace",fontSize:10,color:"#c084fc",letterSpacing:"0.06em"}}>AI ASSISTANT</div>
                  <div style={{fontSize:8,color:"#3a4050",fontFamily:"monospace"}}>Ask questions about your trading data</div>
                </div>
                {aiMessages.length>0 && (
                  <button onClick={async()=>{setAiMessages([]);try{await supabase.from("ai_chats").delete().neq("id",0);}catch{}}} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:4,padding:"3px 8px",fontSize:8,color:"#555",fontFamily:"monospace",cursor:"pointer"}}>Clear</button>
                )}
              </div>
              {/* Suggestions */}
              {aiMessages.length===0 && (
                <div style={{padding:"10px 14px",borderBottom:"1px solid #0d1117"}}>
                  <div style={{fontSize:8,color:"#2a3040",fontFamily:"monospace",marginBottom:7,letterSpacing:"0.06em"}}>SUGGESTED QUESTIONS</div>
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
                        style={{maxWidth:"85%",background:m.role==="user"?"#1a2030":"#080c12",border:`1px solid ${m.role==="user"?"#58a6ff30":m.starred?"#ffd16660":"#21262d"}`,borderRadius:8,padding:"8px 11px",fontSize:12,color:m.role==="user"?"#58a6ff":"#c9d1d9",fontFamily:m.role==="assistant"?"monospace":"inherit",lineHeight:1.6,whiteSpace:"pre-wrap",cursor:m.role==="assistant"?"pointer":"default"}}
                        title={m.role==="assistant"?"Click to copy":""}
                      >
                        {m.content}
                      </div>
                      {m.role==="assistant" && (
                        <div style={{display:"flex",gap:8,alignItems:"center",paddingLeft:2}}>
                          <span style={{fontSize:9,color:m.copied?"#00ff88":"#3a4050",fontFamily:"monospace",transition:"color .2s"}}>{m.copied?"✓ copied":"⎘ click to copy"}</span>
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
                      <span style={{fontSize:10,color:"#3a4050",fontFamily:"monospace"}}>Analyzing your data…</span>
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
                <button onClick={sendAI} disabled={aiLoading||!aiInput.trim()} style={{background:"#c084fc",color:"#010409",border:"none",borderRadius:6,padding:"8px 14px",fontSize:11,fontWeight:700,fontFamily:"monospace",opacity:aiLoading||!aiInput.trim()?0.5:1,cursor:aiLoading||!aiInput.trim()?"default":"pointer"}}>Ask</button>
              </div>
            </div>
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
              <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
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
                  }} style={{background:"#ffd166",color:"#010409",border:"none",borderRadius:6,padding:"7px 18px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                  <button onClick={()=>setStratForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}

            {/* Strategy cards with stats */}
            {strategies.length===0 && !stratForm && (
              <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:24,textAlign:"center",color:"#3a4050",fontSize:11,fontFamily:"monospace"}}>
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
                <div key={s.id} style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div>
                      <div style={{fontFamily:"monospace",fontWeight:700,color:"#ffd166",fontSize:14}}>{s.name}</div>
                      {s.description && <div style={{fontSize:11,color:"#8b949e",marginTop:2}}>{s.description}</div>}
                    </div>
                    <div style={{display:"flex",gap:5}}>
                      <button onClick={()=>setStratForm({...s})} style={{background:"transparent",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:4,padding:"3px 10px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Edit</button>
                      <button onClick={async()=>{if(!window.confirm("Delete "+s.name+"?"))return;await supabase.from("strategies").delete().eq("id",s.id);setStrategies(p=>p.filter(x=>x.id!==s.id));}} style={{background:"transparent",color:"#ff4560",border:"1px solid #ff456030",borderRadius:4,padding:"3px 10px",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>Delete</button>
                    </div>
                  </div>
                  {/* Stats row */}
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:s.rules?10:0}}>
                    {[
                      {label:"Contracts", value:sc.length, color:"#e6edf3"},
                      {label:"Open",      value:scOpen.length, color:"#ffd166"},
                      {label:"Closed",    value:scClosed.length, color:"#555"},
                      {label:"Win Rate",  value:winRate!=null?winRate+"%":"—", color:winRate>=60?"#00ff88":winRate>=40?"#ffd166":"#ff4560"},
                      {label:"Total Profit", value:fSign0(totalProfit), color:totalProfit>=0?"#00ff88":"#ff4560"},
                      {label:"Total Premium", value:f$0(totalPremium), color:"#58a6ff"},
                      {label:"Avg Profit", value:avgProfit!=null?fSign(+avgProfit):"—", color:+avgProfit>=0?"#00ff88":"#ff4560"},
                      {label:"Avg Days",  value:avgDays!=null?avgDays+"d":"—", color:"#555"},
                    ].map(({label,value,color})=>(
                      <div key={label} style={{background:"#080c12",border:"1px solid #1c2128",borderRadius:6,padding:"6px 10px",minWidth:80}}>
                        <div style={{fontSize:7,color:"#3a4050",fontFamily:"monospace",marginBottom:2,textTransform:"uppercase"}}>{label}</div>
                        <div style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {s.rules && <div style={{fontSize:10,color:"#555",fontFamily:"monospace",whiteSpace:"pre-wrap",borderTop:"1px solid #1c2128",paddingTop:8,marginTop:4}}>{s.rules}</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* ══ PLAN ══ */}
        {tab==="plan" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Ticker cards */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:11}}>
              <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:9}}>TICKER CARDS — tap to add to plan</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {knownTickers.map(t=>{
                  const sd = stocksData[t.ticker] || {};
                  const sharesOwned = (sd.schwabShares||0) + (sd.etradeShares||0);
                  const hasOpenCall = openC.some(c=>c.stock?.toUpperCase()===t.ticker&&c.type==="Call");
                  const isOwned = sharesOwned > 0;
                  const borderColor = isOwned && !hasOpenCall ? "#00ff88" : isOwned && hasOpenCall ? "#ffd166" : "#21262d";
                  const bg = isOwned && !hasOpenCall ? "#00ff8808" : isOwned && hasOpenCall ? "#ffd16608" : "#080c12";
                  return (
                    <button key={t.ticker} onClick={()=>openPlanForm(t.ticker)}
                      title={isOwned?`${sharesOwned} shares owned${hasOpenCall?" · covered call outstanding":""}` : ""}
                      style={{background:bg,border:`1px solid ${borderColor}`,borderRadius:5,padding:"3px 7px",cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                      <span style={{fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:11}}>{t.ticker}</span>
                      {t.open>0 && <span style={{background:"#00ff8820",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:8,fontSize:8,fontFamily:"monospace",padding:"0 3px"}}>{t.open}</span>}
                      {isOwned && !hasOpenCall && (<span style={{fontSize:8,color:"#00ff88",fontFamily:"monospace"}}>CC</span>)}
                      {isOwned && hasOpenCall  && (<span style={{fontSize:8,color:"#ffd166",fontFamily:"monospace"}}>★</span>)}
                    </button>
                  );
                })}
                {knownTickers.length===0 && <span style={{color:"#2a3040",fontSize:10,fontFamily:"monospace"}}>Import history to see tickers</span>}
              </div>
              <div style={{display:"flex",gap:10,marginTop:7,flexWrap:"wrap"}}>
                <span style={{fontSize:8,color:"#3a4050",fontFamily:"monospace"}}>Legend:</span>
                <span style={{fontSize:8,color:"#00ff88",fontFamily:"monospace"}}>■ CC = shares owned, no open call (available for covered call)</span>
                <span style={{fontSize:8,color:"#ffd166",fontFamily:"monospace"}}>■ ★ = shares owned + open call outstanding</span>
                <span style={{fontSize:8,color:"#555",fontFamily:"monospace"}}>■ no color = no shares tracked</span>
              </div>
              {/* Add any ticker to plan */}
              <div style={{marginTop:9,display:"flex",gap:6,alignItems:"center"}}>
                <input type="text" placeholder="Add any ticker…" id="planFreeTicker"
                  style={{width:110,fontSize:11,padding:"4px 7px",textTransform:"uppercase"}}
                  onKeyDown={e=>{if(e.key==="Enter"&&e.target.value.trim()){openPlanForm(e.target.value.trim().toUpperCase());e.target.value="";}}}/>
                <button onClick={()=>{const el=document.getElementById("planFreeTicker");if(el?.value.trim()){openPlanForm(el.value.trim().toUpperCase());el.value="";}}}
                  style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:5,padding:"4px 10px",fontSize:10,fontFamily:"monospace"}}>+ Plan</button>
                <span style={{fontSize:8,color:"#2a3040",fontFamily:"monospace"}}>any ticker, even if not in history</span>
              </div>
            </div>

            {/* Expiring today */}
            {expToday.length>0 && (
              <div style={{background:"#ff456008",border:"1px solid #ff456030",borderRadius:8,padding:"7px 11px"}}>
                <div style={{fontFamily:"monospace",fontSize:7,color:"#ff4560",letterSpacing:"0.08em",marginBottom:7}}>⚡ EXPIRING TODAY</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {expToday.map(c=><div key={c.id} style={{background:"#ff456010",border:"1px solid #ff456025",borderRadius:5,padding:"4px 9px",fontFamily:"monospace",fontSize:10}}><span style={{color:"#e6edf3",fontWeight:700}}>{fTitle(c)}</span></div>)}
                </div>
              </div>
            )}

            {/* Open contracts */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}}>
              <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>OPEN CONTRACTS</div>
              <div className="ms">
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr>
                    <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contract</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                    <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Expires</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>OTM %</th>
                    <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Band</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Tgt %</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>$/share</th>
                    <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Tgt Close</th>
                    <th style={{padding:"5px 8px",textAlign:"center",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>ITM/OTM</th>
                    <th style={{padding:"5px 8px",borderBottom:"1px solid #1c2128",width:60}}></th>
                  </tr></thead>
                  <tbody>
                    {planOpen.map(c=>{
                      const itmStatus=getITMStatus(c);
                      const bd=getContractBand(c);
                      return(
                      <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",background:c.expires===planToday?"#ff456005":itmStatus==="ITM"?"#ff456003":itmStatus==="OTM"?"#00ff8803":"transparent"}}>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:11}}>{fTitle(c)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{c.qty}</td>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:c.expires===planToday?"#ff4560":"#2a3040"}}>{c.expires||"—"}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(c.premium)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:bd?bd.bandColor:"#555"}}>{bd?bd.otmPct.toFixed(2)+"%":"—"}</td>
                        <td style={{padding:"5px 8px"}}>{bd?<span style={{fontSize:9,fontFamily:"monospace",background:bd.bandColor+"22",color:bd.bandColor,border:`1px solid ${bd.bandColor}40`,borderRadius:3,padding:"1px 5px"}}>{bd.bandLabel}</span>:<span style={{color:"#2a3040",fontSize:10}}>—</span>}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:bd?bd.bandColor:"#555"}}>{bd?bd.tgtPct+"%":"—"}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88",fontWeight:700}}>{bd?"$"+bd.targetPerShare.toFixed(2):"—"}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88"}}>{bd?f$(bd.targetClose):"—"}</td>
                        <td style={{padding:"5px 8px",textAlign:"center"}}>{itmStatus?<Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴":"🟢"}</Tag>:<span style={{color:"#2a3040",fontSize:10}}>—</span>}</td>
                        <td style={{padding:"5px 8px"}}>
                          <button onClick={()=>openPlanForm(c.stock||"",{action:"BTC",qty:c.qty,strike:c.strike,expiration:c.expires,account:c.account})} style={{background:"#58a6ff18",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:3,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>+ Add</button>
                        </td>
                      </tr>
                    );})}
                    {planOpen.length===0 && <tr><td colSpan={11} style={{padding:18,textAlign:"center",color:"#3a4050",fontSize:10,fontFamily:"monospace"}}>No open contracts</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Plan form */}
            {planForm && (
              <div style={{background:"#0a0e14",border:"1px solid #00ff8825",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:"#00ff88"}}/>
                  <span style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",letterSpacing:"0.07em"}}>PLAN — {planForm.ticker}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(115px,1fr))",gap:7,marginBottom:7}}>
                  <div><FL>Action</FL><select value={planForm.action} onChange={e=>pf("action",e.target.value)}><option>STO</option><option>BTO</option><option>BTC</option><option>STC</option></select></div>
                  <div><FL>Type</FL><select value={planForm.type||"Call"} onChange={e=>pf("type",e.target.value)}><option>Call</option><option>Put</option></select></div>
                  <div><FL>Account</FL><select value={planForm.account||""} onChange={e=>pf("account",e.target.value)}><option value="">—</option><option>Schwab</option><option>Etrade</option></select></div>
                  <div><FL>Qty</FL><input type="number" value={planForm.qty} onChange={e=>pf("qty",e.target.value)}/></div>
                  <div><FL>Strike</FL><input type="number" value={planForm.strike} onChange={e=>pf("strike",e.target.value)}/></div>
                  <div><FL>Expiration</FL><input type="date" value={planForm.expiration} onChange={e=>pf("expiration",e.target.value)}/></div>
                  <div><FL>Target Premium $</FL><input type="number" value={planForm.targetPremium} onChange={e=>pf("targetPremium",e.target.value)}/></div>
                  <div><FL>Stock Price $</FL><input type="number" value={planForm.stockPrice} onChange={e=>pf("stockPrice",e.target.value)}/></div>
                  <div><FL>Bid</FL><input type="number" value={planForm.bid} onChange={e=>pf("bid",e.target.value)}/></div>
                  <div><FL>Ask</FL><input type="number" value={planForm.ask} onChange={e=>pf("ask",e.target.value)}/></div>
                </div>
                <div style={{marginBottom:9}}><FL>Notes</FL><input type="text" value={planForm.notes} onChange={e=>pf("notes",e.target.value)}/></div>
                <div style={{display:"flex",gap:7}}>
                  <button onClick={savePlan} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>ADD TO PLAN</button>
                  <button onClick={()=>setPlanForm(null)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                </div>
              </div>
            )}

            {/* Today's Plan */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}}>
              <div style={{padding:"7px 11px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
                <span style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>TODAY'S PLAN</span>
                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  <input type="date" value={planDateFilter} onChange={e=>setPlanDateFilter(e.target.value)} style={{width:120,fontSize:10,padding:"2px 5px"}}/>
                  {planDateFilter!==TODAY && <button onClick={()=>setPlanDateFilter(TODAY)} style={{background:"transparent",color:"#3a4050",border:"1px solid #21262d",borderRadius:3,padding:"2px 6px",fontSize:8,fontFamily:"monospace"}}>Today</button>}
                  {activePlan.length>0 && <Tag color="green">{activePlan.length} pending</Tag>}
                  {donePlan.length>0 && <button onClick={()=>persistPlan(planItems.filter(p=>p.status!=="done"||!filteredPlan.find(x=>x.id===p.id)))} style={{background:"transparent",color:"#3a4050",border:"1px solid #21262d",borderRadius:3,padding:"2px 7px",fontSize:8,fontFamily:"monospace"}}>Clear done</button>}
                </div>
              </div>
              {filteredPlan.length===0 ? (
                <div style={{padding:20,textAlign:"center",color:"#2a3040",fontSize:10,fontFamily:"monospace"}}>No plan items for this date</div>
              ) : (
                <div className="ms">
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr>
                      <th style={{padding:"5px 8px",width:30,borderBottom:"1px solid #1c2128"}}>✓</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Ticker</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contract</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Action</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Strike</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Target $</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>OTM %</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Band</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>$/share</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Tgt Close</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Acct</th>
                      <th style={{padding:"5px 8px",width:36,borderBottom:"1px solid #1c2128"}}></th>
                    </tr></thead>
                    <tbody>
                      {[...activePlan,...donePlan].map(p=>{
                        // Build contract name from plan fields
                        const planContractName = (() => {
                          if (!p.ticker||!p.expiration||!p.strike) return "—";
                          const d = new Date(p.expiration+"T12:00:00");
                          const exp = (d.getMonth()+1).toString().padStart(2,"0")+"/"+d.getDate().toString().padStart(2,"0")+"/"+d.getFullYear();
                          return `${p.ticker} ${exp} ${(+p.strike).toFixed(2)} C`;
                        })();
                        // Look up the matching open contract to get band data
                        const matchedContract = originals.find(c=>
                          c.status==="Open" &&
                          c.stock?.toUpperCase()===p.ticker?.toUpperCase() &&
                          String(c.strike)===String(p.strike) &&
                          c.expires===p.expiration
                        );
                        const bd = matchedContract ? getContractBand(matchedContract) : null;
                        return (
                        <tr key={p.id} className="rh" style={{borderTop:"1px solid #0d1117",opacity:p.status==="done"?0.4:1}}>
                          <td style={{padding:"5px 8px",textAlign:"center"}}>
                            <input type="checkbox" checked={p.status==="done"} onChange={()=>p.status==="done"?(()=>{persistPlan(planItems.map(x=>x.id===p.id?{...x,status:"open"}:x));})():closePlan(p.id)} style={{width:14,height:14,cursor:"pointer",accentColor:"#00ff88"}}/>
                          </td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:12,textDecoration:p.status==="done"?"line-through":"none"}}>{p.ticker}</td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",color:"#555",fontSize:10,whiteSpace:"nowrap"}}>{planContractName}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={p.action==="STO"||p.action==="STC"?"green":p.action==="BTC"?"amber":p.action==="BTO"?"purple":"blue"}>{p.action}</Tag></td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${p.strike||"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555"}}>{p.qty}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#00ff88"}}>{p.targetPremium?f$(+p.targetPremium):"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:bd?bd.bandColor:"#555"}}>{bd?bd.otmPct.toFixed(2)+"%":"—"}</td>
                          <td style={{padding:"5px 8px"}}>{bd?<span style={{fontSize:9,fontFamily:"monospace",background:bd.bandColor+"22",color:bd.bandColor,border:`1px solid ${bd.bandColor}40`,borderRadius:3,padding:"1px 5px"}}>{bd.bandLabel}</span>:<span style={{color:"#2a3040",fontSize:10}}>—</span>}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88",fontWeight:700}}>{bd?"$"+bd.targetPerShare.toFixed(2):"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:"#00ff88"}}>{bd?f$(bd.targetClose):"—"}</td>
                          <td style={{padding:"5px 8px"}}>{p.account?<Tag color={p.account==="Schwab"?"blue":"amber"}>{p.account}</Tag>:<span style={{color:"#2a3040",fontSize:10}}>—</span>}</td>
                          <td style={{padding:"4px 4px"}}><button onClick={()=>delPlan(p.id)} style={{background:"transparent",color:"#ff456030",border:"none",fontSize:11,cursor:"pointer",padding:"1px 4px"}}>✕</button></td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* AI Assistant button */}
            <div style={{background:"#0a0e14",border:"1px solid #c084fc25",borderRadius:8,padding:14,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>setTab("analytics")}>
              <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#1a0a1f,#0d1f12)",border:"1px solid #c084fc30",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🤖</div>
              <div style={{flex:1}}>
                <div style={{fontFamily:"monospace",fontSize:10,color:"#c084fc",letterSpacing:"0.07em",marginBottom:2}}>AI ASSISTANT</div>
                <div style={{fontSize:11,color:"#555"}}>Ask questions about your trading data — available in the Analytics tab</div>
              </div>
              <div style={{color:"#c084fc",fontSize:16}}>→</div>
            </div>
          </div>
        )}

        {/* ══ STOCKS ══ */}
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
            return (
              <div style={{display:"flex",flexDirection:"column",gap:9}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <button onClick={()=>setSelectedTicker(null)} style={{background:"transparent",border:"1px solid #1c2128",borderRadius:6,padding:"5px 10px",fontSize:11,color:"#555",fontFamily:"monospace"}}>← Stocks</button>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:20,color:"#e6edf3"}}>{selectedTicker}</span>
                  <Tag color={td.openCount>0?"green":"gray"}>{td.openCount} open</Tag>
                </div>
                {/* Stock info cards */}
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <KPI label="Total Premium" value={f$(td.totalPremium)} sub={td.contracts.length+" contracts"}/>
                  <KPI label="Total Profit"  value={fSign(td.totalProfit)} sub={td.closedCount+" closed"} color={td.totalProfit>=0?"#00ff88":"#ff4560"}/>
                  <KPI label="Open"          value={td.openCount} sub="active contracts" color="#ffd166"/>
                </div>
                {/* Editable stock data */}
                <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:13}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <span style={{fontFamily:"monospace",fontSize:8,color:"#2a3040",letterSpacing:"0.08em"}}>STOCK DATA</span>
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
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
                    <div><FL>Shares — Schwab</FL><input type="number" defaultValue={sd.sharesSchwab||""} onBlur={e=>updateStockData(selectedTicker,"sharesSchwab",e.target.value?+e.target.value:null)}/></div>
                    <div><FL>Shares — Etrade</FL><input type="number" defaultValue={sd.sharesEtrade||""} onBlur={e=>updateStockData(selectedTicker,"sharesEtrade",e.target.value?+e.target.value:null)}/></div>
                    <div>
                      <FL>Current Price $</FL>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <input type="number" defaultValue={sd.currentPrice||""} onBlur={e=>updateStockData(selectedTicker,"currentPrice",e.target.value?+e.target.value:null)} key={sd.currentPrice}/>
                        {sd.bid!=null && <span style={{fontSize:8,color:"#555",fontFamily:"monospace",whiteSpace:"nowrap"}}>b:{sd.bid} a:{sd.ask}</span>}
                      </div>
                    </div>
                    <div><FL>IV % <span style={{color:"#2a3040",fontSize:7}}>(manual)</span></FL><input type="number" defaultValue={sd.iv||""} placeholder="e.g. 45.2" onBlur={e=>updateStockData(selectedTicker,"iv",e.target.value?+e.target.value:null)}/></div>
                    <div><FL>Next Earnings Date</FL><input type="date" defaultValue={sd.earningsDate||""} onBlur={e=>updateStockData(selectedTicker,"earningsDate",e.target.value||null)}/></div>
                  </div>
                </div>
                {/* Contract history for this ticker */}
                <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}} className="ms">
                  <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>CONTRACT HISTORY</div>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contract</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Opt</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Executed</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#00ff8860",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Live Bid</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#00ff8860",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Live Ask</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Profit</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Acct</th>
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Status</th>
                    </tr></thead>
                    <tbody>
                      {tickerContracts.map(c=>(
                        <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer"}} onClick={()=>setViewC(c)}>
                          {(() => { const lo = c.status==="Open" ? getLiveOption(c) : null; return (<>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",color:"#c9d1d9",fontSize:10,whiteSpace:"nowrap"}}>{fTitle(c)}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":"gray"}>{c.optType}</Tag></td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#c9d1d9",fontWeight:600}}>{c.qty}</td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#555"}}>{c.dateExec||"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:c.premium<0?"#ff4560":"#58a6ff"}}>{fMoney(c.premium)}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:"#00ff88"}}>
                            {lo?.bid!=null ? f$(lo.bid) : <span style={{color:"#1c2128"}}>—</span>}
                          </td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:10,color:"#58a6ff"}}>
                            {lo?.ask!=null ? f$(lo.ask) : <span style={{color:"#1c2128"}}>—</span>}
                          </td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>{c.profit!=null?<span style={{color:c.profit>=0?"#00ff88":"#ff4560"}}>{fSign(c.profit)}</span>:<span style={{color:"#1c2128"}}>—</span>}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>
                          <td style={{padding:"5px 8px"}}><Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag></td>
                          </>); })()}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
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
              style={{padding:"5px 8px",textAlign:right?"right":"left",color:stocksSortKey===key?"#c9d1d9":"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128",whiteSpace:"nowrap"}}>
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
                <span style={{fontSize:9,color:etradeStatus==="error"?"#ff4560":etradeStatus==="ok"?"#00ff8870":"#3a4050",fontFamily:"monospace",flex:1}}>
                  {etradeMsg || "Click to pull live quotes & option chains from E*TRADE sandbox"}
                </span>
                {etradeLastFetch && <span style={{fontSize:8,color:"#2a3040",fontFamily:"monospace",flexShrink:0}}>last sync {etradeLastFetch}</span>}
              </div>

              {/* Cash + filter row */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"stretch"}}>
                {/* Schwab cash square */}
                <div style={{background:"#0a0e14",border:"1px solid #58a6ff30",borderRadius:8,padding:"8px 12px",minWidth:110,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{fontSize:7,color:"#58a6ff",fontFamily:"monospace",letterSpacing:"0.08em"}}>SCHWAB CASH</div>
                  <input type="number" defaultValue={cashData.schwab||""} placeholder="0.00"
                    onBlur={e=>updateCash("schwab",e.target.value)}
                    style={{width:"100%",fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#58a6ff",background:"transparent",border:"none",borderBottom:"1px solid #58a6ff30",padding:"2px 0",outline:"none"}}/>
                </div>
                {/* Etrade cash square */}
                <div style={{background:"#0a0e14",border:"1px solid #ffd16630",borderRadius:8,padding:"8px 12px",minWidth:110,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{fontSize:7,color:"#ffd166",fontFamily:"monospace",letterSpacing:"0.08em"}}>ETRADE CASH</div>
                  <input type="number" defaultValue={cashData.etrade||""} placeholder="0.00"
                    onBlur={e=>updateCash("etrade",e.target.value)}
                    style={{width:"100%",fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#ffd166",background:"transparent",border:"none",borderBottom:"1px solid #ffd16630",padding:"2px 0",outline:"none"}}/>
                </div>
                {/* Total cash */}
                {((cashData.schwab||0)+(cashData.etrade||0))>0 && (
                  <div style={{background:"#0a0e14",border:"1px solid #00ff8830",borderRadius:8,padding:"8px 12px",minWidth:110,display:"flex",flexDirection:"column",gap:4}}>
                    <div style={{fontSize:7,color:"#00ff88",fontFamily:"monospace",letterSpacing:"0.08em"}}>TOTAL CASH</div>
                    <div style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#00ff88"}}>{f$((cashData.schwab||0)+(cashData.etrade||0))}</div>
                  </div>
                )}
                {/* Filter + Add Stock */}
                <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  <button onClick={()=>setStocksFilter("all")} style={{background:stocksFilter==="all"?"#00ff8814":"transparent",color:stocksFilter==="all"?"#00ff88":"#444",border:stocksFilter==="all"?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"4px 10px",fontSize:9,fontFamily:"monospace"}}>All</button>
                  <button onClick={()=>setStocksFilter("owned")} style={{background:stocksFilter==="owned"?"#00ff8814":"transparent",color:stocksFilter==="owned"?"#00ff88":"#444",border:stocksFilter==="owned"?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"4px 10px",fontSize:9,fontFamily:"monospace"}}>Owned ({ownedTickers.length})</button>
                  <button onClick={()=>setShowAddStock(p=>!p)} style={{background:"#00ff8814",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:6,padding:"5px 11px",fontSize:10,fontFamily:"monospace",fontWeight:700}}>+ Add Stock</button>
                </div>
              </div>

              {/* Add Stock form */}
              {showAddStock && (
                <div style={{background:"#0a0e14",border:"1px solid #00ff8825",borderRadius:8,padding:12,animation:"fadeIn .2s"}}>
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
                    }} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>SAVE</button>
                    <button onClick={()=>setShowAddStock(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"7px 12px",fontSize:11}}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Monopoly Board */}
              {(() => {
                // Ticker → sector map
                const SECTOR_MAP = {
                  // Tech — dark blue
                  AAPL:"Tech", MSFT:"Tech", GOOG:"Tech", GOOGL:"Tech", NVDA:"Tech",
                  AMD:"Tech", SMCI:"Tech", NVTS:"Tech", OKLO:"Tech", MSTR:"Tech",
                  META:"Tech", AMZN:"Tech", RBLX:"Tech",
                  // Finance — green
                  JPM:"Finance", GS:"Finance", BAC:"Finance", WFC:"Finance",
                  MS:"Finance", RF:"Finance", USB:"Finance",
                  // Energy — yellow
                  XOM:"Energy", CVX:"Energy", OXY:"Energy", WDC:"Energy",
                  // Healthcare — red
                  JNJ:"Healthcare", UNH:"Healthcare", PFE:"Healthcare",
                  ABBV:"Healthcare", MRK:"Healthcare", NKE:"Healthcare",
                  // Consumer — orange
                  TSLA:"Consumer", F:"Consumer", GM:"Consumer", TGT:"Consumer",
                  WMT:"Consumer", COST:"Consumer", UPS:"Consumer", TKO:"Consumer",
                  LEVI:"Consumer",
                  // Media/Entertainment — pink
                  NFLX:"Media", DIS:"Media", SPOT:"Media", PARA:"Media",
                  // Industrial — light blue
                  BA:"Industrial", CAT:"Industrial", GE:"Industrial", HON:"Industrial",
                  // Other — brown
                  SPY:"Other", QQQ:"Other", OWL:"Other", NOBL:"Other",
                  TLRY:"Other", RF:"Other",
                };
                const SECTOR_COLORS = {
                  Tech:         "#003bbd",  // dark blue
                  Finance:      "#1a8a1a",  // green
                  Energy:       "#d4a800",  // yellow
                  Healthcare:   "#cc1111",  // red
                  Consumer:     "#e07000",  // orange
                  Media:        "#cc44aa",  // pink/magenta
                  Industrial:   "#44aacc",  // light blue
                  Other:        "#7a5c3a",  // brown
                };
                const SECTOR_LABELS = {
                  Tech:"Technology", Finance:"Finance", Energy:"Energy",
                  Healthcare:"Healthcare", Consumer:"Consumer", Media:"Media/Entertainment",
                  Industrial:"Industrial", Other:"Other",
                };

                // Only show tickers with shares entered
                const boardTickers = tickers.filter(t => {
                  const sd = stocksData[t.ticker]||{};
                  return (sd.sharesSchwab||0) + (sd.sharesEtrade||0) > 0;
                });

                if (boardTickers.length === 0) return (
                  <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:24,textAlign:"center"}}>
                    <div style={{fontFamily:"monospace",fontSize:9,color:"#2a3040",marginBottom:6}}>MONOPOLY BOARD</div>
                    <div style={{fontSize:11,color:"#3a4050"}}>Enter shares in a ticker's detail view to see it on the board</div>
                  </div>
                );

                // Group by sector
                const sectorGroups = {};
                boardTickers.forEach(t => {
                  const sector = SECTOR_MAP[t.ticker] || "Other";
                  if (!sectorGroups[sector]) sectorGroups[sector] = [];
                  sectorGroups[sector].push(t);
                });

                const BOARD_SIZE = 520;
                const CELL_SIZE = 60;
                const BOARD_PAD = 60; // corner size
                const INNER = BOARD_SIZE - BOARD_PAD * 2;

                // Lay out sectors around the board edges
                // bottom row (left→right), right col (bottom→top), top row (right→left), left col (top→bottom)
                const sectorOrder = Object.keys(SECTOR_LABELS);
                const cellsPerSide = Math.ceil(sectorOrder.length / 4);

                // Build property cells — distribute sectors around 4 sides
                const sides = [[],[],[],[]]; // bottom, right, top, left
                sectorOrder.forEach((sector, si) => {
                  sides[si % 4].push(sector);
                });

                const renderBuilding = (t, x, y, maxH, color, vertical=false) => {
                  const sd = stocksData[t.ticker]||{};
                  const shares = (sd.sharesSchwab||0)+(sd.sharesEtrade||0);
                  const price = sd.currentPrice||0;
                  const val = shares*price||1;
                  const maxVal = Math.max(...(sectorGroups[SECTOR_MAP[t.ticker]||"Other"]||[t]).map(tt=>{
                    const s2=stocksData[tt.ticker]||{};
                    const sh=(s2.sharesSchwab||0)+(s2.sharesEtrade||0);
                    return sh*(s2.currentPrice||0)||1;
                  }),1);
                  const bH = Math.max(8, Math.round((val/maxVal)*maxH));
                  const bW = vertical ? bH : 16;
                  const bH2 = vertical ? 16 : bH;
                  const floors = Math.max(1, Math.floor(bH2/6));
                  return (
                    <g key={t.ticker} style={{cursor:"pointer"}} onClick={()=>setSelectedTicker(t.ticker)}>
                      <rect x={x} y={y-(vertical?0:bH2)} width={bW} height={bH2} fill={color} opacity={0.8} rx={1}/>
                      {[...Array(Math.min(floors,4))].map((_,fi)=>
                        [...Array(2)].map((_,ci)=>{
                          const wx = x+2+ci*6;
                          const wy = (y-(vertical?0:bH2))+2+fi*6;
                          if(wy+4>y-(vertical?0:0)+bH2-2) return null;
                          return <rect key={`${fi}-${ci}`} x={wx} y={wy} width={4} height={4} fill="#fffde7" opacity={0.9} rx={0.5}/>;
                        })
                      )}
                      <title>{t.ticker} — ${((shares*price)/1000).toFixed(0)}k ({shares} shares @ ${price})</title>
                    </g>
                  );
                };

                return (
                  <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:12}}>
                    <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:8}}>
                      PORTFOLIO BOARD — only tickers with shares · building height = shares × price · click to view
                    </div>
                    <div style={{overflowX:"auto"}}>
                      <svg width={BOARD_SIZE} height={BOARD_SIZE} style={{display:"block",margin:"0 auto"}}>
                        {/* Board background */}
                        <rect x={0} y={0} width={BOARD_SIZE} height={BOARD_SIZE} fill="#060d08" rx={8}/>
                        {/* Inner board */}
                        <rect x={BOARD_PAD} y={BOARD_PAD} width={INNER} height={INNER} fill="#0a1a0e" rx={4}/>
                        <rect x={BOARD_PAD} y={BOARD_PAD} width={INNER} height={INNER} fill="none" stroke="#1c2128" strokeWidth={1} rx={4}/>

                        {/* Center logo */}
                        <text x={BOARD_SIZE/2} y={BOARD_SIZE/2-40} textAnchor="middle" fill="#00ff88" fontSize={18} fontFamily="monospace" fontWeight="700" opacity={0.6}>PRI</text>
                        <text x={BOARD_SIZE/2} y={BOARD_SIZE/2-24} textAnchor="middle" fill="#2a3040" fontSize={8} fontFamily="monospace">PORTFOLIO BOARD</text>
                        {/* Cash display in center */}
                        {(cashData.schwab||cashData.etrade) && (<>
                          <rect x={BOARD_SIZE/2-70} y={BOARD_SIZE/2-15} width={62} height={32} fill="#0a1a2e" stroke="#58a6ff30" strokeWidth={1} rx={4}/>
                          <text x={BOARD_SIZE/2-39} y={BOARD_SIZE/2-3} textAnchor="middle" fill="#58a6ff" fontSize={7} fontFamily="monospace">SCHWAB</text>
                          <text x={BOARD_SIZE/2-39} y={BOARD_SIZE/2+10} textAnchor="middle" fill="#58a6ff" fontSize={9} fontFamily="monospace" fontWeight="700">{cashData.schwab?"$"+(+cashData.schwab).toLocaleString("en-US",{maximumFractionDigits:0}):"—"}</text>
                          <rect x={BOARD_SIZE/2+8} y={BOARD_SIZE/2-15} width={62} height={32} fill="#1a1a0a" stroke="#ffd16630" strokeWidth={1} rx={4}/>
                          <text x={BOARD_SIZE/2+39} y={BOARD_SIZE/2-3} textAnchor="middle" fill="#ffd166" fontSize={7} fontFamily="monospace">ETRADE</text>
                          <text x={BOARD_SIZE/2+39} y={BOARD_SIZE/2+10} textAnchor="middle" fill="#ffd166" fontSize={9} fontFamily="monospace" fontWeight="700">{cashData.etrade?"$"+(+cashData.etrade).toLocaleString("en-US",{maximumFractionDigits:0}):"—"}</text>
                        </>)}
                        <text x={BOARD_SIZE/2} y={BOARD_SIZE/2+28} textAnchor="middle" fill="#1c2128" fontSize={7} fontFamily="monospace">TRADING OPTIONS DASHBOARD</text>

                        {/* Render each sector as a property strip around the board */}
                        {sectorOrder.map((sector, si) => {
                          const color = SECTOR_COLORS[sector] || "#555";
                          const group = sectorGroups[sector] || [];
                          const side = si % 4; // 0=bottom,1=right,2=top,3=left
                          const posInSide = Math.floor(si / 4);
                          const totalOnSide = sectorOrder.filter((_,i)=>i%4===side).length;
                          const sideLen = INNER;
                          const segW = sideLen / totalOnSide;

                          // Position of this sector strip
                          let sx, sy, sw, sh, labelX, labelY, labelAngle=0, vertical=false;
                          if (side === 0) { // bottom
                            sx = BOARD_PAD + posInSide*segW; sy = BOARD_SIZE-BOARD_PAD;
                            sw = segW; sh = BOARD_PAD;
                            labelX = sx+sw/2; labelY = sy+BOARD_PAD*0.65;
                          } else if (side === 1) { // right
                            sx = BOARD_SIZE-BOARD_PAD; sy = BOARD_PAD + posInSide*segW;
                            sw = BOARD_PAD; sh = segW; vertical=true;
                            labelX = sx+BOARD_PAD*0.5; labelY = sy+sh/2; labelAngle=90;
                          } else if (side === 2) { // top
                            sx = BOARD_PAD + (totalOnSide-1-posInSide)*segW; sy = 0;
                            sw = segW; sh = BOARD_PAD;
                            labelX = sx+sw/2; labelY = sy+BOARD_PAD*0.38;
                          } else { // left
                            sx = 0; sy = BOARD_PAD + (totalOnSide-1-posInSide)*segW;
                            sw = BOARD_PAD; sh = segW; vertical=true;
                            labelX = sx+BOARD_PAD*0.5; labelY = sy+sh/2; labelAngle=270;
                          }

                          const colorBandH = 12;
                          return (
                            <g key={sector}>
                              {/* Property cell background */}
                              <rect x={sx} y={sy} width={sw} height={sh} fill={`${color}10`} stroke={`${color}40`} strokeWidth={0.5}/>
                              {/* Color band */}
                              {side===0 && <rect x={sx} y={sy} width={sw} height={colorBandH} fill={color} opacity={0.7}/>}
                              {side===1 && <rect x={sx} y={sy} width={colorBandH} height={sh} fill={color} opacity={0.7}/>}
                              {side===2 && <rect x={sx} y={sy+sh-colorBandH} width={sw} height={colorBandH} fill={color} opacity={0.7}/>}
                              {side===3 && <rect x={sx+sw-colorBandH} y={sy} width={colorBandH} height={sh} fill={color} opacity={0.7}/>}
                              {/* Sector label */}
                              <text x={labelX} y={labelY} textAnchor="middle" fill={color} fontSize={7} fontFamily="monospace" fontWeight="700" opacity={0.9}
                                transform={labelAngle ? `rotate(${labelAngle},${labelX},${labelY})` : undefined}>
                                {SECTOR_LABELS[sector]||sector}
                              </text>
                              {/* Buildings for this sector */}
                              {group.map((t, ti) => {
                                const maxH = side===0||side===2 ? sh-colorBandH-18 : sw-colorBandH-18;
                                const spacing = (side===0||side===2 ? sw : sh) / (group.length+1);
                                let bx, by;
                                if (side===0) { bx=sx+spacing*(ti+1)-8; by=sy+sh-4; }
                                else if (side===1) { bx=sx+colorBandH+4; by=sy+spacing*(ti+1); }
                                else if (side===2) { bx=sx+sw-spacing*(ti+1)-8; by=sy+colorBandH+maxH; }
                                else { bx=sx+sw-colorBandH-20; by=sy+sh-spacing*(ti+1); }
                                const isVert = side===1||side===3;
                                return renderBuilding(t, bx, by, maxH, color, isVert);
                              })}
                            </g>
                          );
                        })}

                        {/* Corner squares */}
                        {[
                          {x:0,y:0,label:"GO"},
                          {x:BOARD_SIZE-BOARD_PAD,y:0,label:"FREE"},
                          {x:0,y:BOARD_SIZE-BOARD_PAD,label:"JAIL"},
                          {x:BOARD_SIZE-BOARD_PAD,y:BOARD_SIZE-BOARD_PAD,label:"TAX"},
                        ].map(({x,y,label})=>(
                          <g key={label}>
                            <rect x={x} y={y} width={BOARD_PAD} height={BOARD_PAD} fill="#0a1a0e" stroke="#1c2128" strokeWidth={1}/>
                            <text x={x+BOARD_PAD/2} y={y+BOARD_PAD/2+4} textAnchor="middle" fill="#00ff8860" fontSize={9} fontFamily="monospace" fontWeight="700">{label}</text>
                          </g>
                        ))}
                      </svg>
                    </div>
                    {/* Legend */}
                    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                      {Object.entries(SECTOR_COLORS).map(([sector,color])=>(
                        <div key={sector} style={{display:"flex",alignItems:"center",gap:4}}>
                          <div style={{width:10,height:10,background:color,borderRadius:2,opacity:0.8}}/>
                          <span style={{fontSize:8,color:"#555",fontFamily:"monospace"}}>{SECTOR_LABELS[sector]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}} className="ms">
                <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>{stocksFilter==="owned"?"OWNED TICKERS":"ALL TICKERS"} — click to view details · click column to sort</div>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr>
                    {sth("ticker","Ticker")}
                    {sth("schwab","Schwab Shares",true)}
                    {sth("etrade","Etrade Shares",true)}
                    {sth("price","Price $",true)}
                    {sth("iv","IV %",true)}
                    {sth("earnings","Earnings")}
                    {sth("premium","Total Premium",true)}
                    {sth("profit","Total Profit",true)}
                    {sth("contracts","Contracts",true)}
                    {sth("open","Open",true)}
                  </tr></thead>
                  <tbody>
                    {sortedDisplayTickers.length===0&&<tr><td colSpan={10} style={{padding:20,textAlign:"center",color:"#3a4050",fontSize:11,fontFamily:"monospace"}}>{stocksFilter==="owned"?"No tickers with shares entered — click a ticker to add shares":"No tickers with data — import history or add tickers to contracts"}</td></tr>}
                    {sortedDisplayTickers.map(t=>{
                      const sd = stocksData[t.ticker]||{};
                      return(
                        <tr key={t.ticker} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer"}} onClick={()=>setSelectedTicker(t.ticker)}>
                          <td style={{padding:"5px 8px",fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:"#e6edf3",fontSize:13}}>{t.ticker}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#c9d1d9"}}>{sd.sharesSchwab!=null?sd.sharesSchwab:"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#c9d1d9"}}>{sd.sharesEtrade!=null?sd.sharesEtrade:"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:sd.lastQuoteAt?"#c9d1d9":"#888"}}>
                            {sd.currentPrice?f$(sd.currentPrice):"—"}
                            {sd.lastQuoteAt && <span style={{fontSize:7,color:"#00ff8870",marginLeft:4}}>●</span>}
                          </td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:sd.iv>50?"#ff4560":sd.iv>30?"#ffd166":"#00ff88",fontSize:10}}>{sd.iv!=null?sd.iv.toFixed(1)+"%":"—"}</td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:sd.earningsDate&&sd.earningsDate>=TODAY?"#ffd166":"#555"}}>{sd.earningsDate||"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(t.totalPremium)}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:t.totalProfit>=0?"#00ff88":"#ff4560"}}>{fSign(t.totalProfit)}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555"}}>{t.contracts.length}</td>
                          <td style={{padding:"5px 8px",textAlign:"right"}}>{t.openCount>0?<Tag color="green">{t.openCount}</Tag>:<span style={{color:"#1c2128",fontSize:10}}>—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}


      </div>
    </div>
  );
}
