import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "./lib/supabase.js";
import { installApiAuth } from "./lib/apiAuth.js";
import { AuthContext } from "./lib/authContext.js";
import {
  roleAtLeast, isValidEmail, idleMsFromEnv, idleStatus, secondsUntilExpiry,
  normalizeAppUser, enabledProviders,
} from "./lib/authCore.js";

const ACTIVITY_KEY = "pri_last_activity";
const IDLE_MS = idleMsFromEnv(import.meta.env.VITE_IDLE_MINUTES);
const PROVIDERS = enabledProviders(import.meta.env.VITE_AUTH_PROVIDERS);
const RESEND_SECONDS = 30;

const readLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const lightMode = () => readLS("pri_light_mode") === "on";

function friendlyError(err) {
  const m = String(err?.message || err || "");
  if (/rate limit|too many|security purposes/i.test(m)) return "Too many attempts. Wait a minute and try again.";
  if (/expired|invalid/i.test(m)) return "That code or link is invalid or has expired. Request a new one.";
  if (/not allowed|signups not allowed|user not found/i.test(m)) return "If that email is authorized, a sign-in link is on its way.";
  return "Sign-in failed. Please try again.";
}

export default function AuthGate({ children }) {
  const [phase, setPhase] = useState("loading"); // loading | signedOut | checking | denied | setup | ready
  const [appUser, setAppUser] = useState(null);
  const [session, setSession] = useState(null);
  const [warnSecs, setWarnSecs] = useState(null);
  const sessionRef = useRef(null);
  const claimingRef = useRef(null);

  // Attach the user's token to /api/* calls (once, app-wide).
  useEffect(() => {
    installApiAuth(async () => {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token || null;
    });
  }, []);

  const signOut = useCallback(async () => {
    try { await supabase.auth.signOut(); } catch { /* already gone */ }
    setAppUser(null);
    setPhase("signedOut");
  }, []);

  // Resolve a Supabase session to an allow-listed app user.
  const resolveSession = useCallback(async (sess) => {
    if (sess && claimingRef.current === sess.access_token) return; // already resolving this session
    sessionRef.current = sess;
    setSession(sess);
    if (!sess) { claimingRef.current = null; setAppUser(null); setPhase("signedOut"); return; }
    claimingRef.current = sess.access_token;
    setPhase("checking");
    let { data, error } = await supabase.rpc("claim_app_user");
    // The first-ever sign-in binds the account server-side; retry once so a concurrent
    // caller that lost that race can never be shown a false "not authorized".
    if (!error && !(Array.isArray(data) ? data[0] : data)) {
      await new Promise(r => setTimeout(r, 400));
      ({ data, error } = await supabase.rpc("claim_app_user"));
    }
    if (sessionRef.current?.access_token !== sess.access_token) return; // superseded
    if (error) {
      console.error("[auth] claim_app_user failed:", error.message);
      setPhase("setup");
      return;
    }
    const row = normalizeAppUser(Array.isArray(data) ? data[0] : data);
    if (!row) { setAppUser(null); setPhase("denied"); return; }
    writeLS(ACTIVITY_KEY, String(Date.now()));
    setAppUser(row);
    setPhase("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => { if (!cancelled) resolveSession(data?.session ?? null); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (event === "TOKEN_REFRESHED") { sessionRef.current = sess; return; }
      if (event === "SIGNED_OUT") { resolveSession(null); return; }
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        // Defer: awaiting supabase calls inside this callback can deadlock the client.
        setTimeout(() => { if (!cancelled && sess?.access_token !== sessionRef.current?.access_token) resolveSession(sess); }, 0);
      }
    });
    return () => { cancelled = true; sub?.subscription?.unsubscribe(); };
  }, [resolveSession]);

  // Idle timeout — activity in any tab counts (shared via localStorage).
  useEffect(() => {
    if (phase !== "ready") return;
    let lastWrite = 0;
    const bump = () => {
      const now = Date.now();
      if (now - lastWrite < 5000) return;
      lastWrite = now;
      writeLS(ACTIVITY_KEY, String(now));
    };
    const events = ["mousedown", "keydown", "touchstart", "scroll", "pointermove"];
    events.forEach(e => window.addEventListener(e, bump, { passive: true }));
    const tick = setInterval(() => {
      const lastActivity = Number(readLS(ACTIVITY_KEY)) || Date.now();
      const now = Date.now();
      const status = idleStatus({ lastActivity, now, idleMs: IDLE_MS });
      if (status === "expired") { setWarnSecs(null); signOut(); }
      else if (status === "warn") setWarnSecs(secondsUntilExpiry({ lastActivity, now, idleMs: IDLE_MS }));
      else setWarnSecs(null);
    }, 1000);
    return () => { events.forEach(e => window.removeEventListener(e, bump)); clearInterval(tick); };
  }, [phase, signOut]);

  const ctx = useMemo(() => ({
    user: appUser,
    role: appUser?.role,
    email: session?.user?.email,
    can: (minRole) => roleAtLeast(appUser?.role, minRole),
    signOut,
  }), [appUser, session, signOut]);

  if (phase === "ready" && appUser) {
    return (
      <AuthContext.Provider value={ctx}>
        {children}
        {warnSecs !== null && (
          <div role="alertdialog" aria-label="Session expiring" style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:100000,background:"#0d1117",border:"1px solid #ffa50060",borderRadius:10,padding:"12px 16px",display:"flex",gap:14,alignItems:"center",fontFamily:"monospace",fontSize:12,color:"#e6edf3",boxShadow:"0 8px 30px #000a"}}>
            <span>Signing out in {warnSecs}s due to inactivity</span>
            <button onClick={() => { writeLS(ACTIVITY_KEY, String(Date.now())); setWarnSecs(null); }} style={{background:"#00ff88",color:"#010409",border:"none",borderRadius:6,padding:"6px 12px",fontWeight:700,cursor:"pointer"}}>Stay signed in</button>
          </div>
        )}
      </AuthContext.Provider>
    );
  }

  return <LoginScreen phase={phase} email={session?.user?.email} onSignOut={signOut} />;
}

