'use strict';

const { solve, toCents, ratioAmountCents, EPS } = require('./solver');

class InvalidInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_INPUT';
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new InvalidInputError('input must be a JSON object');
  }
  if (typeof input.totalAmount !== 'number' || !(input.totalAmount >= 0)) {
    throw new InvalidInputError('totalAmount must be a non-negative number');
  }
  if (!Array.isArray(input.tiers) || input.tiers.length === 0 ||
      !input.tiers.every((t) => typeof t === 'number')) {
    throw new InvalidInputError('tiers must be a non-empty array of numbers');
  }
  if (!Array.isArray(input.centers) || input.centers.length === 0) {
    throw new InvalidInputError('centers must be a non-empty array');
  }
  const ids = new Set();
  for (const c of input.centers) {
    if (!c || typeof c.id !== 'string') {
      throw new InvalidInputError('each center requires a string id');
    }
    if (ids.has(c.id)) {
      throw new InvalidInputError(`duplicate center id ${c.id}`);
    }
    ids.add(c.id);
  }
  if (input.ratios != null) {
    if (typeof input.ratios !== 'object' || Array.isArray(input.ratios)) {
      throw new InvalidInputError('ratios must be an object mapping center id to ratio');
    }
    const keys = Object.keys(input.ratios);
    if (keys.length !== ids.size || !keys.every((k) => ids.has(k))) {
      throw new InvalidInputError('ratios must cover every center exactly once');
    }
    let sum = 0;
    for (const k of keys) {
      if (typeof input.ratios[k] !== 'number') {
        throw new InvalidInputError(`ratio for ${k} must be a number`);
      }
      sum += input.ratios[k];
    }
    if (Math.abs(sum - 100) > 1e-6) {
      throw new InvalidInputError(`ratio set sums to ${sum}, expected 100`);
    }
  }
}

class AllocationEngine {
  constructor(input) {
    this.totalAmount = input.totalAmount;
    this.tiers = input.tiers.slice().sort((a, b) => a - b);
    this.budget = input.searchBudget == null ? 100000 : input.searchBudget;
    this.baseCenters = input.centers.map((c) => ({
      id: c.id,
      minRatio: c.minRatio == null ? 0 : c.minRatio,
      maxRatio: c.maxRatio == null ? 100 : c.maxRatio,
      cap: c.cap == null ? null : c.cap,
    }));
    this.trace = [];
    this.seq = 0;
    this.layers = [];
    this.previousAssignment = null;
    this.result = null;
    this.log({
      type: 'init',
      totalAmount: this.totalAmount,
      tiers: this.tiers,
      searchBudget: this.budget,
      centers: this.baseCenters.map((c) => c.id),
    });
    if (input.ratios) {
      this.acceptProvidedRatios(input.ratios);
    }
  }

  log(event) {
    this.seq += 1;
    this.trace.push({ seq: this.seq, ...event });
  }

  acceptProvidedRatios(ratios) {
    const totalCents = toCents(this.totalAmount);
    const problems = [];
    for (const c of this.baseCenters) {
      const r = ratios[c.id];
      if (!this.tiers.includes(r)) problems.push(`${c.id}: ratio ${r} not an allowed tier`);
      if (r < c.minRatio - EPS || r > c.maxRatio + EPS) {
        problems.push(`${c.id}: ratio ${r} outside [${c.minRatio}, ${c.maxRatio}]`);
      }
      if (c.cap != null && ratioAmountCents(totalCents, r) > toCents(c.cap)) {
        problems.push(`${c.id}: amount for ratio ${r} exceeds cap ${c.cap}`);
      }
    }
    if (problems.length > 0) {
      this.log({ type: 'ratios-rejected', problems });
      return;
    }
    this.previousAssignment = new Map(Object.entries(ratios));
    this.log({ type: 'ratios-accepted', ratios });
  }

  activeLocks() {
    const locks = new Map();
    for (const layer of this.layers) {
      if (layer.cancelled) continue;
      for (const [center, ratio] of Object.entries(layer.locks)) {
        locks.set(center, ratio);
      }
    }
    return locks;
  }

  lockedCenters() {
    const locks = this.activeLocks();
    return this.baseCenters.map((c) => ({
      ...c,
      lockedRatio: locks.has(c.id) ? locks.get(c.id) : null,
    }));
  }

