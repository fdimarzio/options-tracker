// OpportunityScanner.jsx
// Extracted from pri-tod-v3.jsx for use in the unified options chain app.
// New prop: onOpenChain(ticker) — called when user clicks "View Chain →" on an opp card.

import React, { useState, useRef, useEffect } from "react";

const PROXY = "https://options-tracker-five.vercel.app/api/schwab-proxy";

// ── Ticker universe ────────────────────────────────────────────────────────────
const SCAN_TICKERS = [
  "AAPL","AMZN","AMD","CAT","CEG","COST","GOOG","GOOGL","JPM","LMT","MSFT","NFLX","NVDA","OKLO","TKO","UPS","WDC",
  "TSLA","META","BAC","GS","WFC","C","MS","BX","PLTR","SMCI",
  "INTC","CSCO","MU","ORCL","CRM","XOM","CVX","OXY","SLB","HAL",
  "PFE","MRNA","JNJ","ABBV","LLY","UBER","F","GM","T","VZ",
  "DIS","BA","GE","V","AVGO",
  "GEV",  // GE Vernova — bull flag BTO validation candidate
];

// ── Backtest EV stats ──────────────────────────────────────────────────────────
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
  GEV:{wr:0.250,avgPrem:15.00,avgProfit:45.00,ev:2.50}, // stub — BTO validation candidate; update after real backtest
};

