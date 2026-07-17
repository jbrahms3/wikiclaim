import test from "node:test";
import assert from "node:assert/strict";

import { contiguousSettlement, earningsCapMultiplier } from "./game.js";
import { parseDate, addDaysUTC, formatYYYYMMDD } from "./wikimedia.js";

// Builds a views Map with `count` days of `dailyViews` immediately before
// `beforeDate` (exclusive) - a synthetic "normal" history for the
// rolling-baseline cap to compare a settlement day against.
function withBaseline(views, beforeDate, count, dailyViews) {
  let cursor = addDaysUTC(beforeDate, -1);
  for (let i = 0; i < count; i++) {
    views.set(formatYYYYMMDD(cursor), dailyViews);
    cursor = addDaysUTC(cursor, -1);
  }
  return views;
}

test("does not advance when Wikimedia returns no published dates", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map(),
      parseDate("20260712"),
      parseDate("20260713")
    ),
    { earned: 0, latestEarned: 0, settledThrough: null, escrowDelta: 0, streakDays: 0 }
  );
});

test("settles real zero-view days when the date is present", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map([["20260712", 0]]),
      parseDate("20260712"),
      parseDate("20260712")
    ),
    { earned: 0, latestEarned: 0, settledThrough: "20260712", escrowDelta: 0, streakDays: 0 }
  );
});

test("stops before a missing day instead of skipping it", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map([
        ["20260711", 100],
        ["20260713", 187],
      ]),
      parseDate("20260711"),
      parseDate("20260713")
    ),
    { earned: 100, latestEarned: 100, settledThrough: "20260711", escrowDelta: 0, streakDays: 0 }
  );
});

test("returns the latest settled day's payout separately from the total", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map([
        ["20260712", 100],
        ["20260713", 187],
      ]),
      parseDate("20260712"),
      parseDate("20260713")
    ),
    { earned: 287, latestEarned: 187, settledThrough: "20260713", escrowDelta: 0, streakDays: 0 }
  );
});

test("with no prior history at all, a day's full raw views are credited uncapped", () => {
  // No baseline data available (e.g. a brand-new article) - nothing to judge
  // "normal" against, so the cap can't apply.
  const result = contiguousSettlement(
    new Map([["20260712", 5000]]),
    parseDate("20260712"),
    parseDate("20260712")
  );
  assert.equal(result.earned, 5000);
  assert.equal(result.escrowDelta, 0);
});

test("caps an anomalous spike against the rolling baseline and escrows the excess", () => {
  const target = parseDate("20260712");
  const views = withBaseline(new Map(), target, 30, 10); // 30 real days averaging 10 views
  views.set("20260712", 10000); // a refresh-bot-sized spike

  const result = contiguousSettlement(views, target, target);

  // baseline = 10, cap = round(10 * earningsCapMultiplier(10))
  const expectedCap = Math.round(10 * earningsCapMultiplier(10));
  assert.equal(result.earned, expectedCap);
  assert.equal(result.latestEarned, expectedCap);
  assert.equal(result.escrowDelta, 10000 - expectedCap);
  assert.equal(result.streakDays, 1);
  // The cap should be a modest bump over baseline, not anywhere near the raw spike.
  assert.ok(expectedCap < 20, `expected a small capped amount, got ${expectedCap}`);
});

test("a day within the normal baseline range is never capped or escrowed", () => {
  const target = parseDate("20260712");
  const views = withBaseline(new Map(), target, 30, 1000);
  views.set("20260712", 1100); // a real, modest 10% day-to-day swing

  const result = contiguousSettlement(views, target, target);
  assert.equal(result.earned, 1100);
  assert.equal(result.escrowDelta, 0);
  assert.equal(result.streakDays, 0);
});

test("the over-cap streak carries across separate settlement passes", () => {
  // One consistent underlying dataset, as real Wikimedia data would be
  // (already-published days don't change between fetches) - two sustained
  // spike days after 30 normal days.
  const day1 = parseDate("20260712");
  const day2 = parseDate("20260713");
  const views = withBaseline(new Map(), day1, 30, 10);
  views.set("20260712", 5000); // over cap
  views.set("20260713", 5000); // still over cap the next day too (sustained)

  // First settlement call only sees/settles day1.
  const pass1 = contiguousSettlement(views, day1, day1, 0);
  assert.equal(pass1.streakDays, 1);

  // A later call settles day2, seeded with the streak the first pass
  // returned (this is what settleHolding persists on the holding between
  // calls) - the streak should continue, not reset just because it's a new
  // settlement pass.
  const pass2 = contiguousSettlement(views, day2, day2, pass1.streakDays);
  assert.equal(pass2.streakDays, 2, "streak should continue from the prior pass, not reset to 1");
});

test("earningsCapMultiplier shrinks toward the floor as the baseline grows", () => {
  const tiny = earningsCapMultiplier(1);
  const mid = earningsCapMultiplier(500);
  const huge = earningsCapMultiplier(1_000_000);
  assert.ok(tiny > mid && mid > huge, "multiplier should strictly decrease as baseline grows");
  assert.ok(tiny <= 1.5 + 1e-9, "small-article multiplier should not exceed the configured ceiling");
  assert.ok(huge >= 1.15 - 1e-9, "large-article multiplier should not drop below the configured floor");
});
