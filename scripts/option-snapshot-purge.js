// scripts/option-snapshot-purge.js
// Config-row-driven, batched purge of option_snapshots. Runs on a schedule via
// .github/workflows/option-snapshot-purge.yml — deliberately NOT a Vercel function
// (12-function limit already at 9/12).
//
// Behavior:
//   1. Reads threshold/retention from col_prefs "option_snapshot_purge_config" — no
//      redeploy needed to change either value.
//   2. Skips entirely if current DB size is under the threshold.
//   3. Never purges rows for "active" tickers (open contracts + watchlist), regardless
//      of age — only inactive-ticker rows older than the retention window are deleted.
//   4. Deletes in batches (default 500k rows/loop) via a server-side RPC so a single
//      run can't time out or hold one giant transaction against a 32M+ row table.
//
// VACUUM is NOT run by this script — DELETE cannot reclaim disk by itself, and VACUUM
// cannot run inside a PostgREST RPC transaction. Run `VACUUM ANALYZE option_snapshots;`
// manually via the Supabase SQL editor after a large purge (see SQL FOR FRANK).
//
// Run manually: node --env-file=.env.local scripts/option-snapshot-purge.js

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY  = process.env.PUSHOVER_USER_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

const DEFAULT_CONFIG = { db_size_threshold_gb: 4, retention_days: 14, batch_size: 500000 };
const MAX_BATCHES = 200; // safety cap — 200 * 500k = 100M rows, well above current 32.5M

async function loadConfig() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.option_snapshot_purge_config`, { headers: HEADERS });
  const rows = await res.json();
  return { ...DEFAULT_CONFIG, ...(rows?.[0]?.cols || {}) };
}

async function getDbSizeBytes() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_db_size_bytes`, { method: "POST", headers: HEADERS, body: "{}" });
  if (!res.ok) throw new Error(`get_db_size_bytes RPC failed: ${res.status} ${await res.text()}`);
  return +(await res.json());
}

async function getActiveSymbols() {
  const [contractsRes, watchlistRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/contracts?select=stock&status=eq.Open`, { headers: HEADERS }),
    fetch(`${SUPABASE_URL}/rest/v1/col_prefs?select=cols&id=eq.watchlist`, { headers: HEADERS }),
  ]);
  const contracts = await contractsRes.json();
  const watchlist = (await watchlistRes.json())?.[0]?.cols?.tickers || [];
  const symbols = new Set([
    ...(Array.isArray(contracts) ? contracts.map(c => c.stock?.toUpperCase()) : []),
    ...watchlist.map(t => t.toUpperCase()),
  ].filter(Boolean));
  return [...symbols];
}

async function purgeBatch(retentionDays, activeSymbols, batchSize) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/purge_option_snapshots_batch`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ p_retention_days: retentionDays, p_active_symbols: activeSymbols, p_batch_size: batchSize }),
  });
  if (!res.ok) throw new Error(`purge_option_snapshots_batch RPC failed: ${res.status} ${await res.text()}`);
  return +(await res.json());
}

async function notify(title, message) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSHOVER_API_TOKEN, user: PUSHOVER_USER_KEY, title, message }),
  }).catch(() => {});
}

async function main() {
  const config = await loadConfig();
  const thresholdBytes = config.db_size_threshold_gb * 1024 ** 3;
  const dbSizeBytes = await getDbSizeBytes();
  const dbSizeGb = (dbSizeBytes / 1024 ** 3).toFixed(2);

  console.log(`[purge] DB size: ${dbSizeGb} GB (threshold: ${config.db_size_threshold_gb} GB)`);
  if (dbSizeBytes < thresholdBytes) {
    console.log(`[purge] under threshold — skipping`);
    return;
  }

  const activeSymbols = await getActiveSymbols();
  console.log(`[purge] ${activeSymbols.length} active symbols protected regardless of age: ${activeSymbols.join(", ")}`);
  console.log(`[purge] deleting option_snapshots older than ${config.retention_days} days for inactive symbols, batch size ${config.batch_size}`);

  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const deleted = await purgeBatch(config.retention_days, activeSymbols, config.batch_size);
    totalDeleted += deleted;
    console.log(`[purge] batch ${i + 1}: deleted ${deleted} rows (running total ${totalDeleted})`);
    if (deleted < config.batch_size) break; // last batch was partial — done
  }

  console.log(`[purge] done — ${totalDeleted} rows deleted total. Run VACUUM ANALYZE option_snapshots; to reclaim disk.`);
  if (totalDeleted > 0) {
    await notify(
      "🧹 option_snapshots purge complete",
      `Deleted ${totalDeleted.toLocaleString()} rows older than ${config.retention_days}d (DB was ${dbSizeGb} GB). Run VACUUM ANALYZE option_snapshots to reclaim disk.`
    );
  }
}

main().catch(e => { console.error("[purge] Fatal:", e.message); process.exit(1); });
