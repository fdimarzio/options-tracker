// tests/option-snapshot-purge.test.js
// Covers the purge-completion fix: batch loop drains until a partial (< batchSize)
// batch signals completion, and the referenced-snapshot protection now lives in the
// SQL function rather than being computed (incorrectly, for the size target) client-side.
// Run: npx vitest run tests/option-snapshot-purge.test.js

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const scriptSrc   = fs.readFileSync(path.resolve("scripts/option-snapshot-purge.js"), "utf8");
const sqlSrc      = fs.readFileSync(path.resolve("sql/purge_option_snapshots_batch.sql"), "utf8");
const workflowSrc = fs.readFileSync(path.resolve(".github/workflows/option-snapshot-purge.yml"), "utf8");

// Mirrors the loop in main(): keep calling purgeBatch until a batch comes back
// smaller than batchSize (i.e. exhausted), or maxBatches is hit.
async function runPurgeLoop(purgeBatchFn, batchSize, maxBatches) {
  let total = 0;
  let calls = 0;
  for (let i = 0; i < maxBatches; i++) {
    calls++;
    const deleted = await purgeBatchFn();
    total += deleted;
    if (deleted < batchSize) break;
  }
  return { total, calls };
}

describe("Purge batch loop — drains backlog in fixed-size batches", () => {
  it("positive — rows older than retention, none referenced: loops in 20k batches until exhausted", async () => {
    const queue = [20000, 20000, 20000, 7500]; // 3 full batches then a partial -> done
    let i = 0;
    const purgeBatchFn = async () => queue[i++];
    const { total, calls } = await runPurgeLoop(purgeBatchFn, 20000, 200);
    expect(calls).toBe(4);
    expect(total).toBe(67500);
  });

  it("negative — nothing older than retention: first call returns 0, no-op, no further calls", async () => {
    const purgeBatchFn = async () => 0;
    const { total, calls } = await runPurgeLoop(purgeBatchFn, 20000, 200);
    expect(total).toBe(0);
    expect(calls).toBe(1);
  });

  it("stops at maxBatches safety cap even if every batch stays full", async () => {
    const purgeBatchFn = async () => 20000; // never returns a partial batch
    const { calls } = await runPurgeLoop(purgeBatchFn, 20000, 5);
    expect(calls).toBe(5);
  });
});

describe("scripts/option-snapshot-purge.js — updated defaults and call shape", () => {
  it("default batch size is 20000, not the old timeout-prone 500000", () => {
    expect(scriptSrc).toMatch(/batch_size:\s*20000/);
    expect(scriptSrc).not.toMatch(/batch_size:\s*500000/);
  });

  it("default retention_days is 21", () => {
    expect(scriptSrc).toMatch(/retention_days:\s*21/);
  });

  it("PURGE_RETENTION_DAYS env var can override retention_days", () => {
    expect(scriptSrc).toContain("process.env.PURGE_RETENTION_DAYS");
  });

  it("no longer computes active symbols client-side — always passes an empty array", () => {
    expect(scriptSrc).not.toContain("getActiveSymbols");
    expect(scriptSrc).toContain("p_active_symbols: []");
  });
});

describe("sql/purge_option_snapshots_batch.sql — referenced-snapshot protection", () => {
  it("edge — a snapshot referenced by a trade is excluded from the delete via NOT EXISTS", () => {
    expect(sqlSrc).toMatch(/NOT EXISTS/);
    expect(sqlSrc).toContain("c.entry_snapshot_id = s.id");
    expect(sqlSrc).toContain("c.exit_snapshot_id = s.id");
  });

  it("retention filter is time-based on snapshot_at for all symbols (no unconditional active-symbol exclusion)", () => {
    expect(sqlSrc).toContain("s.snapshot_at < now() - make_interval(days => p_retention_days)");
    expect(sqlSrc).toContain("p_active_symbols IS NULL OR NOT (s.symbol = ANY(p_active_symbols))");
  });

  it("function signature is unchanged (retention_days, active_symbols, batch_size) — no call-site divergence", () => {
    expect(sqlSrc).toMatch(/p_retention_days integer,\s*\n\s*p_active_symbols text\[\],\s*\n\s*p_batch_size integer DEFAULT 20000/);
  });
});

describe(".github/workflows/option-snapshot-purge.yml — configurable retention", () => {
  it("exposes retention_days as a workflow_dispatch input, default 21", () => {
    expect(workflowSrc).toMatch(/retention_days:/);
    expect(workflowSrc).toMatch(/default:\s*['"]21['"]/);
  });

  it("passes the input through as PURGE_RETENTION_DAYS", () => {
    expect(workflowSrc).toContain("PURGE_RETENTION_DAYS: ${{ github.event.inputs.retention_days }}");
  });
});
