// Constraint compiler: expression AST -> stack-machine bytecode, plus the VM.
// Values at runtime are plain JS numbers (minutes for Dur/Inst) and booleans.

const BIN_OP = {
  '+': 'ADD', '-': 'SUB',
  '==': 'EQ', '!=': 'NE',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  '&&': 'AND', '||': 'OR',
};

// lineIndex: Map lineName -> integer index
export function compile(expr, lineIndex) {
  const code = [];
  const consts = [];
  const linesUsed = new Set();

  function pushConst(v) {
    consts.push(v);
    code.push(['PUSH', consts.length - 1]);
  }

  function gen(e) {
    switch (e.t) {
      case 'int':
      case 'dur':
      case 'inst':
        pushConst(e.v);
        break;
      case 'var': {
        const idx = lineIndex.get(e.name);
        if (idx === undefined) throw new Error(`unknown name '${e.name}' in constraint`);
        pushConst({ line: idx });
        break;
      }
      case 'call': {
        if (e.args.length !== 1 || e.args[0].t !== 'var') {
          throw new Error(`${e.name} expects a single line name`);
        }
        const idx = lineIndex.get(e.args[0].name);
        if (idx === undefined) throw new Error(`unknown line '${e.args[0].name}'`);
        linesUsed.add(e.args[0].name);
        code.push([e.name === 'count' ? 'COUNT' : 'LOAD', idx]);
        break;
      }
      case 'bin':
        gen(e.l);
        gen(e.r);
        code.push([BIN_OP[e.op]]);
        break;
      case 'un':
        gen(e.e);
        code.push([e.op === '!' ? 'NOT' : 'NEG']);
        break;
      default:
        throw new Error(`cannot compile node ${e.t}`);
    }
  }

  gen(expr);
  return { code, consts, linesUsed: [...linesUsed] };
}

// ctx: { counts: number[], loads: number[] } indexed by line index
export function run(program, ctx) {
  const st = [];
  for (const ins of program.code) {
    const op = ins[0];
    switch (op) {
      case 'PUSH': st.push(program.consts[ins[1]]); break;
      case 'COUNT': st.push(ctx.counts[ins[1]]); break;
      case 'LOAD': st.push(ctx.loads[ins[1]]); break;
      case 'ADD': { const b = st.pop(); st.push(st.pop() + b); break; }
      case 'SUB': { const b = st.pop(); st.push(st.pop() - b); break; }
      case 'EQ': { const b = st.pop(); st.push(st.pop() === b); break; }
      case 'NE': { const b = st.pop(); st.push(st.pop() !== b); break; }
      case 'LT': { const b = st.pop(); st.push(st.pop() < b); break; }
      case 'LE': { const b = st.pop(); st.push(st.pop() <= b); break; }
      case 'GT': { const b = st.pop(); st.push(st.pop() > b); break; }
      case 'GE': { const b = st.pop(); st.push(st.pop() >= b); break; }
      case 'AND': { const b = st.pop(); st.push(st.pop() && b); break; }
      case 'OR': { const b = st.pop(); st.push(st.pop() || b); break; }
      case 'NOT': st.push(!st.pop()); break;
      case 'NEG': st.push(-st.pop()); break;
      default: throw new Error(`bad opcode ${op}`);
    }
  }
  return st.pop();
}

// Incremental validator: caches each constraint's last result and only
// re-evaluates constraints whose referenced lines intersect the changed set.
export class Validator {
  constructor() {
    this.constraints = new Map(); // name -> { program, linesUsed, last }
    this.evaluated = 0; // instrumentation: number of bytecode evaluations
  }

  setConstraint(name, program, linesUsed) {
    this.constraints.set(name, { program, linesUsed, last: undefined });
  }

  // changedLines: iterable of line names, or null to force full validation.
  // Returns { ok, failures: [name...] }.
  validate(ctx, lineNames, changedLines) {
    const failures = [];
    const changed = changedLines === null ? null : new Set(changedLines);
    const idxOf = new Map(lineNames.map((n, i) => [n, i]));
    for (const [name, c] of this.constraints) {
      const dirty = c.last === undefined || changed === null ||
        c.linesUsed.some((ln) => changed.has(ln));
      if (dirty) {
        this.evaluated++;
        c.last = run(c.program, ctx);
      }
      if (c.last !== true) failures.push(name);
    }
    return { ok: failures.length === 0, failures };
  }
}
