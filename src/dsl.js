// Interpreter: executes parsed statements against a recovered state.
// Declarations (line/calendar/maintenance/constraint) are idempotent and are
// persisted as part of each commit snapshot; let/template are script-local
// (templates capture their definition environment -> lexical scoping).
// Transaction commands (job/add-job/move-job/savepoint/rollback/commit) run
// against a Txn and are appended to the WAL as they execute.

import { typeOf } from './types.js';
import { compile, Validator } from './bytecode.js';
import { parseConstraintExpr } from './parser.js';
import { scheduleJobs } from './schedule.js';

export class DslError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DslError';
  }
}

export class InfeasibleError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'InfeasibleError';
  }
}

class RuntimeEnv {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }
  define(name, v) {
    this.vars.set(name, v);
  }
}

export function emptyEnv() {
  return { lines: [], constraints: [] };
}

// Recompile persisted constraint sources into bytecode programs.
export function loadValidator(env) {
  const validator = new Validator();
  const lineIndex = new Map(env.lines.map((l, i) => [l.name, i]));
  const tenv = new Map(env.lines.map((l) => [l.name, 'Line']));
  for (const c of env.constraints) {
    const expr = parseConstraintExpr(c.source);
    const t = typeOf(expr, tenv);
    if (t !== 'Bool') throw new DslError(`constraint '${c.name}' must be Bool, got ${t}`);
    const program = compile(expr, lineIndex);
    validator.setConstraint(c.name, program, program.linesUsed);
  }
  return validator;
}

export class Interpreter {
  // state: { gen, env, jobs }; store: Store | null (null = in-memory only)
  constructor(state, store = null) {
    this.env = structuredClone(state.env);
    this.txn = null;
    this.store = store;
    this.rtEnv = new RuntimeEnv();
    this.validator = loadValidator(this.env);
    this.jobs = structuredClone(state.jobs); // last committed jobs
    this.txnActive = false;
    this.lastPlacement = null; // Map id -> {line, start} at last commit
  }

  ensureTxn() {
    if (!this.txn) {
      this.txn = new (txnClass())(this.jobs);
      this.txnActive = true;
    }
    return this.txn;
  }

  lineIndex() {
    return new Map(this.env.lines.map((l, i) => [l.name, i]));
  }

  findLine(name) {
    return this.env.lines.find((l) => l.name === name);
  }

  evalExpr(e, env) {
    switch (e.t) {
      case 'int': return { t: 'Int', v: e.v };
      case 'dur': return { t: 'Dur', v: e.v };
      case 'inst': return { t: 'Inst', v: e.v };
      case 'var': {
        const v = env.get(e.name);
        if (v === undefined) throw new DslError(`unknown name '${e.name}'`);
        return v;
      }
      case 'call':
        throw new DslError(`${e.name}() is only allowed in constraints`);
      case 'un': {
        const v = this.evalExpr(e.e, env);
        if (e.op === '!') {
          if (v.t !== 'Bool') throw new DslError(`! expects Bool, got ${v.t}`);
          return { t: 'Bool', v: !v.v };
        }
        if (v.t !== 'Int' && v.t !== 'Dur') throw new DslError(`unary - expects Int or Dur, got ${v.t}`);
        return { t: v.t, v: -v.v };
      }
      case 'bin': {
        const l = this.evalExpr(e.l, env);
        const r = this.evalExpr(e.r, env);
        return this.applyBin(e.op, l, r);
      }
      default:
        throw new DslError(`cannot evaluate node ${e.t}`);
    }
  }

