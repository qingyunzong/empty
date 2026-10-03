import { parse, exprToString } from './parser.js';
import { checkExpr, TypeCheckError } from './typecheck.js';
import { compileExpr, durToMinutes, parseInstant } from './bytecode.js';
import { Model } from './model.js';
import { TxnManager } from './txn.js';

export class Interpreter {
  constructor(model = new Model()) {
    this.model = model;
    this.symbols = new Map();
    this.templates = new Map();
    this.committed = false;
    this.txn = new TxnManager(model, (undo) => {
      if (undo.op === 'add') this.symbols.delete(undo.name);
    });
    for (const name of model.lines) this.symbols.set(name, { type: 'line' });
    for (const cal of model.calendars) this.symbols.set(cal.name, { type: 'calendar' });
    for (const name of model.jobs.keys()) this.symbols.set(name, { type: 'job' });
  }

  runSource(src) {
    this.run(parse(src));
  }

  run(stmts) {
    for (const s of stmts) this.exec(s);
  }

  exec(s) {
    switch (s.kind) {
      case 'lines': {
        for (const n of s.names) {
          this.declare(n, 'line');
          this.model.addLine(n);
        }
        break;
      }
      case 'calendar': {
        this.declare(s.name, 'calendar');
        this.model.calendars.push({ name: s.name, shifts: s.shifts });
        break;
      }
      case 'maintenance': {
        const lineId = this.requireLine(s.line);
        this.model.maintenance.push({
          lineId,
          start: parseInstant(s.at),
          dur: durToMinutes(s.dur.v, s.dur.unit),
        });
        break;
      }
      case 'template': {
        this.declare(s.name, 'template');
        // Lexical scoping: the body may only see names declared before the
        // template, plus its own parameters (which shadow outer names).
        this.templates.set(s.name, {
          params: s.params,
          body: s.body,
          lexical: new Set(this.symbols.keys()),
        });
        break;
      }
      case 'job': {
        const job = this.resolveJob(s, null, null);
        this.model.addJob(job);
        this.symbols.set(job.name, { type: 'job' });
        break;
      }
      case 'call': {
        this.expandTemplate(s);
        break;
      }
      case 'constraint': {
        const t = checkExpr(s.expr, (name) => {
          const sym = this.symbols.get(name);
          return sym && sym.type === 'line' ? 'line' : null;
        });
        if (t !== 'bool') throw new TypeCheckError(`constraint must be bool, got ${t}`);
        const prog = compileExpr(s.expr, (name) => this.model.lineId.get(name));
        this.model.constraints.push({ prog, ast: s.expr, src: exprToString(s.expr) });
        break;
      }
      case 'add-job': {
        const job = this.resolveJob(s, null, null);
        this.txn.addJob(job);
        this.symbols.set(job.name, { type: 'job' });
        break;
      }
      case 'move-job': {
        this.requireLine(s.to);
        if (!this.model.jobs.has(s.name)) throw new TypeCheckError(`unknown job '${s.name}'`);
        this.txn.moveJob(s.name, s.to);
        break;
      }
      case 'savepoint': {
        this.txn.savepoint(s.name);
        break;
      }
      case 'rollback': {
        this.txn.rollback(s.name);
        break;
      }
      case 'commit': {
        this.txn.commit();
        this.committed = true;
        break;
      }
      default:
        throw new Error(`cannot execute statement kind ${s.kind}`);
    }
  }

  declare(name, type) {
    if (this.symbols.has(name)) throw new TypeCheckError(`duplicate declaration of '${name}'`);
    this.symbols.set(name, { type });
  }

  requireLine(name) {
    const sym = this.symbols.get(name);
    if (!sym || sym.type !== 'line') throw new TypeCheckError(`'${name}' is not a declared line`);
    return this.model.lineId.get(name);
  }

  resolveJob(stmt, params, lexical) {
    const lookup = (name, expected) => {
      if (params && params.has(name)) {
        const p = params.get(name);
        if (p.type !== expected) {
          throw new TypeCheckError(`parameter '${name}' is ${p.type}, expected ${expected}`);
        }
        return p.value;
      }
      if (lexical && !lexical.has(name)) {
        throw new TypeCheckError(`'${name}' is not visible in template (lexical scope)`);
      }
      return undefined;
    };
    const resolveName = (ref) => {
      const v = lookup(ref, 'name');
      if (v !== undefined) return v;
      return ref;
    };
    const jobName = resolveName(stmt.name);
    if (!stmt.fields.line) throw new TypeCheckError(`job '${jobName}' is missing field 'line'`);
    if (!stmt.fields.duration) throw new TypeCheckError(`job '${jobName}' is missing field 'duration'`);

    const lineVal = stmt.fields.line;
    let line;
    if (lineVal.kind === 'ref') {
      const v = lookup(lineVal.name, 'line');
      if (v !== undefined) line = v;
      else { this.requireLine(lineVal.name); line = lineVal.name; }
    } else {
      throw new TypeCheckError(`job '${jobName}' field 'line' must be a line name`);
    }

    const durVal = stmt.fields.duration;
    let duration;
    if (durVal.kind === 'dur') duration = durToMinutes(durVal.v, durVal.unit);
    else if (durVal.kind === 'ref') {
      const v = lookup(durVal.name, 'duration');
      if (v === undefined) throw new TypeCheckError(`job '${jobName}' field 'duration' must be a duration`);
      duration = v;
    } else {
      throw new TypeCheckError(`job '${jobName}' field 'duration' must be a duration`);
    }
    if (duration <= 0) throw new TypeCheckError(`job '${jobName}' duration must be positive`);

    let priority = 0;
    if (stmt.fields.priority) {
      const p = stmt.fields.priority;
      if (p.kind === 'int') priority = p.v;
      else if (p.kind === 'ref') {
        const v = lookup(p.name, 'int');
        if (v === undefined) throw new TypeCheckError(`job '${jobName}' field 'priority' must be an int`);
        priority = v;
      } else {
        throw new TypeCheckError(`job '${jobName}' field 'priority' must be an int`);
      }
    }

    const after = [];
    for (const ref of stmt.fields.after || []) {
      if (ref.kind !== 'ref') throw new TypeCheckError(`job '${jobName}' field 'after' expects job names`);
      after.push(resolveName(ref.name));
    }
    return { name: jobName, line, duration, priority, after };
  }

