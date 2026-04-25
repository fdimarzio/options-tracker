// src/ImportPage.jsx
// Standalone transaction import + review page
// Route: /import  (add to main.jsx)
//
// Flow:
//  1. Pick date range (or use "last N days" for testing)
//  2. Fetch from /api/schwab-transactions
//  3. Review table: edit strategy, notes, price — check off rows
//  4. "Commit Checked" saves to Supabase contracts table
//  5. Test mode: never touches production data

import { useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── Strategies (keep in sync with main app) ───────────────────────────────────
const STRATEGIES = [
  "Covered Call", "Cash-Secured Put", "Naked Call", "Naked Put",
  "Bull Call Spread", "Bear Put Spread", "Iron Condor", "Straddle",
  "Strangle", "LEAPS", "Calendar Spread", "Diagonal Spread", "Other",
];

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg:        "#0a0e14",
  surface:   "#0d1117",
  border:    "#1c2128",
  border2:   "#2a3040",
  green:     "#00ff88",
  blue:      "#58a6ff",
  yellow:    "#ffd166",
  red:       "#ff6b6b",
  orange:    "#ff9f1c",
  muted:     "#8b949e",
  text:      "#e6edf3",
  dimText:   "#6e7681",
};

const pill = (label, color) => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "monospace",
  background: color + "22",
  color,
  border: `1px solid ${color}44`,
});

const OPT_COLORS = { BTO: C.blue, STO: C.green, BTC: C.orange, STC: C.yellow };
const MATCH_COLORS = { exact: C.green, partial: C.yellow, unmatched: C.red };

// ── toDB mapper (mirrors main app) ───────────────────────────────────────────
function contractToDB(c) {
  return {
    stock:              c.stock        || null,
    type:               c.type,
    opt_type:           c.optType,
    strike:             c.strike       != null ? +c.strike : null,
    qty:                c.qty          != null ? +c.qty    : null,
    expires:            c.expires      || null,
    premium:            c.premium      != null ? +c.premium : null,
    price_at_execution: c.priceAtExecution != null ? +c.priceAtExecution : null,
    date_exec:          c.dateExec     || null,
    account:            c.account      || "Schwab",
    status:             c.status       || "Open",
    strategy:           c.strategy     || null,
    notes:              c.notes        || null,
    created_via:        "Schwab Import",
    parent_id:          typeof c.parentId === "number" ? c.parentId : null,
  };
}

