// api/_lib/notificationCooldown.js
// Unified per-(contract-or-symbol, alert-type) notification cooldown for
// CLOSE_NOW / itm_warning / sto_suggestion — these were firing on every 5-min
// refresh for the same ticker/contract. Backed by the notification_log table
// (see sql/notification_cooldown.sql); cooldown_minutes comes from the
// notification_cooldown signal_rules row, default 60.
export function resolveCooldownMinutes(rule, defaultMinutes = 60) {
  if (!rule || rule.cooldown_minutes == null) return defaultMinutes;
  return +rule.cooldown_minutes;
}

export function isWithinCooldown(lastSentAt, cooldownMinutes, now = new Date()) {
  if (!lastSentAt) return false;
  const last = lastSentAt instanceof Date ? lastSentAt : new Date(lastSentAt);
  if (isNaN(last.getTime())) return false;
  const minsSince = (now.getTime() - last.getTime()) / 60000;
  return minsSince < (cooldownMinutes ?? 60);
}

// contract-scoped alerts (CLOSE_NOW, itm_warning) key on the contract id;
// symbol-scoped alerts (sto_suggestion — no contract exists yet) key on
// symbol+account so the same ticker in two accounts is tracked independently.
export function buildNotificationDedupKey({ contractId, symbol, account }) {
  if (contractId != null) return String(contractId);
  return `${(symbol || "").toUpperCase()}|${account || ""}`;
}

export function makeNotificationLogLookupKey(dedupKey, alertType) {
  return `${dedupKey}|${alertType}`;
}