  expandTemplate(call) {
    const tpl = this.templates.get(call.name);
    if (!tpl) throw new TypeCheckError(`unknown template '${call.name}'`);
    if (call.args.length !== tpl.params.length) {
      throw new TypeCheckError(`template '${call.name}' expects ${tpl.params.length} args, got ${call.args.length}`);
    }
    const params = new Map();
    tpl.params.forEach((param, i) => {
      const arg = call.args[i];
      switch (param.type) {
        case 'line': {
          if (arg.kind !== 'ref') throw new TypeCheckError(`arg '${param.name}' must be a line name`);
          this.requireLine(arg.name);
          params.set(param.name, { type: 'line', value: arg.name });
          break;
        }
        case 'duration': {
          if (arg.kind !== 'dur') throw new TypeCheckError(`arg '${param.name}' must be a duration`);
          params.set(param.name, { type: 'duration', value: durToMinutes(arg.v, arg.unit) });
          break;
        }
        case 'int': {
          if (arg.kind !== 'int') throw new TypeCheckError(`arg '${param.name}' must be an int`);
          params.set(param.name, { type: 'int', value: arg.v });
          break;
        }
        case 'instant': {
          if (arg.kind !== 'instant') throw new TypeCheckError(`arg '${param.name}' must be an instant`);
          params.set(param.name, { type: 'instant', value: parseInstant(arg.v) });
          break;
        }
        case 'name': {
          if (arg.kind !== 'ref') throw new TypeCheckError(`arg '${param.name}' must be a name`);
          params.set(param.name, { type: 'name', value: arg.name });
          break;
        }
        default:
          throw new TypeCheckError(`unknown param type '${param.type}'`);
      }
    });
    for (const bodyStmt of tpl.body) {
      const job = this.resolveJob(bodyStmt, params, tpl.lexical);
      this.model.addJob(job);
      this.symbols.set(job.name, { type: 'job' });
    }
  }
}

export function modelToCanonical(model) {
  return {
    lines: model.lines.slice(),
    calendars: model.calendars.map((c) => ({
      name: c.name,
      shifts: c.shifts.map((s) => ({ days: s.days.slice(), from: s.from, to: s.to })),
    })),
    maintenance: model.maintenance.map((m) => ({
      line: model.lines[m.lineId],
      start: m.start,
      dur: m.dur,
    })),
    jobs: [...model.jobs.values()].map((j) => ({
      name: j.name,
      line: j.line,
      duration: j.duration,
      priority: j.priority,
      after: j.after.slice(),
    })),
    constraints: model.constraints.map((c) => c.src),
  };
}

export function modelFromCanonical(c) {
  const model = new Model();
  for (const name of c.lines) model.addLine(name);
  for (const cal of c.calendars) {
    model.calendars.push({ name: cal.name, shifts: cal.shifts.map((s) => ({ days: s.days.slice(), from: s.from, to: s.to })) });
  }
  for (const m of c.maintenance) {
    model.maintenance.push({ lineId: model.lineId.get(m.line), start: m.start, dur: m.dur });
  }
  for (const j of c.jobs) {
    model.addJob({ name: j.name, line: j.line, duration: j.duration, priority: j.priority, after: j.after.slice() });
  }
  if (c.constraints.length) {
    const symbols = new Map(c.lines.map((n) => [n, { type: 'line' }]));
    for (const src of c.constraints) {
      const stmt = parse(`constraint ${src};`)[0];
      const t = checkExpr(stmt.expr, (name) => (symbols.has(name) ? 'line' : null));
      if (t !== 'bool') throw new TypeCheckError(`stored constraint is not bool: ${src}`);
      const prog = compileExpr(stmt.expr, (name) => model.lineId.get(name));
      model.constraints.push({ prog, ast: stmt.expr, src });
    }
  }
  return model;
}
