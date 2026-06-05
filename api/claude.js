// api/claude.js
// Proxies requests to the Anthropic API
// Used by: Analytics AI assistant, Skynet scoring analysis, SAGE data explorer

const ANTHROPIC_API_KEY = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const MODEL = "claude-sonnet-4-5-20250929";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in Vercel environment variables" });
  }

  try {
    const { mode } = req.body;

    // ── Mode 1: Standard chat (Analytics AI assistant) ──────────────────────
    if (!mode || mode === "chat") {
      const { model, max_tokens, system, messages } = req.body;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        body: JSON.stringify({
          model:      model || MODEL,
          max_tokens: max_tokens || 1000,
          system,
          messages,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
        console.error("[claude] API error:", errMsg);
        return res.status(response.status).json({ error: errMsg });
      }
      return res.status(200).json(data);
    }

    // ── Mode 2: Skynet scoring analysis ─────────────────────────────────────
    if (mode === "skynet_analysis") {
      const { signals, outcomes, current_weights, factors } = req.body;

      if (!signals?.length) {
        return res.status(400).json({ error: "No signal data provided for analysis" });
      }

      // Build a compact data summary to stay within context limits
      const goodOutcomes = outcomes?.filter(o => o.signal_quality === "good") || [];
      const badOutcomes  = outcomes?.filter(o => o.signal_quality === "bad")  || [];
      const neutralOutcomes = outcomes?.filter(o => o.signal_quality === "neutral") || [];

      // Group factor values by factor name for analysis
      const factorStats = {};
      if (signals?.length) {
        signals.forEach(s => {
          if (!s.factor_name) return;
          if (!factorStats[s.factor_name]) factorStats[s.factor_name] = { values: [], goodValues: [], badValues: [] };
          factorStats[s.factor_name].values.push(+s.value);
          // Link to outcome via signal_id
          const outcome = outcomes?.find(o => o.signal_id === s.signal_id);
          if (outcome?.signal_quality === "good") factorStats[s.factor_name].goodValues.push(+s.value);
          if (outcome?.signal_quality === "bad")  factorStats[s.factor_name].badValues.push(+s.value);
        });
      }

      // Compute simple stats per factor
      const avg = arr => arr.length ? (arr.reduce((s,v) => s+v, 0) / arr.length).toFixed(2) : null;
      const factorSummary = Object.entries(factorStats).map(([name, d]) => ({
        factor:    name,
        avg_all:   avg(d.values),
        avg_good:  avg(d.goodValues),
        avg_bad:   avg(d.badValues),
        n_total:   d.values.length,
        n_good:    d.goodValues.length,
        n_bad:     d.badValues.length,
      }));

      const systemPrompt = `You are a quantitative trading analyst for PRI (Premium Recurring Income), an options trading system called Skynet that sells covered calls (STOs).

Your job is to analyze signal data and suggest which conditions lead to profitable trades. Be specific with numbers. Focus on actionable insights.

The system sells covered calls (STO = Sell To Open) and buys them back (BTC = Buy To Close).
- "good" outcome = profit ≥ 50% of premium collected
- "neutral" outcome = profit 0-49%  
- "bad" outcome = loss

Current scoring weights (to be tuned):
${JSON.stringify(current_weights, null, 2)}

Factor definitions:
${JSON.stringify(factors?.slice(0, 10), null, 2)}`;

      const userMessage = `Here is the signal analysis data:

Total signals: ${signals?.length || 0}
Outcomes breakdown: ${goodOutcomes.length} good, ${neutralOutcomes.length} neutral, ${badOutcomes.length} bad
Win rate: ${outcomes?.length ? (goodOutcomes.length / outcomes.length * 100).toFixed(1) : "N/A"}%

Factor statistics (avg value for good vs bad outcomes):
${JSON.stringify(factorSummary, null, 2)}

Please provide:
1. Which factors show the strongest correlation with good outcomes?
2. Which factors should have higher/lower weights?
3. Any surprising patterns?
4. Specific weight adjustment suggestions with rationale
5. What additional data would improve the model?

Respond in JSON format:
{
  "summary": "2-3 sentence plain English summary",
  "win_rate_analysis": "...",
  "patterns": [{ "finding": "...", "evidence": "...", "confidence": "high|medium|low" }],
  "weight_suggestions": [{ "factor_name": "...", "current_weight": 1.0, "suggested_weight": 1.5, "rationale": "..." }],
  "additional_data_needed": ["..."],
  "overall_recommendation": "..."
}`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 2000,
          system:     systemPrompt,
          messages:   [{ role: "user", content: userMessage }],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("[claude/skynet] API error:", JSON.stringify(data));
        return res.status(response.status).json(data);
      }

      // Parse the JSON response from Claude
      const text = data.content?.find(b => b.type === "text")?.text || "";
      let analysis = null;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
      } catch(e) {
        analysis = { summary: text, parse_error: true };
      }

      return res.status(200).json({ ok: true, analysis, raw: text });
    }

    // ── Mode 3: SAGE data explorer ───────────────────────────────────────────
    if (mode === "sage_data") {
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: "Supabase env vars not configured" });
      }

      const sbHeaders = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      };

      async function sbFetch(path) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
        if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} ${await r.text()}`);
        return r.json();
      }

      // Fetch contracts, signal_log, and scoring_factor_values in parallel
      const [contracts, signals, factorValues] = await Promise.all([
        sbFetch("contracts?select=*&limit=2000"),
        sbFetch("signal_log?select=*&order=id.desc&limit=2000"),
        sbFetch("scoring_factor_values?select=*&limit=5000"),
      ]);

      return res.status(200).json({ ok: true, contracts, signals, factorValues });
    }

    // ── Mode 4: SAGE Attention Scanner (LIVE — no signal dependency) ───────
    // Fetches live quotes + daily candles + chain IV for all held tickers,
    // computes all SAGE factors on the fly, scores and ranks right now.
    if (mode === "sage_scan") {
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: "Supabase env vars not configured" });
      }

      const SCHWAB_BASE = "https://api.schwabapi.com";
      const sbH = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
      const sb  = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH }).then(r => r.json());

      // ── Factor computation functions (mirrors market-refresh.js) ────────────
      function computeRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) return null;
        const closes = candles.map(c => c.close);
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period, avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
          avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        }
        if (avgLoss === 0) return 100;
        return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
      }

      function computeFibFactors(candles, stockPrice, lookback = 60) {
        if (!candles || candles.length < 10 || !stockPrice) return null;
        const window = candles.slice(-Math.min(lookback, candles.length));
        const swingHigh = Math.max(...window.map(c => c.high));
        const swingLow  = Math.min(...window.map(c => c.low));
        const range = swingHigh - swingLow;
        if (range <= 0) return null;
        const FIB_PCTS = [0.236, 0.382, 0.5, 0.618, 0.786];
        const levels = FIB_PCTS.map(pct => ({ pct, price: Math.round((swingHigh - pct * range) * 100) / 100 }));
        let nearestLevel = null, nearestDistPct = Infinity;
        for (const lvl of levels) {
          const distPct = Math.abs(stockPrice - lvl.price) / stockPrice * 100;
          if (distPct < nearestDistPct) { nearestDistPct = distPct; nearestLevel = lvl; }
        }
        const prevClose  = candles[candles.length - 2]?.close;
        const brokeBelow = nearestLevel && prevClose > nearestLevel.price && stockPrice < nearestLevel.price;
        return {
          fib_proximity_pct:   Math.round(nearestDistPct * 100) / 100,
          fib_level:           nearestLevel?.pct ?? null,
          fib_broke_below:     brokeBelow ? 1 : 0,
          fib_near_resistance: (nearestLevel?.pct <= 0.382 && nearestDistPct < 1.5) ? 1 : 0,
          fib_near_support:    (nearestLevel?.pct >= 0.618 && nearestDistPct < 1.5) ? 1 : 0,
        };
      }

      function computeBollingerBands(candles, period = 20) {
        if (!candles || candles.length < period) return null;
        const recent  = candles.slice(-period);
        const closes  = recent.map(c => c.close);
        const sma     = closes.reduce((s, v) => s + v, 0) / period;
        const variance = closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
        const stdDev  = Math.sqrt(variance);
        const upper   = sma + 2 * stdDev;
        const lower   = sma - 2 * stdDev;
        const cur     = candles[candles.length - 1].close;
        return {
          bb_pct_b:    Math.round((stdDev === 0 ? 0.5 : (cur - lower) / (upper - lower)) * 1000) / 1000,
          bb_width:    stdDev === 0 ? 0 : Math.round((upper - lower) / sma * 10000) / 100,
          bb_position: stdDev === 0 ? 0 : cur >= upper - stdDev * 0.2 ? 1 : cur <= lower + stdDev * 0.2 ? -1 : 0,
          bb_upper:    Math.round(upper * 100) / 100,
          bb_lower:    Math.round(lower * 100) / 100,
          bb_mid:      Math.round(sma * 100) / 100,
        };
      }

      function computeGapFlag(candles, threshold = 0.5) {
        if (!candles || candles.length < 2) return null;
        const today = candles[candles.length - 1], yesterday = candles[candles.length - 2];
        if (!today?.open || !yesterday?.close) return null;
        const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
        const gapAbs = Math.abs(gapPct);
        return {
          gap_pct:       Math.round(gapPct * 100) / 100,
          gap_flag:      gapAbs >= threshold ? 1 : 0,
          gap_direction: gapAbs >= threshold ? (gapPct > 0 ? 1 : -1) : 0,
        };
      }

      function getAtmIv(chainData, symbol, stockPrice) {
        if (!chainData || !symbol || !stockPrice) return null;
        let bestIv = null, bestDist = Infinity;
        for (const [chainKey, chain] of Object.entries(chainData)) {
          const [chainTicker] = chainKey.split("|");
          if (chainTicker !== symbol.toUpperCase()) continue;
          for (const strike of (chain.calls || [])) {
            const dist = Math.abs(strike.strikePrice - stockPrice);
            if (dist < bestDist && strike.volatility != null) { bestDist = dist; bestIv = strike.volatility; }
          }
        }
        return bestIv != null ? Math.round(bestIv * 10) / 10 : null; // Schwab volatility already in % (e.g. 46.5 = 46.5%)
      }

      // ── SAGE flag-based risk model — loaded from DB ───────────────────────
      const [sageFlagsRows, sageThreshRows, tickerTierRows] = await Promise.all([
        sb("sage_flags?select=*&enabled=eq.true"),
        sb("sage_thresholds?select=*&order=min_score.asc"),
        sb("ticker_tiers?select=*"),
      ]);
      const FLAGS      = Array.isArray(sageFlagsRows)  ? sageFlagsRows  : [];
      const THRESHOLDS = Array.isArray(sageThreshRows) ? sageThreshRows : [];
      const TIERS      = {};
      for (const t of (Array.isArray(tickerTierRows) ? tickerTierRows : [])) TIERS[t.ticker] = t.tier;
      console.log(`[sage_scan] loaded ${FLAGS.length} flags, ${THRESHOLDS.length} thresholds, ${Object.keys(TIERS).length} tickers`);

      function evaluateFlags(symbol, factors) {
        const tier      = TIERS[symbol] || "safe";
        const cp        = Number(factors.change_pct ?? 0);
        const dte       = Number(factors.dte ?? 99);
        const isVolatile= tier === "watch" || tier === "high_risk";
        const fired     = [];

        // Evaluate each enabled flag
        for (const flag of FLAGS) {
          let applies = false;
          switch (flag.name) {
            case "high_risk_ticker":   applies = tier === "high_risk"; break;
            case "watch_ticker":       applies = tier === "watch"; break;
            case "safe_ticker":        applies = tier === "safe"; break;
            case "big_down":           applies = cp < -2; break;
            case "big_up":             applies = cp > 3; break;
            case "mild_down":          applies = cp >= -2 && cp < 0; break;
            case "sweet_spot_move":    applies = cp >= 0 && cp <= 2; break;
            case "gap_flag":           applies = factors.gap_flag === 1; break;
            case "fib_broke_below":    applies = factors.fib_broke_below === 1; break;
            case "fib_near_resistance":applies = factors.fib_near_resistance === 1; break;
            case "dte2":               applies = dte === 2; break;
            case "dte2_volatile":      applies = dte === 2 && isVolatile; break;
          }
          if (applies) fired.push({ name: flag.name, display_name: flag.display_name, severity: flag.severity });
        }

        // Total risk score (sum of severities)
        const riskScore = fired.reduce((s, f) => s + f.severity, 0);

        // Look up threshold
        const threshold = THRESHOLDS.find(t => riskScore >= t.min_score && riskScore <= t.max_score)
          || { label: "Unknown", emoji: "❓", color: "#8b949e" };

        return { riskScore, tier, firedFlags: fired, recommendation: threshold };
      }

      // ── Get Schwab token ──────────────────────────────────────────────────
      async function getToken() {
        const tokRow = await sb("col_prefs?select=cols&id=eq.schwab_tokens");
        const t = (Array.isArray(tokRow) ? tokRow : [])[0]?.cols;
        if (!t?.accessToken) throw new Error("No Schwab tokens");
        if (t.accessTokenExpiresAt > Date.now() + 120000) return t.accessToken;
        // Refresh
        const creds = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
        const r = await fetch("https://api.schwabapi.com/v1/oauth/token", {
          method: "POST",
          headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }),
        });
        const n = await r.json();
        if (!n.access_token) throw new Error("Token refresh failed");
        return n.access_token;
      }

      // ── Fetch held tickers ────────────────────────────────────────────────
      const extraTicker = req.body?.extra_ticker?.toUpperCase?.() || null;
      const sdRows    = await sb("col_prefs?select=cols&id=eq.stocks_data");
      const sdBlob    = (Array.isArray(sdRows) ? sdRows : [])[0]?.cols || {};
      const stockRows = Object.entries(sdBlob)
        .filter(([sym, v]) => sym !== "__cash__" && v?.shares >= 100) // need ≥100 shares to write a contract
        .map(([sym, v]) => ({ symbol: sym, shares: v.shares, currentPrice: v.currentPrice ?? null, changePct: v.changePct ?? null }));
      // Add extra ticker if not already in list
      if (extraTicker && !stockRows.find(r => r.symbol === extraTicker)) {
        stockRows.push({ symbol: extraTicker, shares: 0, currentPrice: null, changePct: null });
      }
      const tickers = stockRows.map(r => r.symbol);

      if (!tickers.length) {
        return res.status(200).json({ ok: true, results: [], message: "No held tickers with shares > 0" });
      }

      // ── Get Schwab token + fetch live data ────────────────────────────────
      let token;
      try { token = await getToken(); } catch(e) {
        return res.status(500).json({ error: `Schwab auth failed: ${e.message}` });
      }

      // Live quotes
      const quotesRes  = await fetch(
        `${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${tickers.join(",")}&fields=quote&indicative=false`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
      ).then(r => r.json()).catch(() => ({}));

      // VIX
      let vix = null;
      try {
        const vixData = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=$VIX&fields=quote&indicative=false`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
        vix = vixData?.["$VIX"]?.quote?.lastPrice ?? vixData?.["$VIX"]?.lastPrice ?? null;
      } catch(e) {}

      // Daily candles for all tickers in parallel
      const dailyCandles = {};
      await Promise.all(tickers.map(async sym => {
        try {
          const url  = `${SCHWAB_BASE}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=month&period=3&frequencyType=daily&frequency=1&needExtendedHoursData=false`;
          const data = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).then(r => r.json());
          if (data?.candles?.length) {
            dailyCandles[sym] = data.candles.map(c => ({ date: new Date(c.datetime).toISOString().slice(0,10), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          }
        } catch(e) {}
      }));

      // Chain data for IV
      const chainRow   = await sb("col_prefs?select=cols&id=eq.last_chain_refresh");
      const chainData  = (Array.isArray(chainRow) ? chainRow : [])[0]?.cols?.chains || {};


      function computeSupportResistance(candles, stockPrice, swingPeriod=5, clusterPct=1.5) {
        if(!candles||candles.length<swingPeriod*2+1||!stockPrice) return null;
        const swingHighs=[], swingLows=[];
        for(let i=swingPeriod;i<candles.length-swingPeriod;i++){
          const c=candles[i];
          const lh=candles.slice(i-swingPeriod,i).map(x=>x.high), rh=candles.slice(i+1,i+swingPeriod+1).map(x=>x.high);
          const ll=candles.slice(i-swingPeriod,i).map(x=>x.low),  rl=candles.slice(i+1,i+swingPeriod+1).map(x=>x.low);
          if(c.high>Math.max(...lh)&&c.high>Math.max(...rh)) swingHighs.push({price:c.high,date:c.date});
          if(c.low<Math.min(...ll) &&c.low<Math.min(...rl))  swingLows.push({price:c.low,date:c.date});
        }
        function cluster(pts){
          if(!pts.length) return [];
          const s=[...pts].sort((a,b)=>a.price-b.price); const cs=[]; let cur=[s[0]];
          for(let i=1;i<s.length;i++){ if((s[i].price-cur[0].price)/cur[0].price*100<=clusterPct) cur.push(s[i]); else{cs.push(cur);cur=[s[i]];} }
          cs.push(cur);
          return cs.map(g=>({price:Math.round(g.reduce((s,p)=>s+p.price,0)/g.length*100)/100, strength:g.length}));
        }
        const res=cluster(swingHighs).filter(l=>l.price>stockPrice);
        const sup=cluster(swingLows).filter(l=>l.price<stockPrice);
        const nr=res.sort((a,b)=>a.price-b.price)[0]||null;
        const ns=sup.sort((a,b)=>b.price-a.price)[0]||null;
        const rd=nr?(nr.price-stockPrice)/stockPrice*100:Infinity;
        const sd=ns?(stockPrice-ns.price)/stockPrice*100:Infinity;
        return {
          sr_nearest_type:     rd<=sd?"resistance":"support",
          sr_nearest_price:    rd<=sd?nr?.price:ns?.price,
          sr_nearest_dist_pct: Math.round(Math.min(rd,sd)*100)/100,
          sr_nearest_strength: rd<=sd?nr?.strength??0:ns?.strength??0,
          sr_near_resistance:  rd<2.0?1:0,
          sr_near_support:     sd<2.0?1:0,
          sr_resistance_price: nr?.price??null,
          sr_support_price:    ns?.price??null,
          sr_resistance_dist:  Math.round(rd*100)/100,
          sr_support_dist:     Math.round(sd*100)/100,
        };
      }

      // ── Score each ticker ─────────────────────────────────────────────────
      const results = [];
      for (const { symbol, shares, currentPrice, changePct: sdChangePct } of stockRows) {
        const q          = quotesRes?.[symbol]?.quote ?? quotesRes?.[symbol];
        const stockPrice = q?.lastPrice ?? currentPrice;
        const changePct  = q ? (q.changePct ?? q.netPercentChange ?? 0) : (sdChangePct ?? 0) * 100;
        const candles    = dailyCandles[symbol] || [];

        // Compute all factors live
        const rsi    = computeRSI(candles);
        const fib    = computeFibFactors(candles, stockPrice);
        const bb     = computeBollingerBands(candles);
        const gap    = computeGapFlag(candles);
        const ivPct  = getAtmIv(chainData, symbol, stockPrice);

        const sr = computeSupportResistance(candles, stockPrice);
        const factors = {
          change_pct: Math.round(changePct * 100) / 100,
          vix:        vix,
          rsi_14:     rsi,
          iv_pct:     ivPct,
          ...(fib || {}),
          ...(bb  || {}),
          ...(gap || {}),
          ...(sr  || {}),
        };

        const { riskScore, tier, firedFlags, recommendation } = evaluateFlags(symbol, factors);

        results.push({
          ticker:      symbol,
          riskScore,
          tier,
          recommendation: recommendation.label ?? "Unknown",
          recommendationEmoji: recommendation.emoji ?? "❓",
          recommendationColor: recommendation.color ?? "#8b949e",
          firedFlags,
          factors,
          shares,
          currentPrice: stockPrice,
        });
      }

      results.sort((a, b) => a.riskScore - b.riskScore);

      // Upsert to sage_attention
      const upsertRows = results.map(r => ({
        ticker: r.ticker, score: r.riskScore, recommendation: r.recommendation,
        passes_gates: (r.riskScore <= 1) ? true : false,
        gate_failures: r.firedFlags.filter(f => f.severity >= 3).map(f => f.display_name),
        contributions: Object.fromEntries(r.firedFlags.map(f => [f.name, f.severity])),
        factors_snapshot: r.factors,
        shares: r.shares, scanned_at: new Date().toISOString(),
      }));
      await fetch(`${SUPABASE_URL}/rest/v1/sage_attention`, {
        method: "POST", headers: { ...sbH, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(upsertRows),
      });

      return res.status(200).json({ ok: true, scanned: results.length, vix, results });
    }
    // ── Mode 5: BTO Opportunity Scanner ─────────────────────────────────────
    // Same live factor fetch as sage_scan but includes an optional extra ticker
    // and returns raw factors — BTO scoring happens client-side
    if (mode === "bto_scan") {
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: "Supabase env vars not configured" });
      }

      const extraTicker = req.body?.extra_ticker?.toUpperCase?.() || null;
      const SCHWAB_BASE = "https://api.schwabapi.com";
      const sbH = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
      const sb  = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH }).then(r => r.json());

      // Reuse same factor functions from sage_scan (already defined above in that mode)
      // — duplicated here since each mode is self-contained
      function computeRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) return null;
        const closes = candles.map(c => c.close);
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; if(d>=0) gains+=d; else losses-=d; }
        let ag = gains/period, al = losses/period;
        for (let i = period+1; i < closes.length; i++) { const d=closes[i]-closes[i-1]; ag=(ag*(period-1)+Math.max(d,0))/period; al=(al*(period-1)+Math.max(-d,0))/period; }
        if(al===0) return 100;
        return Math.round((100-100/(1+ag/al))*100)/100;
      }
      function computeFibFactors(candles, stockPrice, lookback=60) {
        if(!candles||candles.length<10||!stockPrice) return null;
        const w=candles.slice(-Math.min(lookback,candles.length));
        const sh=Math.max(...w.map(c=>c.high)), sl=Math.min(...w.map(c=>c.low)), range=sh-sl;
        if(range<=0) return null;
        const levels=[0.236,0.382,0.5,0.618,0.786].map(p=>({pct:p,price:Math.round((sh-p*range)*100)/100}));
        let nl=null,nd=Infinity;
        for(const l of levels){const d=Math.abs(stockPrice-l.price)/stockPrice*100; if(d<nd){nd=d;nl=l;}}
        const pc=candles[candles.length-2]?.close, bb=nl&&pc>nl.price&&stockPrice<nl.price;
        return {fib_proximity_pct:Math.round(nd*100)/100,fib_level:nl?.pct??null,fib_broke_below:bb?1:0,fib_near_resistance:(nl?.pct<=0.382&&nd<1.5)?1:0,fib_near_support:(nl?.pct>=0.618&&nd<1.5)?1:0};
      }
      function computeBollingerBands(candles, period=20) {
        if(!candles||candles.length<period) return null;
        const cls=candles.slice(-period).map(c=>c.close), sma=cls.reduce((s,v)=>s+v,0)/period;
        const sd=Math.sqrt(cls.reduce((s,v)=>s+Math.pow(v-sma,2),0)/period);
        const upper=sma+2*sd, lower=sma-2*sd, cur=candles[candles.length-1].close;
        return {bb_pct_b:Math.round((sd===0?.5:(cur-lower)/(upper-lower))*1000)/1000,bb_width:sd===0?0:Math.round((upper-lower)/sma*10000)/100,bb_position:sd===0?0:cur>=upper-sd*0.2?1:cur<=lower+sd*0.2?-1:0,bb_upper:Math.round(upper*100)/100,bb_lower:Math.round(lower*100)/100,bb_mid:Math.round(sma*100)/100};
      }
      function computeGapFlag(candles, threshold=0.5) {
        if(!candles||candles.length<2) return null;
        const t=candles[candles.length-1],y=candles[candles.length-2];
        if(!t?.open||!y?.close) return null;
        const gp=(t.open-y.close)/y.close*100,ga=Math.abs(gp);
        return {gap_pct:Math.round(gp*100)/100,gap_flag:ga>=threshold?1:0,gap_direction:ga>=threshold?(gp>0?1:-1):0};
      }
      function getAtmIv(chainData, symbol, stockPrice) {
        if(!chainData||!symbol||!stockPrice) return null;
        let bestIv=null,bestDist=Infinity;
        for(const [key,chain] of Object.entries(chainData)){
          const [t]=key.split("|"); if(t!==symbol.toUpperCase()) continue;
          for(const s of(chain.calls||[])){const d=Math.abs(s.strikePrice-stockPrice);if(d<bestDist&&s.volatility!=null){bestDist=d;bestIv=s.volatility;}}
        }
        return bestIv!=null?Math.round(bestIv*10)/10:null;
      }

      function computeSupportResistance(candles, stockPrice, swingPeriod=5, clusterPct=1.5) {
        if(!candles||candles.length<swingPeriod*2+1||!stockPrice) return null;
        const swingHighs=[], swingLows=[];
        for(let i=swingPeriod;i<candles.length-swingPeriod;i++){
          const c=candles[i];
          const lh=candles.slice(i-swingPeriod,i).map(x=>x.high), rh=candles.slice(i+1,i+swingPeriod+1).map(x=>x.high);
          const ll=candles.slice(i-swingPeriod,i).map(x=>x.low),  rl=candles.slice(i+1,i+swingPeriod+1).map(x=>x.low);
          if(c.high>Math.max(...lh)&&c.high>Math.max(...rh)) swingHighs.push({price:c.high,date:c.date});
          if(c.low<Math.min(...ll) &&c.low<Math.min(...rl))  swingLows.push({price:c.low,date:c.date});
        }
        function cluster(pts){
          if(!pts.length) return [];
          const s=[...pts].sort((a,b)=>a.price-b.price); const cs=[]; let cur=[s[0]];
          for(let i=1;i<s.length;i++){ if((s[i].price-cur[0].price)/cur[0].price*100<=clusterPct) cur.push(s[i]); else{cs.push(cur);cur=[s[i]];} }
          cs.push(cur);
          return cs.map(g=>({price:Math.round(g.reduce((s,p)=>s+p.price,0)/g.length*100)/100, strength:g.length}));
        }
        const res=cluster(swingHighs).filter(l=>l.price>stockPrice);
        const sup=cluster(swingLows).filter(l=>l.price<stockPrice);
        const nr=res.sort((a,b)=>a.price-b.price)[0]||null;
        const ns=sup.sort((a,b)=>b.price-a.price)[0]||null;
        const rd=nr?(nr.price-stockPrice)/stockPrice*100:Infinity;
        const sd=ns?(stockPrice-ns.price)/stockPrice*100:Infinity;
        return {
          sr_nearest_type:     rd<=sd?"resistance":"support",
          sr_nearest_price:    rd<=sd?nr?.price:ns?.price,
          sr_nearest_dist_pct: Math.round(Math.min(rd,sd)*100)/100,
          sr_nearest_strength: rd<=sd?nr?.strength??0:ns?.strength??0,
          sr_near_resistance:  rd<2.0?1:0,
          sr_near_support:     sd<2.0?1:0,
          sr_resistance_price: nr?.price??null,
          sr_support_price:    ns?.price??null,
          sr_resistance_dist:  Math.round(rd*100)/100,
          sr_support_dist:     Math.round(sd*100)/100,
        };
      }

      // Get token
      async function getToken() {
        const tokRow = await sb("col_prefs?select=cols&id=eq.schwab_tokens");
        const t = (Array.isArray(tokRow)?tokRow:[])[0]?.cols;
        if(!t?.accessToken) throw new Error("No Schwab tokens");
        if(t.accessTokenExpiresAt>Date.now()+120000) return t.accessToken;
        const creds=Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString("base64");
        const r=await fetch("https://api.schwabapi.com/v1/oauth/token",{method:"POST",headers:{Authorization:`Basic ${creds}`,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:t.refreshToken})});
        const n=await r.json(); if(!n.access_token) throw new Error("Token refresh failed");
        return n.access_token;
      }

      // Build ticker list: holdings + optional extra
      const sdRows = await sb("col_prefs?select=cols&id=eq.stocks_data");
      const sdBlob = (Array.isArray(sdRows)?sdRows:[])[0]?.cols||{};
      const stockRows = Object.entries(sdBlob)
        .filter(([sym,v])=>sym!=="__cash__"&&v?.shares>=100)
        .map(([sym,v])=>({symbol:sym,shares:v.shares,currentPrice:v.currentPrice??null,changePct:v.changePct??null}));

      // Add extra ticker if provided and not already in list
      if(extraTicker && !stockRows.find(r=>r.symbol===extraTicker)) {
        stockRows.push({symbol:extraTicker, shares:0, currentPrice:null, changePct:null});
      }

      const tickers = stockRows.map(r=>r.symbol);
      if(!tickers.length) return res.status(200).json({ok:true,results:[],message:"No tickers"});

      let token;
      try { token = await getToken(); } catch(e) { return res.status(500).json({error:`Schwab auth: ${e.message}`}); }

      // Live quotes
      const quotesRes = await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=${tickers.join(",")}&fields=quote&indicative=false`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}}).then(r=>r.json()).catch(()=>({}));

      // VIX
      let vix=null;
      try{const vd=await fetch(`${SCHWAB_BASE}/marketdata/v1/quotes?symbols=$VIX&fields=quote&indicative=false`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}}).then(r=>r.json()); vix=vd?.["$VIX"]?.quote?.lastPrice??null;}catch(e){}

      // Daily candles
      const dailyCandles={};
      await Promise.all(tickers.map(async sym=>{
        try{const data=await fetch(`${SCHWAB_BASE}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=month&period=3&frequencyType=daily&frequency=1&needExtendedHoursData=false`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}}).then(r=>r.json());
          if(data?.candles?.length) dailyCandles[sym]=data.candles.map(c=>({date:new Date(c.datetime).toISOString().slice(0,10),open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}));
        }catch(e){}
      }));

      const chainRow = await sb("col_prefs?select=cols&id=eq.last_chain_refresh");
      const chainData = (Array.isArray(chainRow)?chainRow:[])[0]?.cols?.chains||{};

      // Score each ticker
      const results=[];
      for(const {symbol,shares,currentPrice,changePct:sdCp} of stockRows){
        const q=quotesRes?.[symbol]?.quote??quotesRes?.[symbol];
        const stockPrice=q?.lastPrice??currentPrice;
        const changePct=q?(q.changePct??q.netPercentChange??0):(sdCp??0)*100;
        const candles=dailyCandles[symbol]||[];
        const factors={
          change_pct:Math.round(changePct*100)/100,
          vix,
          rsi_14:computeRSI(candles),
          iv_pct:getAtmIv(chainData,symbol,stockPrice),
          ...(computeFibFactors(candles,stockPrice)||{}),
          ...(computeBollingerBands(candles)||{}),
          ...(computeGapFlag(candles)||{}),
        };
        results.push({ticker:symbol,factors,shares,currentPrice:stockPrice});
      }

      return res.status(200).json({ok:true,scanned:results.length,vix,results});
    }

    // ── Mode 6: Catalyst Fetch — research & upsert catalysts for a ticker ──────
    if (mode === "catalyst_fetch") {
      const { ticker } = req.body;
      if (!ticker) return res.status(400).json({ error: "ticker required" });

      const today = new Date().toISOString().split("T")[0];

      const systemPrompt = `You are a financial research analyst. Generate an upcoming catalyst calendar for a stock ticker.
