// scripts/dani-simulation.js
// DANI simulation engine — finds optimal profit target + stop loss per ticker
// Run: node --env-file=.env.local scripts/dani-simulation.js [--symbol AAPL] [--days 90]

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const TODAY        = new Date().toISOString().slice(0, 10);
const PAGE_SIZE    = 1000;
const RUN_AT       = new Date().toISOString();

// 6 simulation scenarios
const SCENARIOS = [
  { label: 'tgt65_nostop',  target_pct: 65, stop_mult: null },
  { label: 'tgt75_nostop',  target_pct: 75, stop_mult: null },
  { label: 'tgt85_nostop',  target_pct: 85, stop_mult: null },
  { label: 'tgt65_stop1.5', target_pct: 65, stop_mult: 1.5  },
  { label: 'tgt75_stop1.5', target_pct: 75, stop_mult: 1.5  },
  { label: 'tgt85_stop1.5', target_pct: 85, stop_mult: 1.5  },
];

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sbHeaders = {
  apikey:        SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPost(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${table}: ${r.status} ${await r.text()}`);
}

async function sbDelete(table, symbol) {
  const qs = symbol ? `?symbol=eq.${encodeURIComponent(symbol)}` : '';
  const r  = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: 'DELETE', headers: sbHeaders,
  });
  if (!r.ok) console.warn(`  DELETE ${table}${qs}: ${r.status}`);
}

// ── Fetch all snapshots for one symbol in pages of PAGE_SIZE ─────────────────
// Returns only the columns needed for simulation to minimize payload.
async function fetchSnapshotsForSymbol(symbol) {
  const snapshots = [];
  let offset = 0;
  const select = 'id,symbol,expiry,strike,snapshot_at,dte,bid,ask,mid,iv,delta,otm_pct,stock_price';
  const base   = `option_snapshots?select=${select}&symbol=eq.${encodeURIComponent(symbol)}&opt_type=eq.call&expiry=lt.${TODAY}&order=snapshot_at.asc`;

  while (true) {
    const page = await sbGet(`${base}&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    snapshots.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stdout.write(`\r  [ ${symbol} ] fetched ${snapshots.length} snapshots...`);
  }
  return snapshots;
}