  // Incremental recompute: locked centers stay fixed, only the unlocked part
  // is re-searched, preferring the previous occupancy.
  recompute(reason) {
    const locks = Object.fromEntries(this.activeLocks());
    this.log({ type: 'recompute', reason, locked: locks });
    this.result = solve({
      centers: this.lockedCenters(),
      tiers: this.tiers,
      totalAmount: this.totalAmount,
      budget: this.budget,
      preferred: this.previousAssignment,
      log: (e) => this.log(e),
    });
    if (this.result.status === 'OK') {
      this.previousAssignment = this.result.assignment;
    }
    this.log({ type: 'recomputed', reason, status: this.result.status });
  }

  initialize() {
    this.recompute('init');
  }

  // An adjustment locks one center to a new ratio. Adjustments may only touch
  // the unlocked part; targeting a locked center is rejected and traced.
  applyAdjustment(doc) {
    if (!doc || typeof doc.id !== 'string' || typeof doc.center !== 'string' ||
        typeof doc.ratio !== 'number') {
      throw new InvalidInputError('each adjustment requires id, center and ratio');
    }
    if (this.layers.some((l) => l.id === doc.id)) {
      throw new InvalidInputError(`duplicate adjustment id ${doc.id}`);
    }
    if (!this.baseCenters.some((c) => c.id === doc.center)) {
      throw new InvalidInputError(`unknown center ${doc.center}`);
    }
    const locks = this.activeLocks();
    if (locks.has(doc.center)) {
      this.log({
        type: 'adjust-rejected',
        doc: doc.id,
        center: doc.center,
        reason: 'center already locked',
        lockedRatio: locks.get(doc.center),
      });
      return;
    }
    const layer = {
      id: doc.id,
      locks: { [doc.center]: doc.ratio },
      cancelled: false,
      snapshotBefore: this.previousAssignment ? new Map(this.previousAssignment) : null,
    };
    this.layers.push(layer);
    this.log({ type: 'adjust', doc: doc.id, center: doc.center, ratio: doc.ratio });
    this.recompute(`adjust:${doc.id}`);
  }

  // Cancellation removes the layer and restores the occupancy that existed
  // before that layer was applied, then recomputes incrementally.
  cancel(docId) {
    const layer = this.layers.find((l) => l.id === docId);
    if (!layer) {
      throw new InvalidInputError(`cannot cancel unknown document ${docId}`);
    }
    if (layer.cancelled) {
      throw new InvalidInputError(`document ${docId} already cancelled`);
    }
    layer.cancelled = true;
    this.previousAssignment = layer.snapshotBefore;
    this.log({
      type: 'cancel',
      doc: docId,
      restoredRatios: layer.snapshotBefore ? Object.fromEntries(layer.snapshotBefore) : null,
    });
    this.recompute(`cancel:${docId}`);
  }

  output() {
    const result = this.result;
    const locks = this.activeLocks();
    const totalCents = toCents(this.totalAmount);
    const allocation = [];
    let lockedCents = 0;
    let allocatedCents = 0;
    let ratioSum = 0;
    for (const c of this.baseCenters) {
      const locked = locks.has(c.id);
      let ratio = null;
      if (result.status === 'OK') ratio = result.assignment.get(c.id);
      else if (locked) ratio = locks.get(c.id);
      const amountCents = ratio == null ? null : ratioAmountCents(totalCents, ratio);
      if (amountCents != null) {
        allocatedCents += amountCents;
        ratioSum += ratio;
        if (locked) lockedCents += amountCents;
      }
      allocation.push({
        center: c.id,
        ratio,
        amount: amountCents == null ? null : amountCents / 100,
        locked,
      });
    }
    return {
      status: result.status,
      totalAmount: this.totalAmount,
      totalRatio: Math.round(ratioSum * 1e9) / 1e9,
      allocation,
      allocatedAmount: allocatedCents / 100,
      lockedAmount: lockedCents / 100,
      pendingAmount: (totalCents - lockedCents) / 100,
      conflictCenters: result.conflictCenters || [],
      searchNodes: result.nodes,
      trace: this.trace,
    };
  }
}

function runAllocation(input) {
  validateInput(input);
  const engine = new AllocationEngine(input);
  engine.initialize();
  for (const doc of input.adjustments || []) engine.applyAdjustment(doc);
  for (const docId of input.cancellations || []) engine.cancel(docId);
  return engine.output();
}

module.exports = { runAllocation, AllocationEngine, InvalidInputError };
