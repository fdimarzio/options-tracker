import { useState, useEffect, useRef, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

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
const fSign = v=>v==null?"—":(v>=0?"+":"−")+"$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
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
const EMPTY_NEW = {stock:"",type:"Call",optType:"STO",strike:"",qty:"",expires:"",premium:"",priceAtExecution:"",dateExec:TODAY,account:"",notes:"",createdVia:"Manual",currentPrice:null};
const EMPTY_CLOSE = {costToClose:"",closeDate:TODAY,exercised:"No",rolledOver:"No",notes:""};

// ── Default column config ─────────────────────────────────────────────────────
const DEFAULT_COLS = [
  {key:"ticker",   label:"Ticker",      show:true,  sortKey:"stock"},
  {key:"contract", label:"Contract",    show:false, sortKey:null},
  {key:"optType",  label:"Opt",         show:true,  sortKey:"optType"},
  {key:"strike",   label:"Strike",      show:true,  sortKey:"strike",   right:true},
  {key:"qty",      label:"Qty",         show:true,  sortKey:"qty",      right:true},
  {key:"expires",  label:"Expires",     show:true,  sortKey:"expires"},
  {key:"dateExec", label:"Executed",    show:false, sortKey:"dateExec"},
  {key:"premium",  label:"Premium",     show:true,  sortKey:"premium",  right:true},
  {key:"profit",   label:"Profit",      show:true,  sortKey:"profit",   right:true},
  {key:"account",  label:"Acct",        show:true,  sortKey:"account"},
  {key:"status",   label:"Status",      show:true,  sortKey:"status"},
  {key:"itmotm",   label:"ITM/OTM",     show:true,  sortKey:null},
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

  // Storage helpers
  const useLS = typeof window !== "undefined" && typeof window.storage === "undefined";
  const gv = async k => {
    if (useLS) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch { return null; } }
    try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
  };
  const sv = async (k,v) => {
    if (useLS) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
    else { try { await window.storage.set(k, JSON.stringify(v)); } catch {} }
  };

  useEffect(() => {
    async function load() {
      const saved = await gv("pri_v6_contracts");
      setContracts(saved?.length ? saved : SEED);
      if (!saved?.length) await sv("pri_v6_contracts", SEED);
      const sp = await gv("pri_v6_plan"); if (sp) setPlanItems(sp);
      const su = await gv("pri_v6_users"); if (su) setUsers(su);
      const sc = await gv("pri_v6_cols"); if (sc) setCols(sc);
      const sn = await gv("pri_v6_notes"); if (sn) setPeriodNotes(sn);
      setStorageMsg((saved?.length || SEED.length) + " contracts");
      setDbReady(true);
    }
    load();
  }, []);

  const persist = async u => { await sv("pri_v6_contracts", u); setContracts(u); setStorageMsg(u.length + " contracts"); };
  const persistPlan = async i => { await sv("pri_v6_plan", i); setPlanItems(i); };
  const persistCols = async c => { await sv("pri_v6_cols", c); setCols(c); };
  const persistNotes = async n => { await sv("pri_v6_notes", n); setPeriodNotes(n); };

  // Ticker defaults
  const tickerDefaults = ticker => {
    if (!ticker) return {};
    const t = ticker.toUpperCase();
    const tc = contracts.filter(c => c.stock?.toUpperCase() === t).sort((a,b) => new Date(b.dateExec) - new Date(a.dateExec));
    if (!tc.length) return {};
    const accs = [...new Set(tc.map(c => c.account).filter(Boolean))];
    return { account: accs.length === 1 ? accs[0] : "", qty: tc[0]?.qty || 1 };
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const applyG = list => list.filter(c => {
    if (gTicker  !== "All" && c.stock?.toUpperCase() !== gTicker) return false;
    if (gOptType !== "All" && c.optType !== gOptType) return false;
    if (gType    !== "All" && c.type   !== gType)    return false;
    return true;
  });
  const allF    = applyG(contracts);
  const openC   = allF.filter(c => c.status === "Open");
  const closedC = allF.filter(c => c.status === "Closed");
  const totalPrem  = allF.reduce((s,c) => s+(c.premium||0), 0);
  const totalProfit = closedC.reduce((s,c) => s+(c.profit||0), 0);
  const openPrem   = openC.reduce((s,c) => s+(c.premium||0), 0);
  const winRate = closedC.length ? (closedC.filter(c=>c.profit>0).length/closedC.length*100).toFixed(0) : 0;
  const avgProfit = closedC.length ? totalProfit/closedC.length : 0;
  const allTickers = [...new Set(contracts.map(c=>c.stock?.toUpperCase()).filter(Boolean))].sort();
  const now2 = new Date();
  const thisYear  = now2.getFullYear().toString();
  const thisMonth = now2.toISOString().slice(0,7);
  const premYTD = allF.filter(c=>c.dateExec?.startsWith(thisYear)).reduce((s,c)=>s+(c.premium||0),0);
  const premMTD = allF.filter(c=>c.dateExec?.startsWith(thisMonth)).reduce((s,c)=>s+(c.premium||0),0);
  const mLabel  = now2.toLocaleString("default",{month:"short"})+" "+thisYear;

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

  // Monthly/weekly for Analytics
  const mkPeriodData = (list, view) => {
    const map = {};
    list.forEach(c => {
      let key;
      const d = c.dateExec?.slice(0,10); if (!d) return;
      if (view === "monthly") { key = d.slice(0,7); }
      else { const dt = new Date(d+"T12:00:00"); const wm = new Date(dt); wm.setDate(dt.getDate()-dt.getDay()+1); key = wm.toISOString().slice(0,10); }
      if (!map[key]) map[key] = {key, premium:0, profit:0, contracts:0};
      map[key].premium   += (c.premium||0);
      map[key].contracts += 1;
      if (c.status==="Closed" && c.profit!=null) map[key].profit += c.profit;
    });
    const ns = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return Object.values(map).sort((a,b)=>a.key.localeCompare(b.key)).map(v => {
      if (view==="monthly") { const [yr,mo]=v.key.split("-"); v.label=ns[+mo]+" "+yr.slice(2); }
      else { v.label = "Wk "+v.key.slice(5); }
      return v;
    });
  };
  const [analyticsView,setAnalyticsView] = useState("monthly");
  const periodData = mkPeriodData(allF, analyticsView);

  // Filtered contracts for table
  const sortedFiltered = contracts.filter(c => {
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

  // Plan derived
  const planToday = new Date().toISOString().slice(0,10);
  const ptm = {};
  contracts.forEach(c => { if (!c.stock) return; const t=c.stock.toUpperCase(); if (!ptm[t]) ptm[t]={ticker:t,open:0}; if (c.status==="Open") ptm[t].open++; });
  const knownTickers = Object.values(ptm).sort((a,b)=>a.ticker.localeCompare(b.ticker));
  const planOpen = contracts.filter(c=>c.status==="Open").sort((a,b)=>(a.expires||"").localeCompare(b.expires||""));
  const expToday = planOpen.filter(c=>c.expires===planToday);
  const filteredPlan = planItems.filter(p => !planDateFilter || (p.createdAt||"").startsWith(planDateFilter));
  const activePlan = filteredPlan.filter(p=>p.status==="open");
  const donePlan   = filteredPlan.filter(p=>p.status==="done");

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
      setUsers(u); sv("pri_v6_users",u); setAuthUser(p=>({...p,pin:pinNew}));
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
    const u = editing ? contracts.map(x=>x.id===editing?c:x) : [c,...contracts];
    await persist(u); setForm({...EMPTY_NEW}); setEditing(null); setShowForm(false); setFormErrors({});
  };

  const saveClose = async () => {
    const orig = contracts.find(c=>c.id===closingId); if (!orig) return;
    const ctc   = +closeForm.costToClose||0;
    const profit = +(orig.premium-ctc).toFixed(2);
    const profitPct = orig.premium>0 ? +(profit/orig.premium).toFixed(4) : 0;
    const daysHeld  = closeForm.closeDate&&orig.dateExec ? Math.round((new Date(closeForm.closeDate)-new Date(orig.dateExec))/86400000) : null;
    // Linked BTC close record
    const cr = {
      id:Date.now(), parentId:orig.id, stock:orig.stock, type:orig.type, optType:"BTC",
      strike:orig.strike, qty:orig.qty, expires:orig.expires, premium:-ctc,
      priceAtExecution:null, dateExec:closeForm.closeDate, account:orig.account,
      status:"Closed", costToClose:ctc, closeDate:closeForm.closeDate,
      profit, profitPct, daysHeld, exercised:closeForm.exercised, rolledOver:closeForm.rolledOver,
      notes:closeForm.notes||orig.notes, createdVia:"Manual", createdBy:authUser?.id||null, currentPrice:null,
    };
    const u = contracts.map(x => x.id===closingId ? {
      ...x, costToClose:ctc, closeDate:closeForm.closeDate, profit, profitPct, daysHeld,
      exercised:closeForm.exercised, rolledOver:closeForm.rolledOver,
      notes:closeForm.notes||x.notes, status:"Closed", closedById:cr.id,
    } : x);
    await persist([cr,...u]);
    setCloseForm({...EMPTY_CLOSE}); setClosingId(null); setShowForm(false);
    // Gamification
    setCelebration({profit});
    if (profit > 0) playCashRegister(); else playLoss();
  };

  const startClose = c => { setClosingId(c.id); setCloseForm({...EMPTY_CLOSE,notes:c.notes||""}); setFormMode("close"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doEdit = c => { setForm({...c,strike:`${c.strike}`,qty:`${c.qty}`,premium:`${c.premium}`,priceAtExecution:c.priceAtExecution??"",costToClose:c.costToClose??"",profit:c.profit??"",daysHeld:c.daysHeld??""}); setEditing(c.id); setFormMode("new"); setShowForm(true); setTab("contracts"); setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50); };
  const doDelete = async id => { await persist(contracts.filter(c=>c.id!==id)); setDeleteConfirm(null); setViewC(null); };
  const doExport = () => { const b=new Blob([JSON.stringify(contracts,null,2)],{type:"application/json"}); const u=URL.createObjectURL(b); const a=document.createElement("a"); a.href=u; a.download="pri_export_"+TODAY+".json"; a.click(); URL.revokeObjectURL(u); };
  const doImport = async () => {
    try { const p=JSON.parse(importText); if (!Array.isArray(p)) throw new Error("Expected array");
    await persist(p); setImportMsg("✓ Imported "+p.length+" contracts"); setImportText(""); setTimeout(()=>{setShowImport(false);setImportMsg("");},1500); }
    catch(e) { setImportMsg("Error: "+e.message); }
  };

  // Update current price on a contract
  const updatePrice = async (id, price) => {
    const u = contracts.map(c => c.id===id ? {...c, currentPrice: price===""?null:+price} : c);
    await persist(u);
  };

  // Plan
  const openPlanForm = (ticker, prefill={}) => {
    const d = tickerDefaults(ticker);
    setPlanForm({ticker,action:prefill.action||"STO",qty:prefill.qty||d.qty||1,strike:prefill.strike||"",expiration:prefill.expiration||nextExpiry(ticker)||"",premium:"",stockPrice:"",bid:"",ask:"",last:"",targetPremium:"",notes:prefill.notes||""});
  };
  const savePlan = () => { if (!planForm?.action) return; const i={...planForm,id:Date.now(),status:"open",createdAt:new Date().toISOString()}; persistPlan([i,...planItems]); setPlanForm(null); };
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
        input,select,textarea{background:#080c12;color:#c9d1d9;border:1px solid #21262d;border-radius:4px;padding:6px 8px;font-family:inherit;font-size:12px;width:100%;outline:none;transition:border .15s}
        input:focus,select:focus,textarea:focus{border-color:#00ff8855}
        input.err{border-color:#ff456060!important}
        button{cursor:pointer;font-family:inherit}
        .rh:hover>td{background:#0a0e14!important}
        .ms{overflow-x:auto;-webkit-overflow-scrolling:touch}
        .thsort{cursor:pointer;user-select:none}
        .thsort:hover{color:#c9d1d9!important}
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
                  <Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":"gray"}>{c.optType}</Tag>
                  <Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag>
                  {itmStatus && <Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus}</Tag>}
                </div>
                <button onClick={()=>setViewC(null)} style={{background:"transparent",border:"none",color:"#555",fontSize:18,lineHeight:1,flexShrink:0}}>✕</button>
              </div>
              <div style={{background:"#080c12",borderRadius:8,padding:12,marginBottom:10,border:"1px solid #00ff8820"}}>
                <div style={{fontFamily:"monospace",fontSize:8,color:"#00ff88",letterSpacing:"0.07em",marginBottom:8}}>OPEN — {c.optType}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {[["Strike","$"+c.strike],["Qty",c.qty],["Account",c.account||"—"],["Exec",c.dateExec||"—"],["Expires",c.expires||"—"],["Premium",f$(c.premium)],["Price@Exec",c.priceAtExecution?f$(c.priceAtExecution):"—"],["Created Via",c.createdVia||"—"],["By",c.createdBy?users.find(u=>u.id===c.createdBy)?.initials||c.createdBy:"—"]].map(([l,v])=>(
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
                  <div style={{fontFamily:"monospace",fontSize:8,color:"#ffd166",letterSpacing:"0.07em",marginBottom:8}}>CLOSE — BTC</div>
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
              const uc = contracts.filter(c=>c.createdBy===u.id);
              const up = closedC.filter(c=>c.createdBy===u.id).reduce((s,c)=>s+(c.profit||0),0);
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
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:12,padding:20,width:"100%",maxWidth:300,animation:"fadeIn .15s"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"monospace",fontSize:10,color:"#00ff88",marginBottom:4}}>COLUMNS</div>
            <div style={{fontFamily:"monospace",fontSize:8,color:"#2a3040",marginBottom:12}}>Toggle visible · use arrows to reorder</div>
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
            <button onClick={()=>setShowColPicker(false)} style={{background:"transparent",color:"#555",border:"1px solid #21262d",borderRadius:6,padding:"8px",width:"100%",fontSize:12,marginTop:6}}>Done</button>
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
            </div>
            {/* KPIs */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              <KPI label="Total Premium" value={f$(totalPrem)}    sub={allF.length+" contracts"}/>
              <KPI label="Realized P/L"  value={fSign(totalProfit)} sub={winRate+"% win"} color={totalProfit>=0?"#00ff88":"#ff4560"}/>
              <KPI label="Open Exposure" value={f$(openPrem)}    sub={openC.length+" open"} color="#ffd166"/>
              <KPI label="Avg Profit"    value={fSign(avgProfit)} sub="per close" color={avgProfit>=0?"#58a6ff":"#ff4560"}/>
              <KPI label="MTD"           value={f$(premMTD)}      sub={mLabel} color="#58a6ff"/>
              <KPI label="YTD"           value={f$(premYTD)}      sub={thisYear} color="#58a6ff"/>
            </div>
            {/* Chart controls */}
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
                  <div><FL req>Strike</FL><input type="number" value={form.strike} onChange={e=>sf("strike",e.target.value)} className={formErrors.strike?"err":""} placeholder="250"/></div>
                  <div><FL req>Quantity</FL><input type="number" value={form.qty} onChange={e=>sf("qty",e.target.value)} className={formErrors.qty?"err":""} placeholder="1"/></div>
                  <div><FL req>Premium $</FL><input type="number" value={form.premium} onChange={e=>sf("premium",e.target.value)} className={formErrors.premium?"err":""} placeholder="3.50"/></div>
                  <div><FL>Price @ Exec $</FL><input type="number" value={form.priceAtExecution||""} onChange={e=>sf("priceAtExecution",e.target.value)}/></div>
                  <div><FL req>Date Executed</FL><input type="date" value={form.dateExec} onChange={e=>sf("dateExec",e.target.value)} className={formErrors.dateExec?"err":""}/></div>
                  <div>
                    <FL req>Expires</FL>
                    <input type="date" value={form.expires||""} onChange={e=>sf("expires",e.target.value)} className={formErrors.expires?"err":""}/>
                    {form.stock && EXPIRY_SCHEDULES[form.stock.toUpperCase()] && <div style={{fontSize:7,color:"#2a3040",marginTop:1,fontFamily:"monospace"}}>{EXPIRY_SCHEDULES[form.stock.toUpperCase()].join("/")}</div>}
                  </div>
                  <div><FL req>Account</FL><select value={form.account||""} onChange={e=>sf("account",e.target.value)} className={formErrors.account?"err":""}><option value="">—</option><option>Schwab</option><option>Etrade</option></select></div>
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
              const ep  = orig ? +(orig.premium-ctc).toFixed(2) : null;
              const epct = orig?.premium>0 ? (ep/orig.premium*100).toFixed(1) : null;
              const ed  = orig&&closeForm.closeDate ? Math.round((new Date(closeForm.closeDate)-new Date(orig.dateExec))/86400000) : null;
              return (
                <div style={{background:"#0a0e14",border:"1px solid #ffd16625",borderRadius:8,padding:13,animation:"fadeIn .2s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:"#ffd166"}}/>
                    <span style={{fontFamily:"monospace",fontSize:10,color:"#ffd166",letterSpacing:"0.07em"}}>CLOSE CONTRACT</span>
                    {orig && <span style={{fontSize:10,color:"#555",fontFamily:"monospace"}}>{fTitle(orig)} — <span style={{color:"#58a6ff"}}>{f$(orig.premium)}</span></span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(135px,1fr))",gap:7,marginBottom:9}}>
                    <div><FL>Cost to Close $</FL><input type="number" value={closeForm.costToClose} onChange={e=>setCloseForm(p=>({...p,costToClose:e.target.value}))} placeholder="Buy-back total"/></div>
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
                    return (
                      <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",cursor:"pointer",background:c.status==="Open"&&itmStatus==="ITM"?"#ff456005":c.status==="Open"&&itmStatus==="OTM"?"#00ff8803":"transparent"}} onClick={()=>setViewC(c)}>
                        {cols.filter(x=>x.show).map(col => {
                          switch(col.key) {
                            case "ticker":  return <td key="ticker" style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:c.parentId?"#58a6ff":"#e6edf3",fontSize:12}}>{c.stock||"—"}{c.parentId&&<span style={{fontSize:7,color:"#58a6ff",marginLeft:2}}>BTC</span>}</td>;
                            case "contract":return <td key="contract" style={{padding:"5px 8px",fontFamily:"monospace",color:"#8b949e",fontSize:10,whiteSpace:"nowrap"}}>{fTitle(c)}</td>;
                            case "optType": return <td key="optType" style={{padding:"5px 8px"}}><Tag color={c.optType==="STO"?"green":c.optType==="BTC"?"amber":"gray"}>{c.optType}</Tag></td>;
                            case "strike":  return <td key="strike" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${c.strike}</td>;
                            case "qty":     return <td key="qty" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{c.qty}</td>;
                            case "expires": return <td key="expires" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#2a3040"}}>{c.expires||"—"}</td>;
                            case "dateExec":return <td key="dateExec" style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:"#1c2128"}}>{c.dateExec||"—"}</td>;
                            case "premium": return <td key="premium" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(c.premium)}</td>;
                            case "profit":  return <td key="profit" style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11}}>{c.profit!=null?<span style={{color:c.profit>=0?"#00ff88":"#ff4560"}}>{fSign(c.profit)}</span>:<span style={{color:"#1c2128"}}>—</span>}</td>;
                            case "account": return <td key="account" style={{padding:"5px 8px"}}><Tag color={c.account==="Schwab"?"blue":"amber"}>{c.account}</Tag></td>;
                            case "status":  return <td key="status" style={{padding:"5px 8px"}}><Tag color={c.status==="Open"?"green":"gray"}>{c.status}</Tag></td>;
                            case "itmotm":  return <td key="itmotm" style={{padding:"5px 8px",textAlign:"center"}}>{c.status==="Open"&&itmStatus?<Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴":"🟢"}</Tag>:<span style={{color:"#1c2128",fontSize:10}}>—</span>}</td>;
                            default: return null;
                          }
                        })}
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
              <div style={{marginLeft:"auto",display:"flex",gap:3}}>
                {["monthly","weekly"].map(v=>(
                  <button key={v} onClick={()=>setAnalyticsView(v)} style={{background:analyticsView===v?"#00ff8814":"transparent",color:analyticsView===v?"#00ff88":"#2a3040",border:analyticsView===v?"1px solid #00ff8825":"1px solid #1c2128",borderRadius:4,padding:"2px 7px",fontSize:8,fontFamily:"monospace",textTransform:"uppercase"}}>{v}</button>
                ))}
              </div>
            </div>

            {/* Period breakdown with notes */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8}} className="ms">
              <div style={{padding:"7px 11px",fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em"}}>{analyticsView.toUpperCase()} BREAKDOWN</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>
                  <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Period</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Premium</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Profit</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Margin</th>
                  <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Contracts</th>
                  <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Notes</th>
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
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontSize:11,color:pp>=0.6?"#00ff88":pp>=0.3?"#ffd166":"#ff4560"}}>{(pp*100).toFixed(1)}%</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{m.contracts}</td>
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
                      </tr>
                    );
                  })}
                  {periodData.length===0 && <tr><td colSpan={6} style={{padding:18,textAlign:"center",color:"#3a4050",fontSize:11,fontFamily:"monospace"}}>No data — import history first</td></tr>}
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
          </div>
        )}

        {/* ══ PLAN ══ */}
        {tab==="plan" && (
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {/* Ticker cards */}
            <div style={{background:"#0a0e14",border:"1px solid #1c2128",borderRadius:8,padding:11}}>
              <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:9}}>TICKER CARDS — tap to add to plan</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {knownTickers.map(t=>(
                  <button key={t.ticker} onClick={()=>openPlanForm(t.ticker)} style={{background:"#080c12",border:"1px solid #21262d",borderRadius:6,padding:"5px 9px",cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
                    <span style={{fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:12}}>{t.ticker}</span>
                    {t.open>0 && <span style={{background:"#00ff8820",color:"#00ff88",border:"1px solid #00ff8830",borderRadius:10,fontSize:8,fontFamily:"monospace",padding:"0 4px"}}>{t.open}</span>}
                  </button>
                ))}
                {knownTickers.length===0 && <span style={{color:"#2a3040",fontSize:10,fontFamily:"monospace"}}>Import history to see tickers</span>}
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
                    <th style={{padding:"5px 8px",textAlign:"center",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>ITM/OTM</th>
                    <th style={{padding:"5px 8px",borderBottom:"1px solid #1c2128",width:60}}></th>
                  </tr></thead>
                  <tbody>
                    {planOpen.map(c=>{
                      const itmStatus=getITMStatus(c);
                      return(
                      <tr key={c.id} className="rh" style={{borderTop:"1px solid #0d1117",background:c.expires===planToday?"#ff456005":itmStatus==="ITM"?"#ff456003":itmStatus==="OTM"?"#00ff8803":"transparent"}}>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:11}}>{fTitle(c)}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#2a3040"}}>{c.qty}</td>
                        <td style={{padding:"5px 8px",fontFamily:"monospace",fontSize:10,color:c.expires===planToday?"#ff4560":"#2a3040"}}>{c.expires||"—"}</td>
                        <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#58a6ff"}}>{f$(c.premium)}</td>
                        <td style={{padding:"5px 8px",textAlign:"center"}}>{itmStatus?<Tag color={itmStatus==="ITM"?"red":"green"}>{itmStatus==="ITM"?"🔴":"🟢"}</Tag>:<span style={{color:"#2a3040",fontSize:10}}>—</span>}</td>
                        <td style={{padding:"5px 8px"}}>
                          <button onClick={()=>openPlanForm(c.stock||"",{action:"BTC",qty:c.qty,strike:c.strike,expiration:c.expires})} style={{background:"#58a6ff18",color:"#58a6ff",border:"1px solid #58a6ff30",borderRadius:3,padding:"2px 8px",fontSize:9,fontFamily:"monospace"}}>+ Add</button>
                        </td>
                      </tr>
                    );})}
                    {planOpen.length===0 && <tr><td colSpan={6} style={{padding:18,textAlign:"center",color:"#3a4050",fontSize:10,fontFamily:"monospace"}}>No open contracts</td></tr>}
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
                      <th style={{padding:"5px 8px",textAlign:"left",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Action</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Strike</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Qty</th>
                      <th style={{padding:"5px 8px",textAlign:"right",color:"#3a4050",fontFamily:"monospace",fontSize:10,borderBottom:"1px solid #1c2128"}}>Target $</th>
                      <th style={{padding:"5px 8px",width:36,borderBottom:"1px solid #1c2128"}}></th>
                    </tr></thead>
                    <tbody>
                      {[...activePlan,...donePlan].map(p=>(
                        <tr key={p.id} className="rh" style={{borderTop:"1px solid #0d1117",opacity:p.status==="done"?0.4:1}}>
                          <td style={{padding:"5px 8px",textAlign:"center"}}>
                            <input type="checkbox" checked={p.status==="done"} onChange={()=>p.status==="done"?(()=>{persistPlan(planItems.map(x=>x.id===p.id?{...x,status:"open"}:x));})():closePlan(p.id)} style={{width:14,height:14,cursor:"pointer",accentColor:"#00ff88"}}/>
                          </td>
                          <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:"#e6edf3",fontSize:12,textDecoration:p.status==="done"?"line-through":"none"}}>{p.ticker}</td>
                          <td style={{padding:"5px 8px"}}><Tag color={p.action==="STO"||p.action==="STC"?"green":p.action==="BTC"?"amber":"blue"}>{p.action}</Tag></td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#b0bac6"}}>${p.strike||"—"}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#555"}}>{p.qty}</td>
                          <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",color:"#00ff88"}}>{p.targetPremium?f$(+p.targetPremium):"—"}</td>
                          <td style={{padding:"4px 4px"}}><button onClick={()=>delPlan(p.id)} style={{background:"transparent",color:"#ff456030",border:"none",fontSize:11,cursor:"pointer",padding:"1px 4px"}}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* AI placeholder */}
            <div style={{background:"#0a0e14",border:"1px dashed #1c2128",borderRadius:8,padding:14,textAlign:"center"}}>
              <div style={{fontFamily:"monospace",fontSize:7,color:"#2a3040",letterSpacing:"0.08em",marginBottom:5}}>AI SUGGESTIONS — COMING SOON</div>
              <div style={{fontSize:10,color:"#2a3040"}}>Claude will analyze your portfolio and trading principles to suggest optimal contracts</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