  applyBin(op, l, r) {
    const bad = () => new DslError(`type error: ${l.t} ${op} ${r.t}`);
    switch (op) {
      case '+':
        if (l.t === 'Int' && r.t === 'Int') return { t: 'Int', v: l.v + r.v };
        if (l.t === 'Dur' && r.t === 'Dur') return { t: 'Dur', v: l.v + r.v };
        if (l.t === 'Inst' && r.t === 'Dur') return { t: 'Inst', v: l.v + r.v };
        if (l.t === 'Dur' && r.t === 'Inst') return { t: 'Inst', v: l.v + r.v };
        throw bad();
      case '-':
        if (l.t === 'Int' && r.t === 'Int') return { t: 'Int', v: l.v - r.v };
        if (l.t === 'Dur' && r.t === 'Dur') return { t: 'Dur', v: l.v - r.v };
        if (l.t === 'Inst' && r.t === 'Dur') return { t: 'Inst', v: l.v - r.v };
        if (l.t === 'Inst' && r.t === 'Inst') return { t: 'Dur', v: l.v - r.v };
        throw bad();
      case '<': case '<=': case '>': case '>=':
        if (l.t === r.t && ['Int', 'Dur', 'Inst'].includes(l.t)) {
          const fns = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
          return { t: 'Bool', v: fns[op](l.v, r.v) };
        }
        throw bad();
      case '==': if (l.t === r.t) return { t: 'Bool', v: l.v === r.v }; throw bad();
      case '!=': if (l.t === r.t) return { t: 'Bool', v: l.v !== r.v }; throw bad();
      case '&&': if (l.t === 'Bool' && r.t === 'Bool') return { t: 'Bool', v: l.v && r.v }; throw bad();
      case '||': if (l.t === 'Bool' && r.t === 'Bool') return { t: 'Bool', v: l.v || r.v }; throw bad();
      default: throw new DslError(`unknown operator ${op}`);
    }
  }

  buildJob(name, stmt, callEnv) {
    let body;
    if (stmt.template) {
      const tmpl = this.rtEnv.get(stmt.template);
      if (!tmpl || tmpl.t !== 'Template') throw new DslError(`unknown template '${stmt.template}'`);
      if (stmt.args.length !== tmpl.params.length) {
        throw new DslError(`template '${stmt.template}' takes ${tmpl.params.length} args, got ${stmt.args.length}`);
      }
      const scope = new RuntimeEnv(tmpl.env); // lexical scoping: definition env
      for (let i = 0; i < tmpl.params.length; i++) {
        scope.define(tmpl.params[i], this.evalExpr(stmt.args[i], callEnv));
      }
      body = tmpl.body;
      callEnv = scope;
    } else {
      body = stmt.body;
    }
    if (!body.duration) throw new DslError(`job '${name}' is missing duration`);
    if (!body.priority) throw new DslError(`job '${name}' is missing priority`);
    const dur = this.evalExpr(body.duration, callEnv);
    if (dur.t !== 'Dur') throw new DslError(`job '${name}' duration must be a duration, got ${dur.t}`);
    if (dur.v <= 0) throw new DslError(`job '${name}' duration must be positive`);
    const pri = this.evalExpr(body.priority, callEnv);
    if (pri.t !== 'Int') throw new DslError(`job '${name}' priority must be an integer, got ${pri.t}`);
    let lines = null;
    if (body.lines) {
      for (const ln of body.lines) {
        if (!this.findLine(ln)) throw new DslError(`job '${name}': unknown line '${ln}'`);
      }
      lines = [...body.lines];
    }
    return { id: name, duration: dur.v, priority: pri.v, lines };
  }

  scheduleAndValidate(jobs) {
    const result = scheduleJobs(jobs, this.env.lines);
    if (result === null) throw new InfeasibleError('jobs cannot be placed');
    // constraint context from the placement
    const counts = this.env.lines.map(() => 0);
    const loads = this.env.lines.map(() => 0);
    for (const job of jobs) {
      const p = result.placement.get(job.id);
      counts[p.line]++;
      loads[p.line] += job.duration;
    }
    // Incremental validation: re-check only constraints whose lines were
    // touched by txn ops or whose placement changed since the last commit.
    let changed = null;
    if (this.lastPlacement !== null) {
      changed = new Set(this.txn ? this.txn.changedLines : []);
      const lineName = (i) => this.env.lines[i].name;
      for (const job of jobs) {
        const prev = this.lastPlacement.get(job.id);
        const cur = result.placement.get(job.id);
        if (!prev || prev.line !== cur.line || prev.start !== cur.start) {
          changed.add(lineName(cur.line));
          if (prev) changed.add(lineName(prev.line));
        }
      }
      for (const id of this.lastPlacement.keys()) {
        if (!jobs.some((j) => j.id === id)) changed = null; // job removed: full re-check
      }
    }
    const lineNames = this.env.lines.map((l) => l.name);
    const { ok, failures } = this.validator.validate({ counts, loads }, lineNames, changed);
    if (!ok) throw new InfeasibleError(`constraints violated: ${failures.join(', ')}`);
    this.lastPlacement = result.placement;
    return result;
  }

