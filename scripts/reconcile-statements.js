// scripts/reconcile-statements.js
// Compares broker PDF statements against stock_transactions in Supabase.
// Flags: (a) in statement but missing from DB, (b) in DB but not on statement.
// Run: node --env-file=.env.local scripts/reconcile-statements.js [--broker schwab|etrade] [--month YYYY-MM]
//
// Directory layout:
//   statements/schwab/YYYY-MM.pdf
//   statements/etrade/YYYY-MM.pdf

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATEMENTS_DIR = path.join(__dirname, "..", "statements");
const REPORT_PATH    = path.join(STATEMENTS_DIR, "reconciliation-report.txt");

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

// ── Supabase ──────────────────────────────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status}`);
  return r.json();
}

// ── PDF parsing ───────────────────────────────────────────────────────────────
async function parsePDF(filePath) {
  let pdfParse;
  try {
    // Dynamic import — pdf-parse uses CommonJS require internally
    const mod = await import("pdf-parse");
    pdfParse = mod.default ?? mod;
  } catch (e) {
    throw new Error(`pdf-parse not available: ${e.message}. Run: npm install pdf-parse`);
  }

  const buf  = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return data.text;
}

// ── Transaction extractors ────────────────────────────────────────────────────
// These are heuristic parsers — adjust regexes to match your actual PDF format.

function extractSchwabTransactions(text, month) {
  const txns = [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Schwab statement lines typically look like:
    // "06/05/2026  Bought  AAPL  100  $213.50  $21,350.00"
    // Date pattern MM/DD/YYYY
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(Bought|Sold|Dividend|Interest|Wire|Journal)\s+(\S+)?/i);
    if (!m) continue;

    const [, dateStr, rawType, symbol] = m;
    const [mm, dd, yyyy] = dateStr.split("/");
    const date = `${yyyy}-${mm}-${dd}`;

    // Only include transactions in the target month
    if (!date.startsWith(month)) continue;

    const txType = rawType.toLowerCase() === "bought"  ? "BUY"
                 : rawType.toLowerCase() === "sold"    ? "SELL"
                 : rawType.toLowerCase() === "dividend"? "DIVIDEND"
                 : rawType.toLowerCase() === "interest"? "INTEREST"
                 : rawType.toLowerCase() === "wire"    ? "DEPOSIT"
                 : "JOURNAL";

    txns.push({ date, transaction_type: txType, symbol: symbol?.toUpperCase() || "CASH", source: "statement", file: path.basename(filePath) });
  }

  console.log(`  Extracted ${txns.length} transactions from ${path.basename(filePath)}`);
  return txns;
}

function extractEtradeTransactions(text, month) {
  // ETrade IRA — excluded by design (same as backfill)
  console.log(`  [ ETrade ] Skipping IRA statements by design`);
  return [];
}