Return ONLY a valid JSON array — no markdown, no explanation, no trailing text.
Each item must have exactly these fields:
  event_date   : ISO date "YYYY-MM-DD" (approximate if uncertain)
  event_name   : string, max 60 chars
  event_type   : one of: earnings | product | regulatory | macro | conference
  impact       : one of: HIGH | MEDIUM | LOW
  description  : 1-2 sentences on what to watch and why it matters
  source       : where this information comes from (e.g. "Company IR", "SEC filing", "Bloomberg est.")`;

      const userMessage = `Generate 8-12 upcoming catalysts for ${ticker.toUpperCase()} starting from today (${today}) through the next 12 months.
Include: earnings dates, key conferences, product launches, regulatory decisions, macro events affecting this stock.
Use your best estimate for dates. Return ONLY the JSON array.`;

      const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 2000,
          system:     systemPrompt,
          messages:   [{ role: "user", content: userMessage }],
        }),
      });

      const apiData = await apiResp.json();
      if (!apiResp.ok) {
        const msg = apiData?.error?.message || JSON.stringify(apiData);
        console.error("[catalyst_fetch] API error:", msg);
        return res.status(apiResp.status).json({ error: msg });
      }

      const text = apiData.content?.find(b => b.type === "text")?.text || "";
      let catalysts = [];
      try {
        const match = text.match(/\[[\s\S]*\]/);
        if (match) catalysts = JSON.parse(match[0]);
      } catch(e) {
        console.error("[catalyst_fetch] parse error:", e.message, "raw:", text.slice(0, 300));
        return res.status(500).json({ error: "Failed to parse catalyst JSON", raw: text.slice(0, 500) });
      }

      // Stamp ticker on each row
      catalysts = catalysts
        .filter(c => c.event_date && c.event_name)
        .map(c => ({
          ticker:      ticker.toUpperCase(),
          event_date:  c.event_date,
          event_name:  c.event_name,
          event_type:  c.event_type || "product",
          impact:      c.impact || "MEDIUM",
          description: c.description || "",
          source:      c.source || "",
        }));

      return res.status(200).json({ ok: true, catalysts });
    }

    return res.status(400).json({ error: `Unknown mode: ${mode}` });

  } catch (err) {
    console.error("[claude] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
