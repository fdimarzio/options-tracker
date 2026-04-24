// api/etrade-notify-test.js - TEMPORARY test endpoint
// Open in browser to send a test Pushover notification:
// https://options-tracker-five.vercel.app/api/etrade-notify-test

export default async function handler(req, res) {
  const PUSHOVER_TOKEN = process.env.PUSHOVER_API_TOKEN;
  const PUSHOVER_USER  = process.env.PUSHOVER_USER_KEY;

  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
    return res.status(500).json({ error: "Pushover credentials missing", 
      token: PUSHOVER_TOKEN ? "set" : "MISSING",
      user:  PUSHOVER_USER  ? "set" : "MISSING",
    });
  }

  const pushRes = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token:   PUSHOVER_TOKEN,
      user:    PUSHOVER_USER,
      title:   "CLOSE SIGNAL: NVDA 05/22 $210 Call",
      message: "Up 98% ($1,240) - consider closing or selling 4 of 7 to lock in cost basis.",
      priority: 1,
      sound:   "cashregister",
    }),
  });

  const data = await pushRes.json();
  res.status(200).json({ pushover_response: data });
}
