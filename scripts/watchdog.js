// scripts/watchdog.js
// Health monitor (Phase 1). Checks that each scheduled job ran and succeeded within its
// window, and that key data is fresh. Alerts via Pushover on transition-to-failing
// (deduped in col_prefs id='watchdog_state'), logs a line per check, and writes its own
// heartbeat. Runs hourly via .github/workflows/watchdog.yml. Design: [[Watchdog]] (vault).
//
// Scheduler-agnostic: a job is monitored by its ecosystem_heartbeat row, so a dead
// cron-jobs.org job and a dead GitHub Action both surface the same way.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY  = process.env.PUSHOVER_USER_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); process.exit(1); }
const HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
const MIN = 60000;

function isMarketHours() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = et.getDay(); if (d === 0 || d === 6) return false;
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= 570 && m < 960; // 9:30–16:00 ET
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return r.json();
}

// A job's heartbeat: exists, status ok, and last_run_at within maxAgeMin.
async function heartbeatFresh(agent, maxAgeMin) {
  const rows = await sbGet(`ecosystem_heartbeat?agent_name=eq.${agent}&select=status,last_run_at`);
  const row = rows && rows[0];
  if (!row) return { ok: false, detail: "no heartbeat ever written" };
  const ageMin = (Date.now() - new Date(row.last_run_at).getTime()) / MIN;
  if (row.status !== "ok") return { ok: false, detail: `status=${row.status}, ${Math.round(ageMin)}m ago` };
  if (ageMin > maxAgeMin) return { ok: false, detail: `last ok ${Math.round(ageMin)}m ago (SLA ${maxAgeMin}m)` };
  return { ok: true, detail: `ok ${Math.round(ageMin)}m ago` };
}

// A table's newest row (by timestamp col) is within maxAgeMin, and has >= minRows.
async function rowFresh(table, tsCol, maxAgeMin) {
  const rows = await sbGet(`${table}?select=${tsCol}&order=${tsCol}.desc&limit=1`);
  if (!rows || !rows.length) return { ok: false, detail: "0 rows" };
  const ageMin = (Date.now() - new Date(rows[0][tsCol]).getTime()) / MIN;
  if (ageMin > maxAgeMin) return { ok: false, detail: `newest ${Math.round(ageMin)}m old (SLA ${maxAgeMin}m)` };
  return { ok: true, detail: `fresh ${Math.round(ageMin)}m` };
}

// A table's newest DATE column is within maxAgeDays.
async function dateFresh(table, dateCol, maxAgeDays) {
  const rows = await sbGet(`${table}?select=${dateCol}&order=${dateCol}.desc&limit=1`);
  if (!rows || !rows.length) return { ok: false, detail: "0 rows" };
  const ageDays = (Date.now() - new Date(rows[0][dateCol] + "T00:00:00Z").getTime()) / 86400000;
  if (ageDays > maxAgeDays) return { ok: false, detail: `newest ${Math.round(ageDays)}d old (SLA ${maxAgeDays}d)` };
  return { ok: true, detail: `recent ${Math.round(ageDays)}d` };
}

// Phase 1 checks. Add a row here (or later: a watchdog_checks table) for each new job.
const CHECKS = [
  { name: "cron: market-refresh",              sev: "critical", marketHoursOnly: true,  run: () => heartbeatFresh("market-refresh", 20) },
  { name: "cron: auto-import",                 sev: "warning",  marketHoursOnly: true,  run: () => heartbeatFresh("auto-import", 60) },
  { name: "job: earnings-refresh",             sev: "warning",  marketHoursOnly: false, run: () => heartbeatFresh("earnings-refresh", 26 * 60) },
  { name: "job: snapshot_purge",               sev: "warning",  marketHoursOnly: false, run: () => heartbeatFresh("snapshot_purge", 8 * 24 * 60) },
  { name: "data: earnings_dates fresh",        sev: "warning",  marketHoursOnly: false, run: () => rowFresh("earnings_dates", "updated_at", 26 * 60) },
  { name: "data: portfolio snapshot recent",   sev: "warning",  marketHoursOnly: false, run: () => dateFresh("portfolio_snapshots", "snapshot_date", 2) },
  { name: "cron: chain-refresh",               sev: "critical", marketHoursOnly: true,  run: () => heartbeatFresh("chain-refresh", 30) },
  { name: "cron: chase",                        sev: "warning",  marketHoursOnly: true,  run: () => heartbeatFresh("chase", 30) },
  { name: "job: extend-etrade-token",          sev: "warning",  marketHoursOnly: false, run: () => heartbeatFresh("extend-etrade-token", 26 * 60) },
];

async function notify(title, message, priority = 0) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return;
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSHOVER_API_TOKEN, user: PUSHOVER_USER_KEY, title, message, priority }),
  }).catch(() => {});
}

async function heartbeat(status, notes) {
  const now = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/ecosystem_heartbeat?on_conflict=agent_name`, {
    method: "POST", headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ agent_name: "watchdog", last_run_at: now, status, notes: String(notes).slice(0, 200), updated_at: now }),
  }).catch(() => {});
}

async function main() {
  const marketHours = isMarketHours();
  const results = [];
  for (const c of CHECKS) {
    if (c.marketHoursOnly && !marketHours) { results.push({ ...c, ok: true, detail: "skipped (off-hours)", skipped: true }); continue; }
    try { results.push({ ...c, ...(await c.run()) }); }
    catch (e) { results.push({ ...c, ok: false, detail: `check error: ${e.message}` }); }
  }

  const pref = await sbGet(`col_prefs?select=cols&id=eq.watchdog_state`).catch(() => []);
  const prev = (pref && pref[0] && pref[0].cols) || {};
  const state = {};
  const newlyFailing = [], recovered = [];
  for (const r of results) {
    if (r.skipped) { state[r.name] = prev[r.name] || "ok"; continue; }
    state[r.name] = r.ok ? "ok" : "fail";
    if (!r.ok && prev[r.name] !== "fail") newlyFailing.push(r);
    if (r.ok && prev[r.name] === "fail") recovered.push(r);
  }

  const failing = results.filter(r => !r.ok && !r.skipped);
  console.log(`[watchdog] ${failing.length} failing / ${results.length} checks (marketHours=${marketHours})`);
  results.forEach(r => console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name} — ${r.detail}`));

  if (newlyFailing.length) {
    const anyCritical = newlyFailing.some(r => r.sev === "critical");
    await notify(`🚨 Watchdog: ${newlyFailing.length} check(s) failing`,
      newlyFailing.map(r => `• ${r.name}: ${r.detail}`).join("\n"), anyCritical ? 1 : 0);
  }
  if (recovered.length) {
    await notify(`✅ Watchdog: recovered`, recovered.map(r => `• ${r.name}`).join("\n"), 0);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/col_prefs`, {
    method: "POST", headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "watchdog_state", cols: state, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  await heartbeat(failing.length ? "warn" : "ok", `${failing.length} failing / ${results.length}`);
}

main().catch(e => { console.error("[watchdog] fatal:", e.message); process.exit(1); });
