-- Run in Supabase SQL Editor
-- Creates the sage_attention table for the SAGE Attention Scanner

CREATE TABLE IF NOT EXISTS sage_attention (
  ticker           TEXT PRIMARY KEY,
  score            INTEGER NOT NULL DEFAULT 0,
  recommendation   TEXT NOT NULL DEFAULT 'no_data',  -- sto_favorable | monitor | hold | no_data
  passes_gates     BOOLEAN NOT NULL DEFAULT false,
  gate_failures    JSONB DEFAULT '[]'::jsonb,
  contributions    JSONB DEFAULT '{}'::jsonb,         -- per-factor score breakdown
  factors_snapshot JSONB DEFAULT '{}'::jsonb,         -- raw factor values at scan time
  signal_id        INTEGER REFERENCES signal_log(id),  -- most recent signal used
  shares           INTEGER DEFAULT 0,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick reads
CREATE INDEX IF NOT EXISTS sage_attention_score_idx ON sage_attention (score DESC);
CREATE INDEX IF NOT EXISTS sage_attention_scanned_idx ON sage_attention (scanned_at DESC);

-- Enable RLS (match your other tables)
ALTER TABLE sage_attention ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON sage_attention FOR ALL USING (true) WITH CHECK (true);
