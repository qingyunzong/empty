// State directory persistence with atomic commits and crash recovery.
//
// Files: oplog.jsonl (source of truth, append-only), certs.jsonl (hash chain),
// plan.json (derived cache). plan.json is committed by writing plan.tmp,
// fsync, then atomic rename. A leftover plan.tmp after a crash is discarded;
// a torn final oplog line is truncated. If plan.json is missing or stale
// relative to the oplog, it is regenerated -- never half-committed.
import fs from "node:fs";
import path from "node:path";
import { replayOps, buildInstance } from "./oplog.js";
import { solve } from "./schedule.js";
import { hashObject } from "./stable.js";

export function hashResult(res) {
  return hashObject({
    sequences: res.sequences,
    makespan: res.makespan,
    changes: res.changes,
    plan: res.plan,
  });
}

function readJsonlSelfHealing(file) {
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const out = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      offset += line.length + 1;
      continue;
    }
    try {
      out.push(JSON.parse(line));
      offset += line.length + 1;
    } catch {
      // Torn write (crash mid-append): truncate the bad tail.
      fs.truncateSync(file, offset);
      break;
    }
  }
  return out;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.opsPath = path.join(dir, "oplog.jsonl");
    this.certsPath = path.join(dir, "certs.jsonl");
    this.planPath = path.join(dir, "plan.json");
    this.tmpPath = path.join(dir, "plan.tmp");
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    // Crash recovery: a stray plan.tmp means the rename never happened.
    if (fs.existsSync(this.tmpPath)) fs.rmSync(this.tmpPath);
    this.ops = readJsonlSelfHealing(this.opsPath);
    this.certs = readJsonlSelfHealing(this.certsPath);
    this.plan = null;
    if (fs.existsSync(this.planPath)) {
      try {
        this.plan = JSON.parse(fs.readFileSync(this.planPath, "utf8"));
      } catch {
        this.plan = null;
      }
    }
    return this;
  }

  // Regenerate the derived plan if the oplog moved past the last commit.
  ensurePlan() {
    if (this.plan && this.plan.oplogLength === this.ops.length) return this.plan;
    if (this.ops.length === 0) return null;
    const rep = replayOps(this.ops);
    if (!rep.base) throw new Error("oplog has no load op");
    const instance = buildInstance(rep.base, rep.effectiveInserts);
    const res = solve(instance, instance.orderIds);
    if (res.status === "infeasible") throw new Error("committed log replays to infeasible plan");
    this.writePlan(res, rep.point);
    return this.plan;
  }

  writePlan(res, point) {
    const planObj = {
      version: 1,
      oplogLength: this.ops.length,
      effectivePoint: point,
      planHash: hashResult(res),
      result: res,
    };
    fs.writeFileSync(this.tmpPath, JSON.stringify(planObj, null, 2));
    const fd = fs.openSync(this.tmpPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(this.tmpPath, this.planPath); // atomic commit
    try {
      const dfd = fs.openSync(this.dir, "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {}
    this.plan = planObj;
  }

  appendOp(op) {
    const fd = fs.openSync(this.opsPath, "a");
    fs.writeSync(fd, JSON.stringify(op) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.ops.push(op);
  }

  appendCert(cert) {
    const fd = fs.openSync(this.certsPath, "a");
    fs.writeSync(fd, JSON.stringify(cert) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.certs.push(cert);
  }
}
