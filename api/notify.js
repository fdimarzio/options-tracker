// api/notify.js
// Vercel serverless function — evaluates open contracts against targets
// and sends Pushover notifications for actionable signals.
//
// Called from the browser after a live data refresh:
//   POST /api/notify
//   Body: { contracts: [...], quotes: {...}, chains: {...} }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const PUSHOVER_TOKEN   = process.env.PUSHOVER_API_TOKEN;
  const PUSHOVER_USER    = process.env.PUSHOVER_USER_KEY;

  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
    return res.status(500).json({ error: "Pushover credentials not configured" });
  }

  try {
    const { signals } = req.body;
    console.log("[notify] received", signals?.length ?? 0, "signals");
    if (!signals?.length) return res.status(200).json({ sent: 0, debug: "no signals received" });

    const sent = [];
    for (const signal of signals) {
      const msg = buildMessage(signal);
      if (!msg) continue;

      const pushRes = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token:    PUSHOVER_TOKEN,
          user:     PUSHOVER_USER,
          title:    msg.title,
          message:  msg.body,
          priority: msg.priority ?? 0,  // 0=normal, 1=high, 2=emergency
          sound:    msg.priority >= 1 ? "cashregister" : "pushover",
        }),
      });

      const pushBody = await pushRes.json();
      console.log("[notify] Pushover response:", JSON.stringify(pushBody));
      if (pushBody.status === 1) {
        sent.push(signal.contract);
      } else {
        console.error("[notify] Pushover error:", JSON.stringify(pushBody));
      }
    }

    res.status(200).json({ sent: sent.length, contracts: sent });
  } catch (err) {
    console.error("[notify] error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

function buildMessage(signal) {
  const { contract, type, gainPct, gainDollar, targetClose, qty, partialQty } = signal;
  switch (type) {
    case "TARGET_HIT":
      return {
        title: "CLOSE SIGNAL: " + contract,
        body:  "Gain " + (gainPct >= 0 ? "+" : "") + gainPct.toFixed(1) + "% ($" + gainDollar.toFixed(0) + ") has hit your target of $" + targetClose.toFixed(0) + ". Consider closing now.",
        priority: 1,
      };
    case "PARTIAL_CLOSE":
      return {
        title: "LOCK IN PROFIT: " + contract,
        body:  "Up " + gainPct.toFixed(0) + "% - sell " + partialQty + " of " + qty + " contracts to recover cost basis and let the rest ride.",
        priority: 1,
      };
    case "APPROACHING_TARGET":
      return {
        title: "APPROACHING TARGET: " + contract,
        body:  "Gain " + gainPct.toFixed(1) + "% ($" + gainDollar.toFixed(0) + ") - getting close to your target of $" + targetClose.toFixed(0) + ".",
        priority: 0,
      };
    default:
      return null;
  }
}
