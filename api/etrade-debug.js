// api/etrade-debug.js - TEMPORARY - delete after debugging
export default async function handler(req, res) {
  const token  = process.env.ETRADE_ACCESS_TOKEN;
  const secret = process.env.ETRADE_ACCESS_TOKEN_SECRET;
  const key    = process.env.ETRADE_CONSUMER_KEY;
  res.status(200).json({
    ETRADE_CONSUMER_KEY:         key    ? key.slice(0,8)+"..."    : "MISSING",
    ETRADE_ACCESS_TOKEN:         token  ? token.slice(0,8)+"..."  : "MISSING",
    ETRADE_ACCESS_TOKEN_SECRET:  secret ? secret.slice(0,8)+"..." : "MISSING",
    token_length:  token?.length,
    secret_length: secret?.length,
  });
}
