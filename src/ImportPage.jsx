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

import { useState, useCallback, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

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
const MATCH_COLORS = { exact: C.green, partial: C.yellow, split: C.blue, unmatched: C.red, manual: C.blue };

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
    trade_rule:         c.tradeRule    || null,
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


// ── Match Modal ───────────────────────────────────────────────────────────────
function MatchModal({ closer, openContracts, onSelect, onClose }) {
  const [search, setSearch] = useState("");

  const filtered = openContracts.filter(o => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      o.stock?.toLowerCase().includes(q) ||
      String(o.strike).includes(q) ||
      o.expires?.includes(q) ||
      o.opt_type?.toLowerCase().includes(q) ||
      String(o.id).includes(q)
    );
  });

  // Sort: same stock first
  const sorted = [...filtered].sort((a, b) => {
    const aMatch = a.stock?.toUpperCase() === closer.stock?.toUpperCase();
    const bMatch = b.stock?.toUpperCase() === closer.stock?.toUpperCase();
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return 0;
  });

  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000,
  };
  const modal = {
    background: "#0d1117", border: `1px solid #2a3040`, borderRadius: 10,
    width: "min(680px, 95vw)", maxHeight: "80vh",
    display: "flex", flexDirection: "column", fontFamily: "monospace",
    boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #1c2128" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3", marginBottom: 4 }}>
                Link Opener for{" "}
                <span style={{ color: OPT_COLORS[closer.optType] }}>{closer.optType}</span>
                {" "}{closer.stock} {closer.strike} {closer.expires} ×{closer.qty}
              </div>
              <div style={{ fontSize: 11, color: "#6e7681" }}>
                {closer.dateExec} · premium {closer.premium >= 0 ? "+" : ""}${Math.abs(closer.premium).toFixed(2)}
              </div>
            </div>
            <button onClick={onClose}
              style={{ background: "none", border: "none", color: "#6e7681", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>
              ✕
            </button>
          </div>
          <input
            autoFocus
            placeholder="Search by stock, strike, expiry, ID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              marginTop: 12, width: "100%", background: "#0a1018",
              border: "1px solid #2a3040", borderRadius: 6, color: "#e6edf3",
              fontFamily: "monospace", fontSize: 13, padding: "8px 12px", outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Results */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {sorted.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#6e7681", fontSize: 12 }}>
              No contracts match "{search}"
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, background: "#0d1117" }}>
                <tr style={{ borderBottom: "1px solid #1c2128" }}>
                  {["ID","Stock","Type","Strike","Expiry","Qty","Date","Premium","Status",""].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#6e7681", fontWeight: 400 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(o => {
                  const isSameStock = o.stock?.toUpperCase() === closer.stock?.toUpperCase();
                  return (
                    <tr key={o.id}
                      onClick={() => { onSelect(o); onClose(); }}
                      style={{
                        borderBottom: "1px solid #1c2128",
                        cursor: "pointer",
                        background: isSameStock ? "#00ff8806" : "transparent",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = "#58a6ff12"}
                      onMouseLeave={e => e.currentTarget.style.background = isSameStock ? "#00ff8806" : "transparent"}
                    >
                      <td style={{ padding: "9px 12px", color: "#6e7681" }}>#{o.id}</td>
                      <td style={{ padding: "9px 12px", fontWeight: 700, color: isSameStock ? "#00ff88" : "#e6edf3" }}>{o.stock}</td>
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ ...pill(o.opt_type, OPT_COLORS[o.opt_type] || "#8b949e") }}>{o.opt_type}</span>
                      </td>
                      <td style={{ padding: "9px 12px", color: "#e6edf3" }}>{o.strike}</td>
                      <td style={{ padding: "9px 12px", color: "#8b949e" }}>{o.expires}</td>
                      <td style={{ padding: "9px 12px", color: "#e6edf3" }}>{o.qty}</td>
                      <td style={{ padding: "9px 12px", color: "#8b949e" }}>{o.date_exec}</td>
                      <td style={{ padding: "9px 12px", color: o.premium >= 0 ? "#00ff88" : "#ff6b6b" }}>
                        {o.premium != null ? `${o.premium >= 0 ? "+" : ""}$${Math.abs(o.premium).toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", color: o.status === "Open" ? "#00ff88" : "#6e7681" }}>{o.status}</td>
                      <td style={{ padding: "4px 8px" }} onClick={e => e.stopPropagation()}>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(JSON.stringify(o, null, 2))
                              .then(() => {
                                e.target.textContent = "✓";
                                setTimeout(() => { e.target.textContent = "⎘"; }, 1500);
                              });
                          }}
                          style={{ fontSize: 11, background: "transparent", border: "1px solid #2a3040", borderRadius: 3, color: "#6e7681", fontFamily: "monospace", padding: "2px 6px", cursor: "pointer" }}
                          title="Copy row data to clipboard">
                          ⎘
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #1c2128", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#6e7681" }}>{sorted.length} contracts · click a row to link</span>
          <button onClick={() => { onSelect(null); onClose(); }}
            style={{ background: "transparent", border: "1px solid #2a3040", borderRadius: 4, color: "#6e7681", fontFamily: "monospace", fontSize: 12, padding: "5px 12px", cursor: "pointer" }}>
            Clear Link
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Edit Opener Modal ─────────────────────────────────────────────────────────
// Allows correcting qty (and other fields) on a mismatched DB opener record
function EditOpenerModal({ contract, closer, onSave, onClose, supabaseProp = null }) {
  const [qty,     setQty]     = useState(String(contract?.qty ?? ""));
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState(null);

  if (!contract) return null;

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      const supabase = supabaseProp ?? createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY
      );
      const { error } = await supabase
        .from("contracts")
        .update({ qty: +qty })
        .eq("id", contract.id);
      if (error) throw new Error(error.message);
      onSave({ ...contract, qty: +qty });
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const overlay = { position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1001 };
  const modal   = { background:"#0d1117", border:"1px solid #2a3040", borderRadius:10, width:"min(480px,95vw)", fontFamily:"monospace", padding:"24px", boxShadow:"0 24px 80px rgba(0,0,0,0.6)" };
  const inp     = { width:"100%", background:"#0a1018", border:"1px solid #2a3040", borderRadius:4, color:"#e6edf3", fontFamily:"monospace", fontSize:13, padding:"7px 10px", outline:"none", boxSizing:"border-box" };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:14, fontWeight:700, color:"#ffd166", marginBottom:4 }}>✎ Edit Opener Record</div>
        <div style={{ fontSize:11, color:"#6e7681", marginBottom:16 }}>
          Fixing DB record #{contract.id} · {contract.stock} {contract.opt_type} {contract.strike} {contract.expires}
        </div>
        <div style={{ display:"flex", gap:16, marginBottom:12, fontSize:12 }}>
          <div>
            <div style={{ color:"#6e7681", marginBottom:4 }}>Closer qty (from Schwab)</div>
            <div style={{ color:"#e6edf3", fontWeight:700 }}>{closer?.qty}</div>
          </div>
          <div>
            <div style={{ color:"#6e7681", marginBottom:4 }}>DB qty (to fix)</div>
            <div style={{ color:"#ffd166", fontWeight:700 }}>{contract.qty}</div>
          </div>
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:11, color:"#6e7681", display:"block", marginBottom:6 }}>New Qty</label>
          <input type="number" value={qty} min={1} onChange={e => setQty(e.target.value)} style={inp} />
        </div>
        {err && <div style={{ color:"#ff6b6b", fontSize:12, marginBottom:12 }}>⚠ {err}</div>}
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"transparent", border:"1px solid #2a3040", borderRadius:4, color:"#6e7681", fontFamily:"monospace", fontSize:12, padding:"6px 14px", cursor:"pointer" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !qty}
            style={{ background:"#ffd16622", border:"1px solid #ffd16688", borderRadius:4, color:"#ffd166", fontFamily:"monospace", fontSize:12, fontWeight:700, padding:"6px 16px", cursor:saving?"not-allowed":"pointer", opacity:saving?0.6:1 }}>
            {saving ? "Saving…" : "Save to DB"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ImportPage({ parallelRun = false, defaultDays = 30, supabaseClient = null, tradeRules = null, persistedState = null, onStateChange = null }) {
  // Use passed-in client (from main app) or create own as fallback
  const supabase = supabaseClient ?? createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
  );

  // Trade rule names for the dropdown — either passed in from main app or loaded from Supabase
  const [localTradeRules, setLocalTradeRules] = useState([]);
  const rulesList = tradeRules ?? localTradeRules;
  const ruleNames = rulesList.map(r => r.name || r.title || r.rule).filter(Boolean);
  const [mode,         setMode]         = useState(() => (persistedState?.transactions?.length > 0) ? "review" : "config");
  const [testMode,     setTestMode]     = useState(false);
  const [rangeType,    setRangeType]    = useState("days");
  const [days,         setDays]         = useState(defaultDays);
  const [startDate,    setStartDate]    = useState("");
  const [endDate,      setEndDate]      = useState("");
  const [transactions,   setTransactions]   = useState(() => persistedState?.transactions || []);
  const [openContracts,  setOpenContracts]  = useState(() => persistedState?.openContracts || []);
  const [checked,        setChecked]        = useState(new Set());

  // Persist transactions back to parent (debounced to avoid re-render loops)
  useEffect(() => {
    if (onStateChange && transactions.length > 0) {
      onStateChange({ transactions, openContracts });
    }
  }, [transactions]);
  const [meta,           setMeta]           = useState(null);
  const [error,        setError]        = useState(null);
  const [committing,   setCommitting]   = useState(false);
  const [committed,    setCommitted]    = useState([]);
  const [filterOptType,    setFilterOptType]    = useState("ALL");
  const [hideCommitted,    setHideCommitted]    = useState(true);
  const [committedIds,     setCommittedIds]     = useState(new Set());
  const [matchFilter,      setMatchFilter]      = useState("ALL"); // ALL|exact|partial|split|unmatched
  const [accountFilter,    setAccountFilter]    = useState("ALL"); // ALL|Schwab|ETrade 6917|ETrade 8222
  const [sortCol,          setSortCol]          = useState("dateExec");
  const [sortDir,          setSortDir]          = useState("desc");
  const [dismissed,        setDismissed]        = useState(new Set()); // _idx values
  const [showDismissed,    setShowDismissed]    = useState(false);
  const [matchModal,       setMatchModal]       = useState(null);
  const [editOpenerModal,  setEditOpenerModal]  = useState(null); // { txIdx, contract }

  // ── Pending transactions (auto-import) ─────────────────────────────────────
  const [pending,          setPending]          = useState([]);
  const [pendingLoading,   setPendingLoading]   = useState(false);
  const [committingPending, setCommittingPending] = useState(new Set());

  const updatePending = (id, field, value) => {
    setAllPending(prev => prev.map(t => t.id === id ? { ...t, [field]: value } : t));
  };

  const commitPendingTx = async (t) => {
    setCommittingPending(prev => new Set([...prev, t.id]));
    try {
      // Build contract row
      const contract = {
        stock:               t.stock,
        type:                t.type,
        opt_type:            t.opt_type,
        strike:              t.strike,
        expires:             t.expires,
        qty:                 t.qty,
        premium:             t.premium,
        price_at_execution:  t.stock_price_at_exec,
        date_exec:           t.date_exec,
        account:             t.account || "Schwab",
        status:              ["BTC","STC"].includes(t.opt_type) ? "Closed" : "Open",
        strategy:            t.strategy || null,
        trade_rule:          t.trade_rule || null,
        notes:               t.notes || null,
        created_via:         "Auto Import",
        schwab_transaction_id: t.schwab_transaction_id,
        stock_price_at_close: ["BTC","STC"].includes(t.opt_type) ? t.stock_price_at_exec : null,
      };

      const { data: inserted, error: insErr } = await supabase
        .from("contracts")
        .insert(contract)
        .select()
        .single();
      if (insErr) throw insErr;

      // If it's a close with a matched open contract, update the parent
      if (["BTC","STC"].includes(t.opt_type) && t.match_id) {
        const costToClose = Math.abs(t.premium);
        const { data: parent } = await supabase
          .from("contracts")
          .select("premium,date_exec")
          .eq("id", t.match_id)
          .single();
        if (parent) {
          const profit = Math.abs(parent.premium) - costToClose;
          const daysHeld = parent.date_exec
            ? Math.ceil((new Date(t.date_exec) - new Date(parent.date_exec)) / 86400000)
            : null;
          await supabase.from("contracts").update({
            status:         "Closed",
            cost_to_close:  costToClose,
            close_date:     t.date_exec,
            profit:         Math.round(profit * 100) / 100,
            days_held:      daysHeld,
            stock_price_at_close: t.stock_price_at_exec,
          }).eq("id", t.match_id);
        }
      }

      // Mark pending as committed
      await supabase.from("pending_transactions")
        .update({ status: "committed", reviewed_at: new Date().toISOString() })
        .eq("id", t.id);

      setPending(prev => prev.filter(p => p.id !== t.id));
      setAllPending(prev => prev.map(p => p.id === t.id ? { ...p, status: "committed", reviewed_at: new Date().toISOString() } : p));
    } catch (e) {
      console.error("commitPendingTx:", e.message);
      alert("Commit failed: " + e.message);
    }
    setCommittingPending(prev => { const n = new Set(prev); n.delete(t.id); return n; });
  };

  const skipPendingTx = async (t) => {
    await supabase.from("pending_transactions")
      .update({ status: "skipped", reviewed_at: new Date().toISOString() })
      .eq("id", t.id);
    setPending(prev => prev.filter(p => p.id !== t.id));
    setAllPending(prev => prev.map(p => p.id === t.id ? { ...p, status: "skipped", reviewed_at: new Date().toISOString() } : p));
  };
  useEffect(() => {
    if (tradeRules !== null) return; // already provided by parent
    supabase.from("col_prefs").select("cols").eq("id","trade_rules").single()
      .then(({ data }) => { if (data?.cols) setLocalTradeRules(data.cols); })
      .catch(() => {});
  }, [tradeRules]); // eslint-disable-line

  // ── Fetch transactions ──────────────────────────────────────────────────────
  const fetchTransactions = useCallback(async () => {
    setMode("loading");
    setError(null);
    try {
      // ── Fetch Schwab transactions ───────────────────────────────────────────
      let schwabUrl = "/api/schwab-transactions?";
      if (rangeType === "days") {
        schwabUrl += `days=${days}`;
      } else {
        schwabUrl += `startDate=${startDate}&endDate=${endDate}`;
      }
      const schwabRes  = await fetch(schwabUrl);
      const schwabData = await schwabRes.json();
      if (!schwabRes.ok) throw new Error(schwabData.error || `Schwab HTTP ${schwabRes.status}`);

      // ── Fetch ETrade transactions (both accounts) ───────────────────────────
      let etradeUrl = "/api/etrade?action=import&dryRun=1&";
      if (rangeType === "days") {
        etradeUrl += `days=${days}`;
      } else {
        // ETrade counts backwards from today — need days from today back to startDate
        const daysBack = Math.ceil((new Date() - new Date(startDate)) / 86400000) + 1;
        etradeUrl += `days=${daysBack}`;
      }
      let etradeTxs = [];
      try {
        const etradeRes  = await fetch(etradeUrl);
        const etradeData = await etradeRes.json();
        console.log("[ImportPage] ETrade response:", etradeRes.status, JSON.stringify(etradeData).slice(0, 200));
        if (etradeRes.ok && etradeData.transactions) {
          // Filter to date range if using startDate/endDate
          const from = rangeType === "dates" ? startDate : null;
          const to   = rangeType === "dates" ? endDate   : null;
          etradeTxs = etradeData.transactions
            .filter(t => !from || (t.date_exec >= from && t.date_exec <= to))
            .map(t => ({
              // Map ETrade fields to match Schwab transaction shape
              schwabTransactionId: t.schwab_transaction_id,
              stock:         t.stock,
              type:          t.type,
              optType:       t.opt_type,
              strike:        t.strike,
              expires:       t.expires,
              qty:           t.qty,
              premium:       t.premium,
              dateExec:      t.date_exec,
              account:       t.account,
              exercised:     t.exercised,
              matchConfidence: t.match_confidence || null,
              parentId:      t.match_id || null,
              matchedContract: null,
              priceAtExecution: null,
              priceAtExecutionAuto: false,
              strategy:      t.strategy || null,
              tradeRule:     t.trade_rule || null,
              _raw:          t._raw,
            }));
        }
      } catch (e) {
        console.warn("[ImportPage] ETrade fetch failed:", e.message);
        // Don't fail the whole fetch if ETrade fails
      }

      // ── Merge and add UI state ──────────────────────────────────────────────
      const schwabTxs = (schwabData.transactions || []).map(t => ({ ...t, account: t.account || "Schwab" }));
      const allTxs    = [...schwabTxs, ...etradeTxs];

      const txs = allTxs.map((t, i) => ({
        ...t,
        _idx: i,
        strategy: t.strategy || (t.type === "Call" && t.optType === "STO" ? "OTM Covered Call Strategy" : null),
      }));

      setTransactions(txs);
      setOpenContracts(schwabData.openContracts || []);
      setMeta({ ...schwabData.meta, total: txs.length });
      setChecked(new Set());

      // Load committed IDs for filter
      try {
        const { data } = await supabase.from("pending_transactions")
          .select("schwab_transaction_id")
          .not("schwab_transaction_id", "is", null);
        setCommittedIds(new Set((data||[]).map(r => String(r.schwab_transaction_id))));
      } catch(e) { console.warn("committedIds load failed:", e.message); }

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

  // ── Dismiss helpers ─────────────────────────────────────────────────────────
  const dismiss = (idx) => {
    setDismissed(prev => new Set([...prev, idx]));
    setChecked(prev => { const n = new Set(prev); n.delete(idx); return n; });
  };
  const dismissGroup = (splitGroup) => {
    const idxs = transactions.filter(t => t.splitGroup === splitGroup).map(t => t._idx);
    setDismissed(prev => new Set([...prev, ...idxs]));
    setChecked(prev => { const n = new Set(prev); idxs.forEach(i => n.delete(i)); return n; });
  };
  const undismiss = (idx) => setDismissed(prev => { const n = new Set(prev); n.delete(idx); return n; });

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
    const ETRADE_CUTOVER = "2026-05-03";
    const toCommit = transactions.filter(t =>
      checked.has(t._idx) &&
      !(t.account?.startsWith("ETrade") && t.dateExec < ETRADE_CUTOVER)
    );
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

  // ── Filtered + sorted view ──────────────────────────────────────────────────
  const SORT_KEYS = {
    stock: t => t.stock ?? "",
    optType: t => t.optType ?? "",
    strike: t => Number(t.strike) ?? 0,
    expires: t => t.expires ?? "",
    qty: t => Number(t.qty) ?? 0,
    premium: t => Number(t.premium) ?? 0,
    priceAtExecution: t => Number(t.priceAtExecution) ?? 0,
    dateExec: t => t.dateExec ?? "",
    matchConfidence: t => t.matchConfidence ?? "",
  };

  const filtered = transactions
    .filter(t => filterOptType === "ALL" ? true : t.optType === filterOptType)
    .filter(t => matchFilter === "ALL" ? true : t.matchConfidence === matchFilter)
    .filter(t => accountFilter === "ALL" ? true : t.account === accountFilter)
    .filter(t => hideCommitted ? !committedIds.has(String(t.schwabTransactionId)) : true)
    .filter(t => showDismissed ? dismissed.has(t._idx) : !dismissed.has(t._idx))
    .sort((a, b) => {
      const fn = SORT_KEYS[sortCol] ?? (t => "");
      const av = fn(a), bv = fn(b);
      const cmp = typeof av === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <span style={{ color: "#2a3040", marginLeft: 3 }}>⇅</span>;
    return <span style={{ color: C.blue, marginLeft: 3 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  // Pre-compute split group premium totals for display
  const splitGroupTotals = {};
  for (const t of transactions) {
    if (!t.splitGroup) continue;
    splitGroupTotals[t.splitGroup] = (splitGroupTotals[t.splitGroup] ?? 0) + (t.premium ?? 0);
  }

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

  // ── Pending transactions section (shown on all screens) ───────────────────
  const [pendingFilter, setPendingFilter] = useState("pending"); // pending | committed | skipped | all
  const [allPending, setAllPending] = useState([]);

  const loadAllPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const { data } = await supabase
        .from("pending_transactions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      setAllPending((data || []).map((t, i) => ({ ...t, _idx: i, strategy: t.strategy || "", trade_rule: t.trade_rule || "", notes: t.notes || "" })));
      // Also update pending (status=pending only) for badge count
      const pendingOnly = (data || []).filter(t => t.status === "pending");
      setPending(pendingOnly.map((t, i) => ({ ...t, _idx: i, strategy: t.strategy || "", trade_rule: t.trade_rule || "", notes: t.notes || "" })));
    } catch (e) { console.warn("loadAllPending:", e.message); }
    setPendingLoading(false);
  }, [supabase]);

  // Replace loadPending with loadAllPending on mount
  useEffect(() => { loadAllPending(); }, [loadAllPending]);

  const filteredPending = allPending.filter(t =>
    pendingFilter === "all" ? true : t.status === pendingFilter
  );

  const PendingSection = allPending.length > 0 ? (
    <div style={{ maxWidth: 1100, margin: "0 auto 28px auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          📥 Transactions
        </div>
        {/* Filter tabs */}
        {["pending","committed","skipped","all"].map(f => {
          const count = f === "all" ? allPending.length : allPending.filter(t => t.status === f).length;
          if (count === 0 && f !== "pending") return null;
          return (
            <button key={f} onClick={() => setPendingFilter(f)}
              style={{ fontSize: 9, fontFamily: "monospace", textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: pendingFilter === f ? "1px solid #00ff8844" : `1px solid ${C.border}`, background: pendingFilter === f ? "#00ff8814" : "transparent", color: pendingFilter === f ? C.green : C.dimText }}>
              {f} {count > 0 && <span style={{ background: f === "pending" ? "#ff6b2b" : C.dimText, color: "#fff", borderRadius: 8, fontSize: 7, fontWeight: 700, padding: "0px 4px", marginLeft: 3 }}>{count}</span>}
            </button>
          );
        })}
        <button onClick={loadAllPending} style={{ background: "transparent", border: "none", color: C.dimText, fontSize: 10, cursor: "pointer", marginLeft: "auto" }}>
          ↻ Refresh
        </button>
      </div>
      {filteredPending.length === 0 ? (
        <div style={{ color: C.dimText, fontSize: 11, fontFamily: "monospace", padding: "12px 0" }}>No {pendingFilter} transactions.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filteredPending.map(t => {
            const isClose    = ["BTC","STC"].includes(t.opt_type);
            const isCommitting = committingPending.has(t.id);
            const isPending  = t.status === "pending";
            const matchColor = t.match_confidence === "exact" ? C.green : t.match_confidence === "partial" ? C.yellow : C.red;
            const matchLabel = t.match_confidence === "exact" ? "✓ Matched" : t.match_confidence === "partial" ? "~ Partial" : "⚠ No Match";
            const statusColor = t.status === "committed" ? C.green : t.status === "skipped" ? C.dimText : C.yellow;
            return (
              <div key={t.id} style={{ background: C.card, border: `1px solid ${isClose && t.match_confidence === "none" && isPending ? C.red + "44" : C.border}`, borderRadius: 8, padding: "10px 14px", opacity: t.status !== "pending" ? 0.6 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {/* Status badge */}
                  {t.status !== "pending" && (
                    <div style={{ fontSize: 9, color: statusColor, fontFamily: "monospace", background: statusColor + "18", borderRadius: 4, padding: "1px 6px", textTransform: "uppercase" }}>
                      {t.status}
                    </div>
                  )}
                  {/* Transaction info */}
                  <div style={{ fontFamily: "monospace", fontSize: 12, color: C.text, fontWeight: 700, minWidth: 180 }}>
                    {t.opt_type} {t.stock} {t.expires} ${t.strike} {t.type}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: t.premium >= 0 ? C.green : C.red }}>
                    {t.premium >= 0 ? "+" : ""}{t.premium}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: C.dimText }}>
                    qty={t.qty} · {t.date_exec}
                  </div>
                  {t.stock_price_at_exec && (
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: C.dimText }}>
                      stk@${t.stock_price_at_exec}
                    </div>
                  )}
                  {isClose && (
                    <div style={{ fontSize: 10, color: matchColor, fontFamily: "monospace", background: matchColor + "18", borderRadius: 4, padding: "1px 6px" }}>
                      {matchLabel}
                    </div>
                  )}
                  {/* Edit fields + actions (only for pending) */}
                  {isPending ? (
                    <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
                      <select value={t.strategy || ""} onChange={e => updatePending(t.id, "strategy", e.target.value)}
                        style={{ fontSize: 10, background: C.input, border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "2px 5px" }}>
                        <option value="">— strategy —</option>
                        {["OTM Covered Call Strategy","Put Spread","BTO Call","Iron Condor","Other"].map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      {ruleNames?.length > 0 && (
                        <select value={t.trade_rule || ""} onChange={e => updatePending(t.id, "trade_rule", e.target.value)}
                          style={{ fontSize: 10, background: C.input, border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "2px 5px" }}>
                          <option value="">— rule —</option>
                          {ruleNames.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      )}
                      <input value={t.notes || ""} onChange={e => updatePending(t.id, "notes", e.target.value)}
                        placeholder="notes..." style={{ fontSize: 10, background: C.input, border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: "2px 7px", width: 120 }} />
                      <button onClick={() => commitPendingTx(t)} disabled={isCommitting || (t.account?.startsWith("ETrade") && t.date_exec < "2026-05-03")}
                        title={t.account?.startsWith("ETrade") && t.date_exec < "2026-05-03" ? "ETrade cutover is 2026-05-03 — cannot commit earlier transactions" : ""}
                        style={{ fontSize: 10, background: isCommitting ? C.dimText : (t.account?.startsWith("ETrade") && t.date_exec < "2026-05-03") ? C.dimText : C.green, color: "#000", border: "none", borderRadius: 4, padding: "3px 10px", fontWeight: 700, cursor: (isCommitting || (t.account?.startsWith("ETrade") && t.date_exec < "2026-05-03")) ? "default" : "pointer", opacity: (t.account?.startsWith("ETrade") && t.date_exec < "2026-05-03") ? 0.4 : 1 }}>
                        {isCommitting ? "Saving..." : "Commit →"}
                      </button>
                      <button onClick={() => skipPendingTx(t)}
                        style={{ fontSize: 10, background: "transparent", color: C.dimText, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
                        Skip
                      </button>
                    </div>
                  ) : (
                    <div style={{ marginLeft: "auto", fontSize: 10, color: C.dimText, fontFamily: "monospace" }}>
                      {t.reviewed_at ? new Date(t.reviewed_at).toLocaleString() : ""}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  ) : pendingLoading ? (
    <div style={{ maxWidth: 1100, margin: "0 auto 28px auto", color: C.dimText, fontSize: 11, fontFamily: "monospace" }}>Loading transactions...</div>
  ) : null;

  // ── Config screen ─────────────────────────────────────────────────────────
  if (mode === "config") {
    return (
      <div style={page}>
        <div style={{ maxWidth: 580, margin: "0 auto" }}>
          {PendingSection}
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

          {/* Test mode toggle — locked in parallel-run mode */}
          <div style={{ ...card, border: `1px solid ${parallelRun ? C.orange + "44" : testMode ? C.yellow + "44" : C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: parallelRun ? C.orange : testMode ? C.yellow : C.text }}>
                  {parallelRun ? "⚡ Parallel Run Mode" : testMode ? "🧪 Test Mode ON" : "🚀 Live Mode"}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                  {parallelRun
                    ? "Commit is disabled — reviewing transactions in parallel with manual entry. Cut over date TBD."
                    : testMode
                    ? "Transactions will NOT be saved to the database. Safe for testing."
                    : "Transactions WILL be committed to the production database."}
                </div>
              </div>
              {!parallelRun && (
                <button onClick={() => setTestMode(v => !v)} style={btn(testMode ? C.yellow : C.green)}>
                  {testMode ? "Switch to Live" : "Switch to Test"}
                </button>
              )}
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
          {PendingSection}
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
  const checkedCount    = checked.size;
  const allActive       = transactions.filter(t => !dismissed.has(t._idx));
  const unmatchedCount  = allActive.filter(t => t.matchConfidence === "unmatched").length;
  const exactCount      = allActive.filter(t => t.matchConfidence === "exact").length;
  const partialCount    = allActive.filter(t => t.matchConfidence === "partial").length;
  const splitCount      = allActive.filter(t => t.matchConfidence === "split").length;
  const dismissedCount  = dismissed.size;

  return (
    <div style={{ ...page, padding: "16px 20px" }}>
      {PendingSection}
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
          {/* Match confidence filters */}
          {[
            { key: "ALL",       label: "All",       color: C.muted,   count: null },
            { key: "exact",     label: "Exact",     color: C.green,   count: exactCount },
            { key: "partial",   label: "Partial",   color: C.yellow,  count: partialCount },
            { key: "split",     label: "Split",     color: C.blue,    count: splitCount },
            { key: "unmatched", label: "Unmatched", color: C.red,     count: unmatchedCount },
          ].map(({ key, label, color, count }) => (
            <button key={key} onClick={() => setMatchFilter(key)}
              style={{ ...btn(color), background: matchFilter === key ? color + "33" : "transparent", fontSize: 11, padding: "4px 10px" }}>
              {label}
              {count > 0 && <span style={{ marginLeft: 4, background: color + "33", borderRadius: 8, padding: "1px 5px" }}>{count}</span>}
            </button>
          ))}
          {dismissedCount > 0 && (
            <button onClick={() => setShowDismissed(v => !v)}
              style={{ ...btn(C.dimText), background: showDismissed ? C.dimText + "22" : "transparent", fontSize: 11, padding: "4px 10px" }}>
              {showDismissed ? "← Active" : `Dismissed (${dismissedCount})`}
            </button>
          )}
          <button onClick={() => setHideCommitted(v => !v)}
            style={{ ...btn(hideCommitted ? C.green : C.dimText), background: hideCommitted ? C.green + "22" : "transparent", fontSize: 11, padding: "4px 10px" }}>
            {hideCommitted ? "✓ Hide Committed" : "Show All"}
          </button>
          <div style={{ width: 1, height: 20, background: C.border }} />
          {/* Account filter */}
          {[
            { key: "ALL",          label: "All Accts",   color: C.muted },
            { key: "Schwab",       label: "Schwab",      color: "#4fc3f7" },
            { key: "ETrade 6917",  label: "ETrade 6917", color: "#ffd166" },
            { key: "ETrade 8222",  label: "ETrade 8222", color: "#ffd166" },
          ].map(({ key, label, color }) => {
            const count = key === "ALL" ? transactions.length : transactions.filter(t => t.account === key).length;
            if (count === 0 && key !== "ALL") return null;
            return (
              <button key={key} onClick={() => setAccountFilter(key)}
                style={{ ...btn(color), background: accountFilter === key ? color + "33" : "transparent", fontSize: 11, padding: "4px 10px" }}>
                {label}
                {count > 0 && key !== "ALL" && <span style={{ marginLeft: 4, background: color + "33", borderRadius: 8, padding: "1px 5px" }}>{count}</span>}
              </button>
            );
          })}
          <div style={{ width: 1, height: 20, background: C.border }} />
          <button onClick={checkAll}  style={btn(C.blue, false)}>Check All</button>
          <button onClick={uncheckAll} style={btn(C.muted)}>Uncheck All</button>
          {parallelRun && (
            <button
              onClick={() => { checked.forEach(idx => dismiss(idx)); setChecked(new Set()); }}
              disabled={checkedCount === 0}
              style={{ ...btn(C.orange, checkedCount === 0), fontSize: 11, padding: "4px 10px" }}>
              ✓ Clear Reviewed ({checkedCount})
            </button>
          )}
          <button
            onClick={parallelRun ? undefined : commitChecked}
            disabled={checkedCount === 0 || committing || parallelRun}
            title={parallelRun ? "Commit disabled during parallel run" : ""}
            style={btn(C.green, checkedCount === 0 || committing || parallelRun)}>
            {parallelRun ? "🔒 Commit Disabled" : committing ? "Saving..." : `${testMode ? "Test Commit" : "Commit"} ${checkedCount > 0 ? checkedCount : ""} Checked →`}
          </button>
        </div>
      </div>

      {parallelRun && (
        <div style={{ background: C.orange + "0a", border: `1px solid ${C.orange}44`, borderRadius: 6, padding: "8px 14px", marginBottom: 10, fontSize: 11, color: C.orange, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>⚡ <strong>Parallel Run</strong> — reviewing only, no commits. Cut over date TBD (next weekend).</span>
          <span style={{ color: C.dimText, fontSize: 10 }}>Cutover: pull transactions after that date only</span>
        </div>
      )}
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
                {[
                  { label: "Stock",       col: "stock",            align: "left"  },
                  { label: "Type",        col: "optType",          align: "left"  },
                  { label: "Strike",      col: "strike",           align: "right" },
                  { label: "Expiry",      col: "expires",          align: "left"  },
                  { label: "Qty",         col: "qty",              align: "right" },
                  { label: "Premium",     col: "premium",          align: "right" },
                  { label: "Stock Price", col: "priceAtExecution", align: "right", minWidth: 100 },
                  { label: "Date",        col: "dateExec",         align: "left"  },
                  { label: "Strategy",    col: null,               align: "left",  minWidth: 130 },
                  { label: "Trade Rule",  col: null,               align: "left",  minWidth: 130 },
                  { label: "Notes",       col: null,               align: "left",  minWidth: 160 },
                  { label: "Match",       col: "matchConfidence",  align: "left"  },
                ].map(({ label, col, align, minWidth }) => (
                  <th key={label}
                    onClick={col ? () => handleSort(col) : undefined}
                    style={{
                      padding: "8px 10px", textAlign: align,
                      color: sortCol === col ? C.blue : C.dimText,
                      fontWeight: 400, minWidth,
                      cursor: col ? "pointer" : "default",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}>
                    {label}{col && <SortIcon col={col} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const isChecked  = checked.has(t._idx);
                const isDismissed = dismissed.has(t._idx);
                const isSplit    = !!t.splitGroup;
                const splitColor = C.blue + "22";
                const rowBg = isDismissed ? "#ffffff05"
                            : isChecked   ? C.green + "08"
                            : isSplit     ? splitColor
                            : "transparent";
                return (
                  <tr key={t._idx}
                    style={{
                      background: rowBg,
                      borderBottom: `1px solid ${C.border}`,
                      borderLeft: isSplit ? `3px solid ${C.blue}66` : "3px solid transparent",
                      opacity: isDismissed ? 0.4 : 1,
                      transition: "background 0.15s",
                    }}
                    onClick={() => !isDismissed && toggleCheck(t._idx)}>

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

                    {/* Premium — for split fills, show individual + group total on last leg */}
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700 }}>
                      <div style={{ color: t.premium >= 0 ? C.green : C.red }}>
                        {t.premium >= 0 ? "+" : ""}${Math.abs(t.premium).toFixed(2)}
                      </div>
                      {t.splitGroup && t.splitIndex === t.splitCount && (() => {
                        const total = splitGroupTotals[t.splitGroup] ?? 0;
                        return (
                          <div style={{ fontSize: 10, color: C.blue, marginTop: 2, borderTop: `1px solid ${C.blue}44`, paddingTop: 2 }}>
                            ∑ {total >= 0 ? "+" : ""}${Math.abs(total).toFixed(2)}
                          </div>
                        );
                      })()}
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

                    {/* Trade Rule — editable dropdown */}
                    <td style={{ padding: "6px 10px" }} onClick={e => e.stopPropagation()}>
                      <EditCell
                        value={t.tradeRule}
                        onChange={v => updateTx(t._idx, "tradeRule", v || null)}
                        options={ruleNames.length ? ruleNames : undefined}
                        placeholder="optional rule"
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

                    {/* Match cell — actions depend on confidence */}
                    <td style={{ padding: "6px 10px", minWidth: 180 }} onClick={e => e.stopPropagation()}>
                      {(t.optType === "BTC" || t.optType === "STC") ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {/* Confidence pill + parent id */}
                          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                            <span style={pill(t.matchConfidence, MATCH_COLORS[t.matchConfidence] || C.muted)}>
                              {t.matchConfidence}
                              {t.splitGroup && ` ${t.splitIndex}/${t.splitCount}`}
                            </span>
                            {t.parentId && <span style={{ fontSize: 10, color: C.dimText }}>#{t.parentId}</span>}
                          </div>
                          {/* Matched contract summary */}
                          {t.matchedContract && (
                            <div style={{ fontSize: 10, color: C.muted }}>
                              {t.matchedContract.stock} {t.matchedContract.strike} {t.matchedContract.expires?.slice(5)} ×{t.matchedContract.qty}
                            </div>
                          )}
                          {/* Action buttons per confidence */}
                          {!dismissed.has(t._idx) && (
                            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                              {/* Exact: dismiss or import anyway */}
                              {t.matchConfidence === "exact" && (<>
                                <button onClick={e => { e.stopPropagation(); dismiss(t._idx); }}
                                  style={{ fontSize: 10, background: C.green+"11", border:`1px solid ${C.green}44`, borderRadius:3, color:C.green, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✓ Dismiss
                                </button>
                                <button onClick={e => { e.stopPropagation(); setMatchModal({ txIdx: t._idx }); }}
                                  style={{ fontSize: 10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✎ Change
                                </button>
                              </>)}
                              {/* Partial: edit opener, link, or dismiss */}
                              {t.matchConfidence === "partial" && (<>
                                <button onClick={e => { e.stopPropagation(); setEditOpenerModal({ txIdx: t._idx, contract: t.matchedContract }); }}
                                  style={{ fontSize: 10, background: C.yellow+"11", border:`1px solid ${C.yellow}44`, borderRadius:3, color:C.yellow, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✎ Edit Opener
                                </button>
                                <button onClick={e => { e.stopPropagation(); setMatchModal({ txIdx: t._idx }); }}
                                  style={{ fontSize: 10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.muted, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  🔗 Link
                                </button>
                                <button onClick={e => { e.stopPropagation(); dismiss(t._idx); }}
                                  style={{ fontSize: 10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✕
                                </button>
                              </>)}
                              {/* Split: dismiss whole group or change */}
                              {t.matchConfidence === "split" && (<>
                                <button onClick={e => { e.stopPropagation(); dismissGroup(t.splitGroup); }}
                                  style={{ fontSize: 10, background: C.blue+"11", border:`1px solid ${C.blue}44`, borderRadius:3, color:C.blue, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✓ Dismiss All
                                </button>
                                <button onClick={e => { e.stopPropagation(); setMatchModal({ txIdx: t._idx }); }}
                                  style={{ fontSize: 10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✎ Change
                                </button>
                              </>)}
                              {/* Unmatched: link, dismiss, or import as orphan */}
                              {t.matchConfidence === "unmatched" && (<>
                                <button onClick={e => { e.stopPropagation(); setMatchModal({ txIdx: t._idx }); }}
                                  style={{ fontSize: 10, background: C.red+"11", border:`1px solid ${C.red}44`, borderRadius:3, color:C.red, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  🔗 Link
                                </button>
                                <button onClick={e => { e.stopPropagation(); dismiss(t._idx); }}
                                  style={{ fontSize: 10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                                  ✕ Dismiss
                                </button>
                              </>)}
                              {/* Debug always available */}
                              <button onClick={e => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(JSON.stringify({ parsed: { schwabTransactionId:t.schwabTransactionId, stock:t.stock, optType:t.optType, strike:t.strike, qty:t.qty, expires:t.expires, premium:t.premium, dateExec:t.dateExec, matchConfidence:t.matchConfidence, parentId:t.parentId, splitGroup:t.splitGroup }, raw:t._raw }, null, 2))
                                  .then(() => { e.target.textContent="✓"; setTimeout(()=>{e.target.textContent="⎘";},1500); });
                              }} style={{ fontSize:10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 6px", cursor:"pointer" }}>⎘</button>
                            </div>
                          )}
                          {/* Undismiss if dismissed */}
                          {dismissed.has(t._idx) && (
                            <button onClick={e => { e.stopPropagation(); undismiss(t._idx); }}
                              style={{ fontSize:10, background:"transparent", border:`1px solid ${C.border2}`, borderRadius:3, color:C.dimText, fontFamily:"monospace", padding:"2px 7px", cursor:"pointer" }}>
                              ↺ Restore
                            </button>
                          )}
                        </div>
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

      {/* Edit Opener Modal */}
      {editOpenerModal && (() => {
        const tx = transactions.find(t => t._idx === editOpenerModal.txIdx);
        return (
          <EditOpenerModal
            contract={editOpenerModal.contract}
            closer={tx}
            onSave={updated => {
              // Update the matchedContract in the transaction so display reflects the fix
              updateTx(editOpenerModal.txIdx, "matchedContract", updated);
              updateTx(editOpenerModal.txIdx, "matchConfidence", "exact");
            }}
            onClose={() => setEditOpenerModal(null)}
          />
        );
      })()}

      {/* Match Modal */}
      {matchModal && (() => {
        const tx = transactions.find(t => t._idx === matchModal.txIdx);
        if (!tx) return null;
        return (
          <MatchModal
            closer={tx}
            openContracts={openContracts}
            onSelect={matched => {
              if (matched) {
                updateTx(matchModal.txIdx, "parentId", matched.id);
                updateTx(matchModal.txIdx, "matchConfidence", "manual");
                updateTx(matchModal.txIdx, "matchedContract", matched);
              } else {
                updateTx(matchModal.txIdx, "parentId", null);
                updateTx(matchModal.txIdx, "matchConfidence", "unmatched");
                updateTx(matchModal.txIdx, "matchedContract", null);
              }
            }}
            onClose={() => setMatchModal(null)}
          />
        );
      })()}

      {/* Bottom action bar */}
      <div style={{ position: "sticky", bottom: 0, background: C.surface, borderTop: `1px solid ${C.border}`, padding: "12px 0", marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => setMode("config")} style={btn(C.muted)}>
          ← Back to Config
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: C.muted }}>
            {checkedCount} of {filtered.length} selected
          </span>
          {parallelRun && (
            <button
              onClick={() => {
                // Clear reviewed = dismiss all checked rows
                checked.forEach(idx => dismiss(idx));
                setChecked(new Set());
              }}
              disabled={checkedCount === 0}
              style={{ ...btn(C.orange, checkedCount === 0), padding: "9px 20px", fontSize: 14 }}>
              ✓ Clear Reviewed ({checkedCount})
            </button>
          )}
          <button
            onClick={parallelRun ? undefined : commitChecked}
            disabled={checkedCount === 0 || committing || parallelRun}
            title={parallelRun ? "Commit disabled during parallel run — cut over date TBD" : ""}
            style={{ ...btn(C.green, checkedCount === 0 || committing || parallelRun), padding: "9px 24px", fontSize: 14, position: "relative" }}>
            {committing ? "Saving..." : parallelRun ? `🔒 Commit Disabled` : testMode ? `🧪 Test Commit (${checkedCount})` : `Commit ${checkedCount} Transactions →`}
          </button>
        </div>
      </div>
    </div>
  );
}