// ── Match heuristic ───────────────────────────────────────────────────────────
function transactionKey(tx) {
  return `${tx.date}|${tx.transaction_type}|${(tx.symbol||"").toUpperCase()}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
    process.exit(1);
  }

  // Check statements directory
  if (!fs.existsSync(STATEMENTS_DIR)) {
    console.log("no statements found — directory does not exist:", STATEMENTS_DIR);
    process.exit(0);
  }

  // Collect all PDF files
  const pdfFiles = [];
  for (const broker of ["schwab", "etrade"]) {
    const brokerDir = path.join(STATEMENTS_DIR, broker);
    if (!fs.existsSync(brokerDir)) continue;
    const files = fs.readdirSync(brokerDir).filter(f => f.endsWith(".pdf"));
    files.forEach(f => pdfFiles.push({ broker, file: path.join(brokerDir, f), month: f.replace(".pdf","") }));
  }

  if (!pdfFiles.length) {
    console.log("no statements found — no PDF files in", STATEMENTS_DIR);
    fs.mkdirSync(path.join(STATEMENTS_DIR, "schwab"), { recursive: true });
    fs.mkdirSync(path.join(STATEMENTS_DIR, "etrade"), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `Reconciliation Report — ${new Date().toISOString()}\n\nno statements found\n`);
    process.exit(0);
  }

  console.log(`\nFound ${pdfFiles.length} statement file(s):`);
  pdfFiles.forEach(p => console.log(`  ${p.broker}/${path.basename(p.file)}`));

  // Parse all PDFs
  const statementTxns = [];
  for (const { broker, file, month } of pdfFiles) {
    console.log(`\nParsing ${broker}/${path.basename(file)}...`);
    try {
      const text = await parsePDF(file);
      const txns = broker === "schwab"
        ? extractSchwabTransactions(text, month)
        : extractEtradeTransactions(text, month);
      statementTxns.push(...txns);
    } catch (e) {
      console.warn(`  Failed to parse ${path.basename(file)}:`, e.message);
    }
  }

  // Determine date range from statements
  const months = pdfFiles.map(p => p.month).sort();
  const earliestMonth = months[0];
  const latestMonth   = months[months.length - 1];
  const startDate = `${earliestMonth}-01`;
  const endDate   = new Date(`${latestMonth}-01`);
  endDate.setMonth(endDate.getMonth() + 1);
  const endDateStr = endDate.toISOString().slice(0, 10);

  // Fetch DB transactions for the same period
  console.log(`\nFetching DB transactions ${startDate} → ${endDateStr}...`);
  const dbRows = await sbGet(
    `stock_transactions?select=id,schwab_transaction_id,symbol,transaction_type,trade_date,net_amount&trade_date=gte.${startDate}T00:00:00Z&trade_date=lt.${endDateStr}T00:00:00Z&order=trade_date.asc&limit=5000`
  );
  console.log(`  ${dbRows.length} DB transactions loaded`);

  // Build lookup sets
  const statementKeys = new Set(statementTxns.map(transactionKey));
  const dbKeys = new Set(dbRows.map(r => transactionKey({
    date: r.trade_date?.slice(0, 10),
    transaction_type: r.transaction_type,
    symbol: r.symbol,
  })));

  // Flag: in statement but not in DB
  const missingFromDB = statementTxns.filter(t => !dbKeys.has(transactionKey(t)));
  // Flag: in DB but not in statement (only for schwab transactions)
  const schwabDbRows = dbRows.filter(r => r.schwab_transaction_id);
  const missingFromStatement = schwabDbRows.filter(r => !statementKeys.has(transactionKey({
    date: r.trade_date?.slice(0, 10),
    transaction_type: r.transaction_type,
    symbol: r.symbol,
  })));

  // Build report
  const lines = [
    `Reconciliation Report`,
    `Generated: ${new Date().toISOString()}`,
    `Statements: ${pdfFiles.map(p => `${p.broker}/${path.basename(p.file)}`).join(", ")}`,
    `Period: ${startDate} → ${endDateStr}`,
    `Statement transactions: ${statementTxns.length}`,
    `DB transactions (Schwab, same period): ${dbRows.length}`,
    ``,
    `${"═".repeat(60)}`,
    `IN STATEMENT BUT MISSING FROM DB (${missingFromDB.length})`,
    `${"═".repeat(60)}`,
    ...(missingFromDB.length
      ? missingFromDB.map(t => `  ${t.date}  ${t.transaction_type.padEnd(12)}  ${(t.symbol||"").padEnd(8)}  [${t.file}]`)
      : ["  (none — all statement transactions found in DB)"]),
    ``,
    `${"═".repeat(60)}`,
    `IN DB BUT NOT ON STATEMENT (${missingFromStatement.length})`,
    `${"═".repeat(60)}`,
    ...(missingFromStatement.length
      ? missingFromStatement.map(r => `  ${r.trade_date?.slice(0,10)}  ${r.transaction_type.padEnd(12)}  ${(r.symbol||"").padEnd(8)}  id:${r.schwab_transaction_id}`)
      : ["  (none — all DB transactions appear on statement)"]),
    ``,
  ];

  const report = lines.join("\n");
  fs.mkdirSync(STATEMENTS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);

  console.log(`\n${report}`);
  console.log(`Report written to: ${REPORT_PATH}`);
  console.log(`\nSummary: ${missingFromDB.length} missing from DB, ${missingFromStatement.length} missing from statement`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
