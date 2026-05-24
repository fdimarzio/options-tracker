// src/OptionsChain.jsx
// Standalone options chain viewer with inline chart panel + contract calculator
// Route: /chain (add to main.jsx) or use as separate app

import React, { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

const PROXY = "https://options-tracker-five.vercel.app/api/schwab-proxy";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
  @keyframes spin { to { transform: rotate(360deg); } }
  .fade-in { animation: fadeIn 0.2s ease forwards; }
  .expiry-row { transition: background 0.12s; cursor: pointer; }
  .expiry-row:hover { background: #151e2a !important; }
  .strike-row { transition: background 0.08s; cursor: default; }
  .strike-row:hover { background: #0f1620 !important; }
  .chart-btn { opacity: 0.3; transition: opacity 0.15s; background: none; border: none; cursor: pointer; padding: 2px 5px; font-size: 12px; line-height:1; }
  .strike-row:hover .chart-btn { opacity: 0.8; }
  .chart-btn.active { opacity: 1 !important; filter: sepia(1) saturate(3) hue-rotate(10deg); }
  @media (max-width: 600px) {
    .chain-table th, .chain-table td { padding: 5px 6px !important; font-size: 10px !important; }
    .hide-mobile { display: none !important; }
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (v, d=2) => v != null ? (+v).toFixed(d) : "—";
const fmtK = v => v != null ? (+v >= 1000 ? (v/1000).toFixed(0)+"k" : String(+v)) : "—";

function Spinner({ size=18 }) {
  return <div style={{width:size,height:size,border:`2px solid ${T.border2}`,borderTopColor:T.blue,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block",flexShrink:0}}/>;
}

// ── OI Tracking — register ticker in Supabase col_prefs ──────────────────────
async function ensureOITracking(ticker) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.oi_tracked_tickers`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const existing = (await res.json())?.[0]?.cols?.tickers || [];
    if (existing.includes(ticker)) return;
    const updated = [...new Set([...existing, ticker])];
    await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "oi_tracked_tickers", cols: { tickers: updated }, updated_at: new Date().toISOString() }),
    });
    console.log(`[OI] Now tracking ${ticker}`);
  } catch (e) {
    console.warn("[OI] tracking update failed:", e.message);
  }
}

// ── Fibonacci level computation ───────────────────────────────────────────────
function computeFibLevels(candles, stockPrice, lookback = 60) {
  if (!candles || candles.length < 10) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow  = Math.min(...window.map(c => c.low));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  const FIB_PCTS   = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_LABELS = ["100%", "78.6%", "61.8%", "50%", "38.2%", "23.6%", "0%"];
  const levels = FIB_PCTS.map((pct, i) => ({
    pct, price: Math.round((swingHigh - pct * range) * 100) / 100, label: FIB_LABELS[i],
    isSupport: pct >= 0.382, isResistance: pct <= 0.382,
  }));
  let nearestLevel = null, nearestDistPct = Infinity;
  if (stockPrice) {
    for (const lvl of levels) {
      const distPct = Math.abs(stockPrice - lvl.price) / stockPrice * 100;
      if (distPct < nearestDistPct) { nearestDistPct = distPct; nearestLevel = lvl; }
    }
  }
  const prevClose  = candles[candles.length - 2]?.close;
  const brokeBelow = nearestLevel && prevClose > nearestLevel.price && stockPrice < nearestLevel.price;
  return {
    swingHigh, swingLow, range, levels, nearest: nearestLevel,
    nearestDistPct: Math.round(nearestDistPct * 100) / 100,
    brokeBelow,
    stoSignal: brokeBelow ? "favorable"
      : nearestLevel?.isResistance && nearestDistPct < 1.5 ? "favorable"
      : nearestLevel?.isSupport    && nearestDistPct < 1.5 ? "suppress"
      : "neutral",
  };
}

// ── StockChartWithFib — daily candles + Fib levels overlaid ──────────────────
function StockChartWithFib({ candles, stockPrice }) {
  const chartRef  = useRef(null);
  const chartInst = useRef(null);
  const [ready, setReady] = useState(false);
  const fib = computeFibLevels(candles, stockPrice);
  useEffect(() => { const t = setTimeout(() => setReady(true), 60); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!ready || !chartRef.current || !candles?.length) return;
    if (chartInst.current) { try { chartInst.current.remove(); } catch(e){} chartInst.current = null; }
    const el = chartRef.current;
    const LC = { 0:"#888", 0.236:"#3a86ff", 0.382:"#8ecae6", 0.5:"#e63946", 0.618:"#f4a261", 0.786:"#8338ec", 1:"#888" };
    const chart = createChart(el, {
      width: el.offsetWidth, height: 280,
      layout: { background:{color:"transparent"}, textColor:T.muted },
      grid: { vertLines:{color:T.border}, horzLines:{color:T.border} },
      crosshair: { mode:CrosshairMode.Normal },
      rightPriceScale: { borderColor:T.border2 },
      timeScale: { borderColor:T.border2, timeVisible:true },
    });
    const cs = chart.addCandlestickSeries({ upColor:T.green, downColor:T.red, borderUpColor:T.green, borderDownColor:T.red, wickUpColor:T.green, wickDownColor:T.red });
    cs.setData(candles.map(c => ({ time:c.date, open:c.open, high:c.high, low:c.low, close:c.close })));
    if (fib) {
      fib.levels.forEach(lvl => {
        const color = LC[lvl.pct] || "#888";
        const isNearest = fib.nearest?.pct === lvl.pct;
        const line = chart.addLineSeries({ color, lineWidth:isNearest?2:1, lineStyle:isNearest?0:3, priceLineVisible:false, lastValueVisible:true, title:lvl.label });
        line.setData([{ time:candles[0].date, value:lvl.price }, { time:candles[candles.length-1].date, value:lvl.price }]);
      });
    }
    chart.timeScale().fitContent();
    chartInst.current = chart;
    return () => { if (chartInst.current) { try { chartInst.current.remove(); } catch(e){} chartInst.current = null; } };
  }, [ready, candles, stockPrice]);
  if (!candles?.length) return null;
  return <div ref={chartRef} style={{ width:"100%", height:"280px" }} />;
}


// ── FibPanel — collapsible Fib overlay with stock candlestick chart ───────────
function FibPanel({ candles, stockPrice }) {
  const [open, setOpen] = useState(false);
  const fib = computeFibLevels(candles, stockPrice);
  if (!fib) return null;

  const LC = { 0:"#888", 0.236:"#3a86ff", 0.382:"#8ecae6", 0.5:"#e63946", 0.618:"#f4a261", 0.786:"#8338ec", 1:"#888" };
  const sigColor = fib.stoSignal==="favorable"?T.green:fib.stoSignal==="suppress"?T.red:"#3a4050";
  const sigLabel = fib.stoSignal==="favorable"&&fib.brokeBelow?"↓ Broke below — favorable for STO"
    :fib.stoSignal==="favorable"?"↑ Near resistance — favorable for STO"
    :fib.stoSignal==="suppress"?"⚠ Near support — suppress STO":"Neutral zone";

  return (
    <div style={{ borderTop:`1px solid ${T.border}`, background:T.surface }}>
      <div onClick={() => setOpen(o=>!o)}
        style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 16px", cursor:"pointer", flexWrap:"wrap" }}>
        <span style={{ fontFamily:T.font, fontSize:8, color:T.dim, letterSpacing:"0.08em" }}>{open?"▼":"▶"} FIBONACCI</span>
        <span style={{ fontFamily:T.font, fontSize:9, color:T.muted }}>{fib.swingLow.toFixed(2)} → {fib.swingHigh.toFixed(2)}</span>
        {fib.nearest && (
          <span style={{ fontFamily:T.font, fontSize:9, color:LC[fib.nearest.pct]||T.muted,
            background:(LC[fib.nearest.pct]||T.muted)+"18", border:`1px solid ${(LC[fib.nearest.pct]||T.muted)}44`,
            borderRadius:4, padding:"1px 6px" }}>
            {fib.nearest.label} ${fib.nearest.price.toFixed(2)} ±{fib.nearestDistPct.toFixed(1)}%
          </span>
        )}
        <span style={{ fontFamily:T.font, fontSize:9, color:sigColor, marginLeft:"auto" }}>{sigLabel}</span>
      </div>
      {open && <StockChartWithFib candles={candles} stockPrice={stockPrice} />}
    </div>
  );
}

// ── ChartPanelInner — shared chart content ────────────────────────────────────
function ChartPanelInner({ opt, type, ticker, expiry, stockPrice, onClose, initialPeriod, fullPage }) {
  const chartRef  = useRef(null);
  const volRef    = useRef(null);
  const chartInst = useRef(null);
  const volInst   = useRef(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [contracts, setContracts] = useState(1);
  const [period,    setPeriod]    = useState(initialPeriod || "day");
  const [ready,     setReady]     = useState(false);

  const mid       = opt.bid != null && opt.ask != null ? (+opt.bid + +opt.ask) / 2 : null;
  const premium   = mid ?? opt.last ?? opt.mark ?? 0;
  const cost      = +(premium * contracts * 100).toFixed(2);
  const breakeven = type === "Call" ? +(+opt.strikePrice + premium).toFixed(2) : +(+opt.strikePrice - premium).toFixed(2);
  const maxProfit = type === "Call" ? "Unlimited" : `$${(+((opt.strikePrice - premium) * contracts * 100)).toLocaleString()}`;
  const itm = type === "Call" ? stockPrice > opt.strikePrice : stockPrice < opt.strikePrice;

  function buildOSI() {
    const exp = expiry.replace(/-/g, "").slice(2);
    const cp  = type === "Call" ? "C" : "P";
    return `${ticker.padEnd(6)}${exp}${cp}${(opt.strikePrice * 1000).toFixed(0).padStart(8, "0")}`;
  }

  const openFullPage = () => {
    const p = new URLSearchParams({ ticker, expiry, strike: opt.strikePrice, type, period });
    window.open(`/?chart=1&${p}`, "_blank");
  };

  useEffect(() => { const t = setTimeout(() => setReady(true), 60); return () => clearTimeout(t); }, []);

  useEffect(() => {
    if (!ready || !chartRef.current || !volRef.current) return;
    if (chartInst.current) { try { chartInst.current.remove(); } catch(e){} chartInst.current = null; }
    if (volInst.current)   { try { volInst.current.remove();   } catch(e){} volInst.current   = null; }
    setLoading(true); setError(null);

    const sym = buildOSI();
    const periodVal = period === "day" ? 1 : 5;
    const freq      = period === "day" ? 1 : 5;
    const url = `${PROXY}?path=/marketdata/v1/pricehistory&symbol=${encodeURIComponent(sym)}&periodType=day&period=${periodVal}&frequencyType=minute&frequency=${freq}&needExtendedHoursData=false`;

    fetch(url).then(r => r.json()).then(data => {
      const candles = data?.candles || [];
      if (!candles.length) throw new Error("No intraday data available");
      const ohlc = candles.map(c => ({ time: Math.floor(c.datetime/1000), open:c.open, high:c.high, low:c.low, close:c.close }));
      const vols = candles.map(c => ({ time: Math.floor(c.datetime/1000), value:c.volume, color: c.close>=c.open?"#00e67666":"#ff444466" }));
      const el = chartRef.current, vel = volRef.current;
      if (!el || !vel) return;
      const mainChart = createChart(el, {
        width: el.offsetWidth, height: 200,
        layout: { background:{color:"transparent"}, textColor:T.muted },
        grid: { vertLines:{color:T.border}, horzLines:{color:T.border} },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor:T.border2 },
        timeScale: { borderColor:T.border2, timeVisible:true, secondsVisible:false },
      });
      const cs = mainChart.addCandlestickSeries({ upColor:T.green, downColor:T.red, borderUpColor:T.green, borderDownColor:T.red, wickUpColor:T.green, wickDownColor:T.red });
      cs.setData(ohlc); chartInst.current = mainChart; mainChart.timeScale().fitContent();
      try {
        const volChart = createChart(vel, {
          width: el.offsetWidth, height: 65,
          layout: { background:{color:"transparent"}, textColor:T.muted },
          grid: { vertLines:{color:"transparent"}, horzLines:{color:T.border} },
          rightPriceScale: { borderColor:T.border2 },
          timeScale: { borderColor:T.border2, timeVisible:false, visible:false },
        });
        const vs = volChart.addHistogramSeries({ priceFormat:{type:"volume"}, priceScaleId:"" });
        vs.priceScale().applyOptions({ scaleMargins:{top:0.1,bottom:0} });
        vs.setData(vols); volInst.current = volChart;
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => { if (range) volChart.timeScale().setVisibleLogicalRange(range); });
      } catch(e) { console.warn("[chart] volChart:", e.message); }
      setLoading(false);
    }).catch(err => { setError(err.message); setLoading(false); });

    return () => {
      if (chartInst.current) { try { chartInst.current.remove(); } catch(e){} chartInst.current = null; }
      if (volInst.current)   { try { volInst.current.remove();   } catch(e){} volInst.current   = null; }
    };
  }, [ready, period, opt.strikePrice, type, ticker, expiry]);

  return (
    <div className="fade-in" style={{padding:"16px 20px", background:T.card}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,color:T.text}}>{ticker} ${opt.strikePrice} {type}</span>
        <span style={{fontSize:11,color:T.muted}}>{expiry}</span>
        {itm && <span style={{fontSize:9,background:type==="Call"?T.green+"22":T.red+"22",color:type==="Call"?T.green:T.red,border:`1px solid ${type==="Call"?T.green+"55":T.red+"55"}`,borderRadius:4,padding:"2px 7px"}}>ITM</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
          {["day","5day"].map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              style={{background:period===p?T.blue+"22":"transparent",color:period===p?T.blue:T.muted,border:`1px solid ${period===p?T.blue+"55":T.border}`,borderRadius:4,padding:"3px 10px",fontSize:10,fontFamily:T.font,cursor:"pointer"}}>
              {p==="day"?"1D":"5D"}
            </button>
          ))}
          {!fullPage && <button onClick={openFullPage} style={{background:"transparent",color:T.muted,border:`1px solid ${T.border}`,borderRadius:4,padding:"3px 10px",fontSize:10,fontFamily:T.font,cursor:"pointer"}}>↗ Full</button>}
          {onClose && <button onClick={onClose} style={{background:"transparent",color:T.muted,border:`1px solid ${T.border}`,borderRadius:4,padding:"3px 10px",fontSize:10,fontFamily:T.font,cursor:"pointer"}}>✕</button>}
        </div>
      </div>
      <div style={{display:"flex",gap:18,marginBottom:14,flexWrap:"wrap"}}>
        {[["Bid",fmt(opt.bid)],["Ask",fmt(opt.ask)],["Mid",mid?fmt(mid):"—"],["Last",fmt(opt.last)],
          ["IV",opt.volatility!=null?opt.volatility.toFixed(1)+"%":"—"],["Delta",fmt(opt.delta,3)],
          ["OI",fmtK(opt.openInterest)],["Vol",fmtK(opt.totalVolume)]
        ].map(([label,val]) => (
          <div key={label} style={{display:"flex",flexDirection:"column",gap:2}}>
            <span style={{fontSize:8,color:T.muted,letterSpacing:"0.08em"}}>{label}</span>
            <span style={{fontSize:12,color:T.text}}>{val}</span>
          </div>
        ))}
      </div>
      <div style={{position:"relative",height:error?undefined:280}}>
        {loading && !error && (
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:T.card+"dd",zIndex:5,borderRadius:4}}>
            <Spinner/><span style={{fontSize:11,color:T.muted}}>Loading price history…</span>
          </div>
        )}
        {error ? (
          <div style={{padding:"20px",textAlign:"center",color:T.muted,fontSize:11,background:T.surface,borderRadius:4}}>⚠ {error}</div>
        ) : (
          <>
            <div ref={chartRef} style={{width:"100%",height:"200px"}}/>
            <div ref={volRef}   style={{width:"100%",height:"65px",marginTop:2}}/>
          </>
        )}
      </div>
      <div style={{marginTop:14,padding:"12px 16px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6}}>
        <div style={{fontSize:9,color:T.muted,letterSpacing:"0.08em",marginBottom:10}}>CONTRACT CALCULATOR</div>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:11,color:T.muted}}>Qty</span>
            <button onClick={() => setContracts(c => Math.max(1,c-1))} style={{width:22,height:22,background:T.border2,color:T.text,border:"none",borderRadius:3,cursor:"pointer",fontSize:14,lineHeight:1}}>−</button>
            <span style={{fontSize:14,color:T.text,minWidth:20,textAlign:"center"}}>{contracts}</span>
            <button onClick={() => setContracts(c => c+1)} style={{width:22,height:22,background:T.border2,color:T.text,border:"none",borderRadius:3,cursor:"pointer",fontSize:14,lineHeight:1}}>+</button>
          </div>
          <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
            {[["Cost",`$${cost.toLocaleString()}`,T.text],["Breakeven",`$${breakeven}`,T.yellow],["Max Profit",maxProfit,T.green],["Premium",`$${fmt(premium)} / contract`,T.blue]].map(([label,val,color]) => (
              <div key={label} style={{display:"flex",flexDirection:"column",gap:2}}>
                <span style={{fontSize:8,color:T.muted,letterSpacing:"0.08em"}}>{label}</span>
                <span style={{fontSize:13,color,fontFamily:T.font}}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ChartPanel — tr/td wrapper for use inside table (full page view) ──────────
function ChartPanel({ opt, type, ticker, expiry, stockPrice, onClose, initialPeriod, fullPage }) {
  return (
    <tr>
      <td colSpan={11} style={{padding:0,borderBottom:`2px solid ${T.border2}`}}>
        <ChartPanelInner opt={opt} type={type} ticker={ticker} expiry={expiry} stockPrice={stockPrice} onClose={onClose} initialPeriod={initialPeriod} fullPage={fullPage}/>
      </td>
    </tr>
  );
}

// ── ChartPanelDiv — div wrapper for use outside table ────────────────────────
function ChartPanelDiv({ opt, type, ticker, expiry, stockPrice, onClose, initialPeriod }) {
  return (
    <div style={{borderTop:`2px solid ${T.border2}`,borderBottom:`2px solid ${T.border2}`}}>
      <ChartPanelInner opt={opt} type={type} ticker={ticker} expiry={expiry} stockPrice={stockPrice} onClose={onClose} initialPeriod={initialPeriod}/>
    </div>
  );
}

// ── Option row ────────────────────────────────────────────────────────────────
function OptionRow({ opt, type, stockPrice, activeChart, onChartToggle, maxOI }) {
  if (!opt) return (
    <tr className="strike-row" style={{borderBottom:`1px solid ${T.border}`}}>
      {Array(11).fill(0).map((_,i) => <td key={i} style={{padding:"7px 10px",color:T.dim,fontSize:11,textAlign:"right"}}>—</td>)}
    </tr>
  );

  const isActive = activeChart === opt.strikePrice;
  const itm      = type === "Call" ? stockPrice > opt.strikePrice : stockPrice < opt.strikePrice;
  const mid      = opt.bid != null && opt.ask != null ? ((+opt.bid + +opt.ask)/2).toFixed(2) : null;
  const ivPct    = opt.volatility != null ? opt.volatility.toFixed(1)+"%" : "—";
  const oiPct    = maxOI > 0 && opt.openInterest ? Math.round((opt.openInterest / maxOI) * 100) : 0;
  const barColor = type === "Call" ? T.green : T.red;

  return (
    <tr className="strike-row" style={{
      borderBottom:`1px solid ${T.border}`,
      background: isActive ? "#151e2a" : itm ? (type==="Call"?"#00e67608":"#ff444408") : "transparent",
    }}>
      {/* Chart toggle */}
      <td style={{padding:"6px 4px",textAlign:"center",width:26}}>
        <button className={`chart-btn${isActive?" active":""}`}
          onClick={() => onChartToggle(opt.strikePrice)}
          title="View option chart">📈</button>
      </td>
      {/* Strike */}
      <td style={{padding:"7px 10px",fontWeight:600,color:itm?(type==="Call"?T.green:T.red):T.text,fontSize:12,textAlign:"right",fontFamily:T.font}}>
        {opt.strikePrice}
        {itm && <span style={{fontSize:8,marginLeft:4,color:type==="Call"?T.green:T.red}}>ITM</span>}
      </td>
      <td style={{padding:"7px 10px",color:T.text,fontSize:11,textAlign:"right"}}>{fmt(opt.bid)}</td>
      <td style={{padding:"7px 10px",color:T.text,fontSize:11,textAlign:"right"}}>{fmt(opt.ask)}</td>
      <td style={{padding:"7px 10px",color:mid?T.blue:T.muted,fontSize:11,textAlign:"right"}}>{mid||"—"}</td>
      <td style={{padding:"7px 10px",color:T.muted,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmt(opt.last)}</td>
      <td style={{padding:"7px 10px",color:T.purple,fontSize:11,textAlign:"right"}} className="hide-mobile">{ivPct}</td>
      <td style={{padding:"7px 10px",color:opt.delta!=null?(opt.delta>=0?T.green:T.red):T.muted,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmt(opt.delta,3)}</td>
      <td style={{padding:"7px 10px",color:T.muted,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmtK(opt.totalVolume)}</td>
      <td style={{padding:"7px 10px",color:T.dim,fontSize:11,textAlign:"right"}} className="hide-mobile">{fmtK(opt.openInterest)}</td>
      {/* OI bar */}
      <td style={{padding:"7px 8px 7px 6px",minWidth:80,width:120}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <div style={{flex:1,height:6,background:T.border,borderRadius:3,overflow:"hidden"}}>
            <div style={{width:`${oiPct}%`,height:"100%",background:barColor+"99",borderRadius:3,transition:"width 0.3s ease"}}/>
          </div>
          <span style={{fontSize:9,color:T.muted,minWidth:28,textAlign:"right"}}>{oiPct}%</span>
        </div>
      </td>
    </tr>
  );
}

// ── Chain table ───────────────────────────────────────────────────────────────
function ChainTable({ calls, puts, stockPrice, showType, ticker, expiry, strikeCount, deepLink }) {
  const [activeChart, setActiveChart] = useState(null);

  useEffect(() => {
    if (!deepLink || !calls.length && !puts.length) return;
    setActiveChart(deepLink.strike);
  }, [deepLink, calls.length, puts.length]); // eslint-disable-line

  const allStrikes = [...new Set([...calls.map(o => o.strikePrice), ...puts.map(o => o.strikePrice)])].sort((a,b) => a-b);
  const callMap = Object.fromEntries(calls.map(o => [o.strikePrice, o]));
  const putMap  = Object.fromEntries(puts.map(o  => [o.strikePrice, o]));

  const filteredStrikes = (() => {
    if (!stockPrice) return allStrikes;
    const below = allStrikes.filter(s => s <= stockPrice).slice(-strikeCount);
    const above = allStrikes.filter(s => s >  stockPrice).slice(0, strikeCount);
    return [...below, ...above];
  })();

  const maxOI = Math.max(1, ...filteredStrikes.map(s => {
    const opt = showType === "Call" ? callMap[s] : putMap[s];
    return opt?.openInterest || 0;
  }));

  const thStyle = {padding:"6px 10px",textAlign:"right",color:T.muted,fontSize:9,fontFamily:T.font,letterSpacing:"0.08em",borderBottom:`1px solid ${T.border2}`,fontWeight:400};
  const handleToggle = (strike) => setActiveChart(prev => prev === strike ? null : strike);

  const activeIdx = activeChart ? filteredStrikes.indexOf(activeChart) : -1;
  const before    = activeIdx >= 0 ? filteredStrikes.slice(0, activeIdx + 1) : filteredStrikes;
  const after     = activeIdx >= 0 ? filteredStrikes.slice(activeIdx + 1) : [];
  const activeOpt = activeChart ? (showType==="Call" ? callMap[activeChart] : putMap[activeChart]) : null;

  const headers = (
    <thead>
      <tr style={{background:T.surface}}>
        <th style={{...thStyle,width:26}}></th>
        {["STRIKE","BID","ASK","MID","LAST","IV","DELTA","VOL","OI","OI BAR"].map((h,i) => (
          <th key={h} style={{...thStyle,...(i===9?{textAlign:"left",paddingLeft:8}:{})}} className={i>=4&&i!==9?"hide-mobile":""}>{h}</th>
        ))}
      </tr>
    </thead>
  );

  const renderRows = (strikes) => strikes.map(strike => {
    const opt = showType==="Call" ? callMap[strike] : putMap[strike];
    return <OptionRow key={strike} opt={opt} type={showType} stockPrice={stockPrice} activeChart={activeChart} onChartToggle={handleToggle} maxOI={maxOI}/>;
  });

  return (
    <div>
      <div style={{overflowX:"auto"}}>
        <table className="chain-table" style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          {headers}<tbody>{renderRows(before)}</tbody>
        </table>
      </div>
      {activeChart && activeOpt && (
        <ChartPanelDiv opt={activeOpt} type={showType} ticker={ticker} expiry={expiry}
          stockPrice={stockPrice} initialPeriod={deepLink?.strike===activeChart?deepLink.period:"day"}
          onClose={() => setActiveChart(null)}/>
      )}
      {after.length > 0 && (
        <div style={{overflowX:"auto"}}>
          <table className="chain-table" style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <tbody>{renderRows(after)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Expiry row ────────────────────────────────────────────────────────────────
function ExpiryRow({ expiry, dte, isOpen, onToggle, calls, puts, stockPrice, showType, onTypeChange, ticker, strikeCount, deepLink }) {
  const [dailyCandles, setDailyCandles] = useState(null);
  const totalVol = [...calls,...puts].reduce((s,o) => s+(o.totalVolume||0), 0);
  const totalOI  = [...calls,...puts].reduce((s,o) => s+(o.openInterest||0), 0);
  const dteColor = dte <= 7 ? T.red : dte <= 14 ? T.yellow : dte <= 30 ? T.blue : T.muted;

  useEffect(() => {
    if (!isOpen || dailyCandles || !ticker) return;
    fetch(`${PROXY}?path=/marketdata/v1/pricehistory&symbol=${ticker}&periodType=month&period=3&frequencyType=daily&frequency=1&needExtendedHoursData=false`)
      .then(r => r.json())
      .then(d => {
        if (d?.candles?.length)
          setDailyCandles(d.candles.map(c => ({ date: new Date(c.datetime).toISOString().slice(0,10), open:c.open, high:c.high, low:c.low, close:c.close })));
      })
      .catch(e => console.warn("[fib] candles:", e.message));
  }, [isOpen, ticker]); // eslint-disable-line

  return (
    <div style={{borderBottom:`1px solid ${T.border}`,overflow:"hidden"}}>
      <div className="expiry-row fade-in" onClick={onToggle}
        style={{display:"flex",alignItems:"center",padding:"12px 16px",gap:12,background:isOpen?T.card:T.surface}}>
        <span style={{color:T.muted,fontSize:10,width:12,transition:"transform 0.15s",transform:isOpen?"rotate(90deg)":"none",display:"inline-block"}}>▶</span>
        <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14,color:T.text,flex:1}}>
          {new Date(expiry+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
        </span>
        <span style={{fontSize:9,fontFamily:T.font,color:dteColor,background:dteColor+"18",border:`1px solid ${dteColor}33`,borderRadius:4,padding:"2px 7px",flexShrink:0}}>{dte}d</span>
        <span style={{fontSize:9,color:T.muted,fontFamily:T.font,flexShrink:0}} className="hide-mobile">Vol {fmtK(totalVol)} · OI {fmtK(totalOI)}</span>
      </div>
      {isOpen && (
        <div className="fade-in" style={{background:T.bg,borderTop:`1px solid ${T.border}`}}>
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
          {dailyCandles && <FibPanel candles={dailyCandles} stockPrice={stockPrice}/>}
          <ChainTable calls={calls} puts={puts} stockPrice={stockPrice} showType={showType}
            ticker={ticker} expiry={expiry} strikeCount={strikeCount}
            deepLink={deepLink?.expiry===expiry?deepLink:null}/>
        </div>
      )}
    </div>
  );
}

// ── Full page chart view ──────────────────────────────────────────────────────
function FullPageChart({ ticker, expiry, strike, type, period }) {
  const [opt,        setOpt]        = useState(null);
  const [stockPrice, setStockPrice] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  useEffect(() => {
    async function load() {
      try {
        // Fetch quote
        const qRes  = await fetch(`${PROXY}?path=/marketdata/v1/quotes&symbols=${ticker}&fields=quote&indicative=false`);
        const qData = await qRes.json();
        const q     = qData?.[ticker]?.quote ?? qData?.[ticker];
        if (q?.lastPrice) setStockPrice(q.lastPrice);

        // Fetch chain for this expiry to get the option data
        const cRes  = await fetch(`${PROXY}?path=/marketdata/v1/chains&symbol=${ticker}&contractType=ALL&strikeCount=50&fromDate=${expiry}&toDate=${expiry}`);
        const cData = await cRes.json();
        const map   = type === "Call" ? cData?.callExpDateMap : cData?.putExpDateMap;
        let found   = null;
        for (const [, strikes] of Object.entries(map || {}))
          for (const [, opts] of Object.entries(strikes))
            for (const o of opts)
              if (+o.strikePrice === +strike) found = o;
        if (!found) throw new Error(`No data found for ${ticker} $${strike} ${type} ${expiry}`);
        setOpt(found);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:T.font}}>
      <style>{css}</style>
      {/* Minimal header */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"10px 20px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:14,color:T.blue,letterSpacing:"0.04em"}}>
          OPTIONS<span style={{color:T.green}}>.</span>CHAIN
        </div>
        <span style={{fontSize:11,color:T.muted}}>
          {ticker} ${strike} {type} · {expiry}
        </span>
        <a href="/" style={{marginLeft:"auto",fontSize:10,color:T.muted,textDecoration:"none",border:`1px solid ${T.border}`,borderRadius:4,padding:"3px 10px"}}>
          ← Back to Chain
        </a>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"20px"}}>
        {loading && (
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"60px 0"}}>
            <Spinner/><span style={{fontSize:12,color:T.muted}}>Loading…</span>
          </div>
        )}
        {error && (
          <div style={{padding:"40px 20px",textAlign:"center",color:T.red,fontSize:12}}>⚠ {error}</div>
        )}
        {opt && !loading && (
          <ChartPanel
            opt={opt}
            type={type}
            ticker={ticker}
            expiry={expiry}
            stockPrice={stockPrice}
            initialPeriod={period}
            onClose={null}
            fullPage={true}
          />
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OptionsChain() {
  const [ticker,      setTicker]      = useState("");
  const [inputVal,    setInputVal]    = useState("");
  const [loading,     setLoading]     = useState(false);
  const [loadingExp,  setLoadingExp]  = useState(null);
  const [error,       setError]       = useState(null);
  const [stockPrice,  setStockPrice]  = useState(null);
  const [stockChange, setStockChange] = useState(null);
  const [expirations, setExpirations] = useState([]);
  const [chains,      setChains]      = useState({});
  const [openExpiry,  setOpenExpiry]  = useState(null);
  const [showType,    setShowType]    = useState("Call");
  const [strikeCount, setStrikeCount] = useState(5);
  const [deepLink,    setDeepLink]    = useState(null); // { expiry, strike, type, period }
  const [dailyCandles,setDailyCandles]= useState(null);

  const fetchTicker = useCallback(async (sym) => {
    if (!sym) return;
    setLoading(true); setError(null); setExpirations([]); setChains({}); setOpenExpiry(null); setStockPrice(null); setDailyCandles(null);
    ensureOITracking(sym);
    try {
      const qRes  = await fetch(`${PROXY}?path=/marketdata/v1/quotes&symbols=${sym}&fields=quote&indicative=false`);
      const qData = await qRes.json();
      const q     = qData?.[sym]?.quote ?? qData?.[sym];
      if (q?.lastPrice) {
        setStockPrice(q.lastPrice);
        setStockChange({ change: q.netChange, pct: q.netPercentChange });
      }
      // Daily candles for Fibonacci — fire and forget
      fetch(`${PROXY}?path=/marketdata/v1/pricehistory&symbol=${encodeURIComponent(sym)}&periodType=month&period=3&frequencyType=daily&frequency=1&needExtendedHoursData=false`)
        .then(r => r.json())
        .then(d => { if (d?.candles?.length) setDailyCandles(d.candles.map(c => ({ date: new Date(c.datetime).toISOString().slice(0,10), open:c.open, high:c.high, low:c.low, close:c.close }))); })
        .catch(() => {});
      const eRes  = await fetch(`${PROXY}?path=/marketdata/v1/expirationchain&symbol=${sym}`);
      const eData = await eRes.json();
      const today = new Date(); today.setHours(0,0,0,0);
      const exps  = (eData?.expirationList || [])
        .map(e => { const d = new Date(e.expirationDate+"T12:00:00"); return { expiry: e.expirationDate, dte: Math.ceil((d-today)/86400000) }; })
        .filter(e => e.dte >= 0)
        .sort((a,b) => a.dte - b.dte);
      setExpirations(exps);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchChain = useCallback(async (sym, expiry) => {
    if (chains[expiry]) return;
    setLoadingExp(expiry);
    try {
      const res  = await fetch(`${PROXY}?path=/marketdata/v1/chains&symbol=${sym}&contractType=ALL&strikeCount=40&fromDate=${expiry}&toDate=${expiry}`);
      const data = await res.json();
      const calls = [], puts = [];
      for (const [,strikes] of Object.entries(data?.callExpDateMap||{}))
        for (const [,opts] of Object.entries(strikes))
          for (const o of opts) calls.push(o);
      for (const [,strikes] of Object.entries(data?.putExpDateMap||{}))
        for (const [,opts] of Object.entries(strikes))
          for (const o of opts) puts.push(o);
      calls.sort((a,b) => a.strikePrice-b.strikePrice);
      puts.sort((a,b)  => a.strikePrice-b.strikePrice);
      setChains(prev => ({ ...prev, [expiry]: { calls, puts } }));
    } catch (err) {
      console.warn("Chain fetch failed:", err.message);
    } finally {
      setLoadingExp(null);
    }
  }, [chains]);

  // ── On mount: detect ?chart=1 params and auto-load ───────────────────────────
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("chart") !== "1") return;
    const sym    = p.get("ticker")?.toUpperCase();
    const expiry = p.get("expiry");
    const strike = parseFloat(p.get("strike"));
    const type   = p.get("type") || "Call";
    const period = p.get("period") || "day";
    if (!sym || !expiry || !strike) return;
    setDeepLink({ expiry, strike, type, period });
    setInputVal(sym);
    setTicker(sym);
    setShowType(type);
    setStrikeCount(20);
    fetchTicker(sym);
  }, []); // eslint-disable-line

  // ── Once expirations load, auto-open the deep-linked expiry ─────────────────
  useEffect(() => {
    if (!deepLink || !expirations.length || !ticker) return;
    const match = expirations.find(e => e.expiry === deepLink.expiry);
    if (!match) return;
    setOpenExpiry(deepLink.expiry);
    fetchChain(ticker, deepLink.expiry);
  }, [deepLink, expirations, ticker]); // eslint-disable-line

  const toggleExpiry = (expiry) => {
    if (openExpiry === expiry) { setOpenExpiry(null); }
    else { setOpenExpiry(expiry); fetchChain(ticker, expiry); }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const sym = inputVal.trim().toUpperCase();
    if (sym) { setTicker(sym); fetchTicker(sym); }
  };

  const changeDir = (stockChange?.change ?? 0) >= 0;

  // ── Full page chart mode ────────────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("chart") === "1") {
    return (
      <FullPageChart
        ticker={urlParams.get("ticker")?.toUpperCase() || ""}
        expiry={urlParams.get("expiry") || ""}
        strike={parseFloat(urlParams.get("strike") || "0")}
        type={urlParams.get("type") || "Call"}
        period={urlParams.get("period") || "day"}
      />
    );
  }

  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:T.font}}>
      <style>{css}</style>

      {/* Header */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"14px 20px",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:960,margin:"0 auto",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:16,color:T.blue,letterSpacing:"0.04em",flexShrink:0}}>
            OPTIONS<span style={{color:T.green}}>.</span>CHAIN
          </div>
          <form onSubmit={handleSearch} style={{display:"flex",gap:0,flex:1,minWidth:180,maxWidth:320}}>
            <input value={inputVal} onChange={e => setInputVal(e.target.value.toUpperCase())}
              placeholder="Enter ticker… AAPL"
              style={{flex:1,background:T.card,border:`1px solid ${T.border2}`,borderRight:"none",borderRadius:"6px 0 0 6px",color:T.text,fontFamily:T.font,fontSize:13,padding:"8px 12px",outline:"none"}}
            />
            <button type="submit"
              style={{background:T.blue+"22",border:`1px solid ${T.border2}`,borderRadius:"0 6px 6px 0",color:T.blue,fontFamily:T.font,fontSize:12,padding:"8px 14px",cursor:"pointer",fontWeight:600}}>
              {loading ? <Spinner size={14}/> : "→"}
            </button>
          </form>
          {stockPrice && (
            <div style={{display:"flex",alignItems:"baseline",gap:8,flexShrink:0}}>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:20,color:T.text}}>${(+stockPrice).toFixed(2)}</span>
              <span style={{fontSize:11,color:changeDir?T.green:T.red}}>
                {changeDir?"+":""}{fmt(stockChange?.change)} ({changeDir?"+":""}{fmt(stockChange?.pct,2)}%)
              </span>
            </div>
          )}
          {/* Strike count filter */}
          {stockPrice && (
            <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
              <span style={{fontSize:9,color:T.muted,letterSpacing:"0.06em",marginRight:4}}>STRIKES</span>
              {[3,5,10,20].map(n => (
                <button key={n} onClick={() => setStrikeCount(n)}
                  style={{background:strikeCount===n?T.blue+"22":"transparent",color:strikeCount===n?T.blue:T.muted,border:`1px solid ${strikeCount===n?T.blue+"55":T.border}`,borderRadius:4,padding:"3px 8px",fontSize:10,fontFamily:T.font,cursor:"pointer",fontWeight:strikeCount===n?600:400}}>
                  ±{n}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{maxWidth:960,margin:"0 auto"}}>
        {error && <div style={{padding:"16px 20px",color:T.red,fontSize:12,borderBottom:`1px solid ${T.border}`}}>⚠ {error}</div>}
        {!ticker && !loading && (
          <div style={{padding:"80px 20px",textAlign:"center"}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:32,fontWeight:800,color:T.border2,marginBottom:12}}>Enter a ticker</div>
            <div style={{fontSize:12,color:T.dim}}>Type a symbol above · click 📈 on any strike to view its chart</div>
          </div>
        )}
        {ticker && !loading && expirations.length===0 && !error && (
          <div style={{padding:"40px 20px",textAlign:"center",color:T.muted,fontSize:12}}>No expirations found for {ticker}</div>
        )}
        {expirations.length > 0 && (
          <div>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:T.text}}>{ticker}</span>
              <span style={{fontSize:10,color:T.muted}}>{expirations.length} expirations</span>
              <span style={{fontSize:10,color:T.muted,marginLeft:"auto"}}>Click 📈 on any strike to view chart + calculator</span>
            </div>
            {expirations.map(({ expiry, dte }) => {
              const chain     = chains[expiry] || { calls:[], puts:[] };
              const isLoading = loadingExp === expiry;
              const isOpen    = openExpiry === expiry;
              return (
                <div key={expiry}>
                  <ExpiryRow
                    expiry={expiry} dte={dte} isOpen={isOpen}
                    onToggle={() => toggleExpiry(expiry)}
                    calls={chain.calls} puts={chain.puts}
                    stockPrice={stockPrice} showType={showType}
                    onTypeChange={setShowType} ticker={ticker}
                    strikeCount={strikeCount}
                    deepLink={deepLink}
                    dailyCandles={dailyCandles}
                  />
                  {isLoading && (
                    <div style={{padding:"16px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:T.bg,borderBottom:`1px solid ${T.border}`}}>
                      <Spinner/><span style={{fontSize:11,color:T.muted}}>Loading {expiry}…</span>
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