// ── Ticker tiers ───────────────────────────────────────────────────────────────
const TICKER_TIERS = {
  COST:"safe",JPM:"safe",NFLX:"safe",TKO:"safe",MSFT:"safe",UPS:"safe",
  AAPL:"safe",GOOG:"safe",GOOGL:"safe",LMT:"safe",AMZN:"safe",
  JNJ:"safe",WFC:"safe",BAC:"safe",META:"safe",ABBV:"safe",CVX:"safe",
  V:"safe",GS:"safe",CRM:"safe",BX:"safe",T:"safe",XOM:"safe",
  NVDA:"watch",CAT:"watch",CEG:"watch",AVGO:"watch",GE:"watch",
  DIS:"watch",BA:"watch",C:"watch",MS:"watch",CSCO:"watch",
  PFE:"watch",UBER:"watch",GM:"watch",HAL:"watch",SLB:"watch",
  OXY:"watch",LLY:"watch",F:"watch",VZ:"watch",GEV:"watch",
  AMD:"high_risk",OKLO:"high_risk",WDC:"high_risk",MU:"high_risk",
  INTC:"high_risk",SMCI:"high_risk",MRNA:"high_risk",PLTR:"high_risk",
  TSLA:"high_risk",ORCL:"high_risk",
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function stoRiskScore(ticker, changePct) {
  const tier  = TICKER_TIERS[ticker] || "watch";
  const flags = [];
  if (tier === "high_risk")            flags.push({ name:"High Risk Ticker", sev:3 });
  if (tier === "watch")                flags.push({ name:"Watch Tier",       sev:2 });
  if (changePct < -2)                  flags.push({ name:"Big Down >2%",     sev:3 });
  if (changePct > 3)                   flags.push({ name:"Big Up >3%",       sev:3 });
  if (changePct >= -2 && changePct < 0)flags.push({ name:"Mild Down",        sev:1 });
  if (tier === "safe")                 flags.push({ name:"Safe Tier",        sev:-1 });
  if (changePct >= 0 && changePct <= 2)flags.push({ name:"Sweet Spot",       sev:-1 });
  return { score: flags.reduce((s, f) => s + f.sev, 0), tier, flags };
}

function rankOptions(opts, stockPrice, type) {
  return opts
    .filter(o => o.bid > 0.05 && o.ask > 0 && o.openInterest > 0)
    .map(o => {
      const mid       = (o.bid + o.ask) / 2;
      const otmPct    = Math.abs(o.strike - stockPrice) / stockPrice * 100;
      const spread    = o.ask - o.bid;
      const spreadPct = mid > 0 ? spread / mid : 99;
      const today     = new Date(); today.setHours(0,0,0,0);
      const exp       = new Date(o.expiryDate + "T12:00:00");
      const dte       = Math.round((exp - today) / 86400000);
      const stoScore  = dte > 0 && otmPct > 0 ? (mid / (otmPct * Math.sqrt(dte))) * (1 - Math.min(spreadPct, 1) * 0.5) : 0;
      const btoStat   = BTO_STATS[o.ticker];
      const btoScore  = btoStat && mid > 0 ? (btoStat.wr * btoStat.avgProfit) / mid : 0;
      return { ...o, mid, otmPct, dte, spreadPct, stoScore, btoScore };
    })
    .filter(o => o.spreadPct < 0.5)
    .sort((a, b) => type === "STO" ? b.stoScore - a.stoScore : b.btoScore - a.btoScore)
    .slice(0, 3);
}

function nextMWFExpiries(n = 2) {
  const dates = []; const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + 1);
  while (dates.length < n) {
    const dow = d.getDay();
    if (dow === 1 || dow === 3 || dow === 5) dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ── Component ──────────────────────────────────────────────────────────────────
export function OpportunityScannerTab({ onOpenChain }) {
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

  useEffect(() => { return () => { scanningRef.current = false; }; }, []);

  const addLog = (msg, type = "info") => {
    const ts = new Date().toLocaleTimeString();
    setScanLog(prev => [{ ts, msg, type }, ...prev].slice(0, 100));
  };

  async function fetchChainForOpp(opp) {
    const expiries = nextMWFExpiries(2);
    try {
      const calls = [];
      for (const expiry of expiries) {
        if (!scanningRef.current && !customScanning) break;
        const res  = await fetch(`${PROXY}?path=/marketdata/v1/chains&symbol=${opp.ticker}&contractType=ALL&strikeCount=20&fromDate=${expiry}&toDate=${expiry}`);
        const data = await res.json();
        for (const [,strikes] of Object.entries(data?.callExpDateMap || {}))
          for (const [,opts] of Object.entries(strikes))
            for (const o of opts)
              calls.push({ ...o, expiryDate:expiry, ticker:opp.ticker, strike:o.strikePrice, bid:o.bid, ask:o.ask, iv:o.volatility, delta:o.delta, openInterest:o.openInterest, volume:o.totalVolume });
      }
      const stockPrice   = opp.price;
      const filteredOpts = opp.type === "STO"
        ? calls.filter(o => o.strike > stockPrice * 0.98)
        : calls.filter(o => o.strike >= stockPrice * 0.99 && o.strike <= stockPrice * 1.06);
      const ranked = rankOptions(filteredOpts, stockPrice, opp.type);
      return { ...opp, chainOptions: ranked, chainFetched: true };
    } catch (e) {
      addLog(`Chain fetch failed for ${opp.ticker}: ${e.message}`, "error");
      return { ...opp, chainOptions: [], chainFetched: true, chainError: e.message };
    }
  }

  async function runScanCycle() {
    if (!scanningRef.current) return;
    addLog(`Cycle ${cycleCount + 1} — pass 1: scanning ${SCAN_TICKERS.length} tickers`, "system");
    setPhase("quotes"); setScanTotal(SCAN_TICKERS.length);
    let vix = null;
    try {
      const vr = await fetch(`${PROXY}?path=/marketdata/v1/quotes&symbols=%24VIX&fields=quote`);
      const vd = await vr.json(); vix = vd?.["$VIX"]?.quote?.lastPrice ?? null;
    } catch (e) {}

    const shortlist = [];
    for (let i = 0; i < SCAN_TICKERS.length; i += QUOTE_BATCH) {
      if (!scanningRef.current) break;
      const batch = SCAN_TICKERS.slice(i, i + QUOTE_BATCH);
      for (const t of batch) {
        setCurrentTicker(t); setScanIndex(i + batch.indexOf(t));
        setScannedTickers(prev => [...prev.filter(x => x !== t), t]);
        await new Promise(r => setTimeout(r, TICK_DELAY));
        if (tickerStripRef.current) {
          const el = tickerStripRef.current.querySelector(`[data-ticker="${t}"]`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
      }
      try {
        const res  = await fetch(`${PROXY}?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(batch.join(","))}&fields=quote`);
        const data = await res.json();
        for (const ticker of batch) {
          const q = data?.[ticker]?.quote; if (!q) continue;
          const close     = q.closePrice ?? q.lastPrice ?? 0;
          const last      = q.lastPrice ?? q.mark ?? 0;
          const changePct = close > 0 ? (last - close) / close * 100 : 0;
          const { score, tier, flags } = stoRiskScore(ticker, changePct);
          const btoStat   = BTO_STATS[ticker];
          const isSTO     = score <= 3;
          const isBTO     = btoStat?.ev > 0 && Math.abs(changePct) >= 1.5;
          const cpStr     = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
          const flagNames = flags.filter(f => f.sev > 0).map(f => f.name).join(", ");
          if (isSTO && isBTO) addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — STO risk:${score} + BTO · ${tier}${flagNames ? " · " + flagNames : ""}`, "good");
          else if (isSTO)     addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — STO risk:${score} · ${tier}${flagNames ? " · flags: " + flagNames : ""}`, score <= 1 ? "good" : "caution");
          else if (isBTO)     addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — BTO · EV +$${btoStat.ev.toFixed(2)} · ${tier}`, "bto");
          else                addLog(`${ticker} $${last.toFixed(2)} ${cpStr} — skip · risk:${score} tier:${tier}${flagNames ? " · " + flagNames : ""}`, "info");
          if (isSTO) shortlist.push({ type:"STO", ticker, price:last, changePct, riskScore:score, tier, flags, vix });
          if (isBTO) shortlist.push({ type:"BTO", ticker, price:last, changePct, btoEv:btoStat.ev, btoWr:btoStat.wr, tier, flags:[], vix });
        }
      } catch (e) { addLog(`Batch failed: ${e.message}`, "error"); }
      if (i + QUOTE_BATCH < SCAN_TICKERS.length && scanningRef.current)
        await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
    if (!scanningRef.current) return;
    addLog(`Pass 1 complete — ${shortlist.length} candidates (${shortlist.filter(o => o.type === "STO").length} STO, ${shortlist.filter(o => o.type === "BTO").length} BTO)`, "system");
    if (shortlist.length > 0) {
      setPhase("chains"); setScanTotal(shortlist.length);
      addLog(`Pass 2 — fetching chains for ${shortlist.length} candidates`, "system");
      const enriched = [];
      for (let i = 0; i < shortlist.length; i++) {
        if (!scanningRef.current) break;
        const opp = shortlist[i];
        setCurrentTicker(opp.ticker); setScanIndex(i);
        setChainStatus(prev => ({ ...prev, [opp.ticker + "-" + opp.type]: "fetching" }));
        addLog(`${opp.type} ${opp.ticker} — fetching chain · $${opp.price?.toFixed(2)} ${opp.changePct >= 0 ? "+" : ""}${opp.changePct?.toFixed(2)}% · risk ${opp.riskScore ?? "BTO"}`, opp.type === "BTO" ? "bto" : "caution");
        const result = await fetchChainForOpp(opp);
        setChainStatus(prev => ({ ...prev, [opp.ticker + "-" + opp.type]: result.chainOptions?.length > 0 ? "found" : "empty" }));
        if (result.chainOptions?.length > 0) {
          const top      = result.chainOptions[0];
          const mid      = top.mid ?? (top.bid + top.ask) / 2;
          const annYield = top.dte > 0 && opp.price > 0 ? (mid / opp.price * 365 / top.dte * 100).toFixed(1) : "—";
          const ivStr    = top.iv ? ` · IV ${(top.iv * 100).toFixed(0)}%` : "";
          const evStr    = opp.type === "BTO" && BTO_STATS[opp.ticker] ? ` · EV/cost ${((BTO_STATS[opp.ticker].wr * BTO_STATS[opp.ticker].avgProfit) / mid).toFixed(1)}x` : "";
          addLog(`${opp.type} ${opp.ticker} — best: $${top.strike} ${top.expiryDate} ${top.dte}d · bid $${top.bid?.toFixed(2)} ask $${top.ask?.toFixed(2)} mid $${mid?.toFixed(2)}${ivStr} · Δ${top.delta?.toFixed(2)} OI ${top.openInterest?.toLocaleString()}${opp.type === "STO" ? " · ann yield " + annYield + "%" : evStr}`, "good");
        } else {
          addLog(`${opp.type} ${opp.ticker} — no liquid options found`, "error");
        }
        enriched.push(result);
        await new Promise(r => setTimeout(r, CHAIN_DELAY));
      }
      setOpportunities(enriched.sort((a, b) => {
        if (a.type !== b.type) return a.type === "STO" ? -1 : 1;
        if (a.type === "STO")  return a.riskScore - b.riskScore;
        return (b.btoEv || 0) - (a.btoEv || 0);
      }));
    }
    if (scanningRef.current) {
      setCycleCount(c => c + 1); setLastScan(new Date()); setCurrentTicker(null); setPhase(null);
      addLog("Cycle complete — next cycle starting", "system");
      setTimeout(runScanCycle, 2000);
    }
  }

  async function scanSingleTicker() {
    const ticker = customTicker.trim().toUpperCase(); if (!ticker) return;
    setCustomScanning(true); setScanLog([]); setChainStatus({});
    addLog(`Manual scan: ${ticker}`, "system");
    try {
      const res  = await fetch(`${PROXY}?path=/marketdata/v1/quotes&symbols=${encodeURIComponent(ticker)}&fields=quote`);
      const data = await res.json();
      const q    = data?.[ticker]?.quote;
      if (!q) { addLog(`${ticker} — no quote data`, "error"); setCustomScanning(false); return; }
      const close     = q.closePrice ?? q.lastPrice ?? 0;
      const last      = q.lastPrice ?? q.mark ?? 0;
      const changePct = close > 0 ? (last - close) / close * 100 : 0;
      const { score, tier, flags } = stoRiskScore(ticker, changePct);
      const btoStat   = BTO_STATS[ticker];
      const cpStr     = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
      const flagNames = flags.filter(f => f.sev > 0).map(f => f.name).join(", ");
      addLog(`${ticker} $${last.toFixed(2)} ${cpStr} · ${tier} tier · STO risk: ${score}${flagNames ? " · " + flagNames : ""}`, score <= 1 ? "good" : score <= 3 ? "caution" : "error");
      if (btoStat) addLog(`${ticker} BTO — hist EV $${btoStat.ev.toFixed(2)} · win rate ${(btoStat.wr * 100).toFixed(0)}% · avg profit $${btoStat.avgProfit.toFixed(2)}`, btoStat.ev > 0 ? "bto" : "info");
      const candidates = [{ type:"STO", ticker, price:last, changePct, riskScore:score, tier, flags, vix:null }];
      if (btoStat) candidates.push({ type:"BTO", ticker, price:last, changePct, btoEv:btoStat.ev, btoWr:btoStat.wr, tier, flags:[], vix:null });
      addLog(`Fetching chains for ${ticker}...`, "system");
      const enriched = [];
      for (const opp of candidates) {
        setChainStatus(prev => ({ ...prev, [ticker + "-" + opp.type]: "fetching" }));
        addLog(`${opp.type} ${ticker} — fetching chain · risk score ${opp.riskScore ?? "BTO"}`, opp.type === "BTO" ? "bto" : "caution");
        const result = await fetchChainForOpp(opp);
        setChainStatus(prev => ({ ...prev, [ticker + "-" + opp.type]: result.chainOptions?.length > 0 ? "found" : "empty" }));
        if (result.chainOptions?.length > 0) {
          const top      = result.chainOptions[0];
          const mid      = top.mid ?? (top.bid + top.ask) / 2;
          const annYield = top.dte > 0 && opp.price > 0 ? (mid / opp.price * 365 / top.dte * 100).toFixed(1) : "—";
          const ivStr    = top.iv ? ` · IV ${(top.iv * 100).toFixed(0)}%` : "";
          const evStr    = opp.type === "BTO" && BTO_STATS[ticker] ? ` · EV/cost ${((BTO_STATS[ticker].wr * BTO_STATS[ticker].avgProfit) / mid).toFixed(1)}x` : "";
          addLog(`${opp.type} ${ticker} — best: $${top.strike} ${top.expiryDate} ${top.dte}d · bid $${top.bid?.toFixed(2)} ask $${top.ask?.toFixed(2)} mid $${mid?.toFixed(2)}${ivStr} · Δ${top.delta?.toFixed(2)} OI ${top.openInterest?.toLocaleString()}${opp.type === "STO" ? " · ann yield " + annYield + "%" : evStr}`, "good");
        } else {
          addLog(`${opp.type} ${ticker} — no liquid options found`, "error");
        }
        enriched.push(result);
      }
      setOpportunities(prev => {
        const filtered = prev.filter(o => o.ticker !== ticker);
        return [...filtered, ...enriched].sort((a, b) => {
          if (a.type !== b.type) return a.type === "STO" ? -1 : 1;
          if (a.type === "STO")  return a.riskScore - b.riskScore;
          return (b.btoEv || 0) - (a.btoEv || 0);
        });
      });
      addLog(`${ticker} scan complete`, "system");
    } catch (e) { addLog(`${ticker} scan failed: ${e.message}`, "error"); }
    setCustomScanning(false);
  }

  const startScanning = () => { scanningRef.current = true; setScanning(true); setOpportunities([]); setScanLog([]); setCycleCount(0); setScannedTickers([]); setChainStatus({}); runScanCycle(); };
  const stopScanning  = () => { scanningRef.current = false; setScanning(false); setCurrentTicker(null); setPhase(null); addLog("Scanning stopped", "system"); };

  const pct         = scanTotal > 0 ? Math.min((scanIndex / scanTotal) * 100, 100) : 0;
  const stoOpps     = opportunities.filter(o => o.type === "STO");
  const btoOpps     = opportunities.filter(o => o.type === "BTO");
  const tierColor   = t => t === "safe" ? "#3fb950" : t === "watch" ? "#ffd166" : "#ff4560";
  const riskColor   = s => s <= 1 ? "#3fb950" : s <= 3 ? "#ffd166" : s <= 5 ? "#ff9500" : "#ff4560";
  const logColor    = t => t === "good" ? "#3fb950" : t === "bto" ? "#58a6ff" : t === "caution" ? "#ffd166" : t === "error" ? "#ff4560" : t === "system" ? "#8b949e" : "#e6edf3";
  const phaseLabel  = phase === "quotes" ? "SCANNING QUOTES" : phase === "chains" ? "FETCHING CHAINS" : scanning ? "IDLE" : "";

  const renderChainOptions = (opp) => {
    if (!opp.chainFetched) return <div style={{padding:"12px",color:"#8b949e",fontSize:9,textAlign:"center"}}>⟳ Fetching live chain data...</div>;
    if (!opp.chainOptions?.length) return <div style={{padding:"12px",color:"#484f58",fontSize:9,textAlign:"center"}}>No liquid options found</div>;
    const btoStat = BTO_STATS[opp.ticker];
    return (
      <div style={{borderTop:"1px solid #21262d"}}>
        <div style={{padding:"6px 12px",background:"#0d1117",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:8,color:"#8b949e",letterSpacing:"0.1em",fontWeight:700}}>TOP {opp.chainOptions.length} CALLS · {opp.type === "STO" ? "RANKED: PREMIUM ÷ RISK" : "RANKED: EV ÷ COST"}</span>
          {/* View chain button */}
          {onOpenChain && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChain(opp.ticker); }}
              style={{background:"#4fc3f722",color:"#4fc3f7",border:"1px solid #4fc3f744",borderRadius:4,padding:"3px 10px",fontSize:9,fontWeight:700,cursor:"pointer",letterSpacing:"0.06em",fontFamily:"monospace"}}
            >
              View Full Chain →
            </button>
          )}
        </div>
        {opp.chainOptions.map((o, i) => {
          const mid       = o.mid ?? (o.bid + o.ask) / 2;
          const annYield  = o.dte > 0 && opp.price > 0 ? (mid / opp.price * 365 / o.dte * 100) : 0;
          const otmPct    = opp.price > 0 ? (Math.abs(o.strike - opp.price) / opp.price * 100) : 0;
          const evRatio   = opp.type === "BTO" && btoStat && mid > 0 ? (btoStat.wr * btoStat.avgProfit) / mid : null;
          const premPct   = opp.price > 0 ? (mid / opp.price * 100) : 0;
          const spreadTight = o.spreadPct < 0.15;
          const rankCol   = i === 0 ? "#ffd166" : i === 1 ? "#8b949e" : "#484f58";
          return (
            <div key={i} style={{padding:"10px 12px",borderBottom:"1px solid #21262d",background:i===0?"#ffffff06":"transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:18,height:18,borderRadius:3,background:rankCol+"22",color:rankCol,fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                <span style={{fontSize:13,fontWeight:700,color:"#e6edf3"}}>${o.strike} Call</span>
                <span style={{fontSize:10,color:"#8b949e"}}>{o.expiryDate}</span>
                <span style={{fontSize:9,background:"#58a6ff22",color:"#58a6ff",border:"1px solid #58a6ff44",borderRadius:3,padding:"1px 6px"}}>{o.dte}d</span>
                <span style={{fontSize:9,color:"#8b949e"}}>{otmPct.toFixed(1)}% OTM</span>
                {i === 0 && <span style={{fontSize:8,color:"#ffd166",fontWeight:700,marginLeft:"auto"}}>★ TOP PICK</span>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:6}}>
                {[{label:"BID",val:`$${o.bid?.toFixed(2)}`,col:"#e6edf3"},{label:"ASK",val:`$${o.ask?.toFixed(2)}`,col:"#e6edf3"},{label:"MID",val:`$${mid?.toFixed(2)}`,col:"#3fb950"},{label:"SPREAD",val:`${(o.spreadPct*100).toFixed(0)}%`,col:spreadTight?"#3fb950":"#ffd166"}].map(({label,val,col})=>(
                  <div key={label} style={{background:"#21262d",borderRadius:4,padding:"4px 6px",textAlign:"center"}}>
                    <div style={{fontSize:7,color:"#484f58",letterSpacing:"0.06em"}}>{label}</div>
                    <div style={{fontSize:10,fontWeight:700,color:col}}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:6}}>
                {[{label:"IV",val:o.iv?`${(o.iv*100).toFixed(0)}%`:"—",col:"#ffd166"},{label:"DELTA",val:o.delta?o.delta.toFixed(3):"—",col:"#8b949e"},{label:"OI",val:o.openInterest?o.openInterest.toLocaleString():"—",col:"#8b949e"},{label:"VOL",val:o.volume?o.volume.toLocaleString():"—",col:"#8b949e"}].map(({label,val,col})=>(
                  <div key={label} style={{background:"#21262d",borderRadius:4,padding:"4px 6px",textAlign:"center"}}>
                    <div style={{fontSize:7,color:"#484f58",letterSpacing:"0.06em"}}>{label}</div>
                    <div style={{fontSize:10,fontWeight:700,color:col}}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                {opp.type === "STO" && <><span style={{fontSize:8,color:"#58a6ff"}}>Ann yield <b>{annYield.toFixed(1)}%</b></span><span style={{fontSize:8,color:"#8b949e"}}>Prem% <b>{premPct.toFixed(2)}%</b></span><span style={{fontSize:8,color:"#8b949e"}}>Max profit <b>${(mid*100).toFixed(0)}/contract</b></span></>}
                {opp.type === "BTO" && evRatio && <><span style={{fontSize:8,color:"#58a6ff"}}>EV/cost <b>{evRatio.toFixed(1)}x</b></span><span style={{fontSize:8,color:"#8b949e"}}>Hist win rate <b>{(btoStat.wr*100).toFixed(0)}%</b></span></>}
                <span style={{fontSize:8,color:spreadTight?"#3fb950":"#ffd166",marginLeft:"auto"}}>{spreadTight?"✓ Tight spread":"⚠ Wide spread"}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOppCard = (o, i) => {
    const isExpanded = expandedOpp === `${o.type}-${o.ticker}`;
    const borderCol  = o.type === "BTO" ? "#58a6ff" : riskColor(o.riskScore);
    return (
      <div key={`${o.ticker}-${o.type}-${i}`} style={{borderBottom:"1px solid #21262d",background:isExpanded?"#0d1117":"transparent"}}>
        <div onClick={() => setExpandedOpp(isExpanded ? null : `${o.type}-${o.ticker}`)} style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <div style={{width:32,height:32,borderRadius:"50%",border:`2px solid ${borderCol}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,flexDirection:"column",lineHeight:1.1}}>
            {o.type === "STO"
              ? <span style={{fontSize:11,fontWeight:700,color:borderCol}}>{o.riskScore}</span>
              : <><span style={{fontSize:7,color:borderCol}}>EV</span><span style={{fontSize:9,fontWeight:700,color:borderCol}}>${o.btoEv?.toFixed(1)}</span></>
            }
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,color:"#e6edf3"}}>{o.ticker}</span>
              <span style={{fontSize:9,background:borderCol+"22",color:borderCol,border:`1px solid ${borderCol}44`,borderRadius:3,padding:"1px 6px",fontWeight:600}}>{o.type}</span>
              <span style={{fontSize:9,background:tierColor(o.tier)+"18",color:tierColor(o.tier),border:`1px solid ${tierColor(o.tier)}33`,borderRadius:3,padding:"1px 5px"}}>{o.tier}</span>
              {o.chainOptions?.length > 0 && <span style={{fontSize:8,color:"#3fb950"}}>⛓ {o.chainOptions.length} options</span>}
            </div>
            <div style={{fontSize:9,color:"#8b949e",marginTop:2}}>
              ${o.price?.toFixed(2)} · {o.changePct >= 0 ? "+" : ""}{o.changePct?.toFixed(2)}%
              {o.vix && <span style={{marginLeft:8}}>VIX {o.vix?.toFixed(1)}</span>}
              {o.type === "STO" && o.flags?.filter(f=>f.sev>0).length > 0 && <span style={{color:"#ffd166",marginLeft:8}}>{o.flags.filter(f=>f.sev>0).map(f=>f.name).join(" · ")}</span>}
            </div>
          </div>
          {/* Quick "View Chain" button on card header */}
          {onOpenChain && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChain(o.ticker); }}
              style={{background:"transparent",color:"#4fc3f7",border:"1px solid #4fc3f733",borderRadius:4,padding:"3px 8px",fontSize:9,cursor:"pointer",flexShrink:0,fontFamily:"monospace"}}
              title={`Open ${o.ticker} in Chain tab`}
            >
              🔗
            </button>
          )}
          <span style={{fontSize:9,color:"#484f58",flexShrink:0}}>{isExpanded ? "▲" : "▼"}</span>
        </div>
        {isExpanded && renderChainOptions(o)}
      </div>
    );
  };

  return (
    <div style={{padding:"16px 20px",fontFamily:"monospace",minHeight:"100vh",background:"#0d1117"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#58a6ff",letterSpacing:"0.1em"}}>⟳ OPPORTUNITY SCANNER</div>
          <div style={{fontSize:10,color:"#8b949e",marginTop:2}}>{SCAN_TICKERS.length} tickers · 2-pass (quotes → chains) · continuous</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <input
              value={customTicker}
              onChange={e => setCustomTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && !customScanning && scanSingleTicker()}
              placeholder="TICKER" maxLength={6}
              style={{background:"#21262d",border:"1px solid #30363d",borderRadius:5,color:"#e6edf3",fontSize:11,fontWeight:700,padding:"5px 10px",width:80,letterSpacing:"0.08em",outline:"none",fontFamily:"monospace"}}
            />
            <button
              onClick={scanSingleTicker}
              disabled={!customTicker.trim() || customScanning}
              style={{background:customScanning?"#58a6ff11":"#58a6ff20",color:customScanning?"#484f58":"#58a6ff",border:`1px solid ${customScanning?"#30363d":"#58a6ff50"}`,borderRadius:5,padding:"5px 12px",fontSize:10,fontWeight:700,cursor:customScanning||!customTicker.trim()?"not-allowed":"pointer"}}
            >
              {customScanning ? "⟳" : "SCAN"}
            </button>
          </div>
          <div style={{width:"1px",height:20,background:"#30363d"}}/>
          {lastScan && <span style={{fontSize:9,color:"#484f58"}}>Last: {lastScan.toLocaleTimeString()}</span>}
          {cycleCount > 0 && <span style={{fontSize:9,color:"#484f58"}}>Cycle #{cycleCount}</span>}
          <button
            onClick={scanning ? stopScanning : startScanning}
            style={{background:scanning?"#ff456020":"#3fb95020",color:scanning?"#ff4560":"#3fb950",border:`1px solid ${scanning?"#ff456050":"#3fb95050"}`,borderRadius:6,padding:"6px 16px",fontSize:11,fontWeight:700,cursor:"pointer"}}
          >
            {scanning ? "⏹ STOP" : "▶ START SCANNING"}
          </button>
        </div>
      </div>

      {/* Progress panel */}
      {scanning && (
        <div style={{marginBottom:12,background:"#161b22",borderRadius:6,border:"1px solid #30363d",overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #21262d",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.08em",color:phase==="quotes"?"#58a6ff":phase==="chains"?"#ffd166":"#8b949e"}}>{phaseLabel}</span>
              <span style={{fontSize:8,color:"#484f58"}}>{phase==="quotes"?`${Math.min(scanIndex+1,scanTotal)} / ${scanTotal} tickers`:phase==="chains"?`${Math.min(scanIndex+1,scanTotal)} / ${scanTotal} candidates`:""}</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{fontSize:8,color:phase==="quotes"?"#58a6ff":"#484f58"}}>⬤ Pass 1: Quotes</span>
              <span style={{fontSize:8,color:phase==="chains"?"#ffd166":"#484f58"}}>⬤ Pass 2: Chains</span>
            </div>
          </div>
          <div style={{height:2,background:"#21262d"}}>
            <div style={{width:`${pct}%`,height:"100%",transition:"width 0.3s ease",background:phase==="chains"?"#ffd166":"#58a6ff"}}/>
          </div>
          <div style={{padding:"6px 12px",borderBottom:"1px solid #21262d"}}>
            <div ref={tickerStripRef} style={{display:"flex",gap:4,overflowX:"auto",scrollbarWidth:"none",paddingBottom:2}}>
              {SCAN_TICKERS.map(t => {
                const isCurrent = t === currentTicker;
                const isScanned = scannedTickers.includes(t);
                return (
                  <span key={t} data-ticker={t} style={{flexShrink:0,fontSize:isCurrent?11:9,fontWeight:isCurrent?700:400,color:isCurrent?"#ffffff":isScanned?"#3fb950":"#484f58",background:isCurrent?"#58a6ff33":"transparent",border:isCurrent?"1px solid #58a6ff88":"1px solid transparent",borderRadius:3,padding:"1px 5px",transition:"all 0.2s ease"}}>{t}</span>
                );
              })}
            </div>
          </div>
          {phase === "chains" && (
            <div style={{padding:"6px 12px"}}>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {Object.entries(chainStatus).map(([key, status]) => {
                  const [ticker, type] = key.split("-");
                  const isActive = ticker === currentTicker;
                  const col = status==="found"?"#3fb950":status==="empty"?"#484f58":isActive?"#ffd166":"#8b949e";
                  return (
                    <span key={key} style={{fontSize:9,fontWeight:isActive?700:400,color:col,background:isActive?col+"22":"transparent",border:`1px solid ${isActive?col+"66":"transparent"}`,borderRadius:3,padding:"1px 6px",transition:"all 0.2s ease"}}>
                      {status==="fetching"?`⟳ ${ticker}`:status==="found"?`✓ ${ticker}`:`— ${ticker}`}
                      <span style={{fontSize:7,color:"#484f58",marginLeft:3}}>{type}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:9,fontWeight:700,color:"#3fb950",letterSpacing:"0.1em"}}>STO OPPORTUNITIES</span>
            <span style={{fontSize:9,color:"#484f58"}}>{stoOpps.length} found</span>
          </div>
          <div style={{maxHeight:360,overflowY:"auto"}}>
            {stoOpps.length === 0
              ? <div style={{padding:"24px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>{scanning?"Scanning...":"Start scanner to find opportunities"}</div>
              : stoOpps.map(renderOppCard)}
          </div>
        </div>
        <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
          <div style={{padding:"7px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:9,fontWeight:700,color:"#58a6ff",letterSpacing:"0.1em"}}>BTO OPPORTUNITIES</span>
            <span style={{fontSize:9,color:"#484f58"}}>{btoOpps.length} found</span>
          </div>
          <div style={{maxHeight:360,overflowY:"auto"}}>
            {btoOpps.length === 0
              ? <div style={{padding:"24px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>{scanning?"Watching for moves ≥1.5%...":"Start scanner to find opportunities"}</div>
              : btoOpps.map(renderOppCard)}
          </div>
        </div>
      </div>

      {/* Scan log */}
      <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
        <div style={{padding:"6px 12px",borderBottom:"1px solid #30363d",display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:9,fontWeight:700,color:"#8b949e",letterSpacing:"0.1em"}}>SCAN LOG</span>
          <span style={{fontSize:9,color:"#484f58"}}>{scanLog.length} events</span>
        </div>
        <div ref={logRef} style={{maxHeight:130,overflowY:"auto",padding:"2px 0"}}>
          {scanLog.length === 0
            ? <div style={{padding:"10px 12px",textAlign:"center",color:"#484f58",fontSize:10}}>No activity yet</div>
            : scanLog.map((l, i) => (
                <div key={i} style={{padding:"2px 12px",display:"flex",gap:8,alignItems:"baseline"}}>
                  <span style={{fontSize:8,color:"#484f58",flexShrink:0,width:64}}>{l.ts}</span>
                  <span style={{fontSize:9,color:logColor(l.type)}}>{l.msg}</span>
                </div>
              ))}
        </div>
      </div>

      {/* Summary bar */}
      {opportunities.length > 0 && (
        <div style={{display:"flex",gap:16,marginTop:10,padding:"7px 12px",background:"#161b22",borderRadius:6,border:"1px solid #30363d",flexWrap:"wrap"}}>
          <span style={{fontSize:9,color:"#8b949e"}}><span style={{color:"#3fb950",fontWeight:700}}>{stoOpps.filter(o=>o.riskScore<=1).length}</span> clean STO</span>
          <span style={{fontSize:9,color:"#8b949e"}}><span style={{color:"#ffd166",fontWeight:700}}>{stoOpps.filter(o=>o.riskScore>1&&o.riskScore<=3).length}</span> caution STO</span>
          <span style={{fontSize:9,color:"#8b949e"}}><span style={{color:"#58a6ff",fontWeight:700}}>{btoOpps.length}</span> BTO signals</span>
          <span style={{fontSize:9,color:"#8b949e"}}><span style={{color:"#e6edf3",fontWeight:700}}>{SCAN_TICKERS.length}</span> tickers watched</span>
          <span style={{fontSize:9,color:"#8b949e"}}><span style={{color:"#e6edf3",fontWeight:700}}>{opportunities.filter(o=>o.chainFetched&&o.chainOptions?.length>0).length}</span> with chain data</span>
        </div>
      )}
    </div>
  );
}
