-- ── Skynet Learning Schema ────────────────────────────────────────────────────

-- 1. signal_outcomes: links signal → contract via decision_log, stores result
-- Populated by auto-import when a contract closes that has a linked signal
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id                    bigint generated always as identity primary key,
  signal_id             bigint references signal_log(id),
  contract_id           bigint references contracts(id),
  decision              text,                    -- traded / passed / partial
  decision_notes        text,
  -- Outcome fields (populated when contract closes)
  outcome_profit        numeric,                 -- actual profit $
  outcome_profit_pct    numeric,                 -- actual profit %
  outcome_days_held     int,
  outcome_exercised     boolean default false,
  outcome_close_method  text,                    -- auto / app / manual
  outcome_closed_at     timestamptz,
  -- Was the signal a good call?
  signal_quality        text,                    -- 'good' / 'bad' / 'neutral' (computed)
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_signal_id   ON signal_outcomes(signal_id);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_contract_id ON signal_outcomes(contract_id);

-- 2. scoring_factors: defines each factor — open-ended, add rows to extend model
CREATE TABLE IF NOT EXISTS scoring_factors (
  id              bigint generated always as identity primary key,
  name            text not null unique,          -- e.g. 'change_pct', 'vix', 'rsi_14', 'sector_etf_change'
  display_name    text,                          -- e.g. 'Stock Change %', 'VIX', 'RSI (14)', 'Sector ETF Change'
  description     text,                          -- plain English: what it measures
  rationale       text,                          -- why it matters for STO decisions
  data_source     text,                          -- 'signal_log', 'schwab_api', 'external_api', 'computed'
  formula         text,                          -- how it's computed, e.g. '(dayHigh - lastPrice) / dayHigh * 100'
  signal_types    text[] default '{sto}',        -- which signal types this applies to
  enabled         boolean default true,
  created_at      timestamptz default now()
);

-- Seed with factors we already capture + ones to add
INSERT INTO scoring_factors (name, display_name, description, rationale, data_source, formula, signal_types) VALUES
  ('change_pct',            'Stock Change %',          'How much the stock is up today vs prior close',
   'Stocks up more are more likely to reverse, making OTM calls safer to sell',
   'signal_log', 'signal_log.change_pct', '{sto,btc_auto}'),

  ('vix',                   'VIX',                     'CBOE Volatility Index at signal time',
   'Higher VIX = higher option premiums = better STO conditions. But extreme VIX means market instability.',
   'signal_log', 'signal_log.vix', '{sto,btc_auto}'),

  ('time_of_day',           'Time of Day',             'Minutes since market open when signal fired',
   'Early signals (9:35-10:30) are riskier — price discovery still happening. Later signals more reliable.',
   'signal_log', 'signal_log.time_of_day', '{sto}'),

  ('dte',                   'Days to Expiration',      'Days until contract expiry at signal time',
   'Short DTE = faster time decay but less room for error. Longer DTE = more premium but more risk.',
   'signal_log', 'signal_log.dte', '{sto,btc_auto}'),

  ('otm_pct',               'OTM %',                   'How far out of the money the suggested strike is',
   '2-3% OTM is sweet spot — enough buffer against exercise, enough premium. Too far = low premium.',
   'signal_log', 'signal_log.otm_pct', '{sto}'),

  ('pullback_from_high',    'Pullback from Intraday High', 'How far stock has pulled back from its daily high',
   'Selling calls when move is fading (stock below high) is safer than selling into a rising stock.',
   'price_snapshots', '(dayHigh - lastPrice) / dayHigh * 100', '{sto}'),

  ('deceleration',          'Momentum Deceleration',   'Change in rate of price increase over 30 mins',
   'Decelerating moves are more likely to reverse, making it safer to sell a covered call.',
   'price_snapshots', 'change_pct_now - change_pct_30m_ago', '{sto}'),

  ('days_since_last_sto',   'Days Since Last STO',     'How many days since last STO on this ticker',
   'Too frequent STOs on same ticker increase risk. Recent successful STO may indicate good timing pattern.',
   'computed', 'days between most recent STO contract and current signal', '{sto}'),

  ('ticker_win_rate',       'Ticker Win Rate',          'Historical profit rate for STOs on this specific ticker',
   'Some tickers consistently perform well for covered calls. Historical win rate is predictive.',
   'computed', 'count(profitable STOs) / count(all STOs) for this ticker', '{sto}'),

  ('rsi_14',                'RSI (14)',                 '14-period Relative Strength Index',
   'RSI > 70 = overbought, good time to sell call. RSI < 30 = oversold, avoid selling calls.',
   'external_api', 'standard RSI formula on daily closes', '{sto}'),

  ('sector_etf_change',     'Sector ETF Change %',     'Performance of sector ETF (e.g. XLF for JPM, QQQ for NVDA)',
   'Stock moving with sector is more sustainable than moving against it. Counter-sector moves often reverse.',
   'external_api', 'ETF change % for tickers sector on signal day', '{sto}'),

  ('short_interest',        'Short Interest %',        'Percentage of float sold short',
   'High short interest = potential short squeeze = dangerous for covered calls (stock may spike up).',
   'external_api', 'short_interest / float * 100', '{sto}'),

  ('insider_buying',        'Recent Insider Buying',   'Number of insider buy transactions in last 30 days',
   'Insiders buying suggests confidence in upside — stock may run further, increasing exercise risk.',
   'external_api', 'count of SEC Form 4 buy filings in last 30d', '{sto}'),

  ('put_call_ratio',        'Put/Call Ratio',          'Ratio of put to call open interest for this ticker',
   'High put/call ratio = bearish sentiment = safer to sell calls. Low ratio = bullish = more risk.',
   'external_api', 'put_open_interest / call_open_interest', '{sto}')
