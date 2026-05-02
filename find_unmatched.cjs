const fs = require("fs");
const db = JSON.parse(fs.readFileSync("db_contracts.json", "utf8"));
const tx = JSON.parse(fs.readFileSync("tx_full.json", "utf8")).transactions;

const dbKeys = new Set(db.map(c =>
  c.stock + "|" + c.opt_type + "|" + c.strike + "|" + c.expires + "|" + Math.round(parseFloat(c.premium) * 100)
));

const unmatched = tx.filter(t =>
  !dbKeys.has(t.stock + "|" + t.optType + "|" + t.strike + "|" + t.expires + "|" + Math.round(parseFloat(t.premium) * 100))
);

console.log("Schwab txs not in DB:", unmatched.length);
unmatched.forEach(t =>
  console.log(t.schwabTransactionId, t.dateExec, t.stock, t.optType, t.qty, t.premium)
);
