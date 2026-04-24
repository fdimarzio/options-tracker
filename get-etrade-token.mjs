import crypto from "crypto";

const CONSUMER_KEY    = "5974003f6130ba9664e925753f1619f2";
const CONSUMER_SECRET = "c45454cd8dda76bc0d68a268947aa780ea9b6fae48d27e5a52661242a71bd29f";
const BASE_URL        = "https://api.etrade.com";

function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function sign(method, url, params, cs, ts = "") {
  const ps = Object.entries(params).map(([k,v]) => [pct(k),pct(v)]).sort(([a],[b]) => a<b?-1:1).map(([k,v]) => `${k}=${v}`).join("&");
  return crypto.createHmac("sha1", `${pct(cs)}&${pct(ts)}`).update([method,pct(url),pct(ps)].join("&")).digest("base64");
}
function auth(params) {
  return "OAuth " + Object.entries(params).map(([k,v]) => `${pct(k)}="${pct(v)}"`).join(", ");
}

const step = process.argv[2];
const token = process.argv[3];
const secret = process.argv[4];
const verifier = process.argv[5];

if (!step || step === "1") {
  const url = `${BASE_URL}/oauth/request_token`;
  const p = { oauth_callback:"oob", oauth_consumer_key:CONSUMER_KEY, oauth_nonce:crypto.randomBytes(16).toString("hex"), oauth_signature_method:"HMAC-SHA1", oauth_timestamp:String(Math.floor(Date.now()/1000)), oauth_version:"1.0" };
  p.oauth_signature = sign("GET", url, p, CONSUMER_SECRET);
  const text = await (await fetch(url, { headers:{ Authorization:auth(p) } })).text();
  const t = Object.fromEntries(new URLSearchParams(text));
  console.log("\nOpen this URL in your browser RIGHT NOW:");
  console.log(`https://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${t.oauth_token}`);
  console.log(`\nThen immediately run:`);
  console.log(`node get-etrade-token.mjs 3 "${t.oauth_token}" "${t.oauth_token_secret}" "YOURCODE"`);
} else if (step === "3") {
  const url = `${BASE_URL}/oauth/access_token`;
  const p = { oauth_consumer_key:CONSUMER_KEY, oauth_nonce:crypto.randomBytes(16).toString("hex"), oauth_signature_method:"HMAC-SHA1", oauth_timestamp:String(Math.floor(Date.now()/1000)), oauth_token:token, oauth_verifier:verifier, oauth_version:"1.0" };
  p.oauth_signature = sign("GET", url, p, CONSUMER_SECRET, secret);
  const text = await (await fetch(url, { headers:{ Authorization:auth(p) } })).text();
  const t = Object.fromEntries(new URLSearchParams(text));
  if (t.oauth_token) {
    console.log("\n SUCCESS! Update Vercel env vars with:");
    console.log(`ETRADE_ACCESS_TOKEN=${t.oauth_token}`);
    console.log(`ETRADE_ACCESS_TOKEN_SECRET=${t.oauth_token_secret}`);
  } else {
    console.log("Failed:", text.slice(0, 300));
  }
}