// src/OptionsChain.jsx
// Standalone options chain viewer
// Route: /chain (add to main.jsx) or use as separate app

import { useState, useEffect, useCallback } from "react";

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:       "#080b10",
  surface:  "#0d1117",
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
function OptionRow({ opt, type, stockPrice, onAdd }) {
  if (!opt) return (
    <tr className="strike-row" style={{borderBottom:`1px solid ${T.border}`}}>
      {Array(9).fill(0).map((_,i) => <td key={i} style={{padding:"7px 10px",color:T.dim,fontSize:11,textAlign:"right"}}>—</td>)}
    </tr>
  );

  const itm    = type === "Call" ? stockPrice > opt.strikePrice : stockPrice < opt.strikePrice;
  const mid    = opt.bid != null && opt.ask != null ? ((+opt.bid + +opt.ask)/2).toFixed(2) : null;
  const ivPct  = opt.volatility != null ? (opt.volatility).toFixed(1)+"%" : "—";

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
    </tr>
  );
}

// ── Chain table ───────────────────────────────────────────────────────────────
function ChainTable({ calls, puts, stockPrice, showType }) {
  // Collect all strikes
  const allStrikes = [...new Set([
    ...calls.map(o => o.strikePrice),
    ...puts.map(o => o.strikePrice),
  ])].sort((a,b) => a-b);

  const callMap = Object.fromEntries(calls.map(o => [o.strikePrice, o]));
  const putMap  = Object.fromEntries(puts.map(o  => [o.strikePrice, o]));

  const thStyle = {padding:"6px 10px",textAlign:"right",color:T.muted,fontSize:9,fontFamily:T.font,letterSpacing:"0.08em",borderBottom:`1px solid ${T.border2}`,fontWeight:400};

  const headers = ["STRIKE","BID","ASK","MID","LAST","IV","DELTA","VOL","OI"];

  return (
    <div style={{overflowX:"auto"}}>
      <table className="chain-table" style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{background:T.surface}}>
            {headers.map((h,i) => (
              <th key={h} style={{...thStyle, ...(i>4?{display:"none"}:{}), ...({})}}
                className={i>=4?"hide-mobile":""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allStrikes.map(strike => (
            <OptionRow
              key={strike}
              opt={showType==="Call" ? callMap[strike] : putMap[strike]}
              type={showType}
              stockPrice={stockPrice}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Expiry row ────────────────────────────────────────────────────────────────
function ExpiryRow({ expiry, dte, isOpen, onToggle, calls, puts, stockPrice, showType, onTypeChange }) {
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
          <ChainTable calls={calls} puts={puts} stockPrice={stockPrice} showType={showType}/>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OptionsChain() {
  const [ticker,      setTicker]      = useState("");
  const [inputVal,    setInputVal]    = useState("");
  const [loading,     setLoading]     = useState(false);
  const [loadingExp,  setLoadingExp]  = useState(null); // expiry being loaded
  const [error,       setError]       = useState(null);
  const [stockPrice,  setStockPrice]  = useState(null);
  const [stockChange, setStockChange] = useState(null);
  const [expirations, setExpirations] = useState([]); // [{expiry, dte}]
  const [chains,      setChains]      = useState({}); // {expiry: {calls,puts}}
  const [openExpiry,  setOpenExpiry]  = useState(null);
  const [showType,    setShowType]    = useState("Call");

  // ── Fetch quote + expirations ───────────────────────────────────────────────
  const fetchTicker = useCallback(async (sym) => {
    if (!sym) return;
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
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:T.font}}>
      <style>{css}</style>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
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

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div style={{maxWidth:900,margin:"0 auto"}}>
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
            {/* Ticker header */}
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:T.text}}>{ticker}</span>
              <span style={{fontSize:10,color:T.muted,fontFamily:T.font}}>{expirations.length} expirations</span>
              <span style={{fontSize:10,color:T.muted,fontFamily:T.font,marginLeft:"auto"}}>Calls &amp; Puts</span>
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
