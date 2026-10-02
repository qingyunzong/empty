import { writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { LamportClock, compareClock, causallyBefore } from './clock.js';
import { InputError } from './errors.js';
import { canonical, sha256, datasetHash, datasetSnapshot, datasetFromSnapshot, validateOrder } from './model.js';
import { plan as computeSchedule } from './schedule.js';
import { Store, opHash, planDigest } from './store.js';

// Planner: append-only causal op log + movable head pointer.
//  - load(dataset)   : replace the dataset (full import)
//  - insert(order)   : incremental order insert; concurrent duplicates are
//                      rejected, the causally prior insert is kept, and a
//                      verifiable certificate is emitted
//  - undoTo(seq)     : move head to any operation point (backwards = undo,
//                      forwards = restore); emits an undo certificate proving
//                      promised due dates were not altered
export class Planner {
  constructor(dir, node = 'node-0') {
    this.store = new Store(dir);
    this.clock = new LamportClock(node);
    this.log = this.store.readLog();
    for (const op of this.log) this.clock.observe(op.clock);
    let plan = this.store.readPlan();
    if (plan) {
      if (plan.headSeq > this.log.length) {
        const err = new Error('plan refers to missing log entries');
        err.code = 'E_CORRUPT';
        throw err;
      }
      // Ops beyond the committed head are either (a) undone-but-restorable
      // history, vouched for by a matching undo certificate, or (b) an
      // uncommitted op from a crash mid-commit. Only (b) is truncated, so no
      // half-committed operation survives a restart.
      if (this.log.length > plan.headSeq) {
        const vouched = this.store.readCerts().some(
          (c) => c.type === 'undo' && c.toHead === plan.headSeq && c.planDigest === plan.digest);
        if (!vouched) this.#truncateLog(plan.headSeq);
      }
      this.head = plan.headSeq;
    } else {
      if (this.log.length > 0) this.#truncateLog(0);
      this.head = 0;
    }
    this.#verifyChain();
  }

  #truncateLog(to) {
    this.log = this.log.slice(0, to);
    const fd = openSync(this.store.logPath, 'w');
    try {
      for (const op of this.log) writeFileSync(fd, canonical(op) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  #verifyChain() {
    let prev = null;
    const seen = [];
    for (const op of this.log) {
      if (op.hash !== opHash(op)) throw corrupt('log hash mismatch at seq ' + op.seq);
      if (op.prevHash !== prev) throw corrupt('log chain broken at seq ' + op.seq);
      for (const p of op.parents) {
        if (!causallyBefore(p, seen)) throw corrupt('op ' + op.seq + ' depends on unknown causal parent');
      }
      prev = op.hash;
      seen.push(op.clock);
    }
  }

  #appendOp(kind, payload, parents = null) {
    const clock = this.clock.tick();
    const op = {
      seq: this.log.length + 1,
      clock,
      kind,
      payload,
      parents: parents ?? (this.log.length ? [this.log[this.log.length - 1].clock] : []),
      prevHash: this.log.length ? this.log[this.log.length - 1].hash : null,
    };
    op.hash = opHash(op);
    this.store.appendOp(op);
    this.log.push(op);
    this.head = this.log.length;
    return op;
  }

  // Fold ops[0..to) into a dataset; also returns orderId -> introducing clock.
  replay(to = this.head) {
    let ds = datasetFromSnapshot({ machines: [], molds: [], operators: [], orders: [], setups: [] });
    const introduced = new Map();
    for (const op of this.log.slice(0, to)) {
      if (op.kind === 'load') {
        ds = datasetFromSnapshot(op.payload.snapshot);
        introduced.clear();
        for (const id of ds.orders.keys()) introduced.set(id, op.clock);
      } else if (op.kind === 'insert') {
        const o = op.payload.order;
        ds.orders.set(o.id, o);
        introduced.set(o.id, op.clock);
      }
    }
    return { ds, introduced };
  }

  #computePlan() {
    const { ds } = this.replay(this.head);
    const result = computeSchedule(ds); // throws InfeasibleError -> nothing is committed
    const commitments = {};
    for (const [id, o] of ds.orders) commitments[id] = o.due;
    const plan = {
      headSeq: this.head,
      headHash: this.head ? this.log[this.head - 1].hash : null,
      clock: this.head ? this.log[this.head - 1].clock : null, // causal point of the plan
      datasetHash: datasetHash(ds),
      seq: result.seq,
      jobs: result.jobs,
      makespan: result.makespan,
      totalSetup: result.totalSetup,
      commitments,
      commitmentsHash: sha256(canonical(commitments)),
    };
    plan.digest = planDigest(plan);
    return plan;
  }

  #commit() {
    const plan = this.#computePlan();
    this.store.commitPlan(plan);
    return plan;
  }

  load(snapshot) {
    const ds = datasetFromSnapshot(snapshot); // validate before touching the log
    datasetHash(ds);
    this.#appendOp('load', { snapshot: datasetSnapshot(ds) });
    return this.#commit();
  }

  // context: causal stamps the inserter had observed (empty = concurrent with everything)
  insert(orderObj, context = []) {
    const { ds, introduced } = this.replay(this.head);
    const order = validateOrder(orderObj, `order/${orderObj && orderObj.id}`, ds.molds, ds.operators);
    const existingClock = introduced.get(order.id);
    if (existingClock) {
      const attemptClock = { node: this.clock.node, counter: this.clock.counter + 1 };
      if (causallyBefore(existingClock, context)) {
        return { status: 'duplicate-ack', kept: { id: order.id, clock: existingClock } };
      }
      // concurrent duplicate: the causally prior insert wins, loser gets a certificate
      const [kept, rejected] = compareClock(existingClock, attemptClock) <= 0
        ? [{ id: order.id, clock: existingClock }, { id: order.id, clock: attemptClock }]
        : [{ id: order.id, clock: attemptClock }, { id: order.id, clock: existingClock }];
      const cert = {
        type: 'insert-conflict',
        seq: this.store.readCerts().length + 1,
        clock: this.clock.tick(),
        reason: 'concurrent duplicate order insert',
        kept, rejected,
        headSeq: this.head,
        headHash: this.head ? this.log[this.head - 1].hash : null,
      };
      cert.digest = sha256(canonical(cert));
      this.store.writeCert(cert);
      return { status: 'rejected', kept, rejected, cert };
    }
    this.#appendOp('insert', { order }, context.length ? context : null);
    const plan = this.#commit();
    return { status: 'applied', plan };
  }

  undoTo(target) {
    if (!Number.isInteger(target) || target < 0 || target > this.log.length) {
      throw new InputError('E_INPUT', `undo/--to`, `target must be an operation point in [0, ${this.log.length}]`);
    }
    const fromHead = this.head;
    this.head = target;
    const plan = this.#computePlan();
    const cert = {
      type: 'undo',
      seq: this.store.readCerts().length + 1,
      clock: this.clock.tick(),
      fromHead,
      toHead: target,
      prevHeadHash: fromHead ? this.log[fromHead - 1].hash : null,
      headHash: target ? this.log[target - 1].hash : null,
      commitments: plan.commitments,          // promised due dates at the restored point
      commitmentsHash: plan.commitmentsHash,  // proof they were not altered
      planDigest: plan.digest,
    };
    cert.digest = sha256(canonical(cert));
    this.store.writeCert(cert);   // cert first: it vouches for the head move
    this.store.commitPlan(plan);
    return { plan, cert };
  }

  currentPlan() {
    return this.store.readPlan();
  }

  verify() {
    const checks = [];
    const ok = (name, detail) => { checks.push({ name, ok: true, detail }); return true; };
    const bad = (name, detail) => { checks.push({ name, ok: false, detail }); return false; };
    try { this.#verifyChain(); ok('log-chain', `${this.log.length} ops, hashes and causal parents valid`); }
    catch (e) { bad('log-chain', e.message); }
    const stored = this.store.readPlan();
    if (!stored) return { ok: checks.every((c) => c.ok), checks };
    const replayed = this.#computePlan();
    (replayed.digest === stored.digest ? ok : bad)('replay', `replay@${this.head} digest ${stored.digest.slice(0, 12)}… matches committed plan`);
    (stored.headSeq === this.head ? ok : bad)('head', `head=${this.head}`);
    for (const cert of this.store.readCerts()) {
      if (cert.type === 'undo') {
        const { ds } = this.replay(cert.toHead);
        const commitments = {};
        for (const [id, o] of ds.orders) commitments[id] = o.due;
        const hashOk = sha256(canonical(commitments)) === cert.commitmentsHash;
        const duesOk = Object.entries(cert.commitments).every(([id, due]) => commitments[id] === due);
        (hashOk && duesOk ? ok : bad)(`cert:undo#${cert.seq}`, `promised due dates at op ${cert.toHead} unchanged`);
      } else if (cert.type === 'insert-conflict') {
        const { introduced } = this.replay(cert.headSeq);
        const kept = introduced.get(cert.kept.id);
        (kept && kept.counter === cert.kept.clock.counter && kept.node === cert.kept.clock.node ? ok : bad)(
          `cert:insert-conflict#${cert.seq}`, `causally prior insert of "${cert.kept.id}" is the one retained`);
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  }
}

function corrupt(msg) { const e = new Error(msg); e.code = 'E_CORRUPT'; return e; }
