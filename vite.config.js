import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import crypto from "crypto";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Support both VITE_ prefixed (local dev) and non-prefixed (Vercel) vars
  const consumerKey       = env.VITE_ETRADE_CONSUMER_KEY       || env.ETRADE_CONSUMER_KEY;
  const consumerSecret    = env.VITE_ETRADE_CONSUMER_SECRET     || env.ETRADE_CONSUMER_SECRET;
  const accessToken       = env.VITE_ETRADE_ACCESS_TOKEN        || env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = env.VITE_ETRADE_ACCESS_TOKEN_SECRET || env.ETRADE_ACCESS_TOKEN_SECRET;

  if (consumerKey) {
    console.log(`[etrade-proxy] Credentials loaded. Key: ${consumerKey.slice(0, 6)}...`);
  } else {
    console.warn("[etrade-proxy] WARNING - No E*TRADE credentials found in env");
  }

  return {
    plugins: [react()],

    server: {
      proxy: {
        "/etrade": {
          target: "https://api.etrade.com",
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/etrade/, ""),

          configure(proxy) {
            proxy.on("proxyReq", (proxyReq, req) => {
              const method = req.method ?? "GET";
              const rawPath = proxyReq.path;

              const qIdx = rawPath.indexOf("?");
              const pathOnly = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
              const queryString = qIdx >= 0 ? rawPath.slice(qIdx + 1) : "";

              const baseUrl = `https://api.etrade.com${pathOnly}`;
              const queryParams = queryString
                ? Object.fromEntries(new URLSearchParams(queryString))
                : {};

              console.log(`[etrade-proxy] -> ${method} ${baseUrl}${queryString ? "?" + queryString : ""}`);

              const authHeader = buildOAuth1Header({
                method, url: baseUrl, queryParams,
                consumerKey, consumerSecret, accessToken, accessTokenSecret,
              });

              proxyReq.setHeader("Authorization", authHeader);
              proxyReq.setHeader("Accept", "application/json");
              console.log(`[etrade-proxy]   Auth: ${authHeader.slice(0, 80)}...`);
            });

            proxy.on("proxyRes", (proxyRes, req) => {
              const status = proxyRes.statusCode;
              if (status !== 200) {
                console.warn(`[etrade-proxy] <- ${status} ${proxyRes.statusMessage} for ${req.url}`);
              } else {
                console.log(`[etrade-proxy] <- 200 OK for ${req.url}`);
              }
            });

            proxy.on("error", (err, _req, res) => {
              console.error("[etrade-proxy] connection error:", err.message);
              if (res && !res.headersSent) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "E*TRADE proxy error", detail: err.message }));
              }
            });
          },
        },
      },
    },

    build: {
      chunkSizeWarningLimit: 1200,
    },
  };
});

function buildOAuth1Header({ method, url, queryParams = {}, consumerKey, consumerSecret, accessToken, accessTokenSecret }) {
  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_token:            accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_version:          "1.0",
  };

  const allParams = { ...queryParams, ...oauthParams };
  const paramString = Object.entries(allParams)
    .map(([k, v]) => [pct(k), pct(String(v))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signatureBase = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey    = `${pct(consumerSecret)}&${pct(accessTokenSecret)}`;
  const signature     = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  oauthParams.oauth_signature = signature;
  return "OAuth " + Object.entries(oauthParams).map(([k, v]) => `${pct(k)}="${pct(String(v))}"`).join(", ");
}

function pct(str) {
  return encodeURIComponent(String(str ?? "")).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