ON CONFLICT (name) DO NOTHING;

-- 3. scoring_factor_values: actual value per factor per signal (the feature vector)
-- Written by market-refresh at signal fire time for available factors
-- Can be backfilled for historical signals
CREATE TABLE IF NOT EXISTS scoring_factor_values (
  id          bigint generated always as identity primary key,
  signal_id   bigint references signal_log(id),
  factor_id   bigint references scoring_factors(id),
  factor_name text not null,                     -- denormalized for query speed
  value       numeric,                           -- the computed value
  raw         jsonb,                             -- optional raw data for debugging
  captured_at timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_sfv_signal_id   ON scoring_factor_values(signal_id);
CREATE INDEX IF NOT EXISTS idx_sfv_factor_name ON scoring_factor_values(factor_name);

-- 4. scoring_weights: current weight per factor, with rationale
CREATE TABLE IF NOT EXISTS scoring_weights (
  id              bigint generated always as identity primary key,
  factor_id       bigint references scoring_factors(id),
  factor_name     text not null,
  signal_type     text not null default 'sto',   -- which signal type these weights apply to
  weight          numeric not null default 1.0,  -- contribution to final score (0.0-1.0 or relative)
  min_value       numeric,                       -- value below this scores 0
  max_value       numeric,                       -- value above this scores max_points
  max_points      numeric default 10,            -- max points this factor can contribute
  direction       text default 'higher_better',  -- 'higher_better' or 'lower_better'
  rationale       text,                          -- why this weight was set here
  set_by          text default 'manual',         -- 'manual' / 'claude_suggestion' / 'auto'
  enabled         boolean default true,
  effective_from  timestamptz default now(),
  created_at      timestamptz default now()
);

-- 5. scoring_weight_history: full audit trail of every weight change
CREATE TABLE IF NOT EXISTS scoring_weight_history (
  id              bigint generated always as identity primary key,
  factor_name     text not null,
  signal_type     text not null,
  old_weight      numeric,
  new_weight      numeric,
  old_rationale   text,
  new_rationale   text,
  changed_by      text,                          -- 'manual' / 'claude_suggestion'
  analysis_period text,                          -- e.g. '2026-05-01 to 2026-05-14'
  signals_analyzed int,
  approval_notes  text,
  created_at      timestamptz default now()
);

-- 6. Add contract_id to decision_log so we can traverse signal → decision → contract
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS contract_id bigint references contracts(id);

-- 7. Seed initial weights (equal weighting to start — Claude will refine)
INSERT INTO scoring_weights (factor_name, signal_type, weight, max_points, direction, rationale, set_by) VALUES
  ('change_pct',         'sto', 1.0, 15, 'higher_better', 'Initial equal weight — to be refined with outcome data', 'manual'),
  ('vix',                'sto', 1.0, 15, 'higher_better', 'Initial equal weight — higher VIX generally better for premium', 'manual'),
  ('time_of_day',        'sto', 1.0, 10, 'lower_better',  'Initial equal weight — later in day after price discovery is better', 'manual'),
  ('dte',                'sto', 1.0, 10, 'neutral',       'Initial equal weight — sweet spot 3-7 DTE', 'manual'),
  ('otm_pct',            'sto', 1.0, 15, 'neutral',       'Initial equal weight — sweet spot 2-3% OTM', 'manual'),
  ('pullback_from_high', 'sto', 1.0, 15, 'higher_better', 'Initial equal weight — more pullback = safer entry', 'manual'),
  ('deceleration',       'sto', 1.0, 10, 'higher_better', 'Initial equal weight — decelerating move = safer entry', 'manual'),
  ('ticker_win_rate',    'sto', 1.0, 10, 'higher_better', 'Initial equal weight — historical win rate is predictive', 'manual')
ON CONFLICT DO NOTHING;
