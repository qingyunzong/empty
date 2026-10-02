#!/usr/bin/env node
// moldplan -- offline injection-molding scheduler CLI.
//
//   moldplan plan --input FILE --state DIR [--node ID]
//   moldplan plan --state DIR --insert JSON [--node ID] [--clock JSON]
//   moldplan plan --state DIR
//   moldplan undo --state DIR --to SEQ
//   moldplan verify --state DIR
//
// Exit codes: 0 ok | 2 invalid input ({code,at}) | 3 infeasible (minimal
// conflict set) | 4 undo would break a committed due date | 1 other.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseInput, validateOrder, InputError } from "./model.js";
import { solve, minimalConflictSet } from "./schedule.js";
import { replayOps, buildInstance } from "./oplog.js";
import { mergeClocks, tick, compareClocks, causalKeyCompare } from "./clock.js";
import { makeCert, verifyChain } from "./cert.js";
import { Store, hashResult } from "./store.js";

class InfeasibleError extends Error {
  constructor(conflicts) {
    super("INFEASIBLE");
    this.conflicts = conflicts;
  }
}

class ExitError extends Error {
  constructor(code, at, exitCode, extra = {}) {
    super(code);
    this.code = code;
    this.at = at;
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function requireState(args) {
  if (!args.state || args.state === true) throw new ExitError("USAGE", "--state required", 2);
  return new Store(args.state).load();
}

function mergedClock(ops) {
  let c = {};
  for (const op of ops) c = mergeClocks(c, op.clock);
  return c;
}

function nextOpMeta(store, node, clockArg) {
  let clock;
  let deps;
  if (clockArg !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(clockArg);
    } catch {
      throw new ExitError("PARSE_ERROR", "--clock", 2);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.values(parsed).some((v) => !Number.isInteger(v) || v < 0))
      throw new ExitError("SCHEMA", "--clock", 2);
    clock = parsed;
    deps = []; // injected clock models a concurrent replica fork
  } else {
    clock = tick(mergedClock(store.ops), node);
    deps = store.ops.length ? [store.ops[store.ops.length - 1].id] : [];
  }
  const seq = store.ops.length;
  return { seq, id: `op${seq}`, node, clock, deps };
}

function solveOrThrow(instance) {
  const res = solve(instance, instance.orderIds);
  if (res.status === "infeasible") {
    throw new InfeasibleError(minimalConflictSet(instance, instance.orderIds));
  }
  return res;
}

function cmdPlan(args, io) {
  const node = typeof args.node === "string" ? args.node : "local";

  if (args.input) {
    // Fresh load: requires an empty state directory.
    const store = requireState(args);
    if (store.ops.length > 0) throw new ExitError("STATE_NOT_EMPTY", args.state, 2);
    let text;
    try {
      text = fs.readFileSync(args.input, "utf8");
    } catch {
      throw new ExitError("IO", String(args.input), 2);
    }
    const instance = parseInput(text, String(args.input));
    const res = solveOrThrow(instance);
    const meta = nextOpMeta(store, node, undefined);
    store.appendOp({ ...meta, kind: "load", input: instance });
    store.writePlan(res, meta.seq);
    io.out({ status: "ok", point: meta.seq, ...publicResult(res, new Set()) });
    return;
  }

  const store = requireState(args);
  store.ensurePlan();

  if (args.insert) {
    let raw;
    try {
      raw = JSON.parse(args.insert);
    } catch {
      throw new ExitError("PARSE_ERROR", "--insert", 2);
    }
    const order = validateOrder(raw, "--insert");
    const rep = replayOps(store.ops);
    if (!rep.base) throw new ExitError("NO_BASE", args.state, 2);
    const mold = rep.base.molds[order.mold];
    if (!mold) throw new ExitError("UNKNOWN_MOLD", `--insert (${order.id}.mold=${order.mold})`, 2);
    const knownIds = new Set(Object.keys(rep.base.orders));
    for (const op of store.ops) if (op.kind === "insert") knownIds.add(op.order.id);
    if (knownIds.has(order.id)) throw new ExitError("DUPLICATE", `--insert (${order.id})`, 2);
    order.proc = order.qty * mold.cycle;

    const meta = nextOpMeta(store, node, args.clock);
    const op = { ...meta, kind: "insert", order };
    const rep2 = replayOps([...store.ops, op]);
    const instance = buildInstance(rep2.base, rep2.effectiveInserts);
    const res = solveOrThrow(instance);

    store.appendOp(op);
    const newConflicts = rep2.conflicts.filter((c) => c.winner === op.id || c.loser === op.id);
    for (const c of newConflicts) {
      const winnerOp = rep2.inserts.find((o) => o.id === c.winner);
      const loserOp = rep2.inserts.find((o) => o.id === c.loser);
      store.appendCert(
        makeCert(store.certs, "conflict", {
          reason: "concurrent-mold-conflict",
          mold: c.mold,
          winner: { op: winnerOp.id, order: winnerOp.order.id, node: winnerOp.node, clock: winnerOp.clock },
          loser: { op: loserOp.id, order: loserOp.order.id, node: loserOp.node, clock: loserOp.clock },
        })
      );
    }
    store.writePlan(res, rep2.point);
    const superseded = rep2.superseded.has(op.id);
    io.out({
      status: superseded ? "superseded" : "ok",
      point: rep2.point,
      op: op.id,
      conflicts: newConflicts.map((c) => ({ winner: c.winner, loser: c.loser, mold: c.mold })),
      ...publicResult(res, rep2.superseded),
    });
    return;
  }

  // Re-print current committed plan (also performs crash recovery).
  if (!store.plan) throw new ExitError("EMPTY", args.state, 2);
  const rep = replayOps(store.ops);
  io.out({ status: "ok", point: rep.point, ...publicResult(store.plan.result, rep.superseded) });
}

function publicResult(res, supersededOps) {
  return {
    makespan: res.makespan,
    changes: res.changes,
    sequences: res.sequences,
    plan: res.plan,
    superseded: [...supersededOps],
  };
}

function solveAt(ops, point) {
  const rep = replayOps(ops, point);
  if (!rep.base) throw new ExitError("NO_BASE", "oplog", 2);
  const instance = buildInstance(rep.base, rep.effectiveInserts);
  const res = solve(instance, instance.orderIds);
  if (res.status === "infeasible") throw new ExitError("INTERNAL", "replay infeasible", 1);
  return { rep, instance, res };
}

function cmdUndo(args, io) {
  const store = requireState(args);
  store.ensurePlan();
  if (store.ops.length === 0) throw new ExitError("EMPTY", args.state, 2);
  const toSeq = Number(args.to);
  const maxSeq = store.ops[store.ops.length - 1].seq;
  if (!Number.isInteger(toSeq) || toSeq < 0 || toSeq > maxSeq)
    throw new ExitError("BAD_TARGET", `--to ${args.to}`, 2);

  const node = typeof args.node === "string" ? args.node : "local";
  const current = replayOps(store.ops).point;
  if (toSeq === current) {
    io.out({ status: "ok", point: current, noop: true, ...publicResult(store.plan.result, replayOps(store.ops).superseded) });
    return;
  }

  const before = solveAt(store.ops, current);
  const after = solveAt(store.ops, toSeq);

  // Undo must not change any committed due date promise.
  const committed = [];
  for (const o of Object.values(before.instance.orders)) {
    if (!o.committed) continue;
    const b = before.res.plan.find((p) => p.order === o.id);
    const a = after.instance.orders[o.id] ? after.res.plan.find((p) => p.order === o.id) : null;
    if (!b) continue;
    if (!a || a.end !== b.end || a.end > o.due) {
      throw new ExitError("UNDO_BREAKS_COMMIT", o.id, 4);
    }
    committed.push({ order: o.id, due: o.due, end: b.end });
  }
  committed.sort((x, y) => (x.order < y.order ? -1 : 1));

  const meta = nextOpMeta(store, node, undefined);
  store.appendOp({ ...meta, kind: "undo", toSeq });
  const cert = makeCert(store.certs, "undo", {
    fromPoint: current,
    toSeq,
    committed,
    planHashBefore: hashResult(before.res),
    planHashAfter: hashResult(after.res),
  });
  store.appendCert(cert);
  store.writePlan(after.res, toSeq);
  io.out({ status: "ok", point: toSeq, cert: cert.hash, ...publicResult(after.res, after.rep.superseded) });
}

function cmdVerify(args, io) {
  const store = requireState(args);
  store.ensurePlan();
  if (store.ops.length === 0 || !store.plan) throw new ExitError("EMPTY", args.state, 2);

  // 1. Certificate hash chain.
  const chain = verifyChain(store.certs);
  if (!chain.ok) throw new ExitError("CERT_CHAIN", chain.at, 1);

  // 2. Replay the oplog and recompute the plan deterministically.
  const rep = replayOps(store.ops);
  if (rep.point !== store.plan.effectivePoint)
    throw new ExitError("PLAN_MISMATCH", `effectivePoint ${store.plan.effectivePoint} != ${rep.point}`, 1);
  const instance = buildInstance(rep.base, rep.effectiveInserts);
  const res = solveOrThrow(instance);
  if (hashResult(res) !== store.plan.planHash)
    throw new ExitError("PLAN_MISMATCH", "planHash", 1);

  // 3. Validate every certificate against an independent replay.
  for (const cert of store.certs) {
    if (cert.type === "undo") {
      const p = cert.payload;
      const before = solveAt(store.ops, p.fromPoint);
      const after = solveAt(store.ops, p.toSeq);
      if (hashResult(before.res) !== p.planHashBefore || hashResult(after.res) !== p.planHashAfter)
        throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
      const expected = [];
      for (const o of Object.values(before.instance.orders)) {
        if (!o.committed) continue;
        const b = before.res.plan.find((x) => x.order === o.id);
        const a = after.instance.orders[o.id] ? after.res.plan.find((x) => x.order === o.id) : null;
        if (b && a && a.end === b.end && a.end <= o.due) expected.push({ order: o.id, due: o.due, end: b.end });
      }
      expected.sort((x, y) => (x.order < y.order ? -1 : 1));
      if (JSON.stringify(expected) !== JSON.stringify(p.committed))
        throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
    } else if (cert.type === "conflict") {
      const p = cert.payload;
      const w = store.ops.find((o) => o.id === p.winner.op);
      const l = store.ops.find((o) => o.id === p.loser.op);
      if (!w || !l || w.kind !== "insert" || l.kind !== "insert")
        throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
      const rel = compareClocks(w.clock, l.clock);
      if (rel === -1 || rel === 1) throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
      if (w.order.mold !== l.order.mold || w.order.mold !== p.mold)
        throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
      if (causalKeyCompare(w, l) >= 0) throw new ExitError("CERT_INVALID", `certs[${cert.seq}]`, 1);
    }
  }

  io.out({
    ok: true,
    ops: store.ops.length,
    certs: store.certs.length,
    point: rep.point,
    planHash: store.plan.planHash,
  });
}

function main(argv, io) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case "plan":
      cmdPlan(args, io);
      break;
    case "undo":
      cmdUndo(args, io);
      break;
    case "verify":
      cmdVerify(args, io);
      break;
    default:
      throw new ExitError("USAGE", "plan|undo|verify", 2);
  }
}

// Programmatic entry: returns the exit code, emits JSON lines via io.
export function runCli(argv, io) {
  const sink = io ?? {
    out: (obj) => process.stdout.write(JSON.stringify(obj) + "\n"),
    err: (obj) => process.stderr.write(JSON.stringify(obj) + "\n"),
  };
  try {
    main(argv, sink);
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      sink.err({ code: e.code, at: e.at });
      return 2;
    }
    if (e instanceof InfeasibleError) {
      sink.err({ code: "INFEASIBLE", conflicts: e.conflicts });
      return 3;
    }
    if (e instanceof ExitError) {
      sink.err({ code: e.code, at: e.at, ...e.extra });
      return e.exitCode;
    }
    sink.err({ code: "INTERNAL", at: String((e && e.stack) || e) });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