function LoginScreen({ phase, email: sessionEmail, onSignOut }) {
  const light = lightMode();
  const th = (d, l) => (light ? l : d);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState("email"); // email | sent
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(() => {
    const h = typeof window !== "undefined" ? window.location.hash : "";
    const q = new URLSearchParams(h.replace(/^#/, ""));
    return q.get("error_description") ? { kind: "err", text: friendlyError({ message: q.get("error_description") }) } : null;
  });
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendLink = async (e) => {
    e?.preventDefault();
    if (busy || cooldown > 0) return;
    if (!isValidEmail(email)) { setMsg({ kind: "err", text: "Enter a valid email address." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    // Same response whether or not the address is authorized — no account enumeration.
    if (error && !/not allowed|signups not allowed|user not found/i.test(error.message)) {
      setMsg({ kind: "err", text: friendlyError(error) });
      return;
    }
    setStep("sent"); setCooldown(RESEND_SECONDS);
    setMsg({ kind: "ok", text: "If that email is authorized, a sign-in link and code are on their way." });
  };

  const verifyCode = async (e) => {
    e?.preventDefault();
    if (busy) return;
    if (!/^\d{6,8}$/.test(code.trim())) { setMsg({ kind: "err", text: "Enter the numeric code from the email." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setMsg({ kind: "err", text: friendlyError(error) });
  };

  const oauth = async (provider) => {
    setMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin, scopes: provider === "azure" ? "email openid profile" : undefined },
    });
    if (error) setMsg({ kind: "err", text: friendlyError(error) });
  };

  const card = { width: "100%", maxWidth: 360, animation: "fadeIn .3s ease" };
  const input = { width: "100%", background: th("#0a0e14", "#f8f3eb"), border: `1px solid ${th("#21262d", "#d8cfc2")}`, borderRadius: 8, padding: "11px 12px", color: th("#e6edf3", "#0d0d0b"), fontSize: 14, outline: "none", fontFamily: "'Inter',sans-serif" };
  const primary = { width: "100%", background: "#00ff88", color: "#010409", border: "none", borderRadius: 8, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", marginTop: 12 };
  const secondary = { width: "100%", background: "transparent", color: th("#8b949e", "#6b5f55"), border: `1px solid ${th("#21262d", "#d8cfc2")}`, borderRadius: 8, padding: "10px 0", fontSize: 12, cursor: "pointer", marginTop: 10, fontFamily: "monospace" };
  const label = { fontSize: 9, color: th("#3a4050", "#8a7e74"), fontFamily: "monospace", letterSpacing: "0.07em", marginBottom: 6, display: "block" };

  let body;
  if (phase === "loading" || phase === "checking") {
    body = (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }} aria-busy="true" aria-label="Checking session">
        <div style={{ width: 14, height: 14, border: "2px solid #1c2128", borderTopColor: "#00ff88", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
      </div>
    );
  } else if (phase === "denied") {
    body = (
      <div>
        <div role="alert" style={{ color: "#ff4560", fontFamily: "monospace", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
          {sessionEmail ? <>{sessionEmail} is not authorized to use this dashboard.</> : "This account is not authorized."}
        </div>
        <button onClick={onSignOut} style={secondary}>Sign out</button>
      </div>
    );
  } else if (phase === "setup") {
    body = (
      <div>
        <div role="alert" style={{ color: "#ffa500", fontFamily: "monospace", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
          Sign-in succeeded but account setup is incomplete (database migration not applied). Contact the administrator.
        </div>
        <button onClick={onSignOut} style={secondary}>Sign out</button>
      </div>
    );
  } else if (step === "email") {
    body = (
      <form onSubmit={sendLink} noValidate>
        <label htmlFor="login-email" style={label}>EMAIL</label>
        <input id="login-email" type="email" autoComplete="username webauthn" inputMode="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={input} />
        <button type="submit" disabled={busy} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
        {PROVIDERS.length > 0 && (
          <>
            <div style={{ textAlign: "center", fontSize: 9, color: th("#3a4050", "#8a7e74"), fontFamily: "monospace", margin: "16px 0 2px", letterSpacing: "0.08em" }}>OR</div>
            {PROVIDERS.map(p => <button key={p.id} type="button" onClick={() => oauth(p.id)} style={secondary}>Continue with {p.label}</button>)}
          </>
        )}
      </form>
    );
  } else {
    body = (
      <form onSubmit={verifyCode} noValidate>
        <div style={{ fontSize: 12, color: th("#8b949e", "#6b5f55"), fontFamily: "monospace", lineHeight: 1.6, marginBottom: 12 }}>
          Open the link we emailed to <b style={{ color: th("#e6edf3", "#0d0d0b") }}>{email.trim()}</b> on this device, or enter the code from the email:
        </div>
        <label htmlFor="login-code" style={label}>CODE</label>
        <input id="login-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" style={{ ...input, letterSpacing: "0.3em", textAlign: "center", fontFamily: "monospace" }} />
        <button type="submit" disabled={busy} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>{busy ? "Verifying…" : "Verify code"}</button>
        <button type="button" disabled={cooldown > 0 || busy} onClick={sendLink} style={{ ...secondary, opacity: cooldown > 0 ? 0.5 : 1 }}>{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend link"}</button>
        <button type="button" onClick={() => { setStep("email"); setCode(""); setMsg(null); }} style={secondary}>Use a different email</button>
      </form>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: th("#010409", "#f5f0e8"), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',sans-serif", padding: 16 }}>
      <style>{`*{box-sizing:border-box}html,body{margin:0;background:#010409}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <main style={card}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: 14, background: "linear-gradient(135deg,#0d1f12,#0a1a1f)", border: "1px solid #00ff8830", marginBottom: 12 }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 17, color: "#00ff88" }}>PRI</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: th("#3a4050", "#8a7e74"), letterSpacing: "0.08em" }}>PREMIUM RECURRING INCOME</div>
          <div style={{ fontFamily: "monospace", fontSize: 8, color: th("#2a3040", "#6b5f55"), letterSpacing: "0.06em", marginTop: 2 }}>TRADING OPTIONS DASHBOARD</div>
        </div>
        {body}
        {msg && (
          <div role={msg.kind === "err" ? "alert" : "status"} style={{ marginTop: 14, textAlign: "center", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, color: msg.kind === "err" ? "#ff4560" : "#00ff88" }}>{msg.text}</div>
        )}
      </main>
    </div>
  );
}
