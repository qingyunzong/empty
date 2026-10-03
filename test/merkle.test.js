import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { computeDigest } from "../src/merkle.js";
import {
  deleteRecord,
  emptyState,
  resolveRecord,
  snapshot,
  upsert,
  verifySnapshot,
} from "../src/replica.js";

// Independent small-scale tree hash implementation, written separately from
// src/merkle.js, used as a cross-check oracle.
function independentCanonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(independentCanonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${independentCanonical(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

function h(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function independentTreeHash(leaves) {
  if (leaves.length === 0) return h("empty");
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? h(`node:${level[i]}${level[i + 1]}`) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function independentDigest(state) {
  const ids = [...new Set([...Object.keys(state.records), ...Object.keys(state.tombstones)])].sort();
  const leaves = [];
  for (const id of ids) {
    if (state.records[id]) {
      leaves.push(h("leaf:record:" + independentCanonical(state.records[id])));
    }
    if (state.tombstones[id]) {
      leaves.push(h("leaf:tombstone:" + independentCanonical(state.tombstones[id])));
    }
  }
  return independentTreeHash(leaves);
}

function applyKind(state, id, kind) {
  if (kind === "absent") return;
  upsert(state, { id, amountA: 10, amountB: 10 });
  if (kind === "resolved") resolveRecord(state, id);
  if (kind === "deleted") deleteRecord(state, id);
}

test("digest matches independent tree hash for all add/resolve/delete combos of 3 records", () => {
  const ids = ["r1", "r2", "r3"];
  const kinds = ["absent", "open", "resolved", "deleted"];
  let checked = 0;
  for (const k1 of kinds) {
    for (const k2 of kinds) {
      for (const k3 of kinds) {
        const state = emptyState("enum");
        applyKind(state, ids[0], k1);
        applyKind(state, ids[1], k2);
        applyKind(state, ids[2], k3);
        assert.equal(
          computeDigest(state),
          independentDigest(state),
          `digest mismatch for combo ${[k1, k2, k3].join(",")}`,
        );
        const snap = snapshot(state);
        assert.equal(snap.certificate.valid, true);
        assert.deepEqual(verifySnapshot(snap), { authentic: true, valid: true });
        checked += 1;
      }
    }
  }
  assert.equal(checked, 64);
});

test("empty tree, single leaf and odd leaf counts hash deterministically", () => {
  const empty = emptyState("e");
  assert.equal(computeDigest(empty), independentDigest(empty));

  const single = emptyState("s");
  upsert(single, { id: "only", amountA: 1, amountB: 2 });
  assert.equal(computeDigest(single), independentDigest(single));

  const odd = emptyState("o");
  for (const id of ["a", "b", "c", "d", "e"]) {
    upsert(odd, { id, amountA: 1, amountB: 1 });
  }
  deleteRecord(odd, "c");
  assert.equal(computeDigest(odd), independentDigest(odd));
  assert.equal(snapshot(odd).certificate.leafCount, 5);
});

test("tampered snapshot fails certificate verification", () => {
  const state = emptyState("t");
  upsert(state, { id: "r1", amountA: 5, amountB: 5 });
  const snap = snapshot(state);
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.records[0].amountA = 999;
  assert.equal(verifySnapshot(tampered).authentic, false);
});