// ── Inline editable cell ──────────────────────────────────────────────────────
function EditCell({ value, onChange, type = "text", options = null, placeholder = "" }) {
  const baseStyle = {
    background:  "#0a1018",
    border:      `1px solid ${C.border2}`,
    borderRadius: 4,
    color:       C.text,
    fontFamily:  "monospace",
    fontSize:    12,
    padding:     "3px 6px",
    width:       "100%",
    outline:     "none",
  };

  if (options) {
    return (
      <select value={value ?? ""} onChange={e => onChange(e.target.value)}
        style={baseStyle}>
        <option value="">— select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      type={type} value={value ?? ""} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={baseStyle}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ImportPage() {
  const [mode,         setMode]         = useState("config");   // config | loading | review | done
  const [testMode,     setTestMode]     = useState(true);
  const [rangeType,    setRangeType]    = useState("days");     // days | dates
  const [days,         setDays]         = useState(30);
  const [startDate,    setStartDate]    = useState("");
  const [endDate,      setEndDate]      = useState("");
  const [transactions, setTransactions] = useState([]);
  const [checked,      setChecked]      = useState(new Set());
  const [meta,         setMeta]         = useState(null);
  const [error,        setError]        = useState(null);
  const [committing,   setCommitting]   = useState(false);
  const [committed,    setCommitted]    = useState([]);
  const [filterOptType, setFilterOptType] = useState("ALL");

  // ── Fetch transactions ──────────────────────────────────────────────────────
  const fetchTransactions = useCallback(async () => {
    setMode("loading");
    setError(null);
    try {
      let url = "/api/schwab-transactions?";
      if (rangeType === "days") {
        url += `days=${days}`;
      } else {
        url += `startDate=${startDate}&endDate=${endDate}`;
      }
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Add UI state to each transaction
      const txs = (data.transactions || []).map((t, i) => ({ ...t, _idx: i }));
      setTransactions(txs);
      setMeta(data.meta);
      setChecked(new Set()); // nothing checked by default
      setMode("review");
    } catch (err) {
      setError(err.message);
      setMode("config");
    }
  }, [rangeType, days, startDate, endDate]);

  // ── Update a field on a single transaction ──────────────────────────────────
  const updateTx = useCallback((idx, field, value) => {
    setTransactions(prev => prev.map((t, i) =>
      i === idx ? { ...t, [field]: value, ...(field === "priceAtExecution" ? { priceAtExecutionAuto: false } : {}) }
                : t
    ));
  }, []);

  // ── Toggle check ────────────────────────────────────────────────────────────
  const toggleCheck = (idx) => {
    setChecked(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };
  const checkAll  = () => setChecked(new Set(filtered.map(t => t._idx)));
  const uncheckAll = () => setChecked(new Set());

  // ── Commit ──────────────────────────────────────────────────────────────────
  const commitChecked = useCallback(async () => {
    const toCommit = transactions.filter(t => checked.has(t._idx));
    if (!toCommit.length) return;
    setCommitting(true);

    if (testMode) {
      // Test mode: just show what would be saved
      await new Promise(r => setTimeout(r, 800));
      setCommitted(toCommit.map(t => ({ ...t, _testMode: true })));
      setMode("done");
      setCommitting(false);
      return;
    }

    try {
      const rows = toCommit.map(contractToDB);

      // Upsert into contracts table
      // Use schwab_transaction_id as conflict key to prevent duplicates
      const { data, error: dbErr } = await supabase
        .from("contracts")
        .upsert(rows, { onConflict: "schwab_transaction_id", ignoreDuplicates: false });

      if (dbErr) throw new Error(dbErr.message);

      // If any closer trades matched a parent, update the parent's closed_by_id
      // (only for exact/partial matches with a numeric parentId)
      const closers = toCommit.filter(t =>
        (t.optType === "BTC" || t.optType === "STC") &&
        typeof t.parentId === "number" &&
        (t.matchConfidence === "exact" || t.matchConfidence === "partial")
      );
      for (const c of closers) {
        // We need the newly inserted id for this row — find by schwab_transaction_id
        if (!c.schwabTransactionId) continue;
        const { data: inserted } = await supabase
          .from("contracts")
          .select("id")
          .eq("schwab_transaction_id", c.schwabTransactionId)
          .single();

        if (inserted?.id) {
          await supabase
            .from("contracts")
            .update({ closed_by_id: inserted.id, status: "Closed" })
            .eq("id", c.parentId);
        }
      }

      setCommitted(toCommit);
      setMode("done");
    } catch (err) {
      setError(`Commit failed: ${err.message}`);
    } finally {
      setCommitting(false);
    }
  }, [transactions, checked, testMode]);

  // ── Filtered view ────────────────────────────────────────────────────────────
  const filtered = transactions.filter(t =>
    filterOptType === "ALL" ? true : t.optType === filterOptType
  );

  // ── Styles ──────────────────────────────────────────────────────────────────
  const page = {
    minHeight:   "100vh",
    background:  C.bg,
    color:       C.text,
    fontFamily:  "monospace",
    padding:     "24px",
  };
  const card = {
    background:   C.surface,
    border:       `1px solid ${C.border}`,
    borderRadius: 8,
    padding:      "20px 24px",
    marginBottom: 16,
  };
  const btn = (color = C.green, disabled = false) => ({
    background:   disabled ? "#1c2128" : color + "22",
    border:       `1px solid ${disabled ? C.border : color + "88"}`,
    borderRadius: 4,
    color:        disabled ? C.dimText : color,
    fontFamily:   "monospace",
    fontSize:     13,
    fontWeight:   700,
    padding:      "7px 16px",
    cursor:       disabled ? "not-allowed" : "pointer",
    opacity:      disabled ? 0.5 : 1,
  });

  // ── Render ───────────────────────────────────────────────────────────────────

  // ── Config screen ─────────────────────────────────────────────────────────
  if (mode === "config") {
    return (
      <div style={page}>
        <div style={{ maxWidth: 580, margin: "0 auto" }}>
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: C.dimText, letterSpacing: "0.12em", marginBottom: 4 }}>
              OPTIONS TRACKER
            </div>
            <h1 style={{ margin: 0, fontSize: 22, color: C.green, fontWeight: 700 }}>
              Import Transactions
            </h1>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              Fetch option trades from Schwab, review them, then commit to the database.
            </div>
          </div>

          {error && (
            <div style={{ ...card, border: `1px solid ${C.red}44`, background: C.red + "0a", marginBottom: 16 }}>
              <div style={{ color: C.red, fontSize: 13 }}>⚠ {error}</div>
            </div>
          )}

          {/* Test mode toggle */}
          <div style={{ ...card, border: `1px solid ${testMode ? C.yellow + "44" : C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: testMode ? C.yellow : C.text }}>
                  {testMode ? "🧪 Test Mode ON" : "🚀 Live Mode"}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                  {testMode
                    ? "Transactions will NOT be saved to the database. Safe for testing."
                    : "Transactions WILL be committed to the production database."}
                </div>
              </div>
              <button onClick={() => setTestMode(v => !v)} style={btn(testMode ? C.yellow : C.green)}>
                {testMode ? "Switch to Live" : "Switch to Test"}
              </button>
            </div>
          </div>

          {/* Date range */}
          <div style={card}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, fontWeight: 700 }}>DATE RANGE</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {["days", "dates"].map(t => (
                <button key={t} onClick={() => setRangeType(t)}
                  style={{ ...btn(C.blue), background: rangeType === t ? C.blue + "33" : "transparent" }}>
                  {t === "days" ? "Last N Days" : "Date Picker"}
                </button>
              ))}
            </div>

            {rangeType === "days" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, color: C.muted }}>Fetch last</span>
                <input
                  type="number" value={days} min={1} max={365}
                  onChange={e => setDays(+e.target.value)}
                  style={{ width: 70, background: "#0a1018", border: `1px solid ${C.border2}`, borderRadius: 4, color: C.text, fontFamily: "monospace", fontSize: 13, padding: "4px 8px", outline: "none" }}
                />
                <span style={{ fontSize: 13, color: C.muted }}>days of transactions</span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 11, color: C.dimText, marginBottom: 4 }}>Start Date</div>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                    style={{ background: "#0a1018", border: `1px solid ${C.border2}`, borderRadius: 4, color: C.text, fontFamily: "monospace", fontSize: 13, padding: "4px 8px", outline: "none" }}
                  />
                </div>
                <div style={{ color: C.dimText, marginTop: 18 }}>→</div>
                <div>
                  <div style={{ fontSize: 11, color: C.dimText, marginBottom: 4 }}>End Date</div>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                    style={{ background: "#0a1018", border: `1px solid ${C.border2}`, borderRadius: 4, color: C.text, fontFamily: "monospace", fontSize: 13, padding: "4px 8px", outline: "none" }}
                  />
                </div>
              </div>
            )}
          </div>

          <button onClick={fetchTransactions}
            disabled={rangeType === "dates" && (!startDate || !endDate)}
            style={{ ...btn(C.green, rangeType === "dates" && (!startDate || !endDate)), width: "100%", padding: "10px 0", fontSize: 14 }}>
            Fetch Transactions →
          </button>
        </div>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (mode === "loading") {
    return (
      <div style={{ ...page, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⟳</div>
          <div style={{ color: C.green, fontSize: 14 }}>Fetching from Schwab...</div>
          <div style={{ color: C.dimText, fontSize: 11, marginTop: 6 }}>
            Pulling transactions + stock prices
          </div>
        </div>
      </div>
    );
  }

  // ── Done screen ────────────────────────────────────────────────────────────
  if (mode === "done") {
    const wasTest = committed[0]?._testMode;
    return (
      <div style={page}>
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <div style={{ ...card, border: `1px solid ${wasTest ? C.yellow + "44" : C.green + "44"}`, background: (wasTest ? C.yellow : C.green) + "08" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: wasTest ? C.yellow : C.green, marginBottom: 8 }}>
              {wasTest ? "🧪 Test Complete" : "✓ Committed Successfully"}
            </div>
            <div style={{ fontSize: 13, color: C.muted }}>
              {wasTest
                ? `${committed.length} transactions would have been saved (test mode — nothing was written).`
                : `${committed.length} transactions saved to the database.`}
            </div>
          </div>

          {/* Summary table */}
          <div style={card}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, fontWeight: 700 }}>
              {wasTest ? "WOULD HAVE COMMITTED" : "COMMITTED"}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dimText, borderBottom: `1px solid ${C.border}` }}>
                  {["Stock","Type","Strike","Exp","Qty","Premium","Strategy","Match"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "4px 8px", fontWeight: 400 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {committed.map((t, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "5px 8px", color: C.text }}>{t.stock}</td>
                    <td style={{ padding: "5px 8px" }}><span style={pill(t.optType, OPT_COLORS[t.optType] || C.muted)}>{t.optType}</span></td>
                    <td style={{ padding: "5px 8px", color: C.text }}>{t.strike}</td>
                    <td style={{ padding: "5px 8px", color: C.muted }}>{t.expires?.slice(5)}</td>
                    <td style={{ padding: "5px 8px", color: C.text }}>{t.qty}</td>
                    <td style={{ padding: "5px 8px", color: t.premium >= 0 ? C.green : C.red }}>
                      {t.premium >= 0 ? "+" : ""}${Math.abs(t.premium).toFixed(2)}
                    </td>
                    <td style={{ padding: "5px 8px", color: C.muted }}>{t.strategy || "—"}</td>
                    <td style={{ padding: "5px 8px" }}>
                      {t.matchConfidence
                        ? <span style={pill(t.matchConfidence, MATCH_COLORS[t.matchConfidence] || C.muted)}>{t.matchConfidence}</span>
                        : <span style={{ color: C.dimText }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => { setMode("config"); setCommitted([]); setTransactions([]); setChecked(new Set()); }}
              style={btn(C.blue)}>
              ← Start New Import
            </button>
            <button onClick={() => { setMode("review"); }}
              style={btn(C.muted)}>
              Back to Review
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Review screen ──────────────────────────────────────────────────────────
  const checkedCount   = checked.size;
  const unmatchedCount = filtered.filter(t => t.matchConfidence === "unmatched").length;

  return (
    <div style={{ ...page, padding: "16px 20px" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 10, color: C.dimText, letterSpacing: "0.12em" }}>OPTIONS TRACKER</div>
          <h1 style={{ margin: 0, fontSize: 18, color: C.green }}>
            Review Transactions
            {testMode && <span style={{ ...pill(C.yellow, C.yellow), marginLeft: 10, fontSize: 10 }}>TEST MODE</span>}
          </h1>
          {meta && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              {meta.total} option transactions · {meta.startDate} → {meta.endDate}
              {unmatchedCount > 0 && <span style={{ color: C.red, marginLeft: 8 }}>⚠ {unmatchedCount} unmatched</span>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Filter by opt type */}
          {["ALL", "BTO", "STO", "BTC", "STC"].map(f => (
            <button key={f} onClick={() => setFilterOptType(f)}
              style={{ ...btn(OPT_COLORS[f] || C.muted), background: filterOptType === f ? (OPT_COLORS[f] || C.muted) + "33" : "transparent", fontSize: 11, padding: "4px 10px" }}>
              {f}
            </button>
          ))}
          <div style={{ width: 1, height: 20, background: C.border }} />
          <button onClick={checkAll}  style={btn(C.blue, false)}>Check All</button>
          <button onClick={uncheckAll} style={btn(C.muted)}>Uncheck All</button>
          <button
            onClick={commitChecked}
            disabled={checkedCount === 0 || committing}
            style={btn(C.green, checkedCount === 0 || committing)}>
            {committing ? "Saving..." : `${testMode ? "Test Commit" : "Commit"} ${checkedCount > 0 ? checkedCount : ""} Checked →`}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: C.red + "0a", border: `1px solid ${C.red}44`, borderRadius: 6, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: C.red }}>
          ⚠ {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.dimText }}>
          No transactions found for this date range.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#0d1117", borderBottom: `2px solid ${C.border2}` }}>
                <th style={{ padding: "8px 10px", textAlign: "center", width: 30, color: C.dimText, fontWeight: 400 }}>✓</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400 }}>Stock</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400 }}>Type</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: C.dimText, fontWeight: 400 }}>Strike</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400 }}>Expiry</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: C.dimText, fontWeight: 400 }}>Qty</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: C.dimText, fontWeight: 400 }}>Premium</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: C.dimText, fontWeight: 400, minWidth: 100 }}>Stock Price</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400 }}>Date</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400, minWidth: 130 }}>Strategy</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400, minWidth: 160 }}>Notes</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: C.dimText, fontWeight: 400 }}>Match</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const isChecked = checked.has(t._idx);
                const rowBg = isChecked ? C.green + "08" : "transparent";
                return (
                  <tr key={t._idx}
                    style={{ background: rowBg, borderBottom: `1px solid ${C.border}`, transition: "background 0.15s" }}
                    onClick={() => toggleCheck(t._idx)}>

                    {/* Checkbox */}
                    <td style={{ padding: "8px 10px", textAlign: "center" }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={isChecked}
                        onChange={() => toggleCheck(t._idx)}
                        style={{ accentColor: C.green, width: 14, height: 14, cursor: "pointer" }}
                      />
                    </td>

                    {/* Stock */}
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: C.text }}>{t.stock}</td>

                    {/* Opt type + call/put */}
                    <td style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <span style={pill(t.optType, OPT_COLORS[t.optType] || C.muted)}>{t.optType}</span>
                        <span style={pill(t.type, t.type === "Put" ? C.red : C.blue)}>{t.type?.[0]}</span>
                      </div>
                    </td>

                    {/* Strike */}
                    <td style={{ padding: "8px 10px", textAlign: "right", color: C.text }}>{t.strike}</td>

                    {/* Expiry */}
                    <td style={{ padding: "8px 10px", color: C.muted }}>{t.expires}</td>

                    {/* Qty */}
                    <td style={{ padding: "8px 10px", textAlign: "right", color: C.text }}>{t.qty}</td>

                    {/* Premium */}
                    <td style={{ padding: "8px 10px", textAlign: "right", color: t.premium >= 0 ? C.green : C.red, fontWeight: 700 }}>
                      {t.premium >= 0 ? "+" : ""}${Math.abs(t.premium).toFixed(2)}
                    </td>

                    {/* Stock price — editable */}
                    <td style={{ padding: "6px 10px" }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="number"
                          value={t.priceAtExecution ?? ""}
                          placeholder="—"
                          onChange={e => updateTx(t._idx, "priceAtExecution", e.target.value ? +e.target.value : null)}
                          style={{ width: 72, background: "#0a1018", border: `1px solid ${t.priceAtExecutionAuto ? C.blue + "66" : C.border2}`, borderRadius: 4, color: t.priceAtExecutionAuto ? C.blue : C.text, fontFamily: "monospace", fontSize: 12, padding: "3px 6px", outline: "none", textAlign: "right" }}
                        />
                        {t.priceAtExecutionAuto && (
                          <span title={`Auto-filled (${t.priceAtExecutionType})`}
                            style={{ fontSize: 10, color: C.blue, cursor: "help" }}>
                            {t.priceAtExecutionType === "live" ? "~" : "c"}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Date */}
                    <td style={{ padding: "8px 10px", color: C.muted }}>{t.dateExec}</td>

                    {/* Strategy — editable */}
                    <td style={{ padding: "6px 10px" }} onClick={e => e.stopPropagation()}>
                      <EditCell
                        value={t.strategy}
                        onChange={v => updateTx(t._idx, "strategy", v || null)}
                        options={STRATEGIES}
                      />
                    </td>

                    {/* Notes — editable */}
                    <td style={{ padding: "6px 10px" }} onClick={e => e.stopPropagation()}>
                      <EditCell
                        value={t.notes}
                        onChange={v => updateTx(t._idx, "notes", v || null)}
                        placeholder="optional notes"
                      />
                    </td>

                    {/* Match status */}
                    <td style={{ padding: "8px 10px" }}>
                      {t.matchConfidence ? (
                        <span style={pill(t.matchConfidence, MATCH_COLORS[t.matchConfidence] || C.muted)}
                          title={t.parentId ? `Linked to ID ${t.parentId}` : "No opener found"}>
                          {t.matchConfidence}
                        </span>
                      ) : (
                        <span style={{ color: C.dimText, fontSize: 11 }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Bottom action bar */}
      <div style={{ position: "sticky", bottom: 0, background: C.surface, borderTop: `1px solid ${C.border}`, padding: "12px 0", marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => setMode("config")} style={btn(C.muted)}>
          ← Back to Config
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: C.muted }}>
            {checkedCount} of {filtered.length} selected
          </span>
          <button
            onClick={commitChecked}
            disabled={checkedCount === 0 || committing}
            style={{ ...btn(C.green, checkedCount === 0 || committing), padding: "9px 24px", fontSize: 14 }}>
            {committing ? "Saving..." : testMode ? `🧪 Test Commit (${checkedCount})` : `Commit ${checkedCount} Transactions →`}
          </button>
        </div>
      </div>
    </div>
  );
}
