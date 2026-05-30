// api/dani-simulate.js
// DANI Simulation Engine v3 — backtests STO strategies against option_snapshots
// Tracks full P&L curve per trade to find optimal exit points
//
// Usage: /api/dani-simulate?secret=XXX          (full run, writes to dani_recommendations)
//        /api/dani-simulate?secret=XXX&dry_run=1 (returns results without writing)
//        /api/dani-simulate?secret=XXX&symbol=AAPL (single ticker)

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Range: "0-49999",             // override Supabase default 1000-row limit
      "Accept-Profile": "public",
    },
  });
  return r.json();
}

async function sbPost(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  return r.ok;
}

// ── Entry criteria ─────────────────────────────────────────────────────────
const STO_CRITERIA = {
  minOTMPct:   1.0,
  maxOTMPct:  10.0,
  minDTE:      1,
  maxDTE:     14,
  minMid:      0.50,
  maxAbsDelta: 0.50,
  optTypes:   ["call", "put"],
};

const PROFIT_THRESHOLDS = [40, 50, 60, 65, 70, 75, 80, 90];

const OTM_BANDS = [
  { label: "0-2%",  min: 0, max: 2 },
  { label: "2-4%",  min: 2, max: 4 },
  { label: "4-6%",  min: 4, max: 6 },
  { label: "6-10%", min: 6, max: 10 },
];

