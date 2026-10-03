import { buildCertificate, computeDigest, leafHash, sortedConflicts } from "./merkle.js";

export class ReplicaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function emptyState(replica = "default") {
  return {
    replica,
    clock: 0,
    opCounter: 0,
    records: {},
    tombstones: {},
    tombstoneClock: {},
    conflicts: [],
  };
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateAmounts(input) {
  return (
    input &&
    typeof input.id === "string" &&
    input.id.length > 0 &&
    typeof input.amountA === "number" &&
    Number.isFinite(input.amountA) &&
    typeof input.amountB === "number" &&
    Number.isFinite(input.amountB)
  );
}

export function upsert(state, input) {
  if (!validateAmounts(input)) {
    throw new ReplicaError("invalid-input");
  }
  if (state.tombstones[input.id]) {
    throw new ReplicaError("stale-resurrect");
  }
  const existing = state.records[input.id];
  let record;
  if (existing) {
    record = {
      ...existing,
      amountA: input.amountA,
      amountB: input.amountB,
      seq: existing.seq + 1,
      updatedBy: state.replica,
      kind: "upsert",
    };
  } else {
    state.opCounter += 1;
    record = {
      id: input.id,
      amountA: input.amountA,
      amountB: input.amountB,
      status: "open",
      seq: 1,
      birth: `${state.replica}:${state.opCounter}`,
      updatedBy: state.replica,
      kind: "create",
    };
  }
  state.records[input.id] = record;
  state.clock += 1;
  return record;
}

export function resolveRecord(state, id) {
  const record = state.records[id];
  if (!record) {
    throw new ReplicaError("not-found");
  }
  if (record.status === "resolved") {
    return record;
  }
  const updated = {
    ...record,
    status: "resolved",
    seq: record.seq + 1,
    updatedBy: state.replica,
    kind: "resolve",
  };
  state.records[id] = updated;
  state.clock += 1;
  return updated;
}

export function deleteRecord(state, id) {
  const record = state.records[id];
  if (!record) {
    throw new ReplicaError("not-found");
  }
  const seq = (state.tombstoneClock[state.replica] ?? 0) + 1;
  state.tombstoneClock[state.replica] = seq;
  const tombstone = {
    id,
    seq,
    deletedBy: state.replica,
    observedBirth: record.birth,
    observedRecordSeq: record.seq,
    observedStatus: record.status,
  };
  delete state.records[id];
  state.tombstones[id] = tombstone;
  state.clock += 1;
  return tombstone;
}

function bumpTombstoneClock(state, tombstone) {
  const current = state.tombstoneClock[tombstone.deletedBy] ?? 0;
  if (tombstone.seq > current) {
    state.tombstoneClock[tombstone.deletedBy] = tombstone.seq;
  }
}

function conflictEntry(record, tombstone) {
  return {
    id: record.id,
    type: "resolve-delete",
    recordSeq: record.seq,
    tombstoneSeq: tombstone.seq,
    deletedBy: tombstone.deletedBy,
  };
}

function addConflict(state, entry) {
  const exists = state.conflicts.some((c) => c.id === entry.id && c.type === entry.type);
  if (!exists) {
    state.conflicts.push(entry);
  }
}

function compareTombstones(a, b) {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.deletedBy < b.deletedBy ? -1 : a.deletedBy > b.deletedBy ? 1 : 0;
}

function applyTombstone(state, tombstone) {
  const local = state.tombstones[tombstone.id];
  if (local) {
    if (compareTombstones(tombstone, local) > 0) {
      state.tombstones[tombstone.id] = tombstone;
    }
    bumpTombstoneClock(state, tombstone);
    return;
  }
  const record = state.records[tombstone.id];
  if (!record) {
    state.tombstones[tombstone.id] = tombstone;
    bumpTombstoneClock(state, tombstone);
    return;
  }
  if (record.birth !== tombstone.observedBirth) {
    bumpTombstoneClock(state, tombstone);
    return;
  }
  if (tombstone.observedRecordSeq >= record.seq) {
    delete state.records[tombstone.id];
    state.tombstones[tombstone.id] = tombstone;
  } else if (record.status === "resolved" && tombstone.observedStatus === "open") {
    state.tombstones[tombstone.id] = tombstone;
    addConflict(state, conflictEntry(record, tombstone));
  } else {
    delete state.records[tombstone.id];
    state.tombstones[tombstone.id] = tombstone;
  }
  bumpTombstoneClock(state, tombstone);
}

function applyRecord(state, record) {
  const tombstone = state.tombstones[record.id];
  if (tombstone) {
    if (record.birth !== tombstone.observedBirth) {
      throw new ReplicaError("stale-resurrect");
    }
    if (record.seq <= tombstone.observedRecordSeq) {
      return;
    }
    if (record.status === "resolved" && tombstone.observedStatus === "open") {
      state.records[record.id] = record;
      addConflict(state, conflictEntry(record, tombstone));
      return;
    }
    throw new ReplicaError("stale-resurrect");
  }
  const local = state.records[record.id];
  if (!local) {
    state.records[record.id] = record;
    return;
  }
  if (local.birth === record.birth) {
    if (record.seq > local.seq) {
      state.records[record.id] = record;
    }
    return;
  }
  if (record.birth > local.birth) {
    state.records[record.id] = record;
  }
}

export function mergeSnapshot(state, snap) {
  if (!snap || !Array.isArray(snap.records) || !Array.isArray(snap.tombstones)) {
    throw new ReplicaError("invalid-snapshot");
  }
  for (const tombstone of snap.tombstones.slice().sort(byId)) {
    applyTombstone(state, tombstone);
  }
  for (const record of snap.records.slice().sort(byId)) {
    applyRecord(state, record);
  }
  for (const conflict of snap.conflicts ?? []) {
    addConflict(state, conflict);
  }
  state.clock = Math.max(state.clock, snap.epoch ?? 0);
  return {
    merged: true,
    epoch: state.clock,
    digest: computeDigest(state),
    conflicts: sortedConflicts(state),
  };
}

export function diffSnapshot(state, snap) {
  if (!snap || !Array.isArray(snap.records) || !Array.isArray(snap.tombstones)) {
    throw new ReplicaError("invalid-snapshot");
  }
  const remoteRecords = new Map(snap.records.map((r) => [r.id, r]));
  const remoteTombstones = new Map(snap.tombstones.map((t) => [t.id, t]));
  const missingRecords = [...remoteRecords.keys()].filter((id) => !state.records[id]).sort();
  const missingTombstones = [...remoteTombstones.keys()].filter((id) => !state.tombstones[id]).sort();
  const divergent = [];
  for (const [id, remote] of remoteRecords) {
    const local = state.records[id];
    if (local && leafHash("record", local) !== leafHash("record", remote)) {
      divergent.push(id);
    }
  }
  for (const [id, remote] of remoteTombstones) {
    const local = state.tombstones[id];
    if (local && leafHash("tombstone", local) !== leafHash("tombstone", remote)) {
      divergent.push(id);
    }
  }
  divergent.sort();
  const localDigest = computeDigest(state);
  return {
    equal: localDigest === snap.digest,
    localDigest,
    remoteDigest: snap.digest ?? null,
    missingRecords,
    missingTombstones,
    divergent,
  };
}

export function snapshot(state) {
  const records = Object.values(state.records).sort(byId);
  const tombstones = Object.values(state.tombstones).sort(byId);
  const conflicts = sortedConflicts(state);
  const digest = computeDigest(state);
  return {
    replica: state.replica,
    epoch: state.clock,
    digest,
    records,
    tombstones,
    conflicts,
    certificate: buildCertificate(state, state.clock),
  };
}

export function verifySnapshot(snap) {
  if (!snap || !snap.certificate || !Array.isArray(snap.records) || !Array.isArray(snap.tombstones)) {
    throw new ReplicaError("invalid-snapshot");
  }
  const state = emptyState(snap.replica ?? "default");
  for (const record of snap.records) {
    state.records[record.id] = record;
  }
  for (const tombstone of snap.tombstones) {
    state.tombstones[tombstone.id] = tombstone;
  }
  state.conflicts = (snap.conflicts ?? []).slice();
  state.clock = snap.epoch ?? 0;
  const recomputed = snapshot(state);
  const authentic =
    recomputed.digest === snap.digest &&
    recomputed.certificate.digest === snap.certificate.digest &&
    recomputed.certificate.valid === snap.certificate.valid &&
    recomputed.certificate.leafCount === snap.certificate.leafCount;
  return { authentic, valid: snap.certificate.valid === true };
}