// ── Group snapshots by (expiry|strike) ────────────────────────────────────────
function groupByContract(snapshots) {
  const groups = {};
  for (const s of snapshots) {
    const key = `${s.expiry}|${parseFloat(s.strike)}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  // Sort each group chronologically (should already be sorted by query, but ensure)
  for (const g of Object.values(groups)) {
    g.sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));
  }
  return groups;
}

// ── Simulate one trade through a scenario ─────────────────────────────────────
// entry: the entry snapshot
// subsequent: all snapshots AFTER entry (same expiry/strike)
// Returns: { exit_at, exit_stock_price, exit_mid, exit_reason, profit_per_contract, profit_pct, won, exit_snapshot_id }
function simulateTrade(entry, subsequent, scenario) {
  const entryMid    = +entry.mid > 0 ? +entry.mid : ((+entry.bid + +entry.ask) / 2);
  if (entryMid <= 0) return null;

  const targetClose = entryMid * (1 - scenario.target_pct / 100); // price at which we'd close (buy back)
  const stopClose   = scenario.stop_mult != null ? entryMid * scenario.stop_mult : Infinity;

  for (const snap of subsequent) {
    const snapMid = +snap.mid > 0 ? +snap.mid : ((+snap.bid + +snap.ask) / 2);

    // Target hit — profit taken
    if (snapMid <= targetClose) {
      const profit = Math.round((entryMid - snapMid) * 100 * 100) / 100;
      return {
        exit_at:            snap.snapshot_at,
        exit_stock_price:   snap.stock_price,
        exit_mid:           snapMid,
        exit_reason:        'target_hit',
        profit_per_contract: profit,
        profit_pct:         Math.round(profit / (entryMid * 100) * 10000) / 100,
        won:                true,
        exit_snapshot_id:   snap.id,
      };
    }

    // Stop loss hit
    if (snapMid >= stopClose) {
      const profit = Math.round((entryMid - snapMid) * 100 * 100) / 100;
      return {
        exit_at:            snap.snapshot_at,
        exit_stock_price:   snap.stock_price,
        exit_mid:           snapMid,
        exit_reason:        'stop_hit',
        profit_per_contract: profit,
        profit_pct:         Math.round(profit / (entryMid * 100) * 10000) / 100,
        won:                false,
        exit_snapshot_id:   snap.id,
      };
    }

    // DTE = 0 — option expired
    if (+snap.dte === 0) {
      const stockAtExpiry = +snap.stock_price;
      const strike        = +entry.strike;
      const expired_itm   = stockAtExpiry > strike;
      let   exitMid       = expired_itm ? Math.max(snapMid, stockAtExpiry - strike) : 0;

      const profit = Math.round((entryMid - exitMid) * 100 * 100) / 100;
      return {
        exit_at:            snap.snapshot_at,
        exit_stock_price:   stockAtExpiry,
        exit_mid:           exitMid,
        exit_reason:        expired_itm ? 'expired_itm' : 'expired_otm',
        profit_per_contract: profit,
        profit_pct:         Math.round(profit / (entryMid * 100) * 10000) / 100,
        won:                !expired_itm,
        exit_snapshot_id:   snap.id,
      };
    }
  }

  // No exit found — use last snapshot as end-of-data exit
  if (subsequent.length > 0) {
    const last    = subsequent[subsequent.length - 1];
    const lastMid = +last.mid > 0 ? +last.mid : ((+last.bid + +last.ask) / 2);
    const profit  = Math.round((entryMid - lastMid) * 100 * 100) / 100;
    return {
      exit_at:            last.snapshot_at,
      exit_stock_price:   last.stock_price,
      exit_mid:           lastMid,
      exit_reason:        'eod',
      profit_per_contract: profit,
      profit_pct:         Math.round(profit / (entryMid * 100) * 10000) / 100,
      won:                profit > 0,
      exit_snapshot_id:   last.id,
    };
  }

  return null;
}

// ── Process one symbol: find entries, simulate, write results ─────────────────
async function processSymbol(symbol) {
  console.log(`\n[ ${symbol} ] Loading snapshots...`);

  // Fetch all call snapshots for this symbol (past expiries only)
  const snapshots = await fetchSnapshotsForSymbol(symbol);
  process.stdout.write(`\r  [ ${symbol} ] ${snapshots.length} total snapshots        \n`);
  if (!snapshots.length) return { symbol, trades: 0 };

  // Group by contract (expiry|strike)
  const groups = groupByContract(snapshots);
  const contractKeys = Object.keys(groups);
  console.log(`  [ ${symbol} ] ${contractKeys.length} unique contracts`);

  // For each contract, find qualifying entry snapshot
  const trades = []; // { entry, subsequent }
  let qualifyingEntries = 0;

  for (const key of contractKeys) {
    const snaps  = groups[key];
    // Find FIRST snapshot meeting entry criteria
    const entryIdx = snaps.findIndex(s =>
      +s.dte >= 2 && +s.dte <= 7 &&
      +s.otm_pct >= 1.5 && +s.otm_pct <= 5 &&
      +s.bid > 0.05 &&
      +s.iv > 0 &&
      +s.mid > 0
    );
    if (entryIdx === -1) continue;

    qualifyingEntries++;
    trades.push({
      entry:       snaps[entryIdx],
      subsequent:  snaps.slice(entryIdx + 1),
    });
  }

  console.log(`  [ ${symbol} ] ${qualifyingEntries} qualifying entries found`);
  if (!trades.length) return { symbol, trades: 0 };

  // Run all 6 scenarios for all entries
  const simResultRows = [];
  const scenarioStats = {}; // { scenario_label: { wins, losses, profits, ... } }

  for (const sc of SCENARIOS) {
    scenarioStats[sc.label] = { wins: 0, losses: 0, profits: [], entries: 0 };
  }

  for (const { entry, subsequent } of trades) {
    for (const sc of SCENARIOS) {
      const result = simulateTrade(entry, subsequent, sc);
      if (!result) continue;

      scenarioStats[sc.label].entries++;
      if (result.won) scenarioStats[sc.label].wins++;
      else            scenarioStats[sc.label].losses++;
      scenarioStats[sc.label].profits.push(result.profit_per_contract);

      simResultRows.push({
        run_at:              RUN_AT,
        sim_label:           sc.label,
        symbol,
        expiry:              entry.expiry,
        strike:              +entry.strike,
        opt_type:            'call',
        entry_at:            entry.snapshot_at,
        entry_stock_price:   +entry.stock_price,
        entry_mid:           +entry.mid > 0 ? +entry.mid : (+entry.bid + +entry.ask) / 2,
        entry_iv:            +entry.iv,
        entry_delta:         +entry.delta,
        entry_otm_pct:       +entry.otm_pct,
        entry_dte:           +entry.dte,
        exit_at:             result.exit_at,
        exit_stock_price:    +result.exit_stock_price,
        exit_mid:            result.exit_mid,
        exit_reason:         result.exit_reason,
        profit_per_contract: result.profit_per_contract,
        profit_pct:          result.profit_pct,
        won:                 result.won,
        sim_params:          { target_pct: sc.target_pct, stop_mult: sc.stop_mult },
        entry_snapshot_id:   +entry.id,
        exit_snapshot_id:    result.exit_snapshot_id,
      });
    }
  }

  // Delete old results for this symbol and rewrite
  await sbDelete('sim_results', symbol);
  await sbDelete('sim_summary', symbol);

  // Write sim_results in chunks
  const CHUNK = 500;
  for (let i = 0; i < simResultRows.length; i += CHUNK) {
    await sbPost('sim_results', simResultRows.slice(i, i + CHUNK));
  }
  console.log(`  [ ${symbol} ] wrote ${simResultRows.length} sim_result rows`);

  // Build and write sim_summary
  const summaryRows = [];
  for (const sc of SCENARIOS) {
    const st = scenarioStats[sc.label];
    if (!st.entries) continue;

    const wins   = st.profits.filter(p => p > 0);
    const losses = st.profits.filter(p => p <= 0);
    const wr     = st.wins / st.entries;
    const avgP   = wins.length   ? wins.reduce((s, v) => s + v, 0)   / wins.length   : 0;
    const avgL   = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 0;
    const ev     = (wr * avgP) + ((1 - wr) * avgL);
    const avgDte = trades.map(t => +t.entry.dte).filter(d => !isNaN(d)).reduce((s, v) => s + v, 0) / trades.length;
    const ivs    = trades.map(t => +t.entry.iv).filter(v => v > 0);
    const avgIv  = ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;

    summaryRows.push({
      updated_at:     RUN_AT,
      sim_label:      sc.label,
      symbol,
      trade_count:    st.entries,
      win_count:      st.wins,
      win_rate:       Math.round(wr * 10000) / 10000,
      avg_profit:     Math.round(avgP * 100) / 100,
      avg_profit_pct: wins.length   ? Math.round(wins.reduce((s, v) => s + v, 0) / wins.length / 100 * 10000) / 100   : 0,
      avg_loss:       Math.round(avgL * 100) / 100,
      avg_loss_pct:   losses.length ? Math.round(losses.reduce((s, v) => s + v, 0) / losses.length / 100 * 10000) / 100 : 0,
      ev:             Math.round(ev * 100) / 100,
      max_profit:     st.profits.length ? Math.round(Math.max(...st.profits) * 100) / 100 : 0,
      max_loss:       st.profits.length ? Math.round(Math.min(...st.profits) * 100) / 100 : 0,
      avg_dte_entry:  Math.round(avgDte * 10) / 10,
      avg_iv_entry:   avgIv != null ? Math.round(avgIv * 10) / 10 : null,
      sim_params:     { target_pct: sc.target_pct, stop_mult: sc.stop_mult },
    });
  }
  await sbPost('sim_summary', summaryRows);

  return { symbol, trades: trades.length, scenarios: summaryRows };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
    process.exit(1);
  }

  const argSymbol = process.argv.find((a, i) => process.argv[i-1] === '--symbol');

  // Known tracked symbols from market-refresh DEFAULT_SNAP_TICKERS + common positions.
  // Pass --symbol TICKER to run a single ticker, or --symbols A,B,C for a custom list.
  const KNOWN_SYMBOLS = ['AAPL','AMD','AMZN','CEG','GEV','JPM','MSFT','NVDA','OKLO','SPY','TSLA','WDC'];

  const argSymbols = process.argv.find((a, i) => process.argv[i-1] === '--symbols');
  let symbols;
  if (argSymbol) {
    symbols = [argSymbol.toUpperCase()];
  } else if (argSymbols) {
    symbols = argSymbols.toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  } else {
    // Confirm which known symbols have data by doing a cheap per-symbol probe
    console.log('Checking available symbols...');
    symbols = [];
    for (const sym of KNOWN_SYMBOLS) {
      const probe = await sbGet(
        `option_snapshots?select=id&symbol=eq.${sym}&opt_type=eq.call&expiry=lt.${TODAY}&bid=gt.0.05&iv=gt.0&limit=1`
      );
      if (Array.isArray(probe) && probe.length > 0) {
        symbols.push(sym);
        process.stdout.write(` ${sym}`);
      }
    }
    console.log(`\nSymbols with data: ${symbols.join(', ')}`);
  }

  console.log(`\n=== DANI Simulation Engine ===`);
  console.log(`Date: ${TODAY}  |  Symbols: ${symbols.join(', ')}`);
  console.log(`Scenarios: ${SCENARIOS.map(s => s.label).join(', ')}\n`);

  const allSummaries = [];

  for (const symbol of symbols) {
    try {
      const result = await processSymbol(symbol);
      if (result.scenarios) allSummaries.push(...result.scenarios);
    } catch (e) {
      console.error(`\n[ ${symbol} ] ERROR:`, e.message);
    }
  }

  // ── Console summary table ──────────────────────────────────────────────────
  if (allSummaries.length) {
    console.log('\n\n=== SIMULATION RESULTS ===\n');
    const header = ['Symbol', 'Scenario', 'Trades', 'Win%', 'AvgProfit', 'AvgLoss', 'EV', 'MaxWin', 'MaxLoss', 'AvgDTE', 'AvgIV'];
    const colW   = [8, 18, 7, 7, 10, 10, 8, 8, 8, 7, 7];
    const pad    = (s, w) => String(s ?? '—').padStart(w);
    const padr   = (s, w) => String(s ?? '—').padEnd(w);

    console.log(header.map((h, i) => (i < 2 ? padr(h, colW[i]) : pad(h, colW[i]))).join(' '));
    console.log('-'.repeat(colW.reduce((s, w) => s + w + 1, 0)));

    // Sort by EV desc within each symbol
    const sorted = [...allSummaries].sort((a, b) => {
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      return b.ev - a.ev;
    });

    for (const r of sorted) {
      const wr  = (r.win_rate * 100).toFixed(1) + '%';
      const ev  = (r.ev >= 0 ? '+' : '') + r.ev.toFixed(2);
      const row = [
        r.symbol,
        r.sim_label,
        r.trade_count,
        wr,
        '$' + (r.avg_profit >= 0 ? '+' : '') + r.avg_profit.toFixed(2),
        '$' + r.avg_loss.toFixed(2),
        '$' + ev,
        '$' + r.max_profit?.toFixed(2),
        '$' + r.max_loss?.toFixed(2),
        r.avg_dte_entry,
        r.avg_iv_entry ?? '—',
      ];
      console.log(row.map((v, i) => (i < 2 ? padr(v, colW[i]) : pad(v, colW[i]))).join(' '));
    }

    // Best scenario per symbol
    console.log('\n=== BEST SCENARIO PER SYMBOL (by EV) ===\n');
    const bySymbol = {};
    for (const r of sorted) {
      if (!bySymbol[r.symbol]) bySymbol[r.symbol] = r;
    }
    for (const [sym, best] of Object.entries(bySymbol)) {
      console.log(`  ${sym.padEnd(8)} → ${best.sim_label.padEnd(18)} EV: $${(best.ev >= 0 ? '+' : '')}${best.ev.toFixed(2)}  WinRate: ${(best.win_rate * 100).toFixed(1)}%  Trades: ${best.trade_count}`);
    }
  }

  console.log(`\n=== Done — ${RUN_AT} ===\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