  commit() {
    const jobs = this.txn ? this.txn.jobList() : this.jobs;
    const result = this.scheduleAndValidate(jobs);
    const snapshot = { env: this.env, jobs };
    let gen;
    if (this.store) {
      gen = this.store.commit(snapshot).gen;
    } else {
      gen = 0;
    }
    this.jobs = structuredClone(jobs);
    this.txn = null;
    this.txnActive = false;
    return { gen, jobs: jobs.length, placement: result.placement };
  }

  exec(stmt) {
    switch (stmt.kind) {
      case 'line': {
        if (!this.findLine(stmt.name)) this.env.lines.push({ name: stmt.name, shifts: [], maintenance: [] });
        break;
      }
      case 'calendar': {
        const line = this.findLine(stmt.line);
        if (!line) throw new DslError(`unknown line '${stmt.line}'`);
        for (const sh of stmt.shifts) {
          if (!line.shifts.some(([s, e]) => s === sh[0] && e === sh[1])) line.shifts.push(sh);
        }
        line.shifts.sort((a, b) => a[0] - b[0]);
        break;
      }
      case 'maintenance': {
        const line = this.findLine(stmt.line);
        if (!line) throw new DslError(`unknown line '${stmt.line}'`);
        const w = [stmt.start, stmt.dur];
        if (!line.maintenance.some(([s, d]) => s === w[0] && d === w[1])) line.maintenance.push(w);
        line.maintenance.sort((a, b) => a[0] - b[0]);
        break;
      }
      case 'let': {
        const v = this.evalExpr(stmt.expr, this.rtEnv);
        // each let pushes a new frame so later redefinitions shadow, never mutate
        const frame = new RuntimeEnv(this.rtEnv);
        frame.define(stmt.name, v);
        this.rtEnv = frame;
        break;
      }
      case 'template': {
        this.rtEnv.define(stmt.name, {
          t: 'Template', params: stmt.params, body: stmt.body, env: this.rtEnv,
        });
        break;
      }
      case 'constraint': {
        const tenv = new Map(this.env.lines.map((l) => [l.name, 'Line']));
        const t = typeOf(stmt.expr, tenv);
        if (t !== 'Bool') throw new DslError(`constraint '${stmt.name}' must be Bool, got ${t}`);
        const program = compile(stmt.expr, this.lineIndex());
        this.validator.setConstraint(stmt.name, program, program.linesUsed);
        const existing = this.env.constraints.findIndex((c) => c.name === stmt.name);
        const rec = { name: stmt.name, source: stmt.source };
        if (existing >= 0) this.env.constraints[existing] = rec;
        else this.env.constraints.push(rec);
        break;
      }
      case 'job':
      case 'add-job': {
        const job = this.buildJob(stmt.name, stmt, this.rtEnv);
        this.ensureTxn().addJob(job);
        if (this.store) this.store.appendOp({ cmd: stmt.kind, job });
        break;
      }
      case 'move-job': {
        if (!this.findLine(stmt.line)) throw new DslError(`unknown line '${stmt.line}'`);
        this.ensureTxn().moveJob(stmt.job, stmt.line);
        if (this.store) this.store.appendOp({ cmd: 'move-job', job: stmt.job, line: stmt.line });
        break;
      }
      case 'savepoint': {
        this.ensureTxn().savepoint(stmt.name);
        if (this.store) this.store.appendOp({ cmd: 'savepoint', name: stmt.name });
        break;
      }
      case 'rollback': {
        this.ensureTxn().rollback(stmt.name);
        if (this.store) this.store.appendOp({ cmd: 'rollback', name: stmt.name });
        break;
      }
      case 'commit': {
        if (this.store) this.store.appendOp({ cmd: 'commit' });
        return this.commit();
      }
      default:
        throw new DslError(`unknown statement ${stmt.kind}`);
    }
    return null;
  }

  execAll(stmts) {
    const commits = [];
    for (const s of stmts) {
      const r = this.exec(s);
      if (r) commits.push(r);
    }
    return commits;
  }
}

// Late import to avoid a cycle at module load time.
import { Txn } from './txn.js';
function txnClass() { return Txn; }