const DTE_RANGES = [
  { label: "1-3d",  min: 1, max: 3 },
  { label: "4-7d",  min: 4, max: 7 },
  { label: "8-14d", min: 8, max: 14 },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret   = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: "Unauthorized" });

  const dryRun     = req.query.dry_run === "1";
  const filterSym  = req.query.symbol?.toUpperCase() || null;
  const startTime  = Date.now();

  try {
    // ── Step 1: Get distinct tickers ───────────────────────────────────────
    const tickerRows = await sbGet(
      "option_snapshots?select=symbol" + (filterSym ? `&symbol=eq.${filterSym}` : "")
    );
    const tickers = [...new Set((Array.isArray(tickerRows) ? tickerRows : []).map(r => r.symbol))];
    if (!tickers.length) return res.status(200).json({ ok: true, message: "No tickers found" });

    console.log(`[dani] Simulating ${tickers.length} tickers: ${tickers.join(", ")}`);

    const allResults = [];
    const debug = [];

    for (const symbol of tickers) {
      // Check elapsed time — Vercel has 60s max for pro, 10s for hobby
      if (Date.now() - startTime > 55000) {
        console.log(`[dani] Time limit approaching, stopping at ${symbol}`);
        break;
      }

      console.log(`[dani] Processing ${symbol}...`);

      // ── Strategy: Instead of loading ALL snapshots (273k+ for AAPL),     ─
      // ── load only distinct contracts that match STO criteria,             ─
      // ── then load their time series individually.                         ─

      // Get the time range for this symbol, then generate evenly-spaced sample points
      const rangeRows = await sbGet(
        `option_snapshots?select=snapshot_at&symbol=eq.${symbol}&order=snapshot_at.asc&limit=1`
      );
      const rangeRowsEnd = await sbGet(
        `option_snapshots?select=snapshot_at&symbol=eq.${symbol}&order=snapshot_at.desc&limit=1`
      );
      const earliest = rangeRows?.[0]?.snapshot_at;
      const latest   = rangeRowsEnd?.[0]?.snapshot_at;
      if (!earliest || !latest) continue;

      const startMs = new Date(earliest).getTime();
      const endMs   = new Date(latest).getTime();
      const spanMs  = endMs - startMs;
      if (spanMs < 3600000) continue; // need at least 1 hour of data

      // Generate ~30 evenly-spaced sample points across the time range
      const sampleCount = 30;
      const entryTimestamps = [];
      for (let i = 0; i < sampleCount; i++) {
        const t = new Date(startMs + (spanMs * i / sampleCount));
        entryTimestamps.push(t.toISOString());
      }
      console.log(`[dani] ${symbol}: range ${earliest} -> ${latest}, ${sampleCount} sample points`);

      // For each entry timestamp, load STO candidates
      const trades = [];

      for (const entryTs of entryTimestamps) {
        // Load candidates at this timestamp matching STO criteria
        if (entryTs === entryTimestamps[0]) {
          const debugUrl = `option_snapshots?select=mid,otm_pct,dte,opt_type&symbol=eq.${symbol}&snapshot_at=gte.${entryTs}&snapshot_at=lt.${new Date(new Date(entryTs).getTime()+1000).toISOString()}&limit=5`;
          console.log(`[dani] DEBUG query URL: ${debugUrl}`);
          const debugResult = await sbGet(debugUrl);
          console.log(`[dani] DEBUG result: ${JSON.stringify(debugResult).slice(0,500)}`);
          debug.push({ debugUrl, debugResultCount: Array.isArray(debugResult) ? debugResult.length : 'not_array', debugSample: JSON.stringify(debugResult).slice(0,300), entryTs, isoConvert: new Date(new Date(entryTs).getTime()+1000).toISOString() });
        }
        // Find candidates in a 10-minute window around the sample point
        const winStart = entryTs;
        const winEnd   = new Date(new Date(entryTs).getTime() + 600000).toISOString();
        const candidates = await sbGet(
          `option_snapshots?select=expiry,strike,opt_type,dte,bid,ask,mid,iv,delta,stock_price,stock_change_pct,otm_pct,vix,rsi14,trend_regime,sma_alignment,snapshot_at` +
          `&symbol=eq.${symbol}&snapshot_at=gte.${winStart}&snapshot_at=lt.${winEnd}` +
          `&otm_pct=gte.${STO_CRITERIA.minOTMPct}&otm_pct=lte.${STO_CRITERIA.maxOTMPct}` +
          `&dte=gte.${STO_CRITERIA.minDTE}&dte=lte.${STO_CRITERIA.maxDTE}` +
          `&mid=gte.${STO_CRITERIA.minMid}` +
          `&limit=200`
        );
        // Deduplicate to one entry per contract (take earliest snapshot in window)
        const seen = new Set();
        const dedupedCandidates = [];
        for (const c of (Array.isArray(candidates) ? candidates : [])) {
          const key = `${c.expiry}|${c.strike}|${c.opt_type}`;
          if (!seen.has(key)) { seen.add(key); dedupedCandidates.push(c); }
        }
        console.log(`[dani] ${symbol} @ ${entryTs}: ${dedupedCandidates.length} candidates`);
        if (!dedupedCandidates.length) continue;

        for (const snap of dedupedCandidates) {
          if (!STO_CRITERIA.optTypes.includes(snap.opt_type)) continue;
          if (Math.abs(Number(snap.delta) || 0) > STO_CRITERIA.maxAbsDelta) continue;

          const entryMid = Number(snap.mid);
          if (entryMid <= 0) continue;

          // Load the forward time series for this specific contract
          const forward = await sbGet(
            `option_snapshots?select=mid,snapshot_at` +
            `&symbol=eq.${symbol}` +
            `&expiry=eq.${snap.expiry}&strike=eq.${snap.strike}&opt_type=eq.${snap.opt_type}` +
            `&snapshot_at=gt.${entryTs}` +
            `&order=snapshot_at&limit=5000`
          );
          if (!Array.isArray(forward) || forward.length < 2) continue;

          // Track full P&L curve
          let peakProfit = 0;
          let worstDrawdown = 0;
          let finalProfitPct = 0;
          let peakProfitTime = null;
          let finalTime = null;
          const thresholdsHit = {};
          const thresholdMins = {};

          for (const f of forward) {
            const fMid = Number(f.mid);
            if (fMid <= 0) continue;

            const profitPct = ((entryMid - fMid) / entryMid) * 100;
            const mins = (new Date(f.snapshot_at) - new Date(entryTs)) / 60000;

            if (profitPct > peakProfit) {
              peakProfit = profitPct;
              peakProfitTime = f.snapshot_at;
            }
            if (profitPct < worstDrawdown) {
              worstDrawdown = profitPct;
            }

            for (const thr of PROFIT_THRESHOLDS) {
              if (!thresholdsHit[thr] && profitPct >= thr) {
                thresholdsHit[thr] = true;
                thresholdMins[thr] = Math.round(mins);
              }
            }

            finalProfitPct = profitPct;
            finalTime = f.snapshot_at;
          }

          const minsToPeak = peakProfitTime
            ? Math.round((new Date(peakProfitTime) - new Date(entryTs)) / 60000)
            : null;

          trades.push({
            contractKey: `${snap.expiry}|${snap.strike}|${snap.opt_type}`,
            optType: snap.opt_type,
            otmPct: Number(snap.otm_pct),
            dte: Number(snap.dte),
            entryMid,
            peakProfit: Math.round(peakProfit * 100) / 100,
            worstDrawdown: Math.round(worstDrawdown * 100) / 100,
            finalProfitPct: Math.round(finalProfitPct * 100) / 100,
            thresholdsHit,
            thresholdMins,
            minsToPeak,
            trendRegime: snap.trend_regime || "unknown",
            rsi14: Number(snap.rsi14) || null,
            vix: Number(snap.vix) || null,
            stockChangePct: Number(snap.stock_change_pct) || 0,
          });
        }
      }

      console.log(`[dani] ${symbol}: ${trades.length} simulated trades`);

      // ── Aggregate by bucket ────────────────────────────────────────────
      for (const optType of STO_CRITERIA.optTypes) {
        for (const band of OTM_BANDS) {
          for (const dteR of DTE_RANGES) {
            const bucket = trades.filter(t =>
              t.optType === optType &&
              t.otmPct >= band.min && t.otmPct < band.max &&
              t.dte >= dteR.min && t.dte <= dteR.max
            );
            if (bucket.length < 3) continue;

            const thresholdStats = {};
            for (const thr of PROFIT_THRESHOLDS) {
              const hitCount = bucket.filter(t => t.thresholdsHit[thr]).length;
              const hitRate = hitCount / bucket.length;
              const hitTrades = bucket.filter(t => t.thresholdMins[thr]);
              const avgMins = hitTrades.length
                ? hitTrades.reduce((s, t) => s + t.thresholdMins[thr], 0) / hitTrades.length
                : 0;

              thresholdStats[thr] = {
                hitRate: Math.round(hitRate * 10000) / 10000,
                hitCount,
                avgMinsToHit: Math.round(avgMins),
              };
            }

            const avgPeakProfit = bucket.reduce((s, t) => s + t.peakProfit, 0) / bucket.length;
            const avgWorstDD    = bucket.reduce((s, t) => s + t.worstDrawdown, 0) / bucket.length;
            const avgFinal      = bucket.reduce((s, t) => s + t.finalProfitPct, 0) / bucket.length;
            const avgPremium    = bucket.reduce((s, t) => s + t.entryMid, 0) / bucket.length * 100;
            const avgMinsToPeak = bucket.filter(t => t.minsToPeak != null).length
              ? bucket.filter(t => t.minsToPeak != null).reduce((s, t) => s + t.minsToPeak, 0) /
                bucket.filter(t => t.minsToPeak != null).length
              : 0;

            const regimes = {};
            bucket.forEach(t => { regimes[t.trendRegime] = (regimes[t.trendRegime] || 0) + 1; });
            const dominantRegime = Object.entries(regimes).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

            const avgVix = bucket.filter(t => t.vix).length
              ? bucket.filter(t => t.vix).reduce((s, t) => s + t.vix, 0) / bucket.filter(t => t.vix).length
              : 0;

            // Optimal exit: highest hitRate × threshold product
            let optimalThreshold = 65;
            let optimalScore = 0;
            for (const thr of PROFIT_THRESHOLDS) {
              const score = thresholdStats[thr].hitRate * thr;
              if (score > optimalScore) {
                optimalScore = score;
                optimalThreshold = thr;
              }
            }

            allResults.push({
              symbol,
              opt_type: optType,
              otm_band: band.label,
              otm_pct_mid: (band.min + band.max) / 2,
              dte_range: dteR.label,
              dte_mid: Math.round((dteR.min + dteR.max) / 2),
              entries: bucket.length,
              avg_peak_profit: Math.round(avgPeakProfit * 100) / 100,
              avg_worst_drawdown: Math.round(avgWorstDD * 100) / 100,
              avg_final_pnl: Math.round(avgFinal * 100) / 100,
              avg_premium: Math.round(avgPremium * 100) / 100,
              avg_mins_to_peak: Math.round(avgMinsToPeak),
              threshold_stats: thresholdStats,
              optimal_exit_pct: optimalThreshold,
              optimal_exit_score: Math.round(optimalScore * 100) / 100,
              dominant_regime: dominantRegime,
              avg_vix: Math.round(avgVix * 100) / 100,
              confidence: bucket.length >= 20 ? "high" : bucket.length >= 10 ? "medium" : "low",
            });
          }
        }
      }
    }

    allResults.sort((a, b) => b.optimal_exit_score - a.optimal_exit_score);

    // ── Build recommendations ──────────────────────────────────────────────
    const recommendations = [];
    const seenSymbols = new Set();

    for (const r of allResults) {
      if (seenSymbols.has(r.symbol)) continue;
      if (r.entries < 5) continue;
      if (r.avg_peak_profit <= 0) continue;

      seenSymbols.add(r.symbol);
      const optThr = r.threshold_stats[r.optimal_exit_pct] || {};
      recommendations.push({
        symbol:       r.symbol,
        rec_type:     r.opt_type === "call" ? "STO_CALL" : "STO_PUT",
        otm_pct:      r.otm_pct_mid,
        target_pct:   r.optimal_exit_pct,
        stop_pct:     200,
        confidence:   r.confidence,
        ev:           r.optimal_exit_score,
        win_rate:     optThr.hitRate || 0,
        generated_at: new Date().toISOString(),
        expires_at:   new Date(Date.now() + 7 * 86400000).toISOString(),
      });
    }

    if (!dryRun && recommendations.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/dani_recommendations?generated_at=lt.${new Date().toISOString()}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      await sbPost("dani_recommendations", recommendations);
      console.log(`[dani] Wrote ${recommendations.length} recommendations`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    res.status(200).json({
      ok: true,
      dryRun,
      elapsed: `${elapsed}s`,
      tickers: tickers.length,
      totalBuckets: allResults.length,
      recommendations: recommendations.length,
      topResults: allResults.slice(0, 30),
      debug: debug.slice(0, 3),
      ...(dryRun ? { recommendationsList: recommendations } : {}),
    });

  } catch (err) {
    console.error("[dani]", err);
    res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
