import test from "node:test";
import assert from "node:assert/strict";

import { contiguousSettlement } from "./game.js";
import { parseDate } from "./wikimedia.js";

test("does not advance when Wikimedia returns no published dates", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map(),
      parseDate("20260712"),
      parseDate("20260713")
    ),
    { earned: 0, latestEarned: 0, settledThrough: null }
  );
});

test("settles real zero-view days when the date is present", () => {
  assert.deepEqual(
    contiguousSettlement(
      new Map([["20260712", 0]]),
      parseDate("20260712"),
      parseDate("20260712")
    ),
    { earned: 0, latestEarned: 0, settledThrough: "20260712" }
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
    { earned: 100, latestEarned: 100, settledThrough: "20260711" }
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
    { earned: 287, latestEarned: 187, settledThrough: "20260713" }
  );
});
