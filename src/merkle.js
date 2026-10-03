import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function sha256hex(data) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function leafHash(kind, payload) {
  return sha256hex("leaf:" + kind + ":" + canonicalize(payload));
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) {
    return sha256hex("empty");
  }
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256hex("node:" + level[i] + level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

export function buildLeaves(state) {
  const ids = new Set([...Object.keys(state.records), ...Object.keys(state.tombstones)]);
  const leaves = [];
  for (const id of [...ids].sort()) {
    if (state.records[id]) {
      leaves.push({ id, kind: "record", hash: leafHash("record", state.records[id]) });
    }
    if (state.tombstones[id]) {
      leaves.push({ id, kind: "tombstone", hash: leafHash("tombstone", state.tombstones[id]) });
    }
  }
  return leaves;
}

export function computeDigest(state) {
  return merkleRoot(buildLeaves(state).map((leaf) => leaf.hash));
}

export function sortedConflicts(state) {
  return (state.conflicts ?? []).slice().sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}

export function buildCertificate(state, epoch) {
  const leaves = buildLeaves(state);
  const conflicts = sortedConflicts(state);
  return {
    epoch,
    digest: merkleRoot(leaves.map((leaf) => leaf.hash)),
    leafCount: leaves.length,
    leaves,
    conflicts,
    valid: conflicts.length === 0,
  };
}
